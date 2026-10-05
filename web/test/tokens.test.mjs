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
const csrf = async () => /name="csrf" value="([0-9a-f]+)"/.exec(await page("/connections"))[1];
const follow = async (r) => page(r.headers.get("location"));

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function row(h, name) {
  const m = new RegExp(`<tr[^>]*><td>${esc(name)}</td>([\\s\\S]*?)</tr>`).exec(h);
  assert.ok(m, `no row for ${name}`);
  return m[1];
}

async function create(fields) {
  const token = await csrf();
  return post("/connections/new", [["csrf", token], ...fields]);
}

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

test("form: name, my vaults to tick, read or read-write, and a required expiry", async () => {
  const h = await page("/connections/new");
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
  const h = await page("/connections");
  assert.doesNotMatch(h, /rlq_[0-9a-f]{64}/);
  const tr = row(h, "Scoped reader");
  assert.match(tr, /<td data-label="Vaults" class="small">Team<\/td>/);
  assert.match(tr, /Read only/);
  assert.match(tr, /Never/);
  const in30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  assert.match(tr, new RegExp(in30));
  assert.match(tr, /Revoke/);
});

test("create: read and write, all vaults", async () => {
  await create([["name", "Everywhere writer"], ["scope", "all"], ["access", "write"], ["days", "7"]]);
  const tr = row(await page("/connections"), "Everywhere writer");
  assert.match(tr, /All your vaults/);
  assert.match(tr, /Read and write/);
});

test("create: a ticked vault narrows the token even if 'all' is still selected", async () => {
  await create([["name", "Mixed signals"], ["scope", "all"], ["vault", TEAM_VAULT], ["access", "read"], ["days", "30"]]);
  const tr = row(await page("/connections"), "Mixed signals");
  assert.match(tr, /<td data-label="Vaults" class="small">Team<\/td>/);
  assert.doesNotMatch(tr, /All your vaults/);
});

test("create: an unknown access level becomes read-only, never read-write", async () => {
  await create([["name", "Odd access"], ["scope", "all"], ["access", "admin"], ["days", "30"]]);
  assert.match(row(await page("/connections"), "Odd access"), /Read only/);
});

// A refused create answers the form again, 400: the reason in it and every
// choice made kept, so nothing is chosen twice.
const refused = async (fields) => {
  const r = await create(fields);
  assert.equal(r.status, 400);
  return r.text();
};
const checkedIn = (h, tag) => new RegExp(`${tag} checked`).test(h);

test("create: refused without a vault, for someone else's vault, or past a year", async () => {
  const none = await refused([["name", "No vaults"], ["scope", "some"], ["access", "read"], ["days", "30"]]);
  assert.match(none, /Tick at least one vault, or choose all your vaults\./);
  assert.doesNotMatch(none, /<td>No vaults<\/td>/);

  const theirs = await refused([["name", "Not mine"], ["scope", "some"], ["vault", DEE_VAULT], ["access", "read"], ["days", "30"]]);
  assert.match(theirs, /A token can only reach vaults you belong to\./);
  assert.doesNotMatch(theirs, /<td>Not mine<\/td>/);

  const long = await refused([["name", "Too long"], ["scope", "all"], ["access", "read"], ["days", "5000"]]);
  assert.match(long, /Tokens last 1 to 366 days\./);
  const never = await refused([["name", "Never ends"], ["scope", "all"], ["access", "read"], ["days", "never"]]);
  assert.match(never, /Tokens last 1 to 366 days\./);
  assert.doesNotMatch(await page("/connections"), /<td>(Too long|Never ends)<\/td>/);

  assert.equal((await create([["name", "Bad id"], ["scope", "some"], ["vault", "not-a-uuid"], ["access", "read"]])).status, 404);
});

test("create: ticking no vault under 'only the vaults I tick' comes back to the form with the name, access and expiry kept, the reason and a reference, and nothing created", async () => {
  const h = await refused([["name", "Kept <agent> & co"], ["scope", "some"], ["access", "write"], ["days", "30"]]);
  assert.match(h, /<p class="callout danger" role="alert" id="token-error">Tick at least one vault, or choose all your vaults\. Nothing was created\. \(ref [0-9a-f]{8}\)<\/p>/);
  assert.match(h, /id="tn" type="text" name="name"[^>]*value="Kept &lt;agent&gt; &amp; co"/);
  assert.ok(checkedIn(h, 'type="radio" name="scope" value="some"'), "'Only the vaults I tick' stays chosen");
  assert.ok(checkedIn(h, 'type="radio" name="access" value="write"'), "read and write stays chosen");
  assert.ok(!checkedIn(h, 'type="radio" name="access" value="read"'));
  assert.match(h, /<option value="30" selected>30 days<\/option>/);
  assert.match(h, /<fieldset[^>]*aria-describedby="token-error">\s*<legend>Vaults<\/legend>/);
  assert.doesNotMatch(await page("/connections"), /Kept &lt;agent&gt;/);
});

test("create: a refusal from the database keeps the ticked vaults too, and an expiry that is not offered falls back to the default", async () => {
  const h = await refused([["name", "Kept ticks"], ["scope", "some"], ["vault", TEAM_VAULT], ["access", "write"], ["days", "5000"]]);
  assert.match(h, /Tokens last 1 to 366 days\. \(ref [0-9a-f]{8}\)<\/p>/);
  assert.match(h, new RegExp(`type="checkbox" name="vault" value="${TEAM_VAULT}" checked> Team`));
  assert.ok(checkedIn(h, 'type="radio" name="scope" value="some"'));
  assert.ok(checkedIn(h, 'type="radio" name="access" value="write"'));
  assert.match(h, /<option value="90" selected>90 days<\/option>/);
  assert.doesNotMatch(await page("/connections"), /<td>Kept ticks<\/td>/);
});

test("create: a blank name is refused in the form, saying what a name is, the field marked and the other choices kept", async () => {
  const h = await refused([["name", "   "], ["scope", "all"], ["access", "write"], ["days", "180"]]);
  assert.match(h, /A token needs a name, up to 100 characters: the agent and machine it is for\. Nothing was created\. \(ref [0-9a-f]{8}\)<\/p>/);
  assert.doesNotMatch(h, /Check violation|too long/i, "not the database's words for a different problem");
  assert.match(h, /id="tn" type="text" name="name"[^>]*aria-invalid="true" aria-describedby="token-error"/);
  assert.ok(checkedIn(h, 'type="radio" name="access" value="write"'));
  assert.match(h, /<option value="180" selected>180 days<\/option>/);
});

test("list: last use and the client name, escaped", async () => {
  const tr = row(await page("/connections"), "Seeded reader");
  assert.match(tr, /2 h ago/);
  assert.match(tr, /from Cursor &lt;img src=x onerror=alert\(3\)&gt;/);
  assert.doesNotMatch(tr, /<img/);
});

test("list: an expired token says so and has nothing to revoke", async () => {
  const h = await page("/connections");
  assert.match(h, /<tr class="inactive"><td>Seeded expired<\/td>/);
  const tr = row(h, "Seeded expired");
  assert.match(tr, /Expired/);
  assert.doesNotMatch(tr, /Revoke/);
});

test("list: a vault the person has left drops out of the token's scope", async () => {
  // Leaving narrows the token for good (20260925180000_member_tokens.sql),
  // so the vault is neither named nor counted.
  const tr = row(await page("/connections"), "Seeded left");
  assert.match(tr, /Team/);
  assert.doesNotMatch(tr, /no longer belong/);
  assert.doesNotMatch(tr, /Dee private/);
});

test("revoke: a scoped token is revoked like any other", async () => {
  const h = await page("/connections");
  const id = new RegExp(`<td>Scoped reader</td>[\\s\\S]*?href="/connections/([0-9a-f-]{36})/revoke"`).exec(h)[1];
  const r = await post(`/connections/${id}/revoke`, [["csrf", await csrf()]]);
  assert.match(await follow(r), /Revoked Scoped reader\./);
  assert.match(row(await page("/connections"), "Scoped reader"), /Revoked/);
});
