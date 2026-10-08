// Rate limits (src/ratelimit.ts, supabase/migrations/20260925200000_rate_limits.sql),
// against web/test.sh's rate-limit instance: AUTH_MODE=supabase with the
// fake Auth, small limits (RATE_LIMITS in web/test.sh) and client addresses
// from x-real-ip (TRUST_PROXY_IP=1), so each test sends from addresses of
// its own (documentation ranges; test.sh checks none reaches the log).
//
// Every code, token and refresh token seen goes to AUTH_SECRETS_FILE, so
// test.sh checks none reached the server logs.

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { before, test } from "node:test";
import pg from "pg";

const { WEB_RL_URL: RL, WEB_AUTH_PUBLIC_URL: PUBLIC_URL, FAKE_AUTH_URL: FAKE, AUTH_SECRETS_FILE, WEB_URL } = process.env;
const ORIGIN = PUBLIC_URL ? new URL(PUBLIC_URL).origin : "";
const PG_PORT = 54332 + (Number(new URL(WEB_URL ?? "http://127.0.0.1:8791").port) - 8791);
// The rate-limit instance's own database (web/test.sh): no other file's
// counters in it.
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/ratelimits`;
const ANA = "00000000-0000-0000-0000-00000000000a";
const AT = "__Host-rlq_at";
const RT = "__Host-rlq_rt";
const RUN = randomBytes(3).toString("hex");

const remember = (...secrets) => appendFileSync(AUTH_SECRETS_FILE, secrets.filter(Boolean).map((s) => `${s}\n`).join(""));
const sha = (s) => createHash("sha256").update(s).digest("hex");
// A fresh documentation-range address for each call.
let n = 0;
const ip = () => `203.0.113.${(++n % 250) + 1}`;
const ALL_IPS = [];
const addr = () => {
  const a = ip();
  ALL_IPS.push(a);
  return a;
};

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

const get = async (path, jar, from) =>
  jar.take(await fetch(RL + path, { headers: { cookie: jar.header, "x-real-ip": from }, redirect: "manual" }));
const post = async (path, fields, jar, from) =>
  jar.take(
    await fetch(RL + path, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: jar.header, "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "x-real-ip": from },
      body: new URLSearchParams(fields).toString(),
    }),
  );
const csrfOf = (html) => /name="csrf" value="([0-9a-f]+)"/.exec(html)?.[1];
const fake = async (path, init) => (await fetch(FAKE + path, init)).json();
const lastEmail = async (email) => {
  const m = await fake(`/_last_email?email=${encodeURIComponent(email)}`);
  if (m) remember(m.code, m.token_hash);
  return m;
};
const mint = async (body) => (await fake("/_mint", { method: "POST", body: JSON.stringify(body) })).token;

async function sql(q, params = [], role) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    if (!role) return (await db.query(q, params)).rows;
    await db.query("begin");
    await db.query(`set local role ${role.role}`);
    if (role.user) await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: role.user, role: "authenticated" })]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

// A 429 page: Retry-After in seconds, within the window, and the page
// saying when to come back.
async function isTooMany(r, window) {
  assert.equal(r.status, 429);
  const wait = Number(r.headers.get("retry-after"));
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= window, `Retry-After ${r.headers.get("retry-after")}`);
  const h = await r.text();
  assert.match(h, /<h1>Too many requests<\/h1>/);
  assert.match(h, /Try again in \d+ (second|minute|hour)s?, after \d{4}-\d\d-\d\d \d\d:\d\d UTC\./);
  assert.match(h, /href="\/style\.css\?v=/, "the design system's page");
  assert.doesNotMatch(h, /<script/i);
  return wait;
}

// Ask for a code (GET /signin, then POST the email), from one address.
async function askForCode(jar, email, from) {
  const page = await (await get("/signin", jar, from)).text();
  return post("/signin", { csrf: csrfOf(page), email, next: "/" }, jar, from);
}

let ana; // Ana's signed-in jar on the rate-limit instance
before(async () => {
  assert.ok(RL && FAKE && PUBLIC_URL && AUTH_SECRETS_FILE, "run through web/test.sh (the rate-limit instance and the fake Auth)");
  ana = new Jar();
  const from = addr();
  const r = await askForCode(ana, "ana@example.test", from);
  assert.equal(r.status, 200);
  const { code } = await lastEmail("ana@example.test");
  const done = await post("/signin/code", { csrf: csrfOf(await r.text()), email: "ana@example.test", code, next: "/" }, ana, from);
  assert.equal(done.status, 303);
});

// Sign-in ------------------------------------------------------------------

test("rate limits: sign-in codes asked for per address: the third for one email in an hour is refused", async () => {
  const email = `rl-ask-${RUN}@example.test`;
  for (let i = 0; i < 2; i++) assert.equal((await askForCode(new Jar(), email, addr())).status, 200);
  const r = await askForCode(new Jar(), email, addr());
  await isTooMany(r, 3600);
  // Another address is unaffected.
  assert.equal((await askForCode(new Jar(), `rl-ask-other-${RUN}@example.test`, addr())).status, 200);
});

test("rate limits: sign-in codes asked for per IP: the fourth from one address in an hour is refused, whatever the email", async () => {
  const from = addr();
  for (let i = 0; i < 3; i++) assert.equal((await askForCode(new Jar(), `rl-ip-${RUN}-${i}@example.test`, from)).status, 200);
  await isTooMany(await askForCode(new Jar(), `rl-ip-${RUN}-x@example.test`, from), 3600);
});

test("rate limits: codes entered per address: after 2 wrong codes, that email's codes are locked, even the right one", async () => {
  const email = "eve@example.test";
  const jar = new Jar();
  const page = await (await askForCode(jar, email, addr())).text();
  const csrf = csrfOf(page);
  const { code } = await lastEmail(email);
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 2; i++) assert.equal((await post("/signin/code", { csrf, email, code: wrong, next: "/" }, jar, addr())).status, 400);
  const r = await post("/signin/code", { csrf, email, code, next: "/" }, jar, addr());
  await isTooMany(r, 900);
  assert.ok(!r.headers.getSetCookie().some((c) => c.startsWith(AT)), "no session");
});

test("rate limits: codes entered per IP: the fourth guess from one address is refused, across emails", async () => {
  const from = addr();
  const jar = new Jar();
  const page = await (await askForCode(jar, `rl-guess-${RUN}@example.test`, addr())).text();
  const csrf = csrfOf(page);
  for (let i = 0; i < 3; i++) {
    const r = await post("/signin/code", { csrf, email: `rl-guess-${RUN}-${i}@example.test`, code: "123456", next: "/" }, jar, from);
    assert.equal(r.status, 400);
  }
  await isTooMany(await post("/signin/code", { csrf, email: `rl-guess-${RUN}-9@example.test`, code: "123456", next: "/" }, jar, from), 900);
  // The emailed link counts against the same address.
  await isTooMany(await post("/auth/confirm", { csrf, token_hash: "a".repeat(40) }, jar, from), 900);
});

test("rate limits: session refreshes per session: the third in an hour is refused, and the session is kept", async () => {
  const jar = new Jar();
  jar.c = new Map(ana.c);
  const exp = Math.floor(Date.now() / 1000) - 5;
  const expired = await mint({ sub: ANA, session_id: `rl-refresh-${RUN}`, claims: { exp } });
  for (let i = 0; i < 2; i++) {
    jar.c.set(AT, expired);
    const r = await get("/", jar, addr());
    assert.equal(r.status, 200, "refreshed");
    assert.notEqual(jar.c.get(AT), expired);
  }
  jar.c.set(AT, expired);
  const rt = jar.c.get(RT);
  const r = await get("/", jar, addr());
  await isTooMany(r, 3600);
  assert.equal(r.headers.getSetCookie().length, 0, "cookies kept");
  assert.equal(jar.c.get(RT), rt);
});

// What a counter holds for one value, as the app keyed it (src/ratelimit.ts).
async function counted(bucket, kind, value) {
  const [{ s }] = await sql("select private.rate_limit_salt() as s");
  const key = createHmac("sha256", s).update(`${kind}\0${value}`).digest("hex");
  const [{ n }] = await sql("select coalesce(sum(hits), 0)::int as n from private.rate_limits where bucket = $1 and key = $2", [bucket, key]);
  return n;
}
const authRefreshes = async () => (await fake("/_stats")).refresh;

test("rate limits: session refreshes: a cookie that can't be a refresh token is cleared, with no counter written and no call to Auth", async () => {
  const from = addr();
  const junk = "x".repeat(600);
  const jar = new Jar();
  jar.c.set(RT, junk);
  const asked = await authRefreshes();
  const r = await get("/", jar, from);
  assert.equal(r.status, 303);
  assert.ok(r.headers.getSetCookie().some((c) => c.startsWith(`${RT}=;`) && /Max-Age=0/.test(c)), "cleared");
  assert.equal(await authRefreshes(), asked);
  assert.equal(await counted("signin_refresh_ip", "ip", from), 0);
  assert.equal(await counted("signin_refresh_session", "session", `refresh:${junk}`), 0);
});

test("rate limits: session refreshes per IP: the fourth in an hour from one address is refused whatever the cookie, and nothing is cleared or sent on", async () => {
  const from = addr();
  const guess = (i) => {
    const jar = new Jar();
    jar.c.set(RT, `guess${RUN}${i}`);
    return jar;
  };
  for (let i = 0; i < 3; i++) assert.equal((await get("/", guess(i), from)).status, 303, "Auth refuses a made-up token");
  const asked = await authRefreshes();
  const jar = guess(3);
  const r = await get("/", jar, from);
  await isTooMany(r, 3600);
  assert.equal(r.headers.getSetCookie().length, 0, "cookies kept");
  assert.equal(await authRefreshes(), asked, "Auth was not asked");
  assert.equal(await counted("signin_refresh_session", "session", `refresh:guess${RUN}3`), 0, "no row for a value the caller chose");
});

// OAuth ----------------------------------------------------------------------

const oauth = (path, fields, from) =>
  fetch(RL + path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-real-ip": from },
    body: new URLSearchParams(fields).toString(),
  });
const refreshFields = (client) => ({ grant_type: "refresh_token", client_id: client, resource: "http://127.0.0.1:8787/mcp", refresh_token: `rlr_${"0".repeat(64)}` });

async function isTooManyJson(r, window) {
  assert.equal(r.status, 429);
  const wait = Number(r.headers.get("retry-after"));
  assert.ok(Number.isInteger(wait) && wait >= 1 && wait <= window);
  const body = await r.json();
  assert.equal(body.error, "rate_limited");
  return body;
}

test("rate limits: /oauth/token per IP: the third from one address in 10 minutes is refused with Retry-After", async () => {
  const from = addr();
  for (let i = 0; i < 2; i++) assert.equal((await oauth("/oauth/token", refreshFields(`https://c${i}.example/${RUN}`), from)).status, 400);
  const body = await isTooManyJson(await oauth("/oauth/token", refreshFields(`https://c9.example/${RUN}`), from), 600);
  assert.match(body.error_description, /^Too many requests\. Retry after \d+ seconds\.$/);
});

test("rate limits: /oauth/token per client id: the fourth for one client in 10 minutes is refused, from any address", async () => {
  const client = `https://token.example/${RUN}/meta.json`;
  for (let i = 0; i < 3; i++) assert.equal((await oauth("/oauth/token", refreshFields(client), addr())).status, 400);
  const body = await isTooManyJson(await oauth("/oauth/token", refreshFields(client), addr()), 600);
  assert.doesNotMatch(JSON.stringify(body), /token\.example/, "the client id isn't echoed");
});

test("rate limits: /oauth/revoke per IP and per client id", async () => {
  const from = addr();
  const revoke = (client, a) => oauth("/oauth/revoke", { token: `rlo_${"0".repeat(64)}`, client_id: client }, a);
  for (let i = 0; i < 2; i++) assert.equal((await revoke(`https://r${i}.example/${RUN}`, from)).status, 200);
  await isTooManyJson(await revoke(`https://r9.example/${RUN}`, from), 600);
  const client = `https://revoke.example/${RUN}/meta.json`;
  for (let i = 0; i < 3; i++) assert.equal((await revoke(client, addr())).status, 200);
  await isTooManyJson(await revoke(client, addr()), 600);
});

test("rate limits: /oauth/authorize per IP: the third consent page from one address in 10 minutes is refused", async () => {
  const from = addr();
  const q = (i) => `/oauth/authorize?client_id=${encodeURIComponent(`https://a${i}.invalid/${RUN}/meta.json`)}&response_type=code`;
  for (let i = 0; i < 2; i++) assert.notEqual((await get(q(i), ana, from)).status, 429);
  await isTooMany(await get(q(9), ana, from), 600);
});

test("rate limits: client metadata fetches per client host: a second fetch from one host within 10 minutes is refused", async () => {
  // Nothing listens there, so each fetch fails and nothing is cached.
  const client = (i) => `http://127.0.0.1:9/${RUN}/meta-${i}.json`;
  const q = (i) => `/oauth/authorize?client_id=${encodeURIComponent(client(i))}&response_type=code&redirect_uri=${encodeURIComponent("http://127.0.0.1:9/cb")}`;
  const first = await get(q(1), ana, addr());
  assert.equal(first.status, 400);
  assert.match(await first.text(), /couldn’t check the app/);
  await isTooMany(await get(q(2), ana, addr()), 600);
});

// Invites --------------------------------------------------------------------

test("rate limits: invite links per IP: the third opened from one address in an hour is refused, before any lookup", async () => {
  const from = addr();
  const link = () => `/invite?token=rli_${randomBytes(32).toString("hex")}`;
  for (let i = 0; i < 2; i++) assert.equal((await get(link(), ana, from)).status, 404);
  await isTooMany(await get(link(), ana, from), 3600);
  // Another address still gets its answer.
  assert.equal((await get(link(), ana, addr())).status, 404);
});

// The env API ----------------------------------------------------------------

test("rate limits: the env API per CLI grant: the third request in a minute is refused; a token that isn't live is never counted", async () => {
  const origin = PUBLIC_URL;
  const resource = `${origin}/api/env`;
  const client = `${origin}/cli/oauth-client.json`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  const redirect = "http://127.0.0.1:53682/callback";
  const [{ code }] = await sql("select public.create_cli_grant($1, $2, $3, $4, null, false) as code", [client, redirect, resource, challenge], {
    role: "authenticated",
    user: ANA,
  });
  const access = `rle_${randomBytes(32).toString("hex")}`;
  remember(code, access);
  const [{ r }] = await sql("select private.oauth_redeem_code($1, $2, $3, $4, $5, $6, $7) as r",
    [sha(code), client, redirect, resource, verifier, sha(access), sha(`rlr_${randomBytes(32).toString("hex")}`)], { role: "reliquary_web" });
  assert.equal(r, "ok");
  const api = (token) => fetch(`${RL}/api/env/vaults`, { headers: { authorization: `Bearer ${token}`, "x-real-ip": addr() } });
  for (let i = 0; i < 2; i++) assert.equal((await api(access)).status, 200);
  const limited = await api(access);
  assert.equal(limited.status, 429);
  const wait = Number(limited.headers.get("retry-after"));
  assert.ok(wait >= 1 && wait <= 60);
  const body = await limited.json();
  assert.equal(body.error, "rate_limited");
  assert.equal(body.where, "rate limit");
  assert.match(body.message, /retry after \d+ seconds/);
  assert.match(body.ref, /^[0-9a-f]{8}$/);
  const dead = `rle_${randomBytes(32).toString("hex")}`;
  for (let i = 0; i < 4; i++) assert.equal((await api(dead)).status, 401);
});

// Web forms ------------------------------------------------------------------

test("rate limits: form posts per session: the fourth in a minute is refused with a page saying when to retry", async () => {
  const jar = new Jar();
  jar.c = new Map(ana.c);
  const csrf = csrfOf(await (await get("/", jar, addr())).text());
  assert.ok(csrf);
  for (let i = 0; i < 3; i++) assert.equal((await post("/theme", { csrf, theme: "dark", back: "/" }, jar, addr())).status, 303);
  await isTooMany(await post("/theme", { csrf, theme: "dark", back: "/" }, jar, addr()), 60);
  // Pages still load.
  assert.equal((await get("/", jar, addr())).status, 200);
});

// Invites ----------------------------------------------------------------------

test("rate limits: sign-in from an invite link whose lookup is over its limit is a 429 and asks for no code", async () => {
  const from = addr();
  const next = `/invite?token=rli_${"0".repeat(64)}`;
  const email = `rl-invite-${RUN}@example.test`;
  const jar = new Jar();
  // Two lookups an hour: the email page counts one, the first post another.
  const csrf = csrfOf(await (await get(`/signin?next=${encodeURIComponent(next)}`, jar, from)).text());
  assert.equal((await post("/signin", { csrf, email, next }, jar, from)).status, 200);
  const asked = (await fake("/_stats")).otp;
  const r = await post("/signin", { csrf, email, next }, jar, from);
  await isTooMany(r, 3600);
  assert.equal((await fake("/_stats")).otp, asked, "Auth was not asked");
});

// When the counter fails -----------------------------------------------------

test("rate limits: with the counter out of reach, sign-in fails closed and the rest fails open", async () => {
  await sql("revoke execute on function private.rate_limit_hit(text[], text[], int[], int[], int[]) from reliquary_web");
  await sql("revoke execute on function private.rate_limit_token(text, text[], int[], int[], int[]) from reliquary_web");
  try {
    const r = await askForCode(new Jar(), `rl-closed-${RUN}@example.test`, addr());
    assert.equal(r.status, 503);
    assert.match(await r.text(), /Sign-in is unavailable/);
    // Open: the token endpoint answers as it would, with no limit.
    const from = addr();
    for (let i = 0; i < 4; i++) assert.equal((await oauth("/oauth/token", refreshFields(`https://open.example/${RUN}`), from)).status, 400);
  } finally {
    await sql("grant execute on function private.rate_limit_hit(text[], text[], int[], int[], int[]) to reliquary_web");
    await sql("grant execute on function private.rate_limit_token(text, text[], int[], int[], int[]) to reliquary_web");
  }
});

// What is stored ---------------------------------------------------------------

test("rate limits: no IP address or email address is stored: every key is an HMAC", async () => {
  const rows = await sql("select bucket, key from private.rate_limits");
  assert.ok(rows.length > 10);
  const emails = ["ana@example.test", "eve@example.test", `rl-ask-${RUN}@example.test`];
  for (const { key } of rows) {
    assert.match(key, /^[0-9a-f]{64}$/);
    for (const a of ALL_IPS) {
      assert.ok(!key.includes(a));
      assert.notEqual(key, sha(a));
      assert.notEqual(key, sha(`ip\0${a}`));
    }
    for (const e of emails) {
      assert.notEqual(key, sha(e));
      assert.notEqual(key, sha(`email\0${e}`));
    }
  }
  // Nothing else in the table could hold one either.
  const cols = (await sql("select column_name from information_schema.columns where table_schema = 'private' and table_name = 'rate_limits' order by ordinal_position")).map((c) => c.column_name);
  assert.deepEqual(cols, ["bucket", "key", "window_start", "expires_at", "hits"]);
});
