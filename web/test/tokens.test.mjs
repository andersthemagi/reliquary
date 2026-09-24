// Tokens page: scoped, expiring tokens, signed in as Ana. The database
// enforces scope (supabase/tests/token_scope_test.sql); these check the page
// creates what the person chose and shows each token honestly.
// Seed: the "Tokens" block at the end of test/seed.sql.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { TEAM_VAULT, DEE_VAULT, LOGIN_FILE } = process.env;
let cookie = "";

const get = (path) => fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
const page = async (path) => (await get(path)).text();
// pairs, so a field (vault) can repeat
const post = (path, pairs) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams(pairs).toString(),
  });
const csrf = async () => /name="csrf" value="([0-9a-f]+)"/.exec(await page("/tokens"))[1];
const follow = async (r) => page(r.headers.get("location"));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function row(h, name) {
  const m = new RegExp(`<tr[^>]*><td>${esc(name)}</td>([\\s\\S]*?)</tr>`).exec(h);
  assert.ok(m, `no row for ${name}`);
  return m[1];
}

async function create(fields) {
  const token = await csrf();
  return post("/tokens/new", [["csrf", token], ...fields]);
}

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

test("form: name, my vaults to tick, read or read-write, and a required expiry", async () => {
  const h = await page("/tokens");
  assert.match(h, /name="scope" value="all" checked/);
  assert.match(h, new RegExp(`type="checkbox" name="vault" value="${TEAM_VAULT}"> Team`));
  assert.doesNotMatch(h, /Dee private/);
  assert.match(h, /name="access" value="read" checked/);
  assert.match(h, /name="access" value="write">/);
  assert.match(h, /<option value="90" selected>90 days<\/option>/);
  assert.match(h, /<option value="366">1 year<\/option>/);
  assert.match(h, /can’t be changed later/);
});

test("create: a read-only token for one vault, shown once", async () => {
  const r = await create([["name", "Scoped reader"], ["scope", "some"], ["vault", TEAM_VAULT], ["access", "read"], ["days", "30"]]);
  const made = await r.text();
  assert.match(made, /<p class="secret">rlq_[0-9a-f]{64}<\/p>/);
  const h = await page("/tokens");
  assert.doesNotMatch(h, /rlq_[0-9a-f]{64}/);
  const tr = row(h, "Scoped reader");
  assert.match(tr, /<td class="small">Team<\/td>/);
  assert.match(tr, /Read only/);
  assert.match(tr, /Never/);
  const in30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  assert.match(tr, new RegExp(in30));
  assert.match(tr, /Revoke/);
});

test("create: read and write, all vaults", async () => {
  await create([["name", "Everywhere writer"], ["scope", "all"], ["access", "write"], ["days", "7"]]);
  const tr = row(await page("/tokens"), "Everywhere writer");
  assert.match(tr, /All your vaults/);
  assert.match(tr, /Read and write/);
});

test("create: a ticked vault narrows the token even if 'all' is still selected", async () => {
  await create([["name", "Mixed signals"], ["scope", "all"], ["vault", TEAM_VAULT], ["access", "read"], ["days", "30"]]);
  const tr = row(await page("/tokens"), "Mixed signals");
  assert.match(tr, /<td class="small">Team<\/td>/);
  assert.doesNotMatch(tr, /All your vaults/);
});

test("create: an unknown access level becomes read-only, never read-write", async () => {
  await create([["name", "Odd access"], ["scope", "all"], ["access", "admin"], ["days", "30"]]);
  assert.match(row(await page("/tokens"), "Odd access"), /Read only/);
});

test("create: refused without a vault, for someone else's vault, or past a year", async () => {
  const none = await follow(await create([["name", "No vaults"], ["scope", "some"], ["access", "read"], ["days", "30"]]));
  assert.match(none, /Tick at least one vault, or choose all your vaults\./);
  assert.doesNotMatch(none, /<td>No vaults<\/td>/);

  const theirs = await follow(await create([["name", "Not mine"], ["scope", "some"], ["vault", DEE_VAULT], ["access", "read"], ["days", "30"]]));
  assert.match(theirs, /A token can only reach vaults you belong to\./);
  assert.doesNotMatch(theirs, /<td>Not mine<\/td>/);

  const long = await follow(await create([["name", "Too long"], ["scope", "all"], ["access", "read"], ["days", "5000"]]));
  assert.match(long, /Tokens last 1 to 366 days\./);
  const never = await follow(await create([["name", "Never ends"], ["scope", "all"], ["access", "read"], ["days", "never"]]));
  assert.match(never, /Tokens last 1 to 366 days\./);
  assert.doesNotMatch(await page("/tokens"), /<td>(Too long|Never ends)<\/td>/);

  assert.equal((await create([["name", "Bad id"], ["scope", "some"], ["vault", "not-a-uuid"], ["access", "read"]])).status, 404);
});

test("list: last use and the client name, escaped", async () => {
  const tr = row(await page("/tokens"), "Seeded reader");
  assert.match(tr, /2 h ago/);
  assert.match(tr, /from Cursor &lt;img src=x onerror=alert\(3\)&gt;/);
  assert.doesNotMatch(tr, /<img/);
});

test("list: an expired token says so and has nothing to revoke", async () => {
  const h = await page("/tokens");
  assert.match(h, /<tr class="inactive"><td>Seeded expired<\/td>/);
  const tr = row(h, "Seeded expired");
  assert.match(tr, /Expired/);
  assert.doesNotMatch(tr, /Revoke/);
});

test("list: a vault the person has left is counted, not named", async () => {
  const tr = row(await page("/tokens"), "Seeded left");
  assert.match(tr, /Team, and 1 you no longer belong to/);
  assert.doesNotMatch(tr, /Dee private/);
});

test("revoke: a scoped token is revoked like any other", async () => {
  const h = await page("/tokens");
  const id = new RegExp(`<td>Scoped reader</td>[\\s\\S]*?action="/tokens/([0-9a-f-]{36})/revoke"`).exec(h)[1];
  const r = await post(`/tokens/${id}/revoke`, [["csrf", await csrf()]]);
  assert.match(await follow(r), /Token revoked/);
  assert.match(row(await page("/tokens"), "Scoped reader"), /Revoked/);
});
