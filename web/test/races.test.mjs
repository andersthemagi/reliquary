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
      for each statement execute function test_races.stop('values');`);
});

after(async () => {
  await sql(`drop trigger if exists zz_races_stop on public.files;
             drop trigger if exists zz_races_stop on private.env_import_secrets;
             drop trigger if exists zz_races_stop on public.log;
             drop trigger if exists zz_races_stop on public.vault_members;
             drop trigger if exists zz_races_stop on public.variable_values;
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
