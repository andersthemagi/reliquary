// One MCP request, one pooled connection (docs/research/server-load.md,
// "Second pass"): Session in src/db.ts, against the test database as the
// server's role, with a pool that counts checkouts and round trips. Seed:
// Gus's read-write token (seed.sql).

import assert from "node:assert/strict";
import { after, test } from "node:test";
import pg from "pg";
import { asIdentity, resolveToken, Session, tokenRef } from "../dist/db.js";

const { GUS_RW, TEST_DATABASE_URL } = process.env;
const GUS = "00000000-0000-0000-0000-000000000011";
const RESOURCE = "http://127.0.0.1/mcp";

// Every checkout ("acquire") and every query a checked-out client sends.
const pools = [];
function countingPool() {
  const db = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
  const n = { checkouts: 0, roundTrips: 0 };
  const wrapped = new WeakSet();
  db.on("acquire", (client) => {
    n.checkouts++;
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const query = client.query.bind(client);
    client.query = (...args) => {
      n.roundTrips++;
      return query(...args);
    };
  });
  pools.push(db);
  return { db, n };
}
after(() => Promise.all(pools.map((p) => p.end())));

const whoAmI = async (c) => (await c.query("select private.uid()::text as u, private.agent() as a, current_user as r")).rows[0];

test("one connection: a tool call's resolve and work share one checkout and one transaction", async () => {
  const { db, n } = countingPool();
  const s = new Session(tokenRef(GUS_RW, RESOURCE), db);
  const id = await s.open();
  assert.equal(id.userId, GUS);
  const me = await s.run(whoAmI);
  await s.close();
  assert.deepEqual(me, { u: GUS, a: "Gus all rw", r: "authenticated" });
  // begin + resolve (one simple query), the work, commit.
  assert.deepEqual(n, { checkouts: 1, roundTrips: 3 });
  assert.equal(db.idleCount, 1, "the connection is back in the pool");
});

test("one connection: before, the same call took two checkouts and five round trips", async () => {
  // The old path, for the record: resolve on its own checkout, then a
  // transaction as the identity. Kept for callers that already hold one.
  const { db, n } = countingPool();
  const id = await resolveToken(GUS_RW, db);
  const me = await asIdentity(id, whoAmI, db);
  assert.equal(me.u, GUS);
  assert.deepEqual(n, { checkouts: 2, roundTrips: 5 });
});

test("one connection: an unknown token checks out once, sets nothing, and gives the connection back", async () => {
  const { db, n } = countingPool();
  const s = new Session(tokenRef("rlq_" + "0".repeat(64), RESOURCE), db);
  assert.equal(await s.open(), null);
  assert.deepEqual(n, { checkouts: 1, roundTrips: 2 }); // begin + resolve, rollback
  assert.equal(db.idleCount, 1);
  const c = await db.connect();
  try {
    const r = (await c.query("select current_user as r, coalesce(current_setting('request.jwt.claims', true), '') as claims")).rows[0];
    assert.deepEqual(r, { r: "reliquary_mcp", claims: "" }, "no role or claims left on the connection");
  } finally {
    c.release();
  }
});

test("one connection: a malformed token never reaches the database", () => {
  assert.equal(tokenRef("rlq_short", RESOURCE), null);
  assert.equal(tokenRef("rle_" + "0".repeat(64), RESOURCE), null);
  assert.deepEqual(tokenRef("rlo_" + "a".repeat(64), RESOURCE)?.resource, RESOURCE);
  assert.equal(tokenRef("rlq_" + "a".repeat(64), RESOURCE)?.resource, null);
});

test("one connection: a batch's calls run one after another on the same connection, each in its own transaction", async () => {
  const { db, n } = countingPool();
  const s = new Session(tokenRef(GUS_RW, RESOURCE), db);
  await s.open();
  const txids = await Promise.all([1, 2, 3].map(() => s.run(async (c) => (await c.query("select txid_current()::text as t")).rows[0].t)));
  await s.close();
  assert.equal(new Set(txids).size, 3, "three transactions");
  // First call: 3 round trips; each later one: begin + resolve, work, commit.
  assert.deepEqual(n, { checkouts: 1, roundTrips: 9 });
});

test("one connection: a failed call rolls back only its own work, and the next call still runs as the token", async () => {
  const { db } = countingPool();
  const s = new Session(tokenRef(GUS_RW, RESOURCE), db);
  await s.open();
  await assert.rejects(s.run((c) => c.query("select 1/0")), { code: "22012" });
  const me = await s.run(whoAmI);
  await s.close();
  assert.equal(me.u, GUS);
  assert.equal(db.idleCount, 1);
});

test("one connection: a request that calls no tool still commits and releases (close is idempotent)", async () => {
  const { db, n } = countingPool();
  const s = new Session(tokenRef(GUS_RW, RESOURCE), db);
  await s.open();
  await s.close();
  await s.close();
  assert.deepEqual(n, { checkouts: 1, roundTrips: 2 }); // begin + resolve, commit
  assert.equal(db.idleCount, 1);
  await assert.rejects(s.run(whoAmI), /session closed/);
});
