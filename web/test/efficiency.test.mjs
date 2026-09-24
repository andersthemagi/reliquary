// Server load, second pass (docs/research/server-load.md): a GET page runs
// in one transaction on one connection (src/db.ts, readOnlyRequest, called
// directly against the test database with a pool that counts), and form
// fields over their ceilings are refused before the database, over HTTP as
// Ana. Uses its own paths. Seed: test/seed.sql.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";
import { asPerson, readOnlyRequest, usePool } from "../dist/db.js";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { TEAM_VAULT, LOGIN_FILE, TEST_DATABASE_URL } = process.env;
const ANA = "00000000-0000-0000-0000-00000000000a";
const V = `/v/${TEAM_VAULT}`;

// ---------------------------------------------------------------------------
// One page, one transaction

const counting = [];
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
  counting.push(db);
  usePool(db);
  return { db, n };
}
after(() => Promise.all(counting.map((p) => p.end())));

const txid = (c) => c.query("select txid_current()::text as t, private.uid()::text as u").then((r) => r.rows[0]);

test("one page: the Review count and every query of a GET page share one checkout and one transaction", async () => {
  const { db, n } = countingPool();
  const seen = await readOnlyRequest(ANA, async () => [
    await asPerson(ANA, txid), // the Review count
    await asPerson(ANA, txid), // the page
    await asPerson(ANA, txid), // a page that asks twice (the Variables page did six times)
  ]);
  assert.equal(new Set(seen.map((s) => s.t)).size, 1, "one transaction");
  assert.ok(seen.every((s) => s.u === ANA), "as the person");
  // begin with the claims (one round trip), three queries, commit.
  assert.deepEqual(n, { checkouts: 1, roundTrips: 5 });
  assert.equal(db.idleCount, 1, "the connection is back in the pool");
});

test("one page: outside a page (a POST), each call is its own transaction, begun in one round trip", async () => {
  const { n } = countingPool();
  const a = await asPerson(ANA, txid);
  const b = await asPerson(ANA, txid);
  assert.notEqual(a.t, b.t);
  // Per call: begin with the claims, the query, commit. Before: begin, the
  // claims, the query, commit.
  assert.deepEqual(n, { checkouts: 2, roundTrips: 6 });
});

test("one page: a failed call rolls back, and the page's next call gets a fresh transaction", async () => {
  const { db } = countingPool();
  const [first, second] = await readOnlyRequest(ANA, async () => {
    const first = await asPerson(ANA, txid);
    await assert.rejects(asPerson(ANA, (c) => c.query("select 1/0")), { code: "22012" });
    return [first, await asPerson(ANA, txid)];
  });
  assert.notEqual(first.t, second.t);
  assert.equal(second.u, ANA);
  assert.equal(db.idleCount, 1);
});

test("one page: after the page is built, a call takes its own transaction again", async () => {
  const { n } = countingPool();
  let later;
  await readOnlyRequest(ANA, async () => {
    await asPerson(ANA, txid);
    later = () => asPerson(ANA, txid);
  });
  const r = await later();
  assert.equal(r.u, ANA);
  assert.deepEqual(n, { checkouts: 2, roundTrips: 6 });
});

test("one page: another person's call inside a page never joins its transaction", async () => {
  const { n } = countingPool();
  const BEN = "00000000-0000-0000-0000-00000000000b";
  const [a, b] = await readOnlyRequest(ANA, async () => [await asPerson(ANA, txid), await asPerson(BEN, txid)]);
  assert.equal(a.u, ANA);
  assert.equal(b.u, BEN);
  assert.notEqual(a.t, b.t);
  assert.equal(n.checkouts, 2);
});

// ---------------------------------------------------------------------------
// Form fields over their ceilings, before the database

let cookie = "";
before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});
const page = async (path) => (await fetch(BASE + path, { headers: { cookie }, redirect: "manual" })).text();
const csrf = async (path) => /name="csrf" value="([0-9a-f]+)"/.exec(await page(path))[1];
const post = (path, fields, headers = {}) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE, ...headers },
    body: new URLSearchParams(fields).toString(),
  });

test("limits: an over-long path goes back to the form's page with the ceiling, never the input, and the database isn't asked", async () => {
  const token = await csrf(`${V}/new`);
  const path = `notes/ECHOMARKER${"p".repeat(1100)}.md`;
  const r = await post(`${V}/file`, { csrf: token, action: "write", path, content: "x" }, { referer: `${BASE}${V}/new` });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), `${V}/new`);
  const next = await page(r.headers.get("location"));
  // The database's answer would be "Invalid path: ...": this one is the app's.
  assert.match(next, /That’s too long \(text up to 1 MB, reasons and notes up to 4000 characters, paths up to 1024, names up to 200\)\. Nothing was saved\./);
  assert.doesNotMatch(next, /ECHOMARKER/);
});

test("limits: a reason over 4000 characters is refused before the database; 4000 is fine", async () => {
  const token = await csrf(`${V}/new`);
  const long = await post(`${V}/file`, { csrf: token, action: "write", path: "notes/limits-reason.md", content: "x", reason: "r".repeat(4001) });
  assert.equal(long.status, 303);
  assert.equal(long.headers.get("location"), "/", "no Referer: home");
  assert.match(await page("/"), /Nothing was saved\./);
  assert.match(await page(`${V}/file?path=notes%2Flimits-reason.md`), /Not found/);
  const fine = await post(`${V}/file`, { csrf: token, action: "write", path: "notes/limits-reason.md", content: "x", reason: "é".repeat(4000) });
  assert.equal(fine.status, 303);
  assert.notEqual(fine.headers.get("location"), "/");
});

test("limits: characters are counted as the database counts them, not as UTF-16 units", async () => {
  const token = await csrf(`${V}/new`);
  // 4000 characters, 8000 UTF-16 units: within the reason ceiling.
  const r = await post(`${V}/file`, { csrf: token, action: "write", path: "notes/limits-emoji.md", content: "x", reason: "😀".repeat(4000) });
  assert.equal(r.status, 303);
  assert.notEqual(r.headers.get("location"), "/");
  assert.doesNotMatch(await page(r.headers.get("location")), /Nothing was saved\./);
});

test("limits: a Referer from another site doesn't choose where the refusal goes", async () => {
  const token = await csrf(`${V}/new`);
  const r = await post(`${V}/file`, { csrf: token, action: "write", path: "p".repeat(1100), content: "x" }, { referer: "https://evil.example/v/x" });
  assert.equal(r.headers.get("location"), "/");
});

test("limits: a form over 2 MB is answered 413, not an error page", async () => {
  // Not a file form (those take up to about 3 MB: efficiency_3.test.mjs).
  const token = await csrf(`${V}/new`);
  const r = await post(`${V}/rules`, { csrf: token, path: "notes/", policy: "canon", note: "x".repeat(2 * 1024 * 1024 + 1) });
  assert.equal(r.status, 413);
  assert.match(await r.text(), /over 2 MB, so nothing was saved/);
});
