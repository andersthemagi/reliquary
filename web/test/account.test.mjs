// Account settings with Supabase Auth (src/settings.ts, src/auth.ts):
// signing out everywhere. Against web/test.sh's AUTH_MODE=supabase instance
// A and the fake Auth (test/fake-auth.mjs). The database rules are in
// supabase/tests/sign_out_everywhere_test.sql.
//
// Everyone here is made by this file (acct-*@example.test, in the fake Auth
// and in auth.users) and used by no other. Every sign-in code, token hash
// and refresh token seen goes to AUTH_SECRETS_FILE, so test.sh checks none
// reached the server logs.

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";

const { WEB_AUTH_A_URL: A, WEB_AUTH_PUBLIC_URL: PUBLIC_URL, FAKE_AUTH_URL: FAKE, AUTH_SECRETS_FILE, WEB_URL } = process.env;
const ORIGIN = PUBLIC_URL ? new URL(PUBLIC_URL).origin : "";
const PG_PORT = 54332 + (Number(new URL(WEB_URL ?? "http://127.0.0.1:8791").port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const AT = "__Host-rlq_at";
const RT = "__Host-rlq_rt";

const remember = (...secrets) => appendFileSync(AUTH_SECRETS_FILE, secrets.filter(Boolean).map((s) => `${s}\n`).join(""));

class Jar {
  constructor(init = {}) {
    this.c = new Map(Object.entries(init));
  }
  take(r) {
    for (const sc of r.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (/Max-Age=0(;|$)/.test(sc)) this.c.delete(k);
      else this.c.set(k, v);
      if (k === RT && v) remember(v);
    }
    return r;
  }
  get header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

const get = async (path, jar) => jar.take(await fetch(A + path, { headers: { cookie: jar.header }, redirect: "manual" }));
const post = async (path, fields, jar) =>
  jar.take(
    await fetch(A + path, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: jar.header, "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
      body: new URLSearchParams(fields).toString(),
    }),
  );
const csrfOf = (html) => /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1];
const fake = async (path, init) => (await fetch(FAKE + path, init)).json();
const stats = () => fake("/_stats");
const lastEmail = async (email) => {
  const m = await fake(`/_last_email?email=${encodeURIComponent(email)}`);
  if (m) remember(m.code, m.token_hash);
  return m;
};

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

// An account in the fake Auth and in the database's auth.users.
async function account(email) {
  const { id } = await fake("/_users", { method: "POST", body: JSON.stringify({ email }) });
  await sql("insert into auth.users (id, email) values ($1, $2) on conflict (id) do update set email = excluded.email", [id, email]);
  return id;
}

// A fresh browser signed in as `email` by its emailed code.
async function signIn(email) {
  const jar = new Jar();
  const page = await (await get("/signin", jar)).text();
  const asked = await post("/signin", { csrf: csrfOf(page), email, next: "/" }, jar);
  assert.equal(asked.status, 200);
  const codePage = await asked.text();
  const { code } = await lastEmail(email);
  const done = await post("/signin/code", { csrf: csrfOf(codePage), email, code, next: "/" }, jar);
  assert.equal(done.status, 303);
  assert.ok(jar.c.has(AT) && jar.c.has(RT), "signed in");
  return jar;
}
const settingsCsrf = async (jar) => csrfOf(await (await get("/settings", jar)).text());
const live = async (user) => (await sql("select count(*)::int as n from public.access_tokens where user_id = $1 and revoked_at is null", [user]))[0].n;
const connect = async (user, name) => {
  await as(user, "select public.create_access_token($1, 30)", [name]);
  await sql(
    `insert into public.access_tokens (user_id, name, kind, client_id, resource, expires_at)
     values ($1, $2, 'oauth', 'https://client.example/meta.json', 'https://mcp.example/mcp', now() + interval '30 days')`,
    [user, `${name} app`],
  );
};
// The next whole second: a session's iat is in seconds, so one begun in
// the same second as a sign-out everywhere counts as begun before it.
const nextSecond = () => new Promise((r) => setTimeout(r, 1100 - (Date.now() % 1000)));

const U = {};
before(async () => {
  assert.ok(A && FAKE && PUBLIC_URL && AUTH_SECRETS_FILE, "run through web/test.sh (supabase-mode instances and the fake Auth)");
  U.sofia = await account("acct-sofia@example.test");
  U.tomas = await account("acct-tomas@example.test");
  U.uma = await account("acct-uma@example.test");
});
after(async () => {
  await fake("/_fail_global_logout", { method: "POST", body: JSON.stringify({ status: 0 }) });
});

// ---------------------------------------------------------------------------
// Sign out everywhere

test("sign out everywhere: Account settings offers it, says connections are separate, and offers to revoke them too", async () => {
  const jar = await signIn("acct-sofia@example.test");
  const h = await (await get("/settings", jar)).text();
  assert.match(h, /<h2 id="everywhere">Sign out everywhere<\/h2>/);
  assert.match(h, /in every browser and on every device, this one included/);
  assert.match(h, /Connections are separate: agent tokens, connected apps \(Claude, ChatGPT, Cursor and others\) and Reliquary CLI sign-ins keep working after you sign out everywhere\. Revoke them all here, or one at a time on <a href="\/tokens">Tokens and connections<\/a>\./);
  assert.match(h, /<form method="post" action="\/settings\/sign-out-everywhere" class="panel settings-form">\s*<input type="hidden" name="csrf" value="[0-9a-f]+">/);
  assert.match(h, /<label class="choice"><input type="checkbox" name="revoke_connections" value="1"> Also revoke all my connections: agent tokens, connected apps and CLI sign-ins<\/label>/);
  assert.match(h, /<button class="danger">Sign out everywhere<\/button>/);
});

test("sign out everywhere: every browser's session ends at once, this one included, and connections keep working", async () => {
  await connect(U.sofia, "sofia laptop");
  const here = await signIn("acct-sofia@example.test");
  const there = await signIn("acct-sofia@example.test");
  const thereRefresh = there.c.get(RT);
  const hereAccess = here.c.get(AT);
  assert.equal((await get("/", there)).status, 200, "the other browser is signed in before");
  const n = (await stats()).logoutGlobal;
  const r = await post("/settings/sign-out-everywhere", { csrf: await settingsCsrf(here) }, here);
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Signed out everywhere<\/h1>/);
  assert.match(h, /Every session of your account has ended, in every browser, this one included\. Your connections \(agent tokens, connected apps and CLI sign-ins\) still work\. To end them, sign in and revoke them on Tokens and connections\. <a href="\/signin">Sign in<\/a> again\./);
  assert.equal((await stats()).logoutGlobal, n + 1, "Supabase ended every session of the account");
  assert.ok(!here.c.has(AT) && !here.c.has(RT), "this browser's cookies are cleared");
  // The other browser's access token is still within its hour, but the
  // database refuses it now: it is sent to sign in, its cookies cleared.
  const other = await get("/settings", there);
  assert.equal(other.status, 303);
  assert.equal(other.headers.get("location"), `/signin?next=${encodeURIComponent("/settings")}`);
  assert.ok(!there.c.has(AT) && !there.c.has(RT));
  assert.equal((await get("/", new Jar({ [AT]: hereAccess }))).status, 303, "this browser's access token, kept, is refused too");
  assert.equal((await get("/", new Jar({ [RT]: thereRefresh }))).status, 303, "its refresh token is revoked too");
  assert.equal(await live(U.sofia), 2, "connections are separate and still work");
});

test("sign out everywhere: a sign-in afterwards works", async () => {
  await nextSecond();
  const jar = await signIn("acct-sofia@example.test");
  assert.equal((await get("/", jar)).status, 200);
  assert.match(await (await get("/settings", jar)).text(), /<strong>acct-sofia@example\.test<\/strong>/);
});

test("sign out everywhere: with Also revoke all my connections, every live connection of mine is revoked, and nobody else's", async () => {
  await connect(U.tomas, "tomas laptop");
  await connect(U.uma, "uma laptop");
  const jar = await signIn("acct-tomas@example.test");
  const r = await post("/settings/sign-out-everywhere", { csrf: await settingsCsrf(jar), revoke_connections: "1" }, jar);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /All 2 of your connections were revoked too: agent tokens, connected apps and CLI sign-ins stop working now\./);
  assert.equal(await live(U.tomas), 0);
  assert.equal(await live(U.uma), 2);
});

test("sign out everywhere: if Supabase Auth refuses or can't be reached, nothing ends, and the page says where, why and a reference", async () => {
  await nextSecond();
  const here = await signIn("acct-uma@example.test");
  const there = await signIn("acct-uma@example.test");
  for (const [status, want, why] of [
    [400, 502, /The sign-in service refused to end your account’s sessions, so none was ended and no connection revoked/],
    [500, 503, /Reliquary couldn’t reach its sign-in service, so no session was ended and no connection revoked/],
  ]) {
    await fake("/_fail_global_logout", { method: "POST", body: JSON.stringify({ status }) });
    const r = await post("/settings/sign-out-everywhere", { csrf: await settingsCsrf(here), revoke_connections: "1" }, here);
    assert.equal(r.status, want);
    const h = await r.text();
    assert.match(h, /Signing out everywhere/);
    assert.match(h, /sign-out \(Supabase Auth\)/);
    assert.match(h, why);
    assert.match(h, /[0-9a-f]{8}/);
  }
  await fake("/_fail_global_logout", { method: "POST", body: JSON.stringify({ status: 0 }) });
  assert.equal((await get("/", here)).status, 200, "this browser is still signed in");
  assert.equal((await get("/", there)).status, 200, "and so is the other");
  assert.equal(await live(U.uma), 2, "and no connection was revoked");
});

test("sign out everywhere: needs the form token and this site's origin", async () => {
  const jar = await signIn("acct-uma@example.test");
  const n = (await stats()).logoutGlobal;
  assert.equal((await post("/settings/sign-out-everywhere", { revoke_connections: "1" }, jar)).status, 403);
  const r = await fetch(A + "/settings/sign-out-everywhere", {
    method: "POST",
    redirect: "manual",
    headers: { cookie: jar.header, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    body: new URLSearchParams({ csrf: await settingsCsrf(jar), revoke_connections: "1" }).toString(),
  });
  assert.equal(r.status, 403);
  assert.equal((await stats()).logoutGlobal, n);
  assert.equal((await get("/", jar)).status, 200);
  assert.equal(await live(U.uma), 2);
});
