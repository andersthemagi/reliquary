// Vault invites by email (src/mailer.ts, deliverInvite in src/invites.ts):
// Resend's HTTP API, faked here by a server in this file (RESEND_API_URL),
// never the real one.
//
// This file starts its own web servers from dist/ (local sign-in), all as
// Rosa, who owns "Invite Mail" and whom no other file uses: one with a
// sender (RESEND_API_KEY and EMAIL_FROM), one with none, one with only
// EMAIL_FROM, and one whose Resend doesn't answer. The key is made up per
// run; it must reach the fake's Authorization header and nothing else.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const ROSA = "00000000-0000-0000-0000-00000000e5a1";
const KEY = `re_test_${randomBytes(16).toString("hex")}`;
const FROM = "Reliquary <no-reply@notify.example.test>";
const VAULT_NAME = `<b>"Mail" & co</b>`;

const servers = [];
const pages = []; // every page this file saw: none may hold the key
let vault = "";

// ---------------------------------------------------------------------------
// The fake Resend: records each request, answers from a queue (default 200).

const calls = [];
let answers = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    calls.push({ method: req.method, url: req.url, headers: req.headers, body });
    const a = answers.shift() ?? { status: 200, json: { id: `4ef9a417-02e9-4d39-ad75-${randomBytes(6).toString("hex")}` } };
    res.writeHead(a.status, { "content-type": "application/json" });
    res.end(JSON.stringify(a.json));
  });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function sql(q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
}

async function start(env) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/invite-email-login-${process.pid}-${port}`;
  const base = { ...process.env };
  for (const k of ["RESEND_API_KEY", "EMAIL_FROM", "RESEND_API_URL", "VERCEL", "SELF_HOSTED"]) delete base[k];
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...base, DATABASE_URL: WEB_DB, LOCAL_USER_ID: ROSA, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const s = { origin, cookie: "", log: "" };
  child.stdout.on("data", (d) => (s.log += d));
  child.stderr.on("data", (d) => (s.log += d));
  servers.push({ child, s });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];
  return s;
}

const S = {};
const page = async (s, path) => {
  const h = await (await fetch(s.origin + path, { headers: { cookie: s.cookie } })).text();
  pages.push(h);
  return h;
};
const invite = async (s, email, role = "editor") => {
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page(s, "/"))[1];
  const r = await fetch(`${s.origin}/v/${vault}/config/members/invite`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin },
    body: new URLSearchParams({ csrf, email, role }).toString(),
  });
  assert.equal(r.status, 200);
  const h = await r.text();
  pages.push(h);
  return h;
};
const tokenOf = (h) => /\/invite\?token=(rli_[0-9a-f]{64})/.exec(h)?.[1];
const invited = async (email) =>
  (await sql("select count(*)::int as n from private.vault_invites where vault_id = $1 and email = $2", [vault, email]))[0].n;

before(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${fake.address().port}`;
  await sql(`insert into auth.users (id, email) values ($1, 'rosa@example.test') on conflict (id) do nothing`, [ROSA]);
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ROSA, role: "authenticated" })]);
    vault = (await db.query("select public.create_vault($1) as id", [VAULT_NAME])).rows[0].id;
    await db.query("commit");
  } finally {
    await db.end();
  }
  S.mail = await start({ RESEND_API_KEY: KEY, EMAIL_FROM: FROM, RESEND_API_URL: api });
  S.none = await start({ RESEND_API_URL: api });
  S.half = await start({ EMAIL_FROM: FROM, RESEND_API_URL: api });
  S.down = await start({ RESEND_API_KEY: KEY, EMAIL_FROM: FROM, RESEND_API_URL: `http://127.0.0.1:${await freePort()}` });
});

after(() => {
  for (const { child } of servers) child.kill();
  fake.close();
});

// ---------------------------------------------------------------------------

test("invite email: with a sender, the invite is emailed once through Resend with the link, escaped, and the page doesn't show the link", async () => {
  calls.length = 0;
  answers = [];
  const h = await invite(S.mail, " Una@Example.test ", "viewer");
  assert.equal(calls.length, 1, "one request to Resend");
  const c = calls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/emails");
  assert.equal(c.headers.authorization, `Bearer ${KEY}`);
  assert.equal(c.headers["content-type"], "application/json");
  assert.match(c.headers["idempotency-key"], /^vault-invite\/[0-9a-f]{40}$/);
  const b = JSON.parse(c.body);
  assert.equal(b.from, FROM);
  assert.deepEqual(b.to, ["una@example.test"]);
  assert.equal(b.subject.includes(VAULT_NAME), true, "the subject names the vault, as plain text");
  assert.deepEqual(b.tags, [{ name: "kind", value: "vault-invite" }]);
  const token = tokenOf(b.html);
  assert.ok(token, "the email holds the invite link");
  assert.match(b.html, new RegExp(`${S.mail.origin.replace(/\./g, "\\.")}/invite\\?token=${token}`));
  assert.equal(c.headers["idempotency-key"].includes(token.slice(4, 20)), false, "the idempotency key isn't the token");
  assert.match(b.html, /&lt;b&gt;&quot;Mail&quot; &amp; co&lt;\/b&gt;/, "the vault name is escaped in the HTML");
  assert.equal(b.html.includes(VAULT_NAME), false);
  assert.match(b.html, /Viewer|viewer/);
  assert.doesNotMatch(b.html, /\{\{ \./, "no placeholder left");
  // The page: emailed, and the link isn't shown.
  assert.match(h, /We emailed them the link\./);
  assert.equal(tokenOf(h), undefined, "the link isn't on the page");
  assert.equal(await invited("una@example.test"), 1);
  // The invite form says it will email.
  assert.match(await page(S.mail, `/v/${vault}/config/members/invite`), /We’ll email them a link/);
});

test("invite email: a 5xx from Resend is retried once with the same idempotency key, so it is sent once", async () => {
  calls.length = 0;
  answers = [{ status: 500, json: { name: "application_error", message: "Unexpected error", statusCode: 500 } }];
  const h = await invite(S.mail, "vic@example.test");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers["idempotency-key"], calls[1].headers["idempotency-key"]);
  assert.equal(calls[0].body, calls[1].body);
  assert.match(h, /We emailed them the link\./);
});

test("invite email: each invite has its own idempotency key", async () => {
  calls.length = 0;
  answers = [];
  await invite(S.mail, "wes@example.test");
  await invite(S.mail, "xia@example.test");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].headers["idempotency-key"], calls[1].headers["idempotency-key"]);
});

test("invite email: when Resend refuses, the invite is kept and the page shows the link, what failed, where, why and a reference in the log", async () => {
  calls.length = 0;
  answers = [{ status: 403, json: { name: "validation_error", message: "The notify.example.test domain is not verified.", statusCode: 403 } }];
  const h = await invite(S.mail, "yan@example.test");
  assert.equal(calls.length, 1, "a 4xx isn't retried");
  assert.equal(await invited("yan@example.test"), 1, "the invite is kept");
  const token = tokenOf(h);
  assert.ok(token, "the link is shown to copy");
  assert.match(h, /<div class="callout warning reveal" role="status" id="invite-link">/);
  assert.match(h, /The invite is made, but we couldn’t email it\./);
  const m = /Emailing the invite failed: Resend answered 403 \(validation_error\): The notify\.example\.test domain is not verified \(where: email sender \(Resend\); ref ([0-9a-f]{8})\)\./.exec(h);
  assert.ok(m, "what, why, where and ref");
  assert.match(h, /Copy this link and send it to them yourself\./);
  await new Promise((r) => setTimeout(r, 100));
  assert.match(S.mail.log, new RegExp(`failure ref=${m[1]} .*"where":"email sender \\(Resend\\)".*"code":"validation_error"`));
});

test("invite email: when Resend can't be reached, the invite is kept and the page shows the link and the network reason with a reference", async () => {
  const h = await invite(S.down, "zed@example.test");
  assert.equal(await invited("zed@example.test"), 1);
  assert.ok(tokenOf(h));
  assert.match(h, /Emailing the invite failed: Resend didn’t answer: connection refused \(ECONNREFUSED\) \(where: email sender \(Resend\); ref [0-9a-f]{8}\)\./);
});

test("invite email: without a sender nothing is sent, and the page shows the link and says it wasn't emailed", async () => {
  calls.length = 0;
  const h = await invite(S.none, "abe@example.test");
  assert.ok(tokenOf(h));
  assert.match(h, /This link wasn’t emailed: no email sender is set up on this server \(RESEND_API_KEY and EMAIL_FROM\)\./);
  assert.match(await page(S.none, `/v/${vault}/config/members/invite`), /You’ll get a link to send them\./);
  const half = await invite(S.half, "bea@example.test");
  assert.ok(tokenOf(half));
  assert.match(half, /This link wasn’t emailed: EMAIL_FROM is set but RESEND_API_KEY isn’t\./);
  assert.equal(calls.length, 0, "no call to Resend");
  assert.match(S.half.log, /Invite email is off: EMAIL_FROM is set but RESEND_API_KEY isn’t/);
});

test("invite email: the key, the link's token and the invited address never reach a server log or a page", async () => {
  await new Promise((r) => setTimeout(r, 100));
  const logs = servers.map(({ s }) => s.log).join("\n");
  assert.equal(logs.includes(KEY), false, "the key is in a log");
  assert.equal(pages.some((h) => h.includes(KEY)), false, "the key is on a page");
  assert.doesNotMatch(logs, /rli_[0-9a-f]/, "a token is in a log");
  assert.doesNotMatch(logs, /@example\.test/, "an address is in a log");
  assert.match(S.mail.log, /email sent kind=vault-invite resend_id=4ef9a417-/);
  // Each email's body went only to Resend: no token from one is in a log.
  for (const c of calls) assert.equal(logs.includes(tokenOf(c.body) ?? "none"), false);
});

test("invite email: RESEND_API_URL is honoured only outside Vercel and self-hosting, and bad settings turn email off, naming the setting, never a value", async () => {
  const { readMailer } = await import("../dist/mailer.js");
  const on = { RESEND_API_KEY: KEY, EMAIL_FROM: FROM, RESEND_API_URL: "http://127.0.0.1:9/" };
  assert.equal(readMailer(on).config.api, "http://127.0.0.1:9");
  for (const strict of [{ VERCEL: "1" }, { SELF_HOSTED: "1" }]) {
    const r = readMailer({ ...on, ...strict });
    assert.equal(r.config.api, "https://api.resend.com");
    assert.match(r.warnings.join("\n"), /RESEND_API_URL is ignored with (VERCEL|SELF_HOSTED) set/);
  }
  const cases = [
    [{ RESEND_API_KEY: KEY }, /RESEND_API_KEY is set but EMAIL_FROM isn’t/],
    [{ RESEND_API_KEY: KEY, EMAIL_FROM: "Reliquary no-reply at example" }, /EMAIL_FROM isn’t an address/],
    [{ RESEND_API_KEY: "<from Resend: API Keys>", EMAIL_FROM: FROM }, /RESEND_API_KEY has a space/],
  ];
  for (const [env, why] of cases) {
    const r = readMailer(env);
    assert.equal(r.config.on, false);
    assert.match(r.config.why, why);
    assert.equal(r.warnings.join("\n").includes(KEY), false, "a warning shows the key");
  }
  assert.equal(readMailer({}).warnings.length, 0, "no sender, no warning");
  assert.equal(readMailer({ RESEND_API_KEY: KEY, EMAIL_FROM: "no-reply@notify.example.test" }).config.on, true);
});
