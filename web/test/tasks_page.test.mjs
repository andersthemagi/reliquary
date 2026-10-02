// The Tasks page in the web app (src/tasks.ts): a vault's work plans with
// their tasks counted by state, and one plan's tasks grouped so what can be
// worked on comes first. The state rules are SQL's (work_plans_test.sql,
// list_work_plans_test.sql) and who may see a plan is RLS's; this file is
// about what a person reads on the page: the words for each state, what a
// task waits on, who holds it, and the marker for a changed plan file.
//
// This file starts its own servers from dist/, signed in as Noa (an owner)
// and Rex (a viewer), people no other test file uses. Noa owns "Tasks main"
// with Edda (an editor, who holds a task below) and Rex.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const NOA = "00000000-0000-0000-0000-0000000055a1";
const EDDA = "00000000-0000-0000-0000-0000000055a2";
const REX = "00000000-0000-0000-0000-0000000055a3";

const V = {};
let noa;
let rex;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function sql(q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
}

async function as(user, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

// A server from dist/, signed in as `user`.
async function start(user, name) {
  const port = await freePort();
  const s = { origin: `http://127.0.0.1:${port}`, cookie: "", child: null };
  const loginFile = `/tmp/tasks-page-${name}-${process.pid}-${port}`;
  s.child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${s.origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];
  return s;
}

const get = (s, path) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (s, path) => (await get(s, path)).text();
const flashOf = (h) => /<p class="callout (\w+) flash" role="(\w+)">([\s\S]*?)<\/p>/.exec(h)?.slice(1);

const tasksUrl = (v) => `/v/${v}/tasks`;
const planUrl = (v, path) => `/v/${v}/tasks/plan?path=${encodeURIComponent(path)}`;

// A plan file and its registration, as `user`.
async function register(user, vault, path, steps) {
  await as(user, "select public.write_file($1, $2, 'The plan')", [vault, path]);
  const [{ v }] = await sql("select current_version_id as v from public.files where vault_id = $1 and path = $2", [vault, path]);
  await as(user, "select public.register_work_plan($1, $2, $3, $4::jsonb)", [vault, path, v, JSON.stringify(steps)]);
}
const claim = async (user, vault, path, key, label) =>
  (await as(user, "select o_secret, o_fence from public.claim_step($1, $2, $3, $4)", [vault, path, key, label]))[0];

// The row of one task (matched by its key under the title), as HTML.
function taskRow(h, key) {
  const row = h.split("<tr>").find((r) => new RegExp(`^<td><strong>[^<]*</strong><span class="token-client"><code>${key}</code>`).test(r));
  assert.ok(row, `a row for the task ${key}`);
  return row;
}

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'noa@example.test'), ($2, 'edda@example.test'), ($3, 'rex@example.test') on conflict (id) do nothing`,
    [NOA, EDDA, REX],
  );
  noa = await start(NOA, "noa");
  rex = await start(REX, "rex");

  [{ id: V.main }] = await as(NOA, "select public.create_vault('Tasks main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, EDDA, NOA]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.main, REX, NOA]);

  // fetch: done. clean: held by Edda. check: ready. ship: blocked on clean and
  // check. side: cancelled. after: blocked by the cancelled side job.
  await register(EDDA, V.main, "plans/launch.md", [
    { key: "fetch", title: "Fetch the data" },
    { key: "clean", title: "Clean it", blocked_by: ["fetch"] },
    { key: "check", title: "Check it", blocked_by: ["fetch"] },
    { key: "ship", title: "Ship it", blocked_by: ["clean", "check"] },
    { key: "side", title: "Side job" },
    { key: "after", title: "After the side job", blocked_by: ["side"] },
  ]);
  const fetch1 = await claim(EDDA, V.main, "plans/launch.md", "fetch", null);
  await as(EDDA, "select public.complete_step($1, 'plans/launch.md', 'fetch', $2, $3)", [V.main, fetch1.o_fence, fetch1.o_secret]);
  await claim(EDDA, V.main, "plans/launch.md", "clean", "<b>cleaning</b> the rows");
  await as(NOA, "select public.cancel_step($1, 'plans/launch.md', 'side')", [V.main]);

  await register(EDDA, V.main, "plans/second.md", [{ key: "only", title: "The only task" }]);

  [{ id: V.empty }] = await as(NOA, "select public.create_vault('Tasks empty', 'open') as id");
  [{ id: V.other }] = await as(REX, "select public.create_vault('Tasks rex-only', 'open') as id");
});

after(async () => {
  noa?.child?.kill();
  rex?.child?.kill();
});

// ---------------------------------------------------------------------------
// The list of plans

test("tasks page: a vault you're not in is 404", async () => {
  assert.equal((await get(noa, tasksUrl(V.other))).status, 404);
  assert.equal((await get(noa, planUrl(V.other, "plans/launch.md"))).status, 404);
});

test("tasks page: a vault with no plan says how one comes to exist, in two sentences, and links the docs", async () => {
  const h = await page(noa, tasksUrl(V.empty));
  assert.match(h, /<h1>Tasks<\/h1>/);
  assert.match(h, /<strong>No plans yet<\/strong>/);
  assert.match(
    h,
    /<p>A plan comes to exist when an agent registers a plan file that holds a <code>work_plan<\/code> block\. Registered plans, and the tasks in them, show up here\.<\/p>/,
  );
  assert.match(h, /<a href="\/docs\/concepts\/tasks">About tasks<\/a>/);
});

test("tasks page: lists each plan with its tasks counted in words, and links to the plan", async () => {
  const h = await page(noa, tasksUrl(V.main));
  const launch = h.split("<tr>").find((r) => r.includes("plans/launch.md"));
  assert.match(launch, new RegExp(`<a href="${tasksUrl(V.main)}/plan\\?path=plans%2Flaunch\\.md">plans/launch\\.md</a>`));
  assert.match(launch, /<strong>1 of 6 done<\/strong><span class="token-client">1 in progress · 1 ready · 2 blocked · 1 cancelled<\/span>/);
  assert.match(launch, /edda@example\.test/, "who registered it");
  const second = h.split("<tr>").find((r) => r.includes("plans/second.md"));
  assert.match(second, /<strong>0 of 1 done<\/strong><span class="token-client">1 ready<\/span>/);
  assert.ok(h.indexOf("plans/launch.md") < h.indexOf("plans/second.md"), "in path order");
});

test("tasks page: has its own section in the vault's nav, current on both of its pages", async () => {
  for (const url of [tasksUrl(V.main), planUrl(V.main, "plans/launch.md")]) {
    const h = await page(noa, url);
    assert.match(h, new RegExp(`<a href="${tasksUrl(V.main)}" aria-current="page">Tasks</a>`), url);
  }
});

test("tasks page: a viewer sees the same list", async () => {
  const h = await page(rex, tasksUrl(V.main));
  assert.match(h, /1 of 6 done/);
  assert.match(h, /plans\/second\.md/);
});

test("tasks page: a plan whose file has changed since it was registered carries a marker with words, and a deleted one says so", async () => {
  let h = await page(noa, tasksUrl(V.main));
  assert.match(h.split("<tr>").find((r) => r.includes("plans/second.md")), /<span class="muted">Unchanged<\/span>/);
  await as(EDDA, "select public.write_file($1, 'plans/second.md', 'The plan, edited')", [V.main]);
  h = await page(noa, tasksUrl(V.main));
  assert.match(h.split("<tr>").find((r) => r.includes("plans/second.md")), /<span class="badge warning">Changed since registered<\/span>/);
  assert.match(h.split("<tr>").find((r) => r.includes("plans/launch.md")), /<span class="muted">Unchanged<\/span>/, "another plan's file is untouched");
  await as(EDDA, "select public.delete_file($1, 'plans/second.md')", [V.main]);
  h = await page(noa, tasksUrl(V.main));
  assert.match(h.split("<tr>").find((r) => r.includes("plans/second.md")), /<span class="badge warning">File deleted<\/span>/);
});

// ---------------------------------------------------------------------------
// One plan

test("plan page: groups what is in progress and ready first, then blocked, cancelled and done", async () => {
  const h = await page(noa, planUrl(V.main, "plans/launch.md"));
  assert.match(h, /<h1 class="path">plans\/launch\.md<\/h1>/);
  assert.match(h, /1 of 6 tasks done\./);
  const order = ["in-progress", "ready", "blocked", "cancelled", "done"].map((g) => h.indexOf(`<h2 id="g-${g}">`));
  assert.ok(order.every((i) => i > 0), "a heading for each group in use");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in progress, ready, blocked, cancelled, done, in that order");
  assert.match(h, /<h2 id="g-in-progress">In progress <span class="muted">1<\/span><\/h2>/);
  assert.match(h, /<h2 id="g-blocked">Blocked <span class="muted">2<\/span><\/h2>/);
  const keys = [...h.matchAll(/<tr><td><strong>[^<]*<\/strong><span class="token-client"><code>([a-z-]+)<\/code>/g)].map((m) => m[1]);
  assert.deepEqual(keys, ["clean", "check", "after", "ship", "side", "fetch"], "a task blocked by a cancelled one comes first among the blocked");
});

test("plan page: every task's state is a word in its row, not only a colour", async () => {
  const h = await page(noa, planUrl(V.main, "plans/launch.md"));
  const states = { clean: "In progress", check: "Ready", ship: "Blocked", after: "Blocked by a cancelled task", side: "Cancelled", fetch: "Done" };
  for (const [key, label] of Object.entries(states)) {
    assert.match(taskRow(h, key), new RegExp(`<td class="small" data-label="State"><span class="badge[^"]*">${label}</span></td>`), key);
  }
  assert.equal(h.match(/<td class="small" data-label="State">/g).length, 6, "a state for every task");
});

test("plan page: a task in progress names who holds it, quotes the label as data, and shows the time left", async () => {
  const row = taskRow(await page(noa, planUrl(V.main, "plans/launch.md")), "clean");
  assert.match(row, /Held by edda@example\.test/);
  assert.match(row, /<span class="token-client">“&lt;b&gt;cleaning&lt;\/b&gt; the rows”<\/span>/, "the label is text, in quotes");
  assert.match(row, /Time left: <time [^>]*>in 2 days<\/time>/);
});

test("plan page: a blocked task names what it waits on", async () => {
  const row = taskRow(await page(noa, planUrl(V.main, "plans/launch.md")), "ship");
  assert.match(row, /Waiting on Clean it <code>clean<\/code>, Check it <code>check<\/code>\./);
});

test("plan page: a task blocked by a cancelled one says so plainly, and what it takes to move it", async () => {
  const row = taskRow(await page(noa, planUrl(V.main, "plans/launch.md")), "after");
  assert.match(row, /Blocked by a cancelled task: Side job <code>side<\/code>\. A cancelled task never counts as done, so this one stays blocked until a person cancels or skips it\./);
});

test("plan page: a ready task, a done one and a cancelled one each say what they are", async () => {
  const h = await page(noa, planUrl(V.main, "plans/launch.md"));
  assert.match(taskRow(h, "check"), /Nobody has taken it yet\./);
  assert.match(taskRow(h, "fetch"), /Done <time [^>]*>[^<]*<\/time>\./);
  assert.match(taskRow(h, "side"), /Doesn’t count as done\./);
});

test("plan page: a lapsed claim reads as ready again, and says why", async () => {
  await sql("update public.work_plan_steps set expires_at = now() - interval '1 minute' where status = 'claimed' and vault_id = $1", [V.main]);
  const h = await page(noa, planUrl(V.main, "plans/launch.md"));
  assert.match(taskRow(h, "clean"), /<span class="badge success">Ready<\/span>/);
  assert.match(taskRow(h, "clean"), /Its last claim ran out, so it can be taken again\./);
  assert.match(await page(noa, tasksUrl(V.main)), /<strong>1 of 6 done<\/strong><span class="token-client">2 ready · 2 blocked · 1 cancelled<\/span>/);
});

test("plan page: a changed plan file is said at the top, with a link to the file's history", async () => {
  await as(EDDA, "select public.write_file($1, 'plans/launch.md', 'The plan, edited')", [V.main]);
  const h = await page(noa, planUrl(V.main, "plans/launch.md"));
  assert.match(h, /<div class="callout warning"><p>This plan’s file has changed since the plan was registered\./);
  assert.match(h, new RegExp(`<a href="/v/${V.main}/file\\?path=plans%2Flaunch\\.md&amp;tab=history">See the file’s history</a>`));
});

test("plan page: a deleted plan file is said at the top, and its tasks stay", async () => {
  const h = await page(noa, planUrl(V.main, "plans/second.md"));
  assert.match(h, /<div class="callout warning"><p>This plan’s file has been deleted\. The tasks below stay, and agents can still work from them\.<\/p><\/div>/);
  assert.match(taskRow(h, "only"), /Ready/);
});

test("plan page: a path with no plan, or none at all, goes back to the list with a warning", async () => {
  const r = await get(noa, planUrl(V.main, "plans/nope.md"));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), tasksUrl(V.main));
  assert.deepEqual(flashOf(await page(noa, tasksUrl(V.main))), ["warning", "status", "There’s no plan registered at plans/nope.md."]);
  const none = await get(noa, `/v/${V.main}/tasks/plan`);
  assert.equal(none.headers.get("location"), tasksUrl(V.main));
  assert.deepEqual(flashOf(await page(noa, tasksUrl(V.main))), ["warning", "status", "There’s no plan registered at that path."]);
});
