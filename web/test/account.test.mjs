// Account settings with Supabase Auth (src/settings.ts, src/auth.ts):
// signing out everywhere and changing the email address. Against
// web/test.sh's AUTH_MODE=supabase instance A and the fake Auth
// (test/fake-auth.mjs). The database rules are in
// supabase/tests/sign_out_everywhere_test.sql and email_change_test.sql.
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

// ---------------------------------------------------------------------------
// Change of email

const flashOf = (h) => (/<p class="callout (?:info|success|warning|danger) flash" role="(?:status|alert)">([^<]*)<\/p>/.exec(h)?.[1] ?? "");
const flashAfter = async (r, jar) => {
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/settings");
  return flashOf(await (await get("/settings", jar)).text());
};
const confirmLink = async (tokenHash, jar) => {
  remember(tokenHash);
  const page = await (await get(`/auth/confirm?token_hash=${tokenHash}&type=email_change`, jar)).text();
  return post("/auth/confirm", { csrf: csrfOf(page), token_hash: tokenHash, type: "email_change" }, jar);
};

test("change email: Account settings shows my address and a form for a new one, saying what changes and what stays", async () => {
  await account("acct-vera@example.test");
  const jar = await signIn("acct-vera@example.test");
  const h = await (await get("/settings", jar)).text();
  assert.match(h, /<h2 id="email">Email<\/h2>\s*<p><strong>acct-vera@example\.test<\/strong><\/p>/);
  assert.match(h, /<form method="post" action="\/settings\/email" class="panel settings-form">\s*<input type="hidden" name="csrf" value="[0-9a-f]+">\s*<label for="new-email">New email address<\/label>/);
  assert.match(h, /<input id="new-email" type="text" name="new_email" inputmode="email" autocomplete="email"[^>]* maxlength="254" required aria-describedby="new-email-hint">/);
  assert.match(h, /We email a link to the new address to confirm it is yours; nothing changes until you open it\. Afterwards you sign in with the new address\. Your vaults, roles, connections and plan stay as they are, and people who share a vault with you see the new address\. Invites made out to your old address stop working: ask for a new one\./);
  assert.match(h, /<button class="primary">Send confirmation link<\/button>/);
  assert.doesNotMatch(h, /It can’t be changed here/);
  assert.doesNotMatch(h, /Waiting for confirmation/);
});

test("change email: asking emails a link to the new address and one to the current, and the page shows the change waiting", async () => {
  const jar = await signIn("acct-vera@example.test");
  const n = (await stats()).userUpdate;
  const r = await post("/settings/email", { csrf: await settingsCsrf(jar), new_email: "  acct-vera.new@example.test " }, jar);
  assert.equal(await flashAfter(r, jar), "We sent a confirmation link to the new address. Open it to finish the change; until then you sign in with your current address.");
  assert.equal((await stats()).userUpdate, n + 1);
  assert.equal((await lastEmail("acct-vera.new@example.test")).type, "email_change");
  assert.equal((await lastEmail("acct-vera@example.test")).type, "email_change");
  const h = await (await get("/settings", jar)).text();
  assert.match(h, /<div class="callout info" id="email-pending"><p class="callout-title"><strong>Change of email address<\/strong><\/p><p>Waiting for confirmation: <strong>acct-vera\.new@example\.test<\/strong>\. We sent a link to that address <time datetime="[^"]+"[^>]*>[^<]+<\/time>, and one to your current address too if this site asks both\. Open it \(or both\) to finish the change\. Until then you sign in with your current address\.<\/p><\/div>/);
  assert.match(h, /<p><strong>acct-vera@example\.test<\/strong><\/p>/, "the address in use is still the current one");
});

test("change email: the links confirm the change, which lands on Account settings with a notice, and the new address signs in", async () => {
  const { token_hash: current } = await lastEmail("acct-vera@example.test");
  const { token_hash: next } = await lastEmail("acct-vera.new@example.test");
  const jar = new Jar();
  const first = await confirmLink(current, jar);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /One address confirmed/);
  const second = await confirmLink(next, jar);
  assert.equal(second.status, 303);
  assert.equal(second.headers.get("location"), "/settings");
  // Supabase Auth writes the new address to auth.users; the fake can't.
  await sql("update auth.users set email = 'acct-vera.new@example.test' where email = 'acct-vera@example.test'");
  const h = await (await get("/settings", jar)).text();
  assert.equal(flashOf(h), "Your email address is changed: you sign in with the new one from now on, and people who share a vault with you see it.");
  assert.match(h, /<p><strong>acct-vera\.new@example\.test<\/strong><\/p>/);
  assert.doesNotMatch(h, /Waiting for confirmation/);
  const again = await signIn("acct-vera.new@example.test");
  assert.match(await (await get("/settings", again)).text(), /<p><strong>acct-vera\.new@example\.test<\/strong><\/p>/);
});

test("change email: a malformed address, my own or another account's is refused with the reason and a reference, and nothing changes", async () => {
  const jar = await signIn("acct-vera.new@example.test");
  const n = (await stats()).userUpdate;
  const csrf = await settingsCsrf(jar);
  assert.match(await flashAfter(await post("/settings/email", { csrf, new_email: "not an address" }, jar), jar), /^Enter the new address like name@example\.com\. Nothing was changed\. \(ref [0-9a-f]{8}\)$/);
  assert.match(await flashAfter(await post("/settings/email", { csrf, new_email: "ACCT-VERA.NEW@example.test" }, jar), jar), /^That is already your address\. Nothing was changed\. \(ref [0-9a-f]{8}\)$/);
  assert.equal((await stats()).userUpdate, n, "neither reached Supabase Auth");
  assert.match(await flashAfter(await post("/settings/email", { csrf, new_email: "acct-uma@example.test" }, jar), jar), /^That address already belongs to another Reliquary account, so it can’t be yours too\. Nothing was changed\. \(ref [0-9a-f]{8}\)$/);
  const h = await (await get("/settings", jar)).text();
  assert.doesNotMatch(h, /Waiting for confirmation/);
  assert.match(h, /<p><strong>acct-vera\.new@example\.test<\/strong><\/p>/);
});

test("change email: if Supabase Auth can't be reached or limits emails, the page says where, why and a reference", async () => {
  const jar = await signIn("acct-vera.new@example.test");
  try {
    await fake("/_fail_user_update", { method: "POST", body: JSON.stringify({ status: 500 }) });
    const r = await post("/settings/email", { csrf: await settingsCsrf(jar), new_email: "acct-vera.third@example.test" }, jar);
    assert.equal(r.status, 503);
    const h = await r.text();
    assert.match(h, /Changing your email address/);
    assert.match(h, /change of email \(Supabase Auth\)/);
    assert.match(h, /Reliquary couldn’t reach its sign-in service, so no confirmation link was sent and your address is unchanged/);
    await fake("/_fail_user_update", { method: "POST", body: JSON.stringify({ status: 429, body: { code: 429, error_code: "over_email_send_rate_limit", msg: "email rate limit exceeded" } }) });
    const limited = await post("/settings/email", { csrf: await settingsCsrf(jar), new_email: "acct-vera.third@example.test" }, jar);
    assert.match(await flashAfter(limited, jar), /^The sign-in service has sent as many emails as it allows for now, so no link was sent\. Wait an hour, then ask again\. Nothing was changed\. \(ref [0-9a-f]{8}\)$/);
  } finally {
    await fake("/_fail_user_update", { method: "POST", body: JSON.stringify({ status: 0 }) });
  }
});

test("change email: needs the form token and this site's origin", async () => {
  const jar = await signIn("acct-vera.new@example.test");
  const n = (await stats()).userUpdate;
  assert.equal((await post("/settings/email", { new_email: "acct-forged@example.test" }, jar)).status, 403);
  const r = await fetch(A + "/settings/email", {
    method: "POST",
    redirect: "manual",
    headers: { cookie: jar.header, "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    body: new URLSearchParams({ csrf: await settingsCsrf(jar), new_email: "acct-forged@example.test" }).toString(),
  });
  assert.equal(r.status, 403);
  assert.equal((await stats()).userUpdate, n);
});
