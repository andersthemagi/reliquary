// Races on plans, limits and invites (supabase/migrations/
// 20260925240100_lock_order.sql, 20260925240200_operator_waits.sql): real
// parallel connections, each its own transaction as a person, against
// web/test.sh's database.
//
// Two kinds of test:
// - Crowds: N connections do the same thing at once where only some may
//   succeed (the last place in a vault, the last vault on a plan, the last
//   bytes of storage). Exactly the right number win, the rest get the limit's
//   refusal, and the storage counter equals a full scan afterwards.
// - Forced interleavings: two operations that take the same locks in
//   opposite orders deadlock (SQLSTATE 40P01, one of them aborted) only when
//   their steps interleave. A test-only trigger (schema test_races, created
//   here and dropped after) stops the first operation at the step that
//   matters, on an advisory lock the test holds (the barrier); the test
//   waits until pg_stat_activity shows it stopped there, starts the second,
//   waits until that one is blocked on a lock (or done), and only then lets
//   the first go. So the interleaving happens on every run, whatever the
//   machine's speed: no sleeps, no retries. With the locks taken in one
//   order, the second simply waits.
//
// People and vaults here are this file's own (ids c0ffee00-...), on plans
// and tiers of this file's own, so no other test sees them.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB_URL = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const PG_PORT = 54332 + (Number(new URL(WEB_URL).port) - 8791);
const SUPER = process.env.TEST_SUPER_URL ?? `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const verbose = Boolean(process.env.RACES_VERBOSE);

const uid = (n) => `c0ffee00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OWNER = uid(1);
const people = Array.from({ length: 24 }, (_, i) => uid(100 + i));
const email = (id) => `races-${id.slice(-4)}@example.test`;

const open = [];
async function connect() {
  const c = new pg.Client({ connectionString: SUPER });
  await c.connect();
  open.push(c);
  return c;
}
// Ends connections a test is done with (the database allows 100).
async function close(...cs) {
  for (const c of cs.flat()) {
    const i = open.indexOf(c);
    if (i >= 0) open.splice(i, 1);
    await c.end().catch(() => {});
  }
}
let db;
let budgetWas;
const sql = async (q, params = []) => (await db.query(q, params)).rows;

// One transaction as a person, on connection c. Optional: `stop` names the
// test_races trigger (see the top of this file) where it stops at the
// barrier.
async function as(c, user, q, params = [], stop) {
  await c.query("begin");
  try {
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    if (stop) await c.query("select set_config('races.stop_on', $1, true)", [stop]);
    const r = await c.query(q, params);
    await c.query("commit");
    return { ok: true, rows: r.rows };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    return { ok: false, code: e.code, message: e.message };
  }
}

// The barrier: an advisory lock the test holds while an operation stops on
// it in the trigger.
const BARRIER = 7_202_609;
async function holdBarrier() {
  const c = await connect();
  await c.query("select pg_advisory_lock($1)", [BARRIER]);
  return { release: () => close(c) };
}

// Waits until connection c's backend is waiting on a lock (on the barrier
// when `advisory`), or until `done` settles. Polls pg_stat_activity; gives
// up (failing the test) after 20 s.
async function blocked(c, { advisory = false, done } = {}) {
  let settled = false;
  done?.then(() => (settled = true), () => (settled = true));
  for (let i = 0; i < 1000; i++) {
    if (settled) return "done";
    const [row] = await sql("select wait_event_type, wait_event from pg_stat_activity where pid = $1", [c.processID]);
    if (row?.wait_event_type === "Lock" && (!advisory || row.wait_event === "advisory")) return "blocked";
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`backend ${c.processID} never ${advisory ? "reached the barrier" : "blocked"}`);
}

const codes = (results) => results.reduce((m, r) => ((m[r.ok ? "ok" : r.code] = (m[r.ok ? "ok" : r.code] ?? 0) + 1), m), {});
const counted = async (vault) =>
  (await sql("select (select bytes from private.vault_storage where vault_id = $1)::bigint as counter, private.storage_scan($1)::bigint as scan", [vault]))[0];
const log = (...a) => verbose && console.log(...a);

async function newVault(owner, name) {
  const r = await as(db, owner, "select public.create_vault($1) as id", [name]);
  assert.ok(r.ok, r.message);
  return r.rows[0].id;
}
async function invite(owner, vault, to) {
  const r = await as(db, owner, "select public.create_invite($1, $2, 'viewer') as t", [vault, email(to)]);
  assert.ok(r.ok, r.message);
  return r.rows[0].t;
}

before(async () => {
  db = await connect();
  const everyone = [OWNER, ...people];
  await sql(
    `insert into auth.users (id, email) select u, 'races-' || right(u::text, 4) || '@example.test' from unnest($1::uuid[]) u
     on conflict (id) do nothing`,
    [everyone],
  );
  // Plans and a tier of this file's own. Roomy for setup, then made small.
  await sql(`insert into private.plans (id, name, max_vaults, max_members, max_storage_bytes)
             values ('races_roomy', 'Races roomy', 1000, 1000, 1000000000),
                    ('races_small', 'Races small', 3, 5, 1000)
             on conflict (id) do nothing`);
  await sql(`insert into private.vault_tiers (id, name, max_members, max_storage_bytes)
             values ('races_tiny', 'Races tiny', 4, 1000), ('races_three', 'Races three', 3, 1000000)
             on conflict (id) do nothing`);
  for (const u of everyone) await sql("select private.set_account_plan($1, 'races_roomy')", [u]);
  // A vault's request budget (F839, proved in request_budget_test.sql) is
  // 300 evaluations a minute: a crowd here that ran past it would spend the
  // rest of the minute told to wait, and how far it got first would depend
  // on the machine's speed. Lifted for this file, put back in after().
  budgetWas = (await sql("select per_minute from private.request_budget"))[0].per_minute;
  await sql("update private.request_budget set per_minute = 1000000");
  // The stopping trigger: AFTER each statement on a table, when this
  // transaction's races.stop_on names it, wait for the barrier. Test-only;
  // dropped in after().
  await sql(`create schema if not exists test_races;
    create or replace function test_races.stop() returns trigger language plpgsql as $f$
    begin
      if current_setting('races.stop_on', true) = tg_argv[0] then
        perform pg_advisory_xact_lock(${BARRIER});
      end if;
      return null;
    end $f$;
    drop trigger if exists zz_races_stop on public.files;
    create trigger zz_races_stop after insert or update on public.files
      for each statement execute function test_races.stop('files');
    drop trigger if exists zz_races_stop on private.env_import_secrets;
    create trigger zz_races_stop after delete on private.env_import_secrets
      for each statement execute function test_races.stop('import_secrets');
    drop trigger if exists zz_races_stop on public.log;
    create trigger zz_races_stop after insert on public.log
      for each statement execute function test_races.stop('log');
    drop trigger if exists zz_races_stop on public.vault_members;
    create trigger zz_races_stop after insert on public.vault_members
      for each statement execute function test_races.stop('members');
    drop trigger if exists zz_races_stop on public.variable_values;
    create trigger zz_races_stop after insert or update on public.variable_values
      for each statement execute function test_races.stop('values');
    drop trigger if exists zz_races_stop on public.thread_messages;
    create trigger zz_races_stop after insert on public.thread_messages
      for each statement execute function test_races.stop('thread_messages');
    drop trigger if exists zz_races_stop on private.vault_deletions;
    create trigger zz_races_stop after insert on private.vault_deletions
      for each statement execute function test_races.stop('vault_deletions');
    drop trigger if exists zz_races_stop on public.path_claims;
    create trigger zz_races_stop after insert or update or delete on public.path_claims
      for each statement execute function test_races.stop('path_claims');`);
  await sql(`drop trigger if exists zz_races_stop on public.work_plan_steps;
    create trigger zz_races_stop after update on public.work_plan_steps
      for each statement execute function test_races.stop('work_plan_steps');`);
  await sql(`drop trigger if exists zz_races_stop_step_log on public.log;
    create trigger zz_races_stop_step_log after insert on public.log
      for each row when (new.event like 'step.%') execute function test_races.stop('step_log');`);
});

after(async () => {
  if (budgetWas) await sql("update private.request_budget set per_minute = $1", [budgetWas]).catch(() => {});
  await sql(`drop trigger if exists zz_races_stop on public.files;
             drop trigger if exists zz_races_stop on private.env_import_secrets;
             drop trigger if exists zz_races_stop on public.log;
             drop trigger if exists zz_races_stop on public.vault_members;
             drop trigger if exists zz_races_stop on public.variable_values;
             drop trigger if exists zz_races_stop on public.thread_messages;
             drop trigger if exists zz_races_stop on private.vault_deletions;
             drop trigger if exists zz_races_stop on public.path_claims;
             drop trigger if exists zz_races_stop on public.work_plan_steps;
             drop trigger if exists zz_races_stop_step_log on public.log;
             drop schema if exists test_races cascade;`).catch(() => {});
  await Promise.all(open.map((c) => c.end().catch(() => {})));
});

// ---------------------------------------------------------------------------
// Crowds

test("races, limits hold: 12 people accepting at once into a vault with one place left, exactly one joins", async () => {
  const v = await newVault(OWNER, "Races last place");
  const crowd = people.slice(0, 12);
  const tokens = [];
  for (const p of crowd) tokens.push(await invite(OWNER, v, p));
  // 1 member now; the tier allows 4: fill two places, leaving one.
  await sql("select test_support.add_member($1, $2, 'viewer', $3), test_support.add_member($1, $4, 'viewer', $3)", [v, people[20], OWNER, people[21]]);
  await sql("select private.set_vault_tier($1, 'races_tiny')", [v]);
  const conns = await Promise.all(crowd.map(() => connect()));
  const t0 = Date.now();
  const results = await Promise.all(crowd.map((p, i) => as(conns[i], p, "select public.accept_invite($1)::text as v", [tokens[i]])));
  await close(conns);
  log("accept crowd", codes(results), `${Date.now() - t0} ms`);
  assert.deepEqual(codes(results), { ok: 1, RLP01: 11 });
  assert.equal((await sql("select count(*)::int as n from public.vault_members where vault_id = $1", [v]))[0].n, 4);
  // The refused keep their invites: nothing was used up.
  assert.equal((await sql(`select count(*)::int as n from private.vault_invites where vault_id = $1 and accepted_at is null and revoked_at is null`, [v]))[0].n, 11);
});

test("races, limits hold: 12 different people redeeming one open link with 5 uses at once, exactly 5 join", async () => {
  const v = await newVault(OWNER, "Races open link");
  const crowd = people.slice(0, 12);
  const made = await as(db, OWNER, "select public.create_invite($1, null, 'viewer', 5) as t", [v]);
  assert.ok(made.ok, made.message);
  const token = made.rows[0].t;
  const conns = await Promise.all(crowd.map(() => connect()));
  const t0 = Date.now();
  const results = await Promise.all(crowd.map((p, i) => as(conns[i], p, "select public.accept_invite($1)::text as v", [token])));
  await close(conns);
  log("open-link crowd", codes(results), `${Date.now() - t0} ms`);
  assert.deepEqual(codes(results), { ok: 5, 55000: 7 });
  assert.equal((await sql("select count(*)::int as n from public.vault_members where vault_id = $1", [v]))[0].n, 6);
  const [row] = await sql(`select uses_count, max_uses, accepted_at is not null as exhausted from private.vault_invites where vault_id = $1 and email is null`, [v]);
  assert.deepEqual(row, { uses_count: 5, max_uses: 5, exhausted: true });
});

test("races, limits hold: 12 new vaults at once with one left on the plan, exactly the limit is reached", async () => {
  const who = people[22];
  await sql("select private.set_account_plan($1, 'races_small')", [who]);
  await newVault(who, "Races own 1");
  await newVault(who, "Races own 2");
  const conns = await Promise.all(Array.from({ length: 12 }, () => connect()));
  const results = await Promise.all(conns.map((c, i) => as(c, who, "select public.create_vault($1)::text as v", [`Races crowd ${i}`])));
  await close(conns);
  log("create_vault crowd", codes(results));
  assert.deepEqual(codes(results), { ok: 1, RLP01: 11 });
  assert.equal((await sql("select count(*)::int as n from public.vaults where created_by = $1", [who]))[0].n, 3);
});

test("races, limits hold: 16 writes at once racing the storage limit never pass it, and the counter equals a scan", async () => {
  const v = await newVault(OWNER, "Races storage");
  await sql("select private.set_vault_tier($1, 'races_tiny')", [v]); // 1000 bytes
  assert.ok((await as(db, OWNER, "select public.write_file($1, 'base.md', $2)", [v, "b".repeat(500)])).ok);
  const conns = await Promise.all(Array.from({ length: 16 }, () => connect()));
  const results = await Promise.all(conns.map((c, i) => as(c, OWNER, "select public.write_file($1, $2, $3)::text", [v, `w/${i}.md`, "w".repeat(100)])));
  await close(conns);
  log("storage crowd", codes(results));
  assert.deepEqual(codes(results), { ok: 5, RLP01: 11 });
  const { counter, scan } = await counted(v);
  assert.equal(Number(counter), 1000);
  assert.equal(counter, scan);
});

test("races, limits hold: writes, deletes and erasures at once on the same files keep the counter exact, with no deadlock", async () => {
  const v = await newVault(OWNER, "Races churn");
  const paths = ["a.md", "b.md", "c.md", "d.md"];
  for (const p of paths) assert.ok((await as(db, OWNER, "select public.write_file($1, $2, 'seed')", [v, p])).ok);
  const conns = await Promise.all(Array.from({ length: 12 }, () => connect()));
  const all = [];
  for (let round = 0; round < 8; round++) {
    all.push(
      ...(await Promise.all(
        conns.map((c, i) => {
          const p = paths[(i + round) % paths.length];
          if (i % 3 === 0) return as(c, OWNER, "select public.write_file($1, $2, $3)::text", [v, p, `r${round} `.repeat(1 + i)]);
          if (i % 3 === 1) return as(c, OWNER, "select public.delete_file($1, $2)::text", [v, p]);
          return as(c, OWNER, "select public.erase_file($1, $2)::text", [v, p]);
        }),
      )),
    );
  }
  await close(conns);
  const seen = codes(all);
  log("churn", seen);
  assert.equal(seen["40P01"], undefined, `deadlocks: ${seen["40P01"]}`);
  const { counter, scan } = await counted(v);
  assert.equal(counter, scan);
});

test("races, one wins: 12 connections write the same file from one base version, exactly one succeeds", async () => {
  const v = await newVault(OWNER, "Races compare and swap");
  const seed = await as(db, OWNER, "select public.write_file($1, 'swap.md', 'base') as v", [v]);
  assert.ok(seed.ok, seed.message);
  const base = seed.rows[0].v;
  const conns = await Promise.all(Array.from({ length: 12 }, () => connect()));
  const results = await Promise.all(
    conns.map((c, i) => as(c, OWNER, "select public.write_file($1, 'swap.md', $2, $3)::text", [v, `writer ${i}`, base])),
  );
  await close(conns);
  log("compare-and-swap crowd", codes(results));
  assert.deepEqual(codes(results), { ok: 1, RLF01: 11 });
  const winner = results.findIndex((r) => r.ok);
  const [row] = await sql(
    `select v.body from public.files f join public.file_versions v on v.id = f.current_version_id where f.vault_id = $1 and f.path = 'swap.md'`,
    [v],
  );
  assert.equal(row.body, `writer ${winner}`);
});

test("races, one wins: 12 connections claim the same free path at once, exactly one succeeds", async () => {
  const v = await newVault(OWNER, "Races claim path");
  const crowd = people.slice(0, 12);
  for (const p of crowd) await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, p, OWNER]);
  assert.ok((await as(db, OWNER, "select public.write_file($1, 'claimed.md', 'x')", [v])).ok);
  const conns = await Promise.all(crowd.map(() => connect()));
  const results = await Promise.all(
    crowd.map((p, i) => as(conns[i], p, "select o_secret from public.claim_path($1, 'claimed.md', $2)", [v, `racer ${i}`])),
  );
  await close(conns);
  log("claim crowd", codes(results));
  assert.deepEqual(codes(results), { ok: 1, RLC01: 11 });
  const [row] = await sql(`select fence from public.path_claims where vault_id = $1 and path = 'claimed.md'`, [v]);
  assert.equal(row.fence, 1);
});

// ---------------------------------------------------------------------------
// A work plan under a crowd (CL-3.3): claim_step's own update grants a step
// only when its stored count of unfinished blockers is 0. Thirty people work
// a 120-step layered plan at once, each trying any unfinished step, and walk
// away from a quarter of what they claim. Checked afterwards from the log
// (its seq is the order things committed in) and the steps' own timestamps,
// and while it runs, from single-statement snapshots of the stored counts.

// Same seed, same plan and the same choices per person, every run; only the
// interleaving varies, and no interleaving may break what's checked.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 8 layers of 15; each step after the first layer is blocked by 1 to 3 of
// the layer before, and sometimes one further back.
function layeredPlan(rand) {
  const key = (l, i) => `l${l}-s${String(i).padStart(2, "0")}`;
  const steps = [];
  for (let l = 0; l < 8; l++) {
    for (let i = 0; i < 15; i++) {
      const blocked_by = new Set();
      if (l > 0) {
        const n = 1 + Math.floor(rand() * 3);
        while (blocked_by.size < n) blocked_by.add(key(l - 1, Math.floor(rand() * 15)));
        if (l > 1 && rand() < 0.3) blocked_by.add(key(Math.floor(rand() * (l - 1)), Math.floor(rand() * 15)));
      }
      steps.push({ key: key(l, i), title: `Step ${l}.${i}`, blocked_by: [...blocked_by] });
    }
  }
  return steps;
}

test("races, work plan gate: 30 people working a 120-step plan at once, abandoning a quarter of their claims, never claim or finish a step before its blockers", async () => {
  const crowd = Array.from({ length: 30 }, (_, i) => uid(400 + i));
  await sql(`insert into auth.users (id, email) select u, 'races-' || right(u::text, 4) || '@example.test' from unnest($1::uuid[]) u
             on conflict (id) do nothing`, [crowd]);
  const v = await newVault(OWNER, "Races work plan crowd");
  for (const p of crowd) await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, p, OWNER]);
  // claim_step strikes whoever let a claim lapse (20261013220000), and this
  // crowd walks away on purpose: no lapse earns a cooldown here, so the
  // gate, not the cooldown, is what gets tested.
  const rule = await as(db, OWNER, "select public.set_claim_rule($1, '', 2880, 10080, null, 1, 5, null, null, null, 1000000)", [v]);
  assert.ok(rule.ok, rule.message);
  const seededFile = await as(db, OWNER, "select public.write_file($1, 'plan.md', 'plan') as v", [v]);
  assert.ok(seededFile.ok, seededFile.message);
  const steps = layeredPlan(seeded(72));
  const reg = await as(db, OWNER, "select public.register_work_plan($1, 'plan.md', $2, $3::jsonb)::text as id", [v, seededFile.rows[0].v, JSON.stringify(steps)]);
  assert.ok(reg.ok, reg.message);
  const plan = reg.rows[0].id;

  // Every stored count equals the real number of unfinished blockers, in one
  // snapshot (complete_step changes a step and its dependents' counts in one
  // transaction).
  const miscounted = async (c) =>
    (await c.query(
      `select s.key, s.open_blockers as stored,
              (select count(*)::int from public.work_plan_step_blockers d join public.work_plan_steps b on b.id = d.blocker_id
                where d.step_id = s.id and b.status <> 'done') as real
         from public.work_plan_steps s where s.plan_id = $1
        order by s.key`, [plan])).rows.filter((r) => r.stored !== r.real);

  const remaining = new Set(steps.map((s) => s.key));
  const refusals = {};
  const unexpected = [];
  const stale = [];
  let abandoned = 0;
  const work = async (c, who, rand) => {
    for (let tries = 0; remaining.size > 0; tries++) {
      if (tries > 3000) throw new Error(`${who} gave up with ${remaining.size} steps unfinished`);
      const keys = [...remaining];
      const key = keys[Math.floor(rand() * keys.length)];
      const cl = await as(c, who, "select o_fence, o_secret from public.claim_step($1, 'plan.md', $2)", [v, key]);
      if (!cl.ok) {
        refusals[cl.code] = (refusals[cl.code] ?? 0) + 1;
        if (cl.code !== "RLW01" && cl.code !== "RLW02") unexpected.push(`claim ${key}: ${cl.code} ${cl.message}`);
        continue;
      }
      const { o_fence: fence, o_secret: secret } = cl.rows[0];
      const complete = () => as(c, who, "select public.complete_step($1, 'plan.md', $2, $3, $4)::text", [v, key, fence, secret]);
      if (abandoned === 0 || rand() < 0.25) {
        // Walked away: the lease lapses (the clock moved for this claim
        // alone), and coming back late to finish it is refused. The first
        // claim of the run always is, whatever the interleaving.
        abandoned++;
        await c.query("update public.work_plan_steps set expires_at = clock_timestamp() where plan_id = $1 and key = $2 and fence = $3", [plan, key, fence]);
        stale.push(outcome(await complete()));
        continue;
      }
      const done = await complete();
      if (done.ok) remaining.delete(key);
      else unexpected.push(`complete ${key}: ${done.code} ${done.message}`);
    }
  };

  const watcher = await connect();
  const conns = await Promise.all(crowd.map(() => connect()));
  // The crowd's first attempts, all at once before anything is done, are
  // at steps of the last layer: every one is refused at the gate.
  const opening = await Promise.all(crowd.map((p, i) =>
    as(conns[i], p, "select o_fence from public.claim_step($1, 'plan.md', $2)", [v, steps[105 + (i % 15)].key])));
  const t0 = Date.now();
  const running = Promise.all(crowd.map((p, i) => work(conns[i], p, seeded(1000 + i))));
  let snapshots = 0;
  const seenMiscounted = [];
  let finished = false;
  running.finally(() => (finished = true)).catch(() => {});
  while (!finished) {
    seenMiscounted.push(...(await miscounted(watcher)));
    snapshots++;
  }
  await running;
  await close(watcher, conns);
  log("work plan crowd", { ms: Date.now() - t0, refusals, abandoned, snapshots });

  assert.deepEqual(unexpected, []);
  assert.deepEqual(seenMiscounted, [], "a stored open_blockers count disagreed with the real one while the crowd ran");
  assert.deepEqual(await miscounted(db), []);

  // From the log, in commit order, and from the steps' own timestamps.
  const violations = await sql(
    `with st as (select id, key, claimed_at, done_at from public.work_plan_steps where plan_id = $2),
          edge as (select s.key as step, b.key as blocker, s.claimed_at, s.done_at, b.done_at as blocker_done
                     from public.work_plan_step_blockers d join st s on s.id = d.step_id join st b on b.id = d.blocker_id),
          ev as (select seq, event, detail->>'step' as key from public.log
                  where vault_id = $1 and event in ('step.claim', 'step.complete'))
     select 'claimed before its blocker was done (log)' as what, e.step, e.blocker
       from edge e join ev c on c.event = 'step.claim' and c.key = e.step
      where not exists (select 1 from ev x where x.event = 'step.complete' and x.key = e.blocker and x.seq < c.seq)
     union all
     select 'done before its blocker was done (log)', e.step, e.blocker
       from edge e join ev c on c.event = 'step.complete' and c.key = e.step
      where not exists (select 1 from ev x where x.event = 'step.complete' and x.key = e.blocker and x.seq < c.seq)
     union all
     select 'claimed before its blocker was done (timestamps)', step, blocker from edge where claimed_at < blocker_done
     union all
     select 'done before its blocker was done (timestamps)', step, blocker from edge where done_at < blocker_done
     order by 1, 2, 3`,
    [v, plan],
  );
  assert.deepEqual(violations.slice(0, 10), [], `${violations.length} gate violations`);

  // Every step finished once; every abandoned claim was claimed again; no
  // late completion counted.
  const [tally] = await sql(
    `select count(*) filter (where s.status = 'done' and s.done_at is not null)::int as done,
            (select count(*)::int from public.log where vault_id = $1 and event = 'step.complete') as completions,
            (select count(*)::int from public.log where vault_id = $1 and event = 'step.claim') as claims,
            sum(s.fence)::int as fences
       from public.work_plan_steps s where s.plan_id = $2`,
    [v, plan],
  );
  assert.deepEqual(tally, { done: 120, completions: 120, claims: 120 + abandoned, fences: 120 + abandoned });
  assert.ok(abandoned > 0, "no claim was abandoned");
  assert.deepEqual([...new Set(stale)], ["RLW03"]);
  assert.deepEqual([...new Set(opening.map((r) => r.code))], ["RLW02"], "a claim got past the blocker gate");
});

// ---------------------------------------------------------------------------
// Forced interleavings

// Runs `first` until it stops at the barrier, then `second` until it is
// blocked (or done), then lets `first` go. Returns both results.
async function interleave(first, second) {
  const barrier = await holdBarrier();
  const [c1, c2] = [await connect(), await connect()];
  const a = first(c1);
  await blocked(c1, { advisory: true, done: a });
  const b = second(c2);
  const bState = await blocked(c2, { done: b });
  await barrier.release();
  const [ra, rb] = await Promise.all([a, b]);
  await close(c1, c2);
  return [ra, rb, bState];
}

// As interleave, but the test holds the vault's row (FOR KEY SHARE), so
// `first` and then `second` queue on it, in that order, before either takes
// anything else.
async function queueOnVault(vault, first, second) {
  const hold = await connect();
  await hold.query("begin");
  await hold.query("select 1 from public.vaults where id = $1 for key share", [vault]);
  const [c1, c2] = [await connect(), await connect()];
  const a = first(c1);
  await blocked(c1, { done: a });
  const b = second(c2);
  await blocked(c2, { done: b });
  await hold.query("commit");
  const r = await Promise.all([a, b]);
  await close(hold, c1, c2);
  return r;
}

const outcome = (x) => (x.ok ? "ok" : x.code);

test("races, lock order: a write and an erasure of the same file, interleaved, don't deadlock", async () => {
  const v = await newVault(OWNER, "Races write erase");
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    assert.ok((await as(db, OWNER, "select public.write_file($1, 'x.md', 'first')", [v])).ok);
    // The write holds x.md's row and stops before its version counts.
    const [w, e, eState] = await interleave(
      (c) => as(c, OWNER, "select public.write_file($1, 'x.md', 'second')::text", [v], "files"),
      (c) => as(c, OWNER, "select public.erase_file($1, 'x.md')::text", [v]),
    );
    outcomes.push(`${outcome(w)}/${outcome(e)} (${eState})`);
  }
  log("write vs erase", outcomes);
  assert.deepEqual(outcomes, ["ok/ok (blocked)", "ok/ok (blocked)", "ok/ok (blocked)"]);
  const { counter, scan } = await counted(v);
  assert.equal(counter, scan);
});

test("races, lock order: a stale write and an erasure of the same file, interleaved, don't deadlock", async () => {
  const v = await newVault(OWNER, "Races stale write erase");
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const seeded = await as(db, OWNER, "select public.write_file($1, 'x.md', 'first') as v", [v]);
    assert.ok(seeded.ok, seeded.message);
    const stale = seeded.rows[0].v;
    // A second write moves the file past the version the racing write
    // holds, so it's already stale before the erasure ever starts.
    assert.ok((await as(db, OWNER, "select public.write_file($1, 'x.md', 'second')", [v])).ok);
    // The erasure holds x.md's row and stops before it commits; the stale
    // write's own version check queues on the same row.
    const [e, w, wState] = await interleave(
      (c) => as(c, OWNER, "select public.erase_file($1, 'x.md')::text", [v], "files"),
      (c) => as(c, OWNER, "select public.write_file($1, 'x.md', 'stale', $2)::text", [v, stale]),
    );
    outcomes.push(`${outcome(e)}/${outcome(w)} (${wState})`);
  }
  log("stale write vs erase", outcomes);
  assert.deepEqual(outcomes, ["ok/RLF01 (blocked)", "ok/RLF01 (blocked)", "ok/RLF01 (blocked)"]);
  const { counter, scan } = await counted(v);
  assert.equal(counter, scan);
});

// A vault where canon/ needs one approval, with the given canon files
// already written, and two editors to propose.
async function canonVault(name, paths) {
  const v = await newVault(OWNER, name);
  for (const p of people.slice(0, 2)) await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, p, OWNER]);
  for (const path of paths) assert.ok((await as(db, OWNER, "select public.write_file($1, $2, 'base')", [v, path])).ok);
  assert.ok((await as(db, OWNER, "select public.set_policy($1, 'canon/', 'canon', 1)", [v])).ok);
  return v;
}
async function propose(v, by, path, body) {
  const r = await as(db, by, "select public.propose($1, $2, $3, 'race') as id", [v, path, body]);
  assert.ok(r.ok, r.message);
  return r.rows[0].id;
}
const decided = (x) => (x.ok ? x.rows[0].r : x.code);

test("races, one wins: two proposals for the same file approved at once, interleaved, one applies and the other goes stale", async () => {
  const v = await canonVault("Races two approvals", ["canon/old.md"]);
  const outcomes = [];
  // A file both proposals change, then one neither proposal's file exists yet.
  for (const path of ["canon/old.md", "canon/new.md"]) {
    const first = await propose(v, people[0], path, "first");
    const second = await propose(v, people[1], path, "second");
    // The first approval has written the file and stops before it commits.
    const [a, b, bState] = await interleave(
      (c) => as(c, OWNER, "select public.decide($1, 'approve') as r", [first], "files"),
      (c) => as(c, OWNER, "select public.decide($1, 'approve') as r", [second]),
    );
    outcomes.push(`${decided(a)}/${decided(b)} (${bState})`);
    const [row] = await sql(
      `select v.body from public.files f join public.file_versions v on v.id = f.current_version_id where f.vault_id = $1 and f.path = $2`,
      [v, path],
    );
    assert.equal(row.body, "first", path);
  }
  log("approve vs approve", outcomes);
  assert.deepEqual(outcomes, ["applied/stale (blocked)", "applied/stale (blocked)"]);
});

test("races, lock order: a final approval and an erasure of its file, interleaved, don't deadlock", async () => {
  const approvals = [
    ["canon/approve.md", "select public.decide($1, 'approve') as r"],
    ["canon/edit.md", "select public.edit_and_approve($1, 'edited') as r"],
  ];
  const v = await canonVault("Races approve erase", approvals.map(([path]) => path));
  const outcomes = [];
  for (const [path, approve] of approvals) {
    const pid = await propose(v, people[0], path, "second");
    // The approval stops at its first log row, holding what it has locked.
    const [d, e, eState] = await interleave(
      (c) => as(c, OWNER, approve, [pid], "log"),
      (c) => as(c, OWNER, "select public.erase_file($1, $2)::text", [v, path]),
    );
    outcomes.push(`${decided(d)}/${outcome(e)} (${eState})`);
  }
  log("approve vs erase", outcomes);
  assert.deepEqual(outcomes, ["applied/ok (blocked)", "applied/ok (blocked)"]);
  const { counter, scan } = await counted(v);
  assert.equal(counter, scan);
});

test("races, lock order: accepting an invite while its owner re-invites the same address, interleaved, doesn't deadlock", async () => {
  const v = await newVault(OWNER, "Races reinvite");
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const who = people[round];
    const token = await invite(OWNER, v, who);
    // Both queue on the vault's row: the re-invite first, then the
    // acceptance (which, taking the invite first, would hold it while it
    // waits).
    const [ri, ac] = await queueOnVault(
      v,
      (c) => as(c, OWNER, "select public.create_invite($1, $2, 'editor') as t", [v, email(who)]),
      (c) => as(c, who, "select public.accept_invite($1)::text", [token]),
    );
    outcomes.push(`${outcome(ri)}/${outcome(ac)}`);
    // The re-invite went first: the first link was withdrawn.
    if (!ac.ok) assert.match(ac.message, /this invite was withdrawn/);
  }
  log("reinvite vs accept", outcomes);
  assert.deepEqual(outcomes, ["ok/55000", "ok/55000", "ok/55000"]);
});

test("races, lock order: accepting an invite while the vault is deleted, interleaved, doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const who = people[3 + round];
    const v = await newVault(OWNER, `Races doomed ${round}`);
    const token = await invite(OWNER, v, who);
    const [d, a] = await queueOnVault(
      v,
      (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, `Races doomed ${round}`]),
      (c) => as(c, who, "select public.accept_invite($1)::text", [token]),
    );
    outcomes.push(`${outcome(d)}/${outcome(a)}`);
    // The deletion went first: the invite went with the vault.
    if (!a.ok) assert.match(a.message, /not valid/);
  }
  log("delete vs accept", outcomes);
  assert.deepEqual(outcomes, ["ok/P0002", "ok/P0002", "ok/P0002"]);
});

test("races, lock order: applying an import while a variable in it is rotated, interleaved, doesn't deadlock", async () => {
  const v = await newVault(OWNER, "Races import");
  const sealed = (n) => ({ key_id: "k1", nonce: Buffer.alloc(12).toString("base64"), ciphertext: Buffer.alloc(n, 0xab).toString("base64") });
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const name = `RACE_${round}`;
    assert.ok((await as(db, OWNER, "select public.set_variable($1, $2, 'development', 'k1', $3, $4)",
      [v, name, Buffer.alloc(12), Buffer.alloc(32, 1)])).ok);
    const made = await as(db, OWNER, "select public.create_env_import($1, array['development'], $2::jsonb) as r",
      [v, JSON.stringify([{ name, environment: "development", ...sealed(40) }, { name: `${name}_NEW`, environment: "development", ...sealed(40) }])]);
    assert.ok(made.ok && made.rows[0].r.ok, JSON.stringify(made));
    const imp = made.rows[0].r.import ?? made.rows[0].r.id;
    // The import takes its values out (the counter's row) and stops before
    // writing them as variables.
    const [ap, ro] = await interleave(
      (c) => as(c, OWNER, "select public.apply_env_import($1)::text as r", [imp], "import_secrets"),
      (c) => as(c, OWNER, "select public.set_variable($1, $2, 'development', 'k1', $3, $4)", [v, name, Buffer.alloc(12), Buffer.alloc(48, 2)]),
    );
    outcomes.push(`${outcome(ap)}/${outcome(ro)}`);
  }
  log("import vs rotate", outcomes);
  assert.deepEqual(outcomes, ["ok/ok", "ok/ok", "ok/ok"]);
  const { counter, scan } = await counted(v);
  assert.equal(counter, scan);
});

test("races, lock order: deleting a vault while a file in it is being written doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const name = `Races delete write ${round}`;
    const v = await newVault(OWNER, name);
    assert.ok((await as(db, OWNER, "select public.write_file($1, 'x.md', 'first')", [v])).ok);
    const [wr, de] = await interleave(
      (c) => as(c, OWNER, "select public.write_file($1, 'x.md', 'second')::text", [v], "files"),
      (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name]),
    );
    outcomes.push(`${outcome(wr)}/${outcome(de)}`);
    assert.equal((await sql("select count(*)::int as n from public.vaults where id = $1", [v]))[0].n, de.ok ? 0 : 1);
    assert.equal((await sql("select count(*)::int as n from private.vault_storage where vault_id = $1", [v]))[0].n, de.ok ? 0 : 1);
  }
  log("write vs delete_vault", outcomes);
  assert.deepEqual(outcomes, ["ok/ok", "ok/ok", "ok/ok"]);
});

test("races, lock order: deleting a vault while a variable in it is being rotated doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const name = `Races delete rotate ${round}`;
    const v = await newVault(OWNER, name);
    const setv = (c, n, stop) =>
      as(c, OWNER, "select public.set_variable($1, 'TOKEN', 'development', 'k1', $2, $3)", [v, Buffer.alloc(12), Buffer.alloc(n, 3)], stop);
    assert.ok((await setv(db, 32)).ok);
    const [ro, de] = await interleave(
      (c) => setv(c, 48, "values"),
      (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name]),
    );
    outcomes.push(`${outcome(ro)}/${outcome(de)}`);
  }
  log("rotate vs delete_vault", outcomes);
  assert.deepEqual(outcomes, ["ok/ok", "ok/ok", "ok/ok"]);
});

// CL-2.2: claim_path's insert, when it re-grants an expired path, takes the
// path_claims row then (its holder changing) a FOR KEY SHARE lock on the
// vault_members row through the foreign key check. delete_vault cascades
// the opposite way, vault_members then (through path_claims' own foreign
// key) any claim. 20260930210000_claims_lock_order.sql makes delete_vault
// delete path_claims itself, first, in the same fixed-order block as
// files and variable values, before either lock order can interleave.

test("races, lock order: renewing a claim while its vault is deleted, interleaved, doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const name = `Races delete renew ${round}`;
    const v = await newVault(OWNER, name);
    const who = people[round];
    await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, who, OWNER]);
    const claimed = await as(db, who, "select o_fence, o_secret from public.claim_path($1, 'x.md', 'holder')", [v]);
    assert.ok(claimed.ok, claimed.message);
    const { o_fence: fence, o_secret: secret } = claimed.rows[0];
    // The renewal holds x.md's claim and stops before it commits.
    const [re, de] = await interleave(
      (c) => as(c, who, "select public.renew_claim($1, 'x.md', $2, $3)::text", [v, fence, secret], "path_claims"),
      (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name]),
    );
    outcomes.push(`${outcome(re)}/${outcome(de)}`);
  }
  log("renew vs delete_vault", outcomes);
  assert.deepEqual(outcomes, ["ok/ok", "ok/ok", "ok/ok"]);
});

test("races, lock order: deleting a vault while a claim in it is renewed, interleaved, doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const name = `Races delete renew reverse ${round}`;
    const v = await newVault(OWNER, name);
    const who = people[3 + round];
    await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, who, OWNER]);
    const claimed = await as(db, who, "select o_fence, o_secret from public.claim_path($1, 'x.md', 'holder')", [v]);
    assert.ok(claimed.ok, claimed.message);
    const { o_fence: fence, o_secret: secret } = claimed.rows[0];
    // The deletion deletes x.md's claim and stops before it commits the
    // rest; the renewal's own row lookup queues on the same row.
    const [de, re] = await interleave(
      (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name], "path_claims"),
      (c) => as(c, who, "select public.renew_claim($1, 'x.md', $2, $3)::text", [v, fence, secret]),
    );
    outcomes.push(`${outcome(de)}/${outcome(re)}`);
  }
  log("delete_vault vs renew", outcomes);
  assert.deepEqual(outcomes, ["ok/P0002", "ok/P0002", "ok/P0002"]);
});

// erase_file only ever touches path_claims through a holder-clearing
// update (no foreign key re-check: MATCH SIMPLE skips it when a column
// goes null), so it never takes the vault_members lock delete_vault's
// cascade does. These two prove the single shared row just queues.

test("races, lock order: erasing a file while a new claimant races in, interleaved, doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const v = await newVault(OWNER, `Races erase claim race ${round}`);
    const holder = people[6 + round];
    const racer = people[9 + round];
    await sql("select test_support.add_member($1, $2, 'editor', $3), test_support.add_member($1, $4, 'editor', $3)", [v, holder, OWNER, racer]);
    assert.ok((await as(db, OWNER, "select public.write_file($1, 'x.md', 'seed')", [v])).ok);
    const claimed = await as(db, holder, "select o_fence from public.claim_path($1, 'x.md', 'holder')", [v]);
    assert.ok(claimed.ok, claimed.message);
    // The erasure clears the existing claim and stops before it commits.
    const [er, cl] = await interleave(
      (c) => as(c, OWNER, "select public.erase_file($1, 'x.md')::text", [v], "path_claims"),
      (c) => as(c, racer, "select o_fence from public.claim_path($1, 'x.md', 'racer')", [v]),
    );
    outcomes.push(`${outcome(er)}/${outcome(cl)}`);
    if (cl.ok) assert.equal(cl.rows[0].o_fence, claimed.rows[0].o_fence + 1);
  }
  log("erase vs new claimant", outcomes);
  assert.deepEqual(outcomes, ["ok/ok", "ok/ok", "ok/ok"]);
});

test("races, lock order: a claim is renewed while the file at its path is erased, interleaved, doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const v = await newVault(OWNER, `Races renew erase ${round}`);
    const who = people[12 + round];
    await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, who, OWNER]);
    assert.ok((await as(db, OWNER, "select public.write_file($1, 'x.md', 'seed')", [v])).ok);
    const claimed = await as(db, who, "select o_fence, o_secret from public.claim_path($1, 'x.md', 'holder')", [v]);
    assert.ok(claimed.ok, claimed.message);
    const { o_fence: fence, o_secret: secret } = claimed.rows[0];
    // The renewal holds x.md's claim (unchanged holder) and stops before
    // it commits; the erasure's own clearing update queues on the row.
    const [re, er] = await interleave(
      (c) => as(c, who, "select public.renew_claim($1, 'x.md', $2, $3)::text", [v, fence, secret], "path_claims"),
      (c) => as(c, OWNER, "select public.erase_file($1, 'x.md')::text", [v]),
    );
    outcomes.push(`${outcome(re)}/${outcome(er)}`);
  }
  log("renew vs erase", outcomes);
  assert.deepEqual(outcomes, ["ok/ok", "ok/ok", "ok/ok"]);
});

// Threads (20261004110000_thread_writes.sql): post_message takes the
// vault's row (for key share) before its thread's, the order delete_vault
// takes them in (the vault's row, then through the cascade the thread's).
// The other way round, a post holding its thread's row and then needing
// the vault's (the log's foreign key) deadlocked against a deletion that
// held the vault's row and then needed the thread's.

test("races, lock order: deleting a vault while a message is posted in it, interleaved, doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const name = `Races delete thread ${round}`;
    const v = await newVault(OWNER, name);
    const who = people[15 + round];
    await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, who, OWNER]);
    const opened = await as(db, who, "select public.open_thread($1, 'Plan', 'first') as id", [v]);
    assert.ok(opened.ok, opened.message);
    const thread = opened.rows[0].id;
    // The deletion holds the vault's row and stops before its cascade.
    const [de, po] = await interleave(
      (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name], "vault_deletions"),
      (c) => as(c, who, "select public.post_message($1, 'second')::text", [thread]),
    );
    outcomes.push(`${outcome(de)}/${outcome(po)}`);
  }
  log("delete_vault vs post", outcomes);
  assert.deepEqual(outcomes, ["ok/P0002", "ok/P0002", "ok/P0002"]);
});

test("races, lock order: a message is posted while its vault is deleted, interleaved, doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const name = `Races post delete ${round}`;
    const v = await newVault(OWNER, name);
    const who = people[18 + round];
    await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, who, OWNER]);
    const opened = await as(db, who, "select public.open_thread($1, 'Plan', 'first') as id", [v]);
    assert.ok(opened.ok, opened.message);
    const thread = opened.rows[0].id;
    // The post holds the vault's row and its thread's, and stops after
    // writing the message, before logging it.
    const [po, de] = await interleave(
      (c) => as(c, who, "select public.post_message($1, 'second')::text", [thread], "thread_messages"),
      (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name]),
    );
    outcomes.push(`${outcome(po)}/${outcome(de)}`);
    assert.equal((await sql("select count(*)::int as n from public.threads where vault_id = $1", [v]))[0].n, 0);
  }
  log("post vs delete_vault", outcomes);
  assert.deepEqual(outcomes, ["ok/ok", "ok/ok", "ok/ok"]);
});

// Work plans (20261002200000_work_plans.sql): claim_step's update sets the
// step's holder, so its foreign key check takes a FOR KEY SHARE lock on the
// holder's vault_members row while it holds the step's row, and its log row
// then needs the vault's. delete_vault takes the vault's row, then deletes
// the vault's members and, through both foreign keys, its steps. complete_step
// holds the step and its dependents, then needs the vault's row for its log.

// A vault with a two-step plan (a, then b) and an editor to work it.
async function planVault(name, who) {
  const v = await newVault(OWNER, name);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, who, OWNER]);
  const seeded = await as(db, OWNER, "select public.write_file($1, 'plan.md', 'plan') as v", [v]);
  assert.ok(seeded.ok, seeded.message);
  const steps = [{ key: "a", title: "A" }, { key: "b", title: "B", blocked_by: ["a"] }];
  const r = await as(db, OWNER, "select public.register_work_plan($1, 'plan.md', $2, $3::jsonb)", [v, seeded.rows[0].v, JSON.stringify(steps)]);
  assert.ok(r.ok, r.message);
  return v;
}
const claimA = (c, v, who, stop) => as(c, who, "select o_fence, o_secret from public.claim_step($1, 'plan.md', 'a')", [v], stop);

test("races, lock order: claiming a step while its vault is deleted, interleaved, doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const name = `Races delete claim step ${round}`;
    const who = people[round];
    const v = await planVault(name, who);
    // The deletion holds the vault's row and stops before its cascade.
    const [de, cl] = await interleave(
      (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name], "vault_deletions"),
      (c) => claimA(c, v, who),
    );
    outcomes.push(`${outcome(de)}/${outcome(cl)}`);
  }
  log("delete_vault vs claim_step", outcomes);
  assert.deepEqual(outcomes, ["ok/P0002", "ok/P0002", "ok/P0002"]);
});

test("races, lock order: a step is claimed while its vault is deleted, interleaved, doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const name = `Races claim step delete ${round}`;
    const who = people[3 + round];
    const v = await planVault(name, who);
    // The claim holds the step's row and its holder's membership, and stops
    // before logging.
    const [cl, de] = await interleave(
      (c) => claimA(c, v, who, "work_plan_steps"),
      (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name]),
    );
    const [{ n }] = await sql("select count(*)::int as n from public.work_plan_steps where vault_id = $1", [v]);
    outcomes.push(`${outcome(cl)}/${outcome(de)} (${n} steps left)`);
  }
  log("claim_step vs delete_vault", outcomes);
  assert.deepEqual(outcomes, ["ok/ok (0 steps left)", "ok/ok (0 steps left)", "ok/ok (0 steps left)"]);
});

test("races, lock order: a step is completed while its vault is deleted, interleaved, doesn't deadlock", async () => {
  const outcomes = [];
  for (let round = 0; round < 3; round++) {
    const name = `Races complete step delete ${round}`;
    const who = people[6 + round];
    const v = await planVault(name, who);
    const claimed = await claimA(db, v, who);
    assert.ok(claimed.ok, claimed.message);
    const { o_fence: fence, o_secret: secret } = claimed.rows[0];
    // The completion holds the step's row and its dependent's, and stops
    // before logging.
    const [co, de] = await interleave(
      (c) => as(c, who, "select public.complete_step($1, 'plan.md', 'a', $2, $3)::text", [v, fence, secret], "work_plan_steps"),
      (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name]),
    );
    outcomes.push(`${outcome(co)}/${outcome(de)}`);
  }
  log("complete_step vs delete_vault", outcomes);
  assert.deepEqual(outcomes, ["ok/ok", "ok/ok", "ok/ok"]);
});

// A plan gaining a step (20261013160000_work_plan_gains_steps.sql) while a
// step it will wait on is completed. complete_step holds a and then locks
// its dependent b; the new step n waits on both, so adding it checks both
// rows, in whichever order its blockers come. Both orders are run.
test("races, a plan gains a step: a step completed while a new step waiting on it and its dependent is added doesn't deadlock, and the new step's count is right", async () => {
  const outcomes = [];
  for (const [round, order] of [["a", "b"], ["b", "a"], ["a", "b"], ["b", "a"]].entries()) {
    const name = `Races plan gains step ${round}`;
    const who = people[9 + round];
    const v = await planVault(name, who);
    const claimed = await claimA(db, v, who);
    assert.ok(claimed.ok, claimed.message);
    const { o_fence: fence, o_secret: secret } = claimed.rows[0];
    const next = await as(db, OWNER, "select public.write_file($1, 'plan.md', 'plan, more') as v", [v]);
    assert.ok(next.ok, next.message);
    const steps = [{ key: "a", title: "A" }, { key: "b", title: "B", blocked_by: ["a"] }, { key: "n", title: "N", blocked_by: order }];
    // The completion holds a, and stops before it locks b.
    const [co, re] = await interleave(
      (c) => as(c, who, "select public.complete_step($1, 'plan.md', 'a', $2, $3)::text", [v, fence, secret], "work_plan_steps"),
      (c) => as(c, OWNER, "select public.register_work_plan($1, 'plan.md', $2, $3::jsonb)::text", [v, next.rows[0].v, JSON.stringify(steps)]),
    );
    const [n] = await sql(
      `select s.open_blockers as stored,
              (select count(*)::int from public.work_plan_step_blockers d join public.work_plan_steps b on b.id = d.blocker_id
                where d.step_id = s.id and b.status <> 'done') as real
         from public.work_plan_steps s join public.work_plans p on p.id = s.plan_id
        where p.vault_id = $1 and s.key = 'n'`,
      [v],
    );
    outcomes.push(`${outcome(co)}/${outcome(re)} n ${n?.stored}/${n?.real}`);
  }
  log("complete_step vs register_work_plan", outcomes);
  assert.deepEqual(outcomes, Array(4).fill("ok/ok n 1/1"));
});

// Review gates (20261013233000_review_gate.sql): a proposal applied
// approves the steps linked to it, from a trigger inside decide(), so
// decide now reaches step rows, and approve_step is a new way in. The lock
// order the migration relies on: the proposal's row, then the plan's shared
// advisory lock, then steps in id order, with the vault's row last (for the
// log). Each pair runs in both orders and must end without 40P01, with every
// stored count of unfinished blockers matching the plan.

// A vault with canon/ under review and a plan of `steps`; `who` (an editor)
// holds the plan's gated step g. Returns its fence and secret.
async function gateVault(name, who, steps) {
  const v = await newVault(OWNER, name);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, who, OWNER]);
  assert.ok((await as(db, OWNER, "select public.set_policy($1, 'canon/', 'canon', 1)", [v])).ok);
  const seeded = await as(db, OWNER, "select public.write_file($1, 'plan.md', 'plan') as v", [v]);
  assert.ok(seeded.ok, seeded.message);
  const r = await as(db, OWNER, "select public.register_work_plan($1, 'plan.md', $2, $3::jsonb)", [v, seeded.rows[0].v, JSON.stringify(steps)]);
  assert.ok(r.ok, r.message);
  return v;
}
const claimStep = async (v, who, key) => {
  const r = await as(db, who, "select o_fence, o_secret from public.claim_step($1, 'plan.md', $2)", [v, key]);
  assert.ok(r.ok, r.message);
  return r.rows[0];
};
const completeSql = "select public.complete_step($1, 'plan.md', $2, $3, $4, $5)::text";
const stepStates = async (v) =>
  Object.fromEntries((await sql(
    `select s.key, s.status from public.work_plan_steps s join public.work_plans p on p.id = s.plan_id where p.vault_id = $1 order by s.id`,
    [v],
  )).map((r) => [r.key, r.status]));
// Every step of the vault whose stored count of unfinished blockers is wrong.
const miscounted = async (v) =>
  (await sql(
    `select s.key from public.work_plan_steps s
      where s.vault_id = $1
        and s.open_blockers <> (select count(*) from public.work_plan_step_blockers d join public.work_plan_steps b on b.id = d.blocker_id
                                 where d.step_id = s.id and b.status <> 'done')`,
    [v],
  )).map((r) => r.key);
const APPLY = {
  decide: "select public.decide($1, 'approve') as r",
  edit: "select public.edit_and_approve($1, 'edited') as r",
};

test("races, review gate: a proposal applied while a completion links it, either first, doesn't deadlock, and the step is approved only if the link came first", async () => {
  const outcomes = [];
  for (const [round, [how, first]] of [["decide", "apply"], ["decide", "complete"], ["edit", "apply"], ["edit", "complete"]].entries()) {
    const who = people[20];
    const v = await gateVault(`Races gate link ${round}`, who, [{ key: "g", title: "G", gate: "review" }, { key: "d", title: "D", blocked_by: ["g"] }]);
    const g = await claimStep(v, who, "g");
    const pid = await propose(v, who, "canon/g.md", "the work");
    const apply = (stop) => (c) => as(c, OWNER, APPLY[how], [pid], stop);
    const complete = (stop) => (c) => as(c, who, completeSql, [v, "g", g.o_fence, g.o_secret, pid], stop);
    // The application stops once it has written the file, holding the
    // proposal's row; the completion once it has stored the step, holding
    // its key share on the proposal and the step's row.
    const [a, b, waited] = first === "apply"
      ? await interleave(apply("files"), complete())
      : await interleave(complete("work_plan_steps"), apply());
    const [x, y] = first === "apply" ? [decided(a), outcome(b)] : [outcome(a), decided(b)];
    const s = await stepStates(v);
    outcomes.push(`${how} ${first} first: ${x}/${y} g ${s.g} d ${s.d} miscounted [${await miscounted(v)}] (${waited})`);
  }
  log("apply vs complete linking it", outcomes);
  assert.deepEqual(outcomes, [
    "decide apply first: applied/22023 g claimed d open miscounted [] (blocked)",
    "decide complete first: ok/applied g done d open miscounted [] (blocked)",
    "edit apply first: applied/22023 g claimed d open miscounted [] (blocked)",
    "edit complete first: ok/applied g done d open miscounted [] (blocked)",
  ]);
});

// g awaits review linked to a proposal; x is held; d waits on both.
async function gateAndHeld(name, who) {
  const v = await gateVault(name, who, [
    { key: "g", title: "G", gate: "review" },
    { key: "x", title: "X" },
    { key: "d", title: "D", blocked_by: ["g", "x"] },
  ]);
  const g = await claimStep(v, who, "g");
  const pid = await propose(v, who, "canon/g.md", "the work");
  const done = await as(db, who, completeSql, [v, "g", g.o_fence, g.o_secret, pid]);
  assert.ok(done.ok, done.message);
  return { v, pid, x: await claimStep(v, who, "x") };
}

// The first stops either at its own step ("own": holding that row and the
// plan's shared lock, before the dependent they share) or once its step
// event is logged ("dependent": holding the dependent too, so the second
// waits for it).
const ROUNDS = [["apply", "own"], ["apply", "dependent"], ["complete", "own"], ["complete", "dependent"]];
const STOP = { own: "work_plan_steps", dependent: "step_log" };

test("races, review gate: a proposal applied, approving its step, while another step waited on by the same step completes, either first, doesn't deadlock", async () => {
  const outcomes = [];
  for (const [round, [first, at]] of [...ROUNDS, ...ROUNDS].entries()) {
    const how = round < ROUNDS.length ? "decide" : "edit";
    const who = people[21];
    const { v, pid, x } = await gateAndHeld(`Races gate apply complete ${round}`, who);
    const apply = (stop) => (c) => as(c, OWNER, APPLY[how], [pid], stop);
    const complete = (stop) => (c) => as(c, who, completeSql, [v, "x", x.o_fence, x.o_secret, null], stop);
    const [a, b, waited] = first === "apply"
      ? await interleave(apply(STOP[at]), complete())
      : await interleave(complete(STOP[at]), apply());
    const [ap, co] = first === "apply" ? [decided(a), outcome(b)] : [decided(b), outcome(a)];
    const s = await stepStates(v);
    outcomes.push(`${how} ${first} first, stopped at ${at}: ${ap}/${co} g ${s.g} x ${s.x} d ${s.d} miscounted [${await miscounted(v)}] (${waited})`);
  }
  log("apply vs complete another", outcomes);
  assert.deepEqual(
    outcomes,
    ["decide", "edit"].flatMap((how) =>
      ROUNDS.map(([first, at]) => `${how} ${first} first, stopped at ${at}: applied/ok g done x done d open miscounted [] (${at === "own" ? "done" : "blocked"})`),
    ),
  );
});

test("races, review gate: a step approved while another step waited on by the same step completes, either first, doesn't deadlock", async () => {
  const outcomes = [];
  for (const [round, [first, at]] of ROUNDS.map(([f, a]) => [f === "apply" ? "approve" : f, a]).entries()) {
    const who = people[22];
    const { v, x } = await gateAndHeld(`Races gate approve complete ${round}`, who);
    const approve = (stop) => (c) => as(c, OWNER, "select public.approve_step($1, 'plan.md', 'g')::text", [v], stop);
    const complete = (stop) => (c) => as(c, who, completeSql, [v, "x", x.o_fence, x.o_secret, null], stop);
    const [a, b, waited] = first === "approve"
      ? await interleave(approve(STOP[at]), complete())
      : await interleave(complete(STOP[at]), approve());
    const s = await stepStates(v);
    outcomes.push(`${first} first, stopped at ${at}: ${outcome(a)}/${outcome(b)} g ${s.g} x ${s.x} d ${s.d} miscounted [${await miscounted(v)}] (${waited})`);
  }
  log("approve vs complete another", outcomes);
  assert.deepEqual(
    outcomes,
    ROUNDS.map(([f, at]) => `${f === "apply" ? "approve" : f} first, stopped at ${at}: ok/ok g done x done d open miscounted [] (${at === "own" ? "done" : "blocked"})`),
  );
});

test("races, review gate: a step approved while its vault is deleted, either first, doesn't deadlock", async () => {
  const outcomes = [];
  for (const [round, first] of ["approve", "delete", "approve", "delete"].entries()) {
    const who = people[23];
    const name = `Races gate approve delete ${round}`;
    const { v } = await gateAndHeld(name, who);
    const approve = (stop) => (c) => as(c, OWNER, "select public.approve_step($1, 'plan.md', 'g')::text", [v], stop);
    const del = (stop) => (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name], stop);
    // The approval stops once it has stored the step, holding its row; the
    // deletion once it holds the steps and the vault's row.
    const [a, b, waited] = first === "approve"
      ? await interleave(approve("work_plan_steps"), del())
      : await interleave(del("vault_deletions"), approve());
    const [{ n }] = await sql("select count(*)::int as n from public.work_plan_steps where vault_id = $1", [v]);
    outcomes.push(`${first} first: ${outcome(a)}/${outcome(b)} (${n} steps left) (${waited})`);
  }
  log("approve vs delete_vault", outcomes);
  assert.deepEqual(outcomes, [
    "approve first: ok/ok (0 steps left) (blocked)",
    "delete first: ok/RLW02 (0 steps left) (blocked)",
    "approve first: ok/ok (0 steps left) (blocked)",
    "delete first: ok/RLW02 (0 steps left) (blocked)",
  ]);
});

// ---------------------------------------------------------------------------
// The operator's changes wait for what they limit

test("races, the operator waits: a plan downgrade waits for a write in flight, so nothing checked against the old plan commits after it", async () => {
  const who = people[23];
  const v = await newVault(who, "Races downgrade");
  assert.ok((await as(db, who, "select public.write_file($1, 'base.md', $2)", [v, "b".repeat(900)])).ok);
  // The write is counted (1100 bytes, fine on Races roomy), then stops in
  // its log row before committing. The downgrade must wait for it.
  const [wr, down, downState] = await interleave(
    (c) => as(c, who, "select public.write_file($1, 'late.md', $2)::text", [v, "l".repeat(200)], "log"),
    (c) => c.query("select private.set_account_plan($1, 'races_small') as s", [who]).then((r) => ({ ok: true, rows: r.rows })),
  );
  log("downgrade:", downState, down.rows?.[0]?.s);
  assert.ok(wr.ok, wr.message);
  assert.equal(downState, "blocked", "the downgrade didn't wait for the write in flight");
  assert.equal(down.rows[0].s, "Races small plan: 1 of 3 vaults");
  const after = await as(db, who, "select public.write_file($1, 'one.md', 'x')::text", [v]);
  assert.equal(after.code, "RLP01");
  const { counter, scan } = await counted(v);
  assert.equal(Number(counter), 1100);
  assert.equal(counter, scan);
});

test("races, the operator waits: a tier change during an acceptance waits for it, and its summary counts the new member", async () => {
  const v = await newVault(OWNER, "Races tier accept");
  await sql("select test_support.add_member($1, $2, 'viewer', $3), test_support.add_member($1, $4, 'viewer', $3)", [v, people[18], OWNER, people[19]]);
  const who = people[17];
  const token = await invite(OWNER, v, who);
  // The acceptance checks the room (3 of 1000 on Races roomy), adds the
  // member and stops before committing.
  const [ac, tier, tierState] = await interleave(
    (c) => as(c, who, "select public.accept_invite($1)::text", [token], "members"),
    (c) => c.query("select private.set_vault_tier($1, 'races_three') as s", [v]).then((r) => ({ ok: true, rows: r.rows })),
  );
  assert.ok(ac.ok, ac.message);
  assert.equal(tierState, "blocked", "the tier change didn't wait for the acceptance in flight");
  assert.equal(tier.rows[0].s, "Races three: 4 of 3 people, 0 bytes of 1 MB (over: read-mostly until under)");
});

test("races, the operator waits: a tier change during a write waits for it, and its summary counts the write's bytes", async () => {
  const v = await newVault(OWNER, "Races tier write");
  assert.ok((await as(db, OWNER, "select public.write_file($1, 'base.md', $2)", [v, "b".repeat(100)])).ok);
  // The write is counted (300 bytes), then stops in its log row before
  // committing. The tier change must wait for it.
  const [wr, tier, tierState] = await interleave(
    (c) => as(c, OWNER, "select public.write_file($1, 'late.md', $2)::text", [v, "l".repeat(200)], "log"),
    (c) => c.query("select private.set_vault_tier($1, 'races_tiny') as s", [v]).then((r) => ({ ok: true, rows: r.rows })),
  );
  assert.ok(wr.ok, wr.message);
  assert.equal(tierState, "blocked", "the tier change didn't wait for the write in flight");
  assert.equal(tier.rows[0].s, "Races tiny: 1 of 4 people, 300 bytes of 1 KB");
});

// ---------------------------------------------------------------------------
// Answering an invite from the Inbox while its link is used
// (20260926140000_inbox_join.sql): the same invite, the same person, two
// tabs. Whichever goes first stops holding the vault's and the invite's
// rows; the other waits on them and is then refused, so the invite is used
// (or declined) once and the person joins at most once.

// An owner of their own: OWNER's invites an hour are spent above.
const INBOX_OWNER = uid(310);
const inboxPeople = [300, 301, 302, 303].map(uid);
const inviteId = async (token) =>
  (await sql("select id from private.vault_invites where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')", [token]))[0].id;

test("races, one wins: joining from the inbox and by the link at once, either first, uses the invite once", async () => {
  await sql(`insert into auth.users (id, email) select u, 'races-' || right(u::text, 4) || '@example.test' from unnest($1::uuid[]) u
             on conflict (id) do nothing`, [[INBOX_OWNER, ...inboxPeople]]);
  const v = await newVault(INBOX_OWNER, "Races inbox join");
  const outcomes = [];
  for (const [round, inboxFirst] of [[0, true], [1, false]]) {
    const who = inboxPeople[round];
    const token = await invite(INBOX_OWNER, v, who);
    const id = await inviteId(token);
    const byInbox = (c, stop) => as(c, who, "select public.accept_my_invite($1)::text", [id], stop);
    const byLink = (c, stop) => as(c, who, "select public.accept_invite($1)::text", [token], stop);
    // The first adds the member and stops before committing.
    const [a, b, bState] = inboxFirst
      ? await interleave((c) => byInbox(c, "members"), (c) => byLink(c))
      : await interleave((c) => byLink(c, "members"), (c) => byInbox(c));
    outcomes.push(`${outcome(a)}/${outcome(b)} (${bState})`);
    if (!b.ok) assert.match(b.message, /this invite has already been used/);
    const [{ members, used, logged }] = await sql(
      `select (select count(*)::int from public.vault_members where vault_id = $1 and user_id = $2) as members,
              (select count(*)::int from private.vault_invites where id = $3 and accepted_by = $2) as used,
              (select count(*)::int from public.log where vault_id = $1 and event = 'invite.accept' and actor = $2) as logged`,
      [v, who, id],
    );
    assert.deepEqual({ members, used, logged }, { members: 1, used: 1, logged: 1 });
  }
  log("inbox join vs link", outcomes);
  assert.deepEqual(outcomes, ["ok/55000 (blocked)", "ok/55000 (blocked)"]);
});

test("races, one wins: declining from the inbox while the link is accepted, either first, answers the invite once", async () => {
  await sql(`insert into auth.users (id, email) select u, 'races-' || right(u::text, 4) || '@example.test' from unnest($1::uuid[]) u
             on conflict (id) do nothing`, [[INBOX_OWNER, ...inboxPeople]]);
  const v = await newVault(INBOX_OWNER, "Races inbox decline");
  const outcomes = [];
  for (const [round, declineFirst] of [[2, true], [3, false]]) {
    const who = inboxPeople[round];
    const token = await invite(INBOX_OWNER, v, who);
    const id = await inviteId(token);
    // The decline stops at its log row; the link's acceptance at its member.
    const decline = (c, stop) => as(c, who, "select public.decline_my_invite($1)", [id], stop);
    const byLink = (c, stop) => as(c, who, "select public.accept_invite($1)::text", [token], stop);
    const [a, b, bState] = declineFirst
      ? await interleave((c) => decline(c, "log"), (c) => byLink(c))
      : await interleave((c) => byLink(c, "members"), (c) => decline(c));
    outcomes.push(`${outcome(a)}/${outcome(b)} (${bState})`);
    if (!b.ok) assert.match(b.message, declineFirst ? /you declined this invite/ : /this invite has already been used/);
    const [{ members }] = await sql("select count(*)::int as members from public.vault_members where vault_id = $1 and user_id = $2", [v, who]);
    assert.equal(members, declineFirst ? 0 : 1);
  }
  log("inbox decline vs link", outcomes);
  assert.deepEqual(outcomes, ["ok/55000 (blocked)", "ok/55000 (blocked)"]);
});

// ---------------------------------------------------------------------------
// Waiting in line (CL-3.9, 20261013170100_request_work.sql onwards)

// One transaction as a person through one of their connections (an access
// token), the way the MCP server acts: the token is the connection.
async function asTok(c, user, tok, q, params = [], stop) {
  await c.query("begin");
  try {
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: user, role: "authenticated", act: { sub: tok, name: "racer", tok } }),
    ]);
    if (stop) await c.query("select set_config('races.stop_on', $1, true)", [stop]);
    const r = await c.query(q, params);
    await c.query("commit");
    return { ok: true, rows: r.rows };
  } catch (e) {
    await c.query("rollback").catch(() => {});
    return { ok: false, code: e.code, message: e.message };
  }
}
async function tokenFor(user, vault, name) {
  const r = await as(db, user, "select public.create_access_token($1, 30, array[$2]::uuid[], 'write')", [name, vault]);
  assert.ok(r.ok, r.message);
  return (await sql("select id from public.access_tokens where user_id = $1 and name = $2", [user, name]))[0].id;
}
const requestWork = "select o_state, o_key, o_fence, o_secret, o_place, o_ready from public.request_work($1, 'plan.md')";
const placesIn = async (v) => (await sql("select count(*)::int as n from public.work_plan_places where vault_id = $1", [v]))[0].n;

// The stopping trigger on places (see the top of this file), made by the
// tests that stop there; after() drops it with the test_races schema.
const placesStop = () =>
  sql(`drop trigger if exists zz_races_stop on public.work_plan_places;
    create trigger zz_races_stop after insert or update or delete on public.work_plan_places
      for each statement execute function test_races.stop('work_plan_places');`);

// Holds a plan's ready steps outside the line (the owner's claims, written
// as the table owner, so no line or cap applies and nothing is logged).
// Whoever asks meanwhile is told to wait, so a crowd starts with all of it
// in line whatever the machine's speed; letGo makes those claims lapse, and
// the line hands the steps on.
const holdReady = async (plan) =>
  (await sql(`update public.work_plan_steps set status = 'claimed', fence = fence + 1, holder = $2,
                     claimed_at = clock_timestamp(), expires_at = clock_timestamp() + interval '1 hour'
               where plan_id = $1 and status = 'open' and open_blockers = 0 returning key`, [plan, OWNER])).map((r) => r.key);
const letGo = (plan, keys) =>
  sql("update public.work_plan_steps set expires_at = clock_timestamp() where plan_id = $1 and key = any($2::text[])", [plan, keys]);
// Runs every job, each connection taking its share one after another (a
// connection runs one transaction at a time).
const spread = async (conns, jobs, run) =>
  (await Promise.all(conns.map(async (c, i) => {
    const out = [];
    for (const job of jobs.filter((_, j) => j % conns.length === i)) out.push(await run(c, job));
    return out;
  }))).flat();
const statesOf = (results) => [...new Set(results.map((r) => (r.ok ? r.rows[0].o_state : r.code)))];

// Thirty people ask request_work for the steps of one 40-step plan at once
// (the first 40 steps of the layered plan above: its first two layers and
// part of the third, each blocked only by steps among them), all of them in
// line first (holdReady), so places past the ready count wait. A caller told
// to wait moves its own clock to its time and asks again; told to cool
// down, it moves the cooldown's end to now. With `abandon`, a quarter of
// the steps granted are walked away from (their lease made to lapse), so
// the line hands them on and the strikes and cooldowns run. Checked after,
// from the log (its seq is commit order) and the tables.
async function lineCrowd(name, abandon) {
  const crowd = Array.from({ length: 30 }, (_, i) => uid(500 + i));
  await sql(`insert into auth.users (id, email) select u, 'races-' || right(u::text, 4) || '@example.test' from unnest($1::uuid[]) u
             on conflict (id) do nothing`, [crowd]);
  const v = await newVault(OWNER, name);
  for (const p of crowd) await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, p, OWNER]);
  const seededFile = await as(db, OWNER, "select public.write_file($1, 'plan.md', 'plan') as v", [v]);
  assert.ok(seededFile.ok, seededFile.message);
  const steps = layeredPlan(seeded(74)).slice(0, 40);
  const reg = await as(db, OWNER, "select public.register_work_plan($1, 'plan.md', $2, $3::jsonb)::text as id", [v, seededFile.rows[0].v, JSON.stringify(steps)]);
  assert.ok(reg.ok, reg.message);
  const plan = reg.rows[0].id;

  const states = {};
  const unexpected = [];
  let abandoned = 0;
  const work = async (c, who, rand) => {
    for (let calls = 0; ; calls++) {
      if (calls > 5000) throw new Error(`${who} gave up after ${calls} calls`);
      const r = await as(c, who, requestWork, [v]);
      if (!r.ok) {
        unexpected.push(`request_work: ${r.code} ${r.message}`);
        continue;
      }
      const a = r.rows[0];
      states[a.o_state] = (states[a.o_state] ?? 0) + 1;
      if (a.o_state === "plan_complete") return;
      if (a.o_state === "wait") {
        await c.query("update public.work_plan_places set next_allowed_at = clock_timestamp() where plan_id = $1 and holder = $2", [plan, who]);
      } else if (a.o_state === "cooling_down") {
        await c.query("update private.work_plan_strikes set cooldown_until = clock_timestamp() where vault_id = $1 and person = $2", [v, who]);
      } else if (a.o_state === "granted") {
        // The first grant of the run is always walked away from, so the
        // hand-on is exercised whatever the interleaving; then a quarter.
        if (abandon && (abandoned === 0 || rand() < 0.25)) {
          abandoned++;
          await c.query("update public.work_plan_steps set expires_at = clock_timestamp() where plan_id = $1 and key = $2 and fence = $3", [plan, a.o_key, a.o_fence]);
          continue;
        }
        const done = await as(c, who, "select public.complete_step($1, 'plan.md', $2, $3, $4)::text", [v, a.o_key, a.o_fence, a.o_secret]);
        if (!done.ok) unexpected.push(`complete ${a.o_key}: ${done.code} ${done.message}`);
      } else {
        unexpected.push(`request_work answered ${a.o_state}`);
      }
    }
  };
  const conns = await Promise.all(crowd.map(() => connect()));
  const held = await holdReady(plan);
  const first = await Promise.all(crowd.map((p, i) => as(conns[i], p, requestWork, [v])));
  assert.deepEqual(statesOf(first), ["wait"], "someone asking while nothing was free wasn't told to wait");
  assert.equal(await placesIn(v), 30, "the crowd isn't all in line");
  await letGo(plan, held);
  const t0 = Date.now();
  await Promise.all(crowd.map((p, i) => work(conns[i], p, seeded(2000 + i))));
  const ms = Date.now() - t0;
  await close(conns);
  log(name, { ms, states, abandoned });
  assert.deepEqual(unexpected, []);

  const violations = await sql(
    `with st as (select id, key from public.work_plan_steps where plan_id = $2),
          edge as (select s.key as step, b.key as blocker from public.work_plan_step_blockers d
                     join st s on s.id = d.step_id join st b on b.id = d.blocker_id),
          ev as (select seq, event, detail->>'step' as key from public.log where vault_id = $1 and event in ('step.claim', 'step.complete'))
     select e.step, e.blocker from edge e join ev c on c.event = 'step.claim' and c.key = e.step
      where not exists (select 1 from ev x where x.event = 'step.complete' and x.key = e.blocker and x.seq < c.seq)
     order by 1, 2`,
    [v, plan],
  );
  assert.deepEqual(violations.slice(0, 10), [], `${violations.length} claims made while a blocker was unfinished`);
  const beyond = await sql(
    `select detail->>'step' as step, (detail->>'place')::int as place, (detail->>'ready')::int as ready from public.log
      where vault_id = $1 and event = 'step.claim' and (detail->>'place')::int > (detail->>'ready')::int`,
    [v],
  );
  assert.deepEqual(beyond, [], "a grant had a place in line beyond the number of ready steps");
  const [tally] = await sql(
    `select count(*) filter (where status = 'done')::int as done,
            (select count(*)::int from public.log where vault_id = $1 and event = 'step.complete') as completions,
            (select count(*)::int from public.log where vault_id = $1 and event = 'step.claim') as claims
       from public.work_plan_steps where plan_id = $2`,
    [v, plan],
  );
  assert.deepEqual(tally, { done: 40, completions: 40, claims: 40 + abandoned });
  assert.equal(await placesIn(v), 0, "a place in line was left behind");
  return { ms, abandoned, states };
}

test("races, waiting in line: 30 people asking for the steps of one 40-step plan at once finish every step, never claim past an unfinished blocker or beyond the ready steps, and leave no place in line", async () => {
  await lineCrowd("Races line crowd", false);
});

test("races, waiting in line: the same crowd walking away from a quarter of its steps still finishes every step, with the lapsed ones handed on through the line", async () => {
  // Whether anyone in the crowd lapses twice before finishing a step, and so
  // cools down, depends on the interleaving; the cooldown itself is proved
  // deterministically in supabase/tests/waiting_test.sql ("strikes:"). Here
  // every abandoned step is handed on through the line (the claims tally).
  const { abandoned } = await lineCrowd("Races line crowd abandoning", true);
  assert.ok(abandoned > 0, "no step was abandoned");
});

// Two requests from one person at once: the first stops after taking its
// place, holding it; the second, from the same connection or from another
// of the person's connections, waits for it and answers too. One place.
test("races, waiting in line: two requests at once, from one connection or from two of one person's connections, both answer and leave one place", async () => {
  await placesStop();
  const who = uid(600);
  await sql(`insert into auth.users (id, email) values ($1, 'races-0600@example.test') on conflict (id) do nothing`, [who]);
  const outcomes = [];
  for (const twoConnections of [false, true]) {
    const v = await planVault(`Races line twice ${twoConnections}`, who);
    // Someone else holds a, so nothing is ready and both requests wait.
    await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, people[23], OWNER]);
    assert.ok((await claimA(db, v, people[23])).ok);
    const [tokA, tokB] = twoConnections ? [await tokenFor(who, v, "line a"), await tokenFor(who, v, "line b")] : [null, null];
    const ask = (c, tok, stop) => (tok ? asTok(c, who, tok, requestWork, [v], stop) : as(c, who, requestWork, [v], stop));
    const [a, b, bState] = await interleave((c) => ask(c, tokA, "work_plan_places"), (c) => ask(c, tokB));
    outcomes.push(`${a.ok ? a.rows[0].o_state : a.code}/${b.ok ? b.rows[0].o_state : b.code} (${bState}) places ${await placesIn(v)}`);
  }
  log("request_work twice", outcomes);
  assert.deepEqual(outcomes, ["wait/wait (blocked) places 1", "wait/wait (blocked) places 1"]);
});

test("races, lock order: asking for work while the vault is deleted, interleaved, doesn't deadlock", async () => {
  const name = "Races delete request work";
  const who = uid(601);
  await sql(`insert into auth.users (id, email) values ($1, 'races-0601@example.test') on conflict (id) do nothing`, [who]);
  const v = await planVault(name, who);
  // The deletion holds the vault's row and its steps, and stops before its cascade.
  const [de, rw] = await interleave(
    (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name], "vault_deletions"),
    (c) => as(c, who, requestWork, [v]),
  );
  assert.deepEqual([outcome(de), rw.ok ? rw.rows[0].o_state : rw.code], ["ok", "no_such_plan"]);
});

test("races, lock order: a place in line taken, or a step granted, while the vault is deleted, interleaved, doesn't deadlock", async () => {
  await placesStop();
  const outcomes = [];
  for (const [round, stop] of [[0, "work_plan_places"], [1, "work_plan_steps"]]) {
    const name = `Races request work delete ${round}`;
    const who = uid(602 + round);
    await sql(`insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`, [who, `races-060${2 + round}@example.test`]);
    const v = await planVault(name, who);
    // To take a place, the one ready step is someone else's first.
    if (stop === "work_plan_places") {
      await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, people[22], OWNER]);
      assert.ok((await claimA(db, v, people[22])).ok);
    }
    // The request holds the vault's row, and its place or its step, and stops.
    const [rw, de] = await interleave(
      (c) => as(c, who, requestWork, [v], stop),
      (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name]),
    );
    outcomes.push(`${rw.ok ? rw.rows[0].o_state : rw.code}/${outcome(de)} places ${await placesIn(v)}`);
  }
  log("request_work vs delete_vault", outcomes);
  assert.deepEqual(outcomes, ["wait/ok places 0", "granted/ok places 0"]);
});

test("races, lock order: leaving a line while the vault is deleted, interleaved, doesn't deadlock", async () => {
  await placesStop();
  const name = "Races leave queue delete";
  const who = uid(604);
  await sql(`insert into auth.users (id, email) values ($1, 'races-0604@example.test') on conflict (id) do nothing`, [who]);
  const v = await planVault(name, who);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, people[21], OWNER]);
  assert.ok((await claimA(db, v, people[21])).ok);
  const joined = await as(db, who, requestWork, [v]);
  assert.equal(joined.rows?.[0]?.o_state, "wait");
  // Leaving holds the vault's row and the place it deleted, and stops.
  const [lq, de] = await interleave(
    (c) => as(c, who, "select public.leave_queue($1, 'plan.md')::text as left", [v], "work_plan_places"),
    (c) => as(c, OWNER, "select public.delete_vault($1, $2)::text", [v, name]),
  );
  assert.deepEqual([lq.ok ? lq.rows[0].left : lq.code, outcome(de), await placesIn(v)], ["true", "ok", 0]);
});

// ---------------------------------------------------------------------------
// Waiting in line against a crowd, a hostile crowd and a hammering one
// (CL-3.10, issue #77; ported from spikes/claims/mixed.sh and the spike's
// hammering runs). A person's connection is an access token, so a hundred
// connections are a hundred tokens, sent over fewer database connections
// (the database allows 100), the way the MCP server's pool sends them.
// Bounds on writes and errors, never on speed: the hostile crowd and the
// honest agents are all in line before anyone is served (holdReady), and
// the honest agents have 10 minutes, a bound only a hang reaches. On every
// push the hostile crowd runs until the honest agents finish the plan and
// the hammering one for 5 seconds; the spike's full run keeps the hostile
// crowd on for 90 seconds and hammers for 15:
//   WAITING_LOAD_FULL=1 WEB_TESTS=test/races.test.mjs ./web/test.sh

const LOAD_FULL = Boolean(process.env.WAITING_LOAD_FULL);
const addUsers = (ids) =>
  sql(`insert into auth.users (id, email) select u, 'races-' || right(u::text, 4) || '@example.test' from unnest($1::uuid[]) u
       on conflict (id) do nothing`, [ids]);
// The first layer's `width` steps have no blockers; each step after is
// blocked by two of the layer before (mixed.sh's plan).
const meshPlan = (layers, width) =>
  Array.from({ length: layers * width }, (_, n) => {
    const [l, i] = [Math.floor(n / width) + 1, n % width];
    return { key: `l${l}-${i}`, title: `Step ${l}.${i}`, blocked_by: l === 1 ? [] : [`l${l - 1}-${i}`, `l${l - 1}-${(i + 1) % width}`] };
  });
async function lineVault(name, members, path, steps) {
  const v = await newVault(OWNER, name);
  for (const p of members) await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, p, OWNER]);
  const file = await as(db, OWNER, "select public.write_file($1, $2, 'plan') as v", [v, path]);
  assert.ok(file.ok, file.message);
  const reg = await as(db, OWNER, "select public.register_work_plan($1, $2, $3, $4::jsonb)::text as id", [v, path, file.rows[0].v, JSON.stringify(steps)]);
  assert.ok(reg.ok, reg.message);
  return { v, plan: reg.rows[0].id };
}
// Claims made while one of the step's blockers was unfinished, in the log's commit order.
const pastBlockers = (v, plan) =>
  sql(`with st as (select id, key from public.work_plan_steps where plan_id = $2),
            edge as (select s.key as step, b.key as blocker from public.work_plan_step_blockers d
                       join st s on s.id = d.step_id join st b on b.id = d.blocker_id),
            ev as (select seq, event, detail->>'step' as key from public.log where vault_id = $1 and event in ('step.claim', 'step.complete'))
       select e.step, e.blocker from edge e join ev c on c.event = 'step.claim' and c.key = e.step
        where not exists (select 1 from ev x where x.event = 'step.complete' and x.key = e.blocker and x.seq < c.seq)
        order by 1, 2`, [v, plan]);
// Steps whose stored count of unfinished blockers disagrees with the plan, in one snapshot.
const drifted = async (c, plans) =>
  (await c.query(
    `select s.key from public.work_plan_steps s where s.plan_id = any($1::uuid[])
        and s.open_blockers <> (select count(*)::int from public.work_plan_step_blockers d join public.work_plan_steps b on b.id = d.blocker_id
                                 where d.step_id = s.id and b.status <> 'done')`, [plans])).rows.map((r) => r.key);
const doneIn = async (plan) =>
  (await sql("select count(*)::int as n from public.work_plan_steps where plan_id = $1 and status = 'done'", [plan]))[0].n;
// A step walked away from: its lease made to lapse (the clock moved for
// that claim alone). An honest agent told to wait moves its own place's
// clock to its time and asks again; told to cool down, its cooldown's end.
const lapse = (c, plan, a) =>
  c.query("update public.work_plan_steps set expires_at = clock_timestamp() where plan_id = $1 and key = $2 and fence = $3", [plan, a.o_key, a.o_fence]);
const nextTurn = (c, plan, who) =>
  c.query("update public.work_plan_places set next_allowed_at = clock_timestamp() where plan_id = $1 and holder = $2", [plan, who]);
const coolOff = (c, v, who) =>
  c.query("update private.work_plan_strikes set cooldown_until = clock_timestamp() where vault_id = $1 and person = $2", [v, who]);

test("races, waiting in line across vaults: many connections asking at once for the same few people and agents across many vaults finish every plan, with no database error", async () => {
  const crowd = [730, 731, 732, 733].map(uid);
  await addUsers(crowd);
  const vaults = [];
  for (let i = 0; i < 8; i++) vaults.push(await lineVault(`Races line vaults ${i}`, crowd, "plan.md", meshPlan(3, 4)));
  // Three agents per person, each reaching all eight vaults: twelve agents.
  const agents = [];
  for (const p of crowd) {
    for (let k = 0; k < 3; k++) {
      const r = await as(db, p, "select public.create_access_token($1, 30, $2::uuid[], 'write')", [`line vaults ${k}`, vaults.map((x) => x.v)]);
      assert.ok(r.ok, r.message);
      agents.push({ who: p, tok: (await sql("select id from public.access_tokens where user_id = $1 and name = $2", [p, `line vaults ${k}`]))[0].id });
    }
  }
  const finished = new Set();
  const states = {};
  const unexpected = [];
  const work = async (c, rand) => {
    for (let calls = 0; finished.size < vaults.length; calls++) {
      if (calls > 5000) throw new Error(`a connection gave up after ${calls} calls with ${vaults.length - finished.size} plans unfinished`);
      const { who, tok } = agents[Math.floor(rand() * agents.length)];
      const open = vaults.filter((x) => !finished.has(x.v));
      const { v, plan } = open[Math.floor(rand() * open.length)];
      const r = await asTok(c, who, tok, requestWork, [v]);
      if (!r.ok) {
        unexpected.push(`request_work: ${r.code} ${r.message}`);
        continue;
      }
      const a = r.rows[0];
      states[a.o_state] = (states[a.o_state] ?? 0) + 1;
      if (a.o_state === "plan_complete") finished.add(v);
      else if (a.o_state === "wait") await nextTurn(c, plan, who);
      else if (a.o_state === "cooling_down") await coolOff(c, v, who);
      else if (a.o_state === "granted") {
        if (rand() < 0.15) {
          await lapse(c, plan, a);
          continue;
        }
        const done = await asTok(c, who, tok, "select public.complete_step($1, 'plan.md', $2, $3, $4)::text", [v, a.o_key, a.o_fence, a.o_secret]);
        if (!done.ok) unexpected.push(`complete ${a.o_key}: ${done.code} ${done.message}`);
      } else if (a.o_state !== "at_capacity") unexpected.push(`request_work answered ${a.o_state}`);
    }
  };
  const conns = await Promise.all(Array.from({ length: 48 }, () => connect()));
  // Every agent asks every vault at once while nothing is free: a person's
  // three agents overlap on one place, and every vault's line is full first.
  const held = await Promise.all(vaults.map((x) => holdReady(x.plan)));
  const first = await spread(conns, agents.flatMap((ag) => vaults.map(({ v }) => [ag, v])),
    (c, [{ who, tok }, v]) => asTok(c, who, tok, requestWork, [v]));
  assert.deepEqual(statesOf(first), ["wait"], "someone asking while nothing was free wasn't told to wait");
  for (const { v } of vaults) assert.equal(await placesIn(v), crowd.length, "a person's agents didn't share one place");
  for (const [k, x] of vaults.entries()) await letGo(x.plan, held[k]);
  const t0 = Date.now();
  await Promise.all(conns.map((c, i) => work(c, seeded(3000 + i))));
  const ms = Date.now() - t0;
  // Everyone asks each vault once more, so a place taken as its plan finished is cleared.
  for (const { v } of vaults) for (const p of crowd) await as(conns[0], p, requestWork, [v]);
  await close(conns);
  log("many vaults", { ms, states });

  assert.deepEqual(unexpected, []);
  for (const { v, plan } of vaults) {
    assert.equal(await doneIn(plan), 12);
    assert.deepEqual(await pastBlockers(v, plan), []);
    assert.equal(await placesIn(v), 0, "a place in line was left behind");
  }
  assert.deepEqual(await drifted(db, vaults.map((x) => x.plan)), []);
});

test("races, waiting in line under load: 20 honest agents beside a hostile crowd of 100 connections run by 5 people finish the plan, never claim past an unfinished blocker, keep every stored count right and never deadlock", async () => {
  const seconds = 90;
  const hang = 600;
  const honest = Array.from({ length: 20 }, (_, i) => uid(700 + i));
  const hostile = Array.from({ length: 5 }, (_, i) => uid(720 + i));
  await addUsers([...honest, ...hostile]);
  const { v, plan } = await lineVault("Races line hostile", [...honest, ...hostile], "mix/plan.md", meshPlan(5, 8));
  // Lease 1 minute, hold limit 1 hour, one step per connection and per
  // person, a place lives 2 minutes, longest hint 1 minute, minimum gap 10
  // seconds, 1 free lapse, cooldown at most 30 minutes.
  const rule = await as(db, OWNER, "select public.set_claim_rule($1, 'mix/', 1, 60, null, 1, 1, 2, 1, 10, 1, 30)::text", [v]);
  assert.ok(rule.ok, rule.message);
  const tokens = [];
  for (const p of hostile) for (let k = 0; k < 20; k++) tokens.push({ who: p, tok: await tokenFor(p, v, `hostile ${k}`) });
  const ask = "select o_state, o_key, o_fence, o_secret from public.request_work($1, 'mix/plan.md')";

  const unexpected = [];
  const states = { honest: {}, hostile: {} };
  const count = (side, s) => (states[side][s] = (states[side][s] ?? 0) + 1);
  let finishedMs = null;
  // Honest: follows the hint, finishes what it is granted but walks away from a tenth.
  const honestAgent = async (c, who, rand) => {
    while (Date.now() < hangAt) {
      const r = await as(c, who, ask, [v]);
      if (!r.ok) {
        unexpected.push(`honest request_work: ${r.code} ${r.message}`);
        continue;
      }
      const a = r.rows[0];
      count("honest", a.o_state);
      if (a.o_state === "plan_complete") return;
      if (a.o_state === "wait") await nextTurn(c, plan, who);
      else if (a.o_state === "cooling_down") await coolOff(c, v, who);
      else if (a.o_state === "granted") {
        if (rand() < 0.1) await lapse(c, plan, a);
        else {
          const done = await as(c, who, "select public.complete_step($1, 'mix/plan.md', $2, $3, $4)::text", [v, a.o_key, a.o_fence, a.o_secret]);
          if (!done.ok) unexpected.push(`complete ${a.o_key}: ${done.code} ${done.message}`);
        }
      }
    }
    throw new Error(`the plan did not finish in ${hang} s: a hang`);
  };
  // Hostile: ignores every hint and asks as fast as it can, through each of
  // its connections in turn, and never works: a step it is granted it sits
  // on until the lease runs out (made to lapse at once).
  const hostileConn = async (c, mine) => {
    for (let n = 0; LOAD_FULL ? Date.now() < fullUntil : finishedMs === null; n++) {
      const { who, tok } = mine[n % mine.length];
      const r = await asTok(c, who, tok, ask, [v]);
      if (!r.ok) {
        unexpected.push(`hostile request_work: ${r.code} ${r.message}`);
        continue;
      }
      count("hostile", r.rows[0].o_state);
      if (r.rows[0].o_state === "granted") await lapse(c, plan, r.rows[0]);
    }
  };
  const honestConns = await Promise.all(honest.map(() => connect()));
  const hostileConns = await Promise.all(Array.from({ length: 40 }, () => connect()));
  const watcher = await connect();
  // The whole hostile crowd asks, then every honest agent, while the ready
  // steps are held: everyone is told to wait, the hostile people first in line.
  const held = await holdReady(plan);
  const hostileFirst = await spread(hostileConns, tokens, (c, { who, tok }) => asTok(c, who, tok, ask, [v]));
  const honestFirst = await spread(honestConns, honest, (c, who) => as(c, who, ask, [v]));
  assert.deepEqual(statesOf([...hostileFirst, ...honestFirst]), ["wait"], "someone asking while nothing was free wasn't told to wait");
  assert.equal(await placesIn(v), hostile.length + honest.length, "the crowd isn't all in line");
  await letGo(plan, held);
  const t0 = Date.now();
  const hangAt = t0 + hang * 1000;
  const fullUntil = t0 + seconds * 1000;
  const honestDone = Promise.all(honest.map((p, i) => honestAgent(honestConns[i], p, seeded(4000 + i))))
    .finally(() => (finishedMs = Date.now() - t0));
  const running = Promise.allSettled([honestDone, ...hostileConns.map((c, i) => hostileConn(c, tokens.filter((_, k) => k % hostileConns.length === i)))]);
  let stopped = false;
  running.finally(() => (stopped = true));
  const seenDrift = [];
  while (!stopped) seenDrift.push(...(await drifted(watcher, [plan])));
  const settled = await running;
  await close(honestConns, hostileConns, watcher);
  for (const r of settled) if (r.status === "rejected") throw r.reason;
  const [grants] = await sql(
    `select count(*) filter (where actor = any($2::uuid[]))::int as hostile, count(*)::int as total
       from public.log where vault_id = $1 and event = 'step.claim'`, [v, hostile]);
  log("hostile crowd", { seconds, finishedMs, states, grants });

  assert.deepEqual(unexpected, [], "a request failed: a database error or a deadlock");
  assert.equal(await doneIn(plan), 40);
  assert.deepEqual(await pastBlockers(v, plan), []);
  assert.deepEqual(seenDrift, [], "a stored blocker count disagreed with the plan while the crowd ran");
  assert.deepEqual(await drifted(db, [plan]), []);
  assert.equal(await placesIn(v), 0, "a place in line was left behind");
});

test("races, waiting in line under load: 100 agents asking as fast as they can cause no error, and write their places no more than once per agent per minimum gap", async () => {
  const seconds = LOAD_FULL ? 15 : 5;
  const gap = 10;
  const crowd = Array.from({ length: 100 }, (_, i) => uid(800 + i));
  await addUsers(crowd);
  const { v } = await lineVault("Races line hammer", crowd, "load/plan.md", [{ key: "a", title: "A" }]);
  // Lease and longest hint an hour, minimum gap 10 seconds; the one step is the owner's.
  const rule = await as(db, OWNER, "select public.set_claim_rule($1, 'load/', 60, 120, null, 1, 5, 60, 60, $2, 1, 60)::text", [v, gap]);
  assert.ok(rule.ok, rule.message);
  const held = await as(db, OWNER, "select o_fence from public.claim_step($1, 'load/plan.md', 'a')", [v]);
  assert.ok(held.ok, held.message);
  await sql(`create table if not exists test_races.place_writes (vault_id uuid not null);
    create or replace function test_races.count_place() returns trigger language plpgsql as $f$
    begin insert into test_races.place_writes values (new.vault_id); return null; end $f$;
    drop trigger if exists zz_races_count on public.work_plan_places;
    create trigger zz_races_count after insert or update on public.work_plan_places
      for each row execute function test_races.count_place();`);

  const ask = "select o_state from public.request_work($1, 'load/plan.md')";
  const states = {};
  const unexpected = [];
  let calls = 0;
  const conns = await Promise.all(Array.from({ length: 40 }, () => connect()));
  const t0 = Date.now();
  const deadline = t0 + seconds * 1000;
  await Promise.all(conns.map(async (c, i) => {
    const mine = crowd.filter((_, k) => k % conns.length === i);
    // Each agent asks at least once, however slow the machine.
    for (let n = 0; n < mine.length || Date.now() < deadline; n++) {
      const r = await as(c, mine[n % mine.length], ask, [v]);
      calls++;
      if (!r.ok) unexpected.push(`${r.code} ${r.message}`);
      else states[r.rows[0].o_state] = (states[r.rows[0].o_state] ?? 0) + 1;
    }
  }));
  const elapsed = (Date.now() - t0) / 1000;
  await close(conns);
  await sql("drop trigger zz_races_count on public.work_plan_places");
  const [{ n: writes }] = await sql("select count(*)::int as n from test_races.place_writes where vault_id = $1", [v]);
  const bound = crowd.length * (Math.floor(elapsed / gap) + 1);
  log("hammer", { seconds: elapsed, calls, perSecond: Math.round(calls / elapsed), writes, bound, states });

  assert.deepEqual(unexpected, []);
  assert.deepEqual(Object.keys(states), ["wait"]);
  assert.ok(writes >= crowd.length && writes <= bound, `${writes} writes to places, from ${crowd.length} agents in ${elapsed} s (at most ${bound})`);
});
