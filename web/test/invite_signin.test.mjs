// Invites with Supabase Auth sign-in (src/signin.ts, src/members.ts),
// against web/test.sh's AUTH_MODE=supabase instance A and the fake Auth
// (test/fake-auth.mjs). Ana owns "Invite Signin" and "Invite Signin Two"
// and invites newbie@example.test (no account yet) to each. Sign-ups start
// off, as in the hosted project. (Eve is left alone: vaults.test.mjs needs
// her with no vaults.)
//
// Every invite token and sign-in code seen goes to AUTH_SECRETS_FILE, so
// test.sh checks none reached the server logs.

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";

const { WEB_AUTH_A_URL: A, WEB_AUTH_PUBLIC_URL: PUBLIC_URL, FAKE_AUTH_URL: FAKE, AUTH_SECRETS_FILE, WEB_URL } = process.env;
const ORIGIN = PUBLIC_URL ? new URL(PUBLIC_URL).origin : "";
const PG_PORT = 54332 + (Number(new URL(WEB_URL ?? "http://127.0.0.1:8791").port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const ANA = "00000000-0000-0000-0000-00000000000a";
const RT = "__Host-rlq_rt";

const remember = (...secrets) => appendFileSync(AUTH_SECRETS_FILE, secrets.filter(Boolean).map((s) => `${s}\n`).join(""));

class Jar {
  constructor() {
    this.c = new Map();
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
const signups = (on) => fake("/_signups", { method: "POST", body: JSON.stringify({ on }) });
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

const V = {};
const T = {};
const next = (token) => `/invite?token=${token}`;
const roleOf = async (user, vault = V.id) =>
  (await sql("select role from public.vault_members where vault_id = $1 and user_id = $2", [vault, user]))[0]?.role ?? "none";

// The email step of sign-in from an invite link, in a fresh browser.
async function askForCode(jar, token, email) {
  const r = await get(next(token), jar);
  assert.equal(r.status, 303);
  const page = await (await get(r.headers.get("location"), jar)).text();
  return post("/signin", { csrf: csrfOf(page), email, next: next(token) }, jar);
}

before(async () => {
  assert.ok(A && FAKE && PUBLIC_URL && AUTH_SECRETS_FILE, "run through web/test.sh (supabase-mode instances and the fake Auth)");
  await sql(
    "insert into auth.users (id, email) values ($1, 'ana@example.test') on conflict (id) do nothing",
    [ANA],
  );
  [{ id: V.id }] = await as(ANA, "select public.create_vault('Invite Signin') as id");
  [{ t: T.newbie }] = await as(ANA, "select public.create_invite($1, 'newbie@example.test', 'editor') as t", [V.id]);
  [{ id: V.two }] = await as(ANA, "select public.create_vault('Invite Signin Two') as id");
  [{ t: T.two }] = await as(ANA, "select public.create_invite($1, 'newbie@example.test', 'viewer') as t", [V.two]);
  remember(T.newbie, T.two);
  await signups(false);
});

after(async () => {
  await signups(false);
});

test("invite sign-in: a signed-out invite link sends you to sign in and back to it", async () => {
  const jar = new Jar();
  const r = await get(next(T.newbie), jar);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), `/signin?next=${encodeURIComponent(next(T.newbie))}`);
  const page = await (await get(r.headers.get("location"), jar)).text();
  assert.match(page, /<h1>Join Invite Signin<\/h1>/);
  assert.match(page, /Sign in with the address the invite was sent to, <strong>n•••@example\.test<\/strong>/);
  assert.match(page, /New to Reliquary\? The same step makes your account\./);
  assert.doesNotMatch(page, /newbie@/);
  assert.doesNotMatch(page, /Reliquary is invite-only/);
});

test("invite sign-in: any other address signs in as usual and never makes an account", async () => {
  const r = await askForCode(new Jar(), T.newbie, "stranger@example.test");
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<h1>Check your email<\/h1>/);
  assert.equal((await stats()).lastCreateUser, false);
});

test("invite sign-in: with sign-ups off, the invited address is told plainly it has no account yet", async () => {
  const r = await askForCode(new Jar(), T.newbie, "Newbie@Example.test");
  assert.equal(r.status, 403);
  const h = await r.text();
  assert.match(h, /<h1>No account yet<\/h1>/);
  assert.match(h, /Ask the person who invited you to have an account made for that address, then open the invite link again\./);
  assert.equal((await stats()).lastCreateUser, true);
  assert.equal(await fake("/_user?email=newbie%40example.test"), null);
});

test("invite sign-in: with sign-ups on, the invited address gets an account, signs in and joins", async () => {
  await signups(true);
  const jar = new Jar();
  const r = await askForCode(jar, T.newbie, "newbie@example.test");
  assert.equal(r.status, 200);
  const codePage = await r.text();
  assert.equal((await stats()).lastCreateUser, true);
  await signups(false);
  const { id } = await fake("/_user?email=newbie%40example.test");
  // What Supabase does when it makes the account.
  await sql("insert into auth.users (id, email) values ($1, 'newbie@example.test')", [id]);
  const { code } = await lastEmail("newbie@example.test");
  const done = await post("/signin/code", { csrf: csrfOf(codePage), email: "newbie@example.test", code, next: next(T.newbie) }, jar);
  assert.equal(done.status, 303);
  assert.equal(done.headers.get("location"), next(T.newbie));
  const invite = await (await get(next(T.newbie), jar)).text();
  assert.match(invite, /<button class="primary">Join Invite Signin<\/button>/);
  const joined = await post("/invite", { csrf: csrfOf(invite), token: T.newbie }, jar);
  assert.equal(joined.status, 303);
  assert.equal(joined.headers.get("location"), `/v/${V.id}`);
  assert.equal(await roleOf(id), "editor");
});

test("invite sign-in: an address that already has an account signs in and joins, with sign-ups off", async () => {
  const jar = new Jar();
  const { id } = await fake("/_user?email=newbie%40example.test");
  const r = await askForCode(jar, T.two, "newbie@example.test");
  assert.equal(r.status, 200);
  const codePage = await r.text();
  assert.deepEqual(await fake("/_user?email=newbie%40example.test"), { id }, "no second account");
  const { code } = await lastEmail("newbie@example.test");
  const done = await post("/signin/code", { csrf: csrfOf(codePage), email: "newbie@example.test", code, next: next(T.two) }, jar);
  assert.equal(done.headers.get("location"), next(T.two));
  const invite = await (await get(next(T.two), jar)).text();
  const joined = await post("/invite", { csrf: csrfOf(invite), token: T.two }, jar);
  assert.equal(joined.status, 303);
  assert.equal(await roleOf(id, V.two), "viewer");
});

test("invite sign-in: a used invite no longer lets sign-in make an account", async () => {
  const jar = new Jar();
  const r = await get(`/signin?next=${encodeURIComponent(next(T.newbie))}`, jar);
  const page = await r.text();
  assert.match(page, /<h1>Sign in to Reliquary<\/h1>/);
  await post("/signin", { csrf: csrfOf(page), email: "newbie@example.test", next: next(T.newbie) }, jar);
  assert.equal((await stats()).lastCreateUser, false);
});
