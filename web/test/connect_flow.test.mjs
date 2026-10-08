// The first run, from a token to a connected agent (src/access.ts): the token
// tabs create a token in place, the answer goes on with that client's steps (the token already in
// them), and Connect says whether anything has connected. One new person
// walks it in order, so each test builds on the one before. What a token may
// reach is the database's (supabase/tests/access_tokens_test.sql); these
// check what the person sees and which button made which token.
//
// Against web/test.sh's AUTH_MODE=supabase instance A and the fake Auth
// (test/fake-auth.mjs). The person is made by this file (flow-*@example.test)
// and used by no other. Every sign-in code and refresh token seen goes to
// AUTH_SECRETS_FILE, so test.sh checks none reached the server logs.

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { before, test } from "node:test";
import pg from "pg";

const { WEB_AUTH_A_URL: A, WEB_AUTH_PUBLIC_URL: PUBLIC_URL, FAKE_AUTH_URL: FAKE, AUTH_SECRETS_FILE, WEB_URL } = process.env;
const ORIGIN = PUBLIC_URL ? new URL(PUBLIC_URL).origin : "";
const PG_PORT = 54332 + (Number(new URL(WEB_URL ?? "http://127.0.0.1:8791").port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const AT = "__Host-rlq_at";
const RT = "__Host-rlq_rt";
const EMAIL = "flow-mark@example.test";

const remember = (...secrets) => appendFileSync(AUTH_SECRETS_FILE, secrets.filter(Boolean).map((s) => `${s}\n`).join(""));
const jar = new Map();
const take = (r) => {
  for (const sc of r.headers.getSetCookie()) {
    const [pair] = sc.split(";");
    const i = pair.indexOf("=");
    const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
    if (/Max-Age=0(;|$)/.test(sc)) jar.delete(k);
    else jar.set(k, v);
    if (k === RT && v) remember(v);
  }
  return r;
};
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const get = async (path) => take(await fetch(A + path, { headers: { cookie: cookie() }, redirect: "manual" }));
const page = async (path) => (await get(path)).text();
const post = async (path, fields) =>
  take(
    await fetch(A + path, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams(fields).toString(),
    }),
  );
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)?.[1];
const fake = async (path, init) => (await fetch(FAKE + path, init)).json();

async function sql(q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
}

const at = (h, s) => {
  const i = h.indexOf(s);
  assert.ok(i >= 0, `missing: ${s}`);
  return i;
};
let userId = "";

before(async () => {
  assert.ok(A && FAKE && PUBLIC_URL && AUTH_SECRETS_FILE, "run through web/test.sh (supabase-mode instances and the fake Auth)");
  const u = await fake("/_users", { method: "POST", body: JSON.stringify({ email: EMAIL }) });
  userId = u.id;
  await sql("insert into auth.users (id, email) values ($1, $2) on conflict (id) do update set email = excluded.email", [userId, EMAIL]);
  const asked = await post("/signin", { csrf: csrfOf(await page("/signin")), email: EMAIL, next: "/" });
  const m = await fake(`/_last_email?email=${encodeURIComponent(EMAIL)}`);
  remember(m.code, m.token_hash);
  const done = await post("/signin/code", { csrf: csrfOf(await asked.text()), email: EMAIL, code: m.code, next: "/" });
  assert.equal(done.status, 303);
  assert.ok(jar.has(AT) && jar.has(RT), "signed in");
});

const csrf = async () => csrfOf(await page("/connections"));
const tokenRow = async (name) => (await sql("select access, all_vaults, kind from public.access_tokens where user_id = $1 and name = $2", [userId, name]))[0];
const createdBy = async (fields) => {
  const r = await post("/connections/new", { csrf: await csrf(), ...fields });
  assert.equal(r.status, 200);
  return r.text();
};

test("connect: before anything has connected the page says so", async () => {
  assert.match(await page("/connect?client=cursor"), /<strong>Nothing has connected in the last 15 minutes\.<\/strong>/);
});

test("quick token: the Cursor, VS Code and Other tabs each create a token in place, read only first, and the Claude Code tab has no form", async () => {
  for (const c of ["cursor", "vscode", "other"]) {
    const h = await page(`/connect?client=${c}`);
    assert.match(h, new RegExp(`<form method="post" action="/connections/new" class="panel token-form quick-token">`));
    assert.match(h, new RegExp(`<input type="hidden" name="client" value="${c}">`));
    assert.ok(at(h, 'name="access" value="read">Create read-only token') < at(h, 'name="access" value="write">Create read and write token'), c);
    assert.ok(at(h, "Either token reaches all your vaults") < at(h, 'name="access" value="read"'), `${c}: the reach is said before the buttons`);
    assert.match(h, new RegExp(`<a href="/connections/new\\?client=${c}">use the full form</a>`));
  }
  assert.doesNotMatch(await page("/connect"), /quick-token/);
});

test("quick token: Create read-only token makes a read-only token for all vaults, and the answer goes on with Cursor's steps, the token in them", async () => {
  const h = await createdBy({ client: "cursor", name: "Flow cursor", access: "read" });
  const token = /<p class="secret">(rlq_[0-9a-f]{64})<\/p>/.exec(h)?.[1];
  assert.ok(token, "the token, shown");
  assert.match(h, new RegExp(`export RELIQUARY_TOKEN='${token}'`));
  assert.match(h, new RegExp(`\\$env:RELIQUARY_TOKEN='${token}'`), "and for PowerShell");
  assert.match(h, /<h2>Set up Cursor<\/h2>/);
  assert.match(h, /cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=reliquary&amp;config=/);
  assert.doesNotMatch(h, /id="new-token"|name="scope"/, "no second form");
  assert.deepEqual(await tokenRow("Flow cursor"), { access: "read", all_vaults: true, kind: "pat" });
  assert.doesNotMatch(await page("/connections"), /rlq_[0-9a-f]{64}/, "shown once");
});

test("quick token: Create read and write token makes a read and write one, and VS Code's steps say to paste it when asked", async () => {
  const h = await createdBy({ client: "vscode", name: "Flow vscode", access: "write" });
  assert.match(h, /<h2>Set up VS Code<\/h2>/);
  assert.match(h, /\$\{input:reliquary-token\}/);
  assert.match(h, /paste the one above/);
  assert.equal((await tokenRow("Flow vscode")).access, "write");
});

test("other clients: the answer has a tools/list test that reads the token from the environment, never inline", async () => {
  const h = await createdBy({ client: "other", name: "Flow other", access: "read" });
  const token = /<p class="secret">(rlq_[0-9a-f]{64})<\/p>/.exec(h)[1];
  const curl = /<pre class="code" tabindex="0">(curl -s [\s\S]*?)<\/pre>/.exec(h)[1];
  assert.match(curl, /^curl -s \S+\/mcp \\\n/);
  assert.match(curl, /Authorization: Bearer \$RELIQUARY_TOKEN/);
  assert.match(curl, /"method":"tools\/list"/);
  assert.equal(curl.includes(token), false);
  const ps = /<pre class="code" tabindex="0">(Invoke-RestMethod [\s\S]*?)<\/pre>/.exec(h)[1];
  assert.match(ps, /\$env:RELIQUARY_TOKEN/);
  assert.equal(ps.includes(token), false);
});

test("full form: a token made from a client's tab goes on with that client's steps too", async () => {
  assert.match(await page("/connections/new?client=cursor"), /<input type="hidden" name="client" value="cursor">/);
  const h = await createdBy({ client: "cursor", name: "Flow full", scope: "all", access: "read", days: "7" });
  assert.match(h, /<h2>Set up Cursor<\/h2>/);
});

test("full form: a refused create goes back to the form with the client kept", async () => {
  const r = await post("/connections/new", { csrf: await csrf(), client: "cursor", name: "Flow refused", scope: "some", access: "read", days: "7" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/connections/new?client=cursor");
  const none = await post("/connections/new", { csrf: await csrf(), name: "Flow refused", scope: "some", access: "read", days: "7" });
  assert.equal(none.headers.get("location"), "/connections/new", "no client, no query");
});

test("unknown client: gets the plain answer, with the token and the links to each client", async () => {
  const h = await createdBy({ client: "<script>", name: "Flow odd", access: "read" });
  assert.match(h, /<p class="secret">rlq_[0-9a-f]{64}<\/p>/);
  assert.match(h, /Next, set up the client:/);
  assert.doesNotMatch(h, /<script>|Set up /);
});

test("connected: a connection last used long ago doesn't count, so an old one can't pass for the setup just finished", async () => {
  await createdBy({ client: "other", name: "Flow stale", access: "read" });
  await sql("update public.access_tokens set last_used_at = now() - interval '2 hours', client_name = 'Old client' where user_id = $1 and name = 'Flow stale'", [userId]);
  const h = await page("/connect?client=other");
  assert.doesNotMatch(h, /<strong>Connected\.<\/strong>/);
  assert.match(h, /Nothing has connected in the last 15 minutes/);
});

test("connected: a revoked or expired token doesn't count however recently it was used", async () => {
  await createdBy({ client: "other", name: "Flow revoked", access: "read" });
  await createdBy({ client: "other", name: "Flow expired", access: "read" });
  await sql("update public.access_tokens set last_used_at = now(), revoked_at = now() where user_id = $1 and name = 'Flow revoked'", [userId]);
  await sql(
    "update public.access_tokens set created_at = now() - interval '2 days', expires_at = now() - interval '1 day', last_used_at = now() where user_id = $1 and name = 'Flow expired'",
    [userId],
  );
  const h = await page("/connect?client=other");
  assert.doesNotMatch(h, /<strong>Connected\.<\/strong>/);
  assert.match(h, /Nothing has connected in the last 15 minutes/);
});

test("connected: a token used just now shows on Connect with its client", async () => {
  await sql("update public.access_tokens set last_used_at = now(), client_name = 'Cursor 1.2' where user_id = $1 and name = 'Flow cursor'", [userId]);
  const h = await page("/connect?client=cursor");
  assert.match(h, /<strong>Connected\.<\/strong> Flow cursor was last used <time[^>]*>[^<]*<\/time><span class="token-client"> · from Cursor 1\.2<\/span>\./);
  assert.doesNotMatch(h, /Nothing has connected/);
});
