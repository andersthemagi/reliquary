// Signup notices (src/signups.ts): the operator is emailed when an account
// confirms its address, with Resend faked by a server in this file
// (RESEND_API_URL). The database's rules are in
// supabase/tests/signup_notices_test.sql.
//
// This file starts its own web servers from dist/ (local sign-in), each
// signed in as a new account it makes. Every account already in the
// database is marked notified first, so only this file's accounts are sent.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const KEY = `re_test_${randomBytes(16).toString("hex")}`;
const FROM = "Reliquary <no-reply@notify.example.test>";
const TO = "ops@signups.example.test";

const servers = [];
const calls = [];
let answers = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    const a = answers.shift() ?? { status: 200, json: { id: randomUUID() } };
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

// A new confirmed account, signed in on a server of its own with `env`.
async function join(email, env) {
  const user = randomUUID();
  await sql("insert into auth.users (id, email) values ($1, $2)", [user, email]);
  const s = await start(env, user);
  return { user, s };
}

async function start(env, user) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/signup-login-${process.pid}-${port}`;
  const base = { ...process.env };
  for (const k of ["RESEND_API_KEY", "EMAIL_FROM", "RESEND_API_URL", "FEEDBACK_EMAIL", "NETLIFY", "SELF_HOSTED"]) delete base[k];
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...base, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const s = { origin, cookie: "", log: "", child };
  child.stdout.on("data", (d) => (s.log += d));
  child.stderr.on("data", (d) => (s.log += d));
  servers.push(child);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];
  return s;
}

const page = async (s, path = "/") => (await fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" })).text();
const notice = async (user) => (await sql("select notified_at, attempts from private.signup_notices where user_id = $1", [user]))[0];
const waitFor = async (cond, what) => {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const signups = () => calls.filter((c) => c.url === "/emails" && c.body.tags?.[0]?.value === "signup");
let MAIL;

before(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  MAIL = { RESEND_API_KEY: KEY, EMAIL_FROM: FROM, RESEND_API_URL: `http://127.0.0.1:${fake.address().port}`, FEEDBACK_EMAIL: TO };
  await sql("insert into private.signup_notices (user_id, notified_at) select id, now() from auth.users on conflict (user_id) do update set notified_at = now()");
});

after(() => {
  for (const child of servers) child.kill();
  fake.close();
});

test("signup notices: a new account's first page emails the operator once, with its address, when, where it stands and the command to let it in", async () => {
  calls.length = 0;
  answers = [];
  const email = `o'neil+${randomBytes(3).toString("hex")}@example.test`;
  const { user, s } = await join(email, MAIL);
  await page(s);
  await waitFor(async () => (await notice(user))?.notified_at, "the notice");
  const [{ open_per_day: pace, invite_only: inviteOnly }] = await sql("select open_per_day, invite_only from private.settings");
  const [{ place, waiting }] = await sql("select (select place from private.line() where user_id = $1) as place, (select count(*) from private.line()) as waiting", [user]);
  const sent = signups();
  assert.equal(sent.length, 1);
  const { headers, body: b } = sent[0];
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.match(headers["idempotency-key"], /^signup\/[0-9a-f]{40}$/);
  assert.equal(b.from, FROM);
  assert.deepEqual(b.to, [TO]);
  assert.equal(b.subject, `Reliquary: new account, ${email}`);
  const escaped = email.replace("'", "&#39;");
  assert.match(b.html, new RegExp(`<td[^>]*>${escaped.replace("+", "\\+")}</td>`));
  assert.match(b.html, /Confirmed<\/th><td[^>]*>\d{4}-\d\d-\d\d \d\d:\d\d UTC</);
  const status = inviteOnly
    ? "Waiting: Reliquary is invite-only, so it can&#39;t create vaults until it&#39;s admitted or accepts an invite."
    : pace === null
      ? "Let in: sign-up is open with no line, so it can create vaults now."
      : `Number ${place} in line of ${waiting} waiting; the line lets in ${pace} a day.`;
  assert.ok(b.html.includes(status), `status ${status} in ${b.html}`);
  assert.ok(b.html.includes(`<code>scripts/plan.sh admit ${escaped}</code>`));
  assert.equal(s.log.includes(email) || s.log.includes(KEY), false, "no address or key in the log");
  // Another instance's first page sends nothing more.
  await page(await start(MAIL, user));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(signups().length, 1);
});

test("signup notices: when Resend fails nothing is marked sent, and the notice goes once its claim lapses", async () => {
  calls.length = 0;
  answers = [{ status: 500, json: { name: "internal_server_error", message: "down" } }, { status: 500, json: { name: "internal_server_error", message: "down" } }];
  const { user, s } = await join(`down-${randomBytes(3).toString("hex")}@example.test`, MAIL);
  await page(s);
  await waitFor(async () => signups().length >= 2, "two tries");
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await notice(user), { notified_at: null, attempts: 1 });
  assert.match(s.log, /failure ref=[0-9a-f]{8} .*"where":"email sender \(Resend\)","why":"Resend answered 500/);
  await sql("update private.signup_notices set claimed_at = now() - interval '11 minutes' where user_id = $1", [user]);
  await page(await start(MAIL, user));
  await waitFor(async () => (await notice(user))?.notified_at, "the retried notice");
  assert.equal((await notice(user)).attempts, 2);
});

test("signup notices: without FEEDBACK_EMAIL outside the hosted service, nothing is emailed and nothing is claimed", async () => {
  for (const child of servers) child.kill();
  calls.length = 0;
  const { user, s } = await join(`quiet-${randomBytes(3).toString("hex")}@example.test`, { ...MAIL, FEEDBACK_EMAIL: "" });
  await page(s);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(signups().length, 0);
  assert.equal(await notice(user), undefined);
});
