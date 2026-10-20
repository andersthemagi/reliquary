// The agents for run.sh (issue #486). Seeds vaults of 5 people and 2 agents
// in the database, as the web app would, writes and registers each vault's
// plan over MCP, then runs every agent over MCP's HTTP endpoint for a stage
// and reports what the stage sustained. Stages grow: each adds vaults to the
// last's, and the vaults already running keep their plans and places.
//
// An honest agent asks for work, spends LOAD_WORK_SECONDS on a granted step
// and completes it, and when told to wait comes back when it was told to. A
// vault's plan is a chain, so one of its agents works while the other waits
// in line. A hostile agent asks as fast as it can, ignores every hint and
// never completes what it is granted (F827's crowd, over MCP). The crowd
// runs in a worker thread of its own, so its thousands of calls a second
// don't slow the event loop that times the honest agents.
//
// Tokens stay in memory: nothing here prints one.

import { randomBytes } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const env = process.env;
const URLS = env.MCP_URLS.split(",").map((u) => new URL(u));
const STAGES = (env.LOAD_VAULTS || "100,300,1000").split(",").map(Number);
const SECONDS = Number(env.LOAD_SECONDS || 90);
const WARMUP = Number(env.LOAD_WARMUP || 20);
const WORK = Number(env.LOAD_WORK_SECONDS || 30);
const GAP = Number(env.LOAD_GAP || 10);
const HOSTILE_VAULTS = Number(env.LOAD_HOSTILE_VAULTS ?? 5);
// LOAD_HERD=1: every agent starts at once instead.
const HERD = env.LOAD_HERD === "1";
const STEPS = 100;
const RATE_LIMITED = -32029;
const TICKS = "`".repeat(3);

const db = new pg.Pool({ connectionString: env.SUPER_URL, max: 16 });
const uid = () => `00000000-0000-4000-8000-${randomBytes(6).toString("hex")}`;

async function as(user, q, params = []) {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    const { rows } = await c.query(q, params);
    await c.query("commit");
    return rows;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Runs fn over items, n at a time.
async function each(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

let clients = 0;
async function connect(token) {
  const url = URLS[clients++ % URLS.length];
  const client = new Client({ name: "load", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

// One tool call: its outcome, its latency, and its text for the caller.
async function call(client, name, args) {
  const t0 = performance.now();
  try {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.map((c) => c.text).join("\n");
    return { ms: performance.now() - t0, text, outcome: r.isError ? "refused" : "ok" };
  } catch (e) {
    // Over a rate limit the server answers 429 with a JSON-RPC error, which
    // the SDK throws as a transport error carrying the body.
    const text = String(e.message ?? e);
    return { ms: performance.now() - t0, text, outcome: text.includes(`"code":${RATE_LIMITED}`) ? "rate_limited" : "error" };
  }
}

const planText = () => {
  const lines = [`${TICKS}work_plan`];
  for (let i = 1; i <= STEPS; i++) {
    lines.push(`- key: s${i}`, `  title: Step ${i}`);
    if (i > 1) lines.push(`  blocked_by: s${i - 1}`);
  }
  lines.push(TICKS, "");
  return lines.join("\n");
};

// A vault of 5 people, 2 of them with an agent each, its plan registered.
// A hostile vault also has 5 more people with 20 connections each.
async function seedVault(i, hostile) {
  const people = Array.from({ length: 5 }, uid);
  const crowd = hostile ? Array.from({ length: 5 }, uid) : [];
  const all = [...people, ...crowd];
  await db.query("insert into auth.users (id, email) select u, right(u::text, 12) || '@example.test' from unnest($1::uuid[]) u", [all]);
  const name = `Load ${i}`;
  const [{ v }] = await as(people[0], "select public.create_vault($1) as v", [name]);
  for (const p of all.slice(1)) await db.query("select test_support.add_member($1, $2, 'editor', $3)", [v, p, people[0]]);
  // Lease 5 minutes, hold limit an hour, one step per connection and per
  // person, a place lives 2 minutes, longest hint a minute, the gap, one
  // free lapse, cooldown at most 30 minutes.
  await as(people[0], "select public.set_claim_rule($1, 'plans/', 5, 60, null, 1, 1, 2, 1, $2, 1, 30)", [v, GAP]);
  const token = async (p, label) => (await as(p, "select public.create_access_token($1, 7, array[$2]::uuid[], 'write') as t", [label, v]))[0].t;
  const owner = await connect(await token(people[0], "Load owner"));
  for (const [tool, args] of [["write_file", { vault: name, path: "plans/chain.md", content: planText() }], ["register_work_plan", { vault: name, path: "plans/chain.md" }]]) {
    const r = await call(owner, tool, args);
    if (r.outcome !== "ok") throw new Error(`seeding ${name}: ${tool}: ${r.text.split("\n")[0]}`);
  }
  await owner.close();
  const agents = [];
  for (const p of people.slice(1, 3)) agents.push({ vault: name, client: await connect(await token(p, "Load agent")) });
  const hostiles = [];
  for (const p of crowd) for (let k = 0; k < 20; k++) hostiles.push({ vault: name, token: await token(p, `Load hostile ${k}`) });
  return { agents, hostiles };
}

// What a stage saw: every call, and the pooler's state each second.
function newStats() {
  return { calls: [], pooler: [], errors: new Map() };
}
const record = (stats, side, tool, r, state) => {
  stats.calls.push({ at: performance.now(), side, tool, ms: r.ms, outcome: r.outcome, state });
  if (r.outcome === "error" || (r.outcome === "refused" && side === "honest")) {
    const line = `${side} ${tool} ${r.outcome}: ${r.text.split("\n")[0].replace(/[0-9a-f]{64}/g, "<secret>").slice(0, 160)}`;
    stats.errors.set(line, (stats.errors.get(line) ?? 0) + 1);
  }
};
const stateOf = (text) => /^(Granted|Wait|Plan complete|Blocked|At capacity|Cooling down)/.exec(text)?.[1] ?? "other";

// Each agent starts at a random moment in the warm-up, as agents arrive in
// real use: started all in the same second, 2,000 of them queue past the
// servers' 5 second wait for a pooled connection (the herd, written up).
async function honest(a, until, stats) {
  const path = "plans/chain.md";
  if (!HERD) await sleep(Math.random() * WARMUP * 1000);
  while (performance.now() < until) {
    const r = await call(a.client, "request_work", { vault: a.vault, path });
    const state = r.outcome === "ok" ? stateOf(r.text) : undefined;
    record(stats, "honest", "request_work", r, state);
    if (state === "Granted") {
      const key = /^Granted step (\S+) of/.exec(r.text)[1];
      const fence = Number(/fence (\d+)/.exec(r.text)[1]);
      const secret = /secret: ([0-9a-f]{64})/.exec(r.text)[1];
      await sleep(Math.max(0, Math.min(WORK * 1000, until - performance.now())));
      record(stats, "honest", "complete_step", await call(a.client, "complete_step", { vault: a.vault, path, key, fence, secret }));
    } else if (state === "Plan complete") {
      return;
    } else {
      const s = Number(/again in (\d+) seconds/.exec(r.text)?.[1] ?? 10);
      await sleep(Math.max(0, Math.min(s * 1000, until - performance.now())));
    }
  }
}

// The worker: the hostile crowd for one stage, answering with its tallies.
async function hostileCrowd({ crowd, seconds }) {
  const conns = await Promise.all(crowd.map(async (h) => ({ vault: h.vault, client: await connect(h.token) })));
  const until = performance.now() + seconds * 1000;
  const answers = {};
  const errors = {};
  await Promise.all(conns.map(async (h) => {
    while (performance.now() < until) {
      const r = await call(h.client, "request_work", { vault: h.vault, path: "plans/chain.md" });
      const a = r.outcome === "ok" ? stateOf(r.text) : r.outcome;
      answers[a] = (answers[a] ?? 0) + 1;
      if (r.outcome === "error") {
        const line = r.text.split("\n")[0].slice(0, 160);
        errors[line] = (errors[line] ?? 0) + 1;
      }
    }
  }));
  await Promise.all(conns.map((h) => h.client.close().catch(() => {})));
  return { answers, errors };
}

async function samplePooler(until, stats) {
  const c = new pg.Client({ connectionString: env.POOLER_URL });
  await c.connect();
  try {
    while (performance.now() < until) {
      const { rows } = await c.query("show pools");
      const p = rows.find((r) => r.database === "postgres" && r.user === "reliquary_mcp");
      if (p) stats.pooler.push({ at: performance.now(), clActive: +p.cl_active, clWaiting: +p.cl_waiting, svActive: +p.sv_active, maxwaitMs: +p.maxwait * 1000 + +p.maxwait_us / 1000 });
      await sleep(1000);
    }
  } finally {
    await c.end();
  }
}

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]);
};
const max = (xs) => (xs.length ? Math.max(...xs) : 0);
const tally = (xs) => xs.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

function report(vaults, agents, crowd, stats, from, to, doneSteps) {
  const seconds = (to - from) / 1000;
  const calls = stats.calls.filter((c) => c.at >= from);
  const pooler = stats.pooler.filter((p) => p.at >= from);
  const rate = (xs) => Math.round((xs.length / seconds) * 10) / 10;
  const asks = calls.filter((c) => c.side === "honest" && c.tool === "request_work");
  const completes = calls.filter((c) => c.side === "honest" && c.tool === "complete_step");
  return {
    vaults,
    honestAgents: agents.length,
    hostileConnections: crowd.connections,
    measuredSeconds: Math.round(seconds),
    callsPerSecond: { honest: rate(calls), honestRequestWork: rate(asks), honestComplete: rate(completes), hostile: crowd.perSecond },
    honestRequestWorkMs: { p50: pct(asks.map((c) => c.ms), 50), p95: pct(asks.map((c) => c.ms), 95), p99: pct(asks.map((c) => c.ms), 99) },
    honestCompleteMs: { p50: pct(completes.map((c) => c.ms), 50), p95: pct(completes.map((c) => c.ms), 95) },
    honestAnswers: tally(asks.map((c) => c.state ?? c.outcome)),
    hostileAnswers: crowd.answers,
    stepsDone: doneSteps,
    pooler: {
      clientsMax: max(pooler.map((p) => p.clActive + p.clWaiting)),
      clientsWaitingMax: max(pooler.map((p) => p.clWaiting)),
      serverConnectionsMax: max(pooler.map((p) => p.svActive)),
      longestWaitMs: Math.round(max(pooler.map((p) => p.maxwaitMs))),
    },
  };
}

const done = async () => (await db.query("select count(*)::int as n from public.work_plan_steps where status = 'done'")).rows[0].n;

if (!isMainThread) {
  parentPort.postMessage(await hostileCrowd(workerData));
  process.exit(0);
}

const runCrowd = (crowd, seconds) =>
  new Promise((resolve, reject) => {
    if (!crowd.length) return resolve({ answers: {}, errors: {} });
    const w = new Worker(new URL(import.meta.url), { workerData: { crowd, seconds } });
    w.once("message", resolve);
    w.once("error", reject);
  });

const agents = [];
const hostiles = [];
const results = [];
let seeded = 0;
for (const vaults of STAGES) {
  const t0 = performance.now();
  const range = Array.from({ length: vaults - seeded }, (_, k) => seeded + k);
  await each(range, 16, async (i) => {
    const v = await seedVault(i, i < HOSTILE_VAULTS);
    agents.push(...v.agents);
    hostiles.push(...v.hostiles);
  });
  seeded = vaults;
  console.log(`seeded ${vaults} vaults (${agents.length} agents, ${hostiles.length} hostile connections) in ${Math.round((performance.now() - t0) / 1000)} s`);

  const stats = newStats();
  const lag = monitorEventLoopDelay({ resolution: 10 });
  const start = performance.now();
  const until = start + SECONDS * 1000;
  const doneBefore = await done();
  const [crowd] = await Promise.all([runCrowd(hostiles, SECONDS), samplePooler(until, stats), ...agents.map((a) => honest(a, until, stats)),
    sleep(WARMUP * 1000).then(() => lag.enable())]);
  lag.disable();
  const total = Object.values(crowd.answers).reduce((a, b) => a + b, 0);
  const r = report(vaults, agents, { connections: hostiles.length, answers: crowd.answers, perSecond: Math.round(total / SECONDS) }, stats,
    start + WARMUP * 1000, performance.now(), (await done()) - doneBefore);
  // The driver's own delay: when it is high, the latencies above are partly the driver's.
  r.driverLagP99Ms = Math.round(lag.percentile(99) / 1e6);
  r.errors = Object.fromEntries([...stats.errors, ...Object.entries(crowd.errors).map(([k, n]) => [`hostile: ${k}`, n])].sort((a, b) => b[1] - a[1]).slice(0, 10));
  results.push(r);
  console.log(JSON.stringify(r, null, 2));
}

console.log("== summary");
console.log("vaults  honest  hostile  hostile calls/s  ask/s  ask p50  ask p95  ask p99  pooler clients  waiting  longest wait  errors");
for (const r of results) {
  const errors = Object.values(r.errors).reduce((a, b) => a + b, 0);
  console.log(
    [r.vaults, r.honestAgents, r.hostileConnections, r.callsPerSecond.hostile, r.callsPerSecond.honestRequestWork,
      `${r.honestRequestWorkMs.p50} ms`, `${r.honestRequestWorkMs.p95} ms`, `${r.honestRequestWorkMs.p99} ms`,
      r.pooler.clientsMax, r.pooler.clientsWaitingMax, `${r.pooler.longestWaitMs} ms`, errors, `driver lag ${r.driverLagP99Ms} ms`].join("  "),
  );
}
for (const a of agents) await a.client.close().catch(() => {});
await db.end();
