// Feedback in the web UI (src/feedback.ts, the Feedback button in
// src/html.ts) and the operator's email notices, with Resend faked by a
// server in this file (RESEND_API_URL), never the real one. The database's
// rules are in supabase/tests/feedback_test.sql.
//
// This file starts its own web servers from dist/ (local sign-in), all as
// Fern, whom no other file uses, and who owns "Fern's <b>notes</b>": one with
// a sender and FEEDBACK_EMAIL, one with a sender and no FEEDBACK_EMAIL, and a
// fresh one with a sender for the page-load pickup. Oona is another person,
// who must see none of Fern's feedback.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const FERN = "00000000-0000-0000-0000-00000000fee1";
const OONA = "00000000-0000-0000-0000-00000000fee2";
const KEY = `re_test_${randomBytes(16).toString("hex")}`;
const FROM = "Reliquary <no-reply@notify.example.test>";
const TO = "ops@feedback.example.test";
const VAULT_NAME = "Fern's <b>notes</b>";

const servers = [];
let vault = "";
let otherVault = "";

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

// q as `who`, in person or (with an agent name) as their agent.
async function asUser(who, q, params = [], agent) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    const claims = { sub: who, role: "authenticated", ...(agent ? { act: { sub: "agent-x", name: agent } } : {}) };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const rows = (await db.query(q, params)).rows;
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

async function start(env, user = FERN) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/feedback-login-${process.pid}-${port}`;
  const base = { ...process.env };
  for (const k of ["RESEND_API_KEY", "EMAIL_FROM", "RESEND_API_URL", "FEEDBACK_EMAIL", "VERCEL", "SELF_HOSTED"]) delete base[k];
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...base, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "", ...env },
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
const get = (s, path) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (s, path) => (await get(s, path)).text();
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
const post = async (s, path, fields, headers = {}) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const send = async (s, fields) => post(s, "/feedback", { csrf: csrfOf(await page(s, "/feedback")), ...fields });
const mine = async (who = FERN) => sql("select * from public.feedback where user_id = $1 order by created_at", [who]);
const waitFor = async (cond, what) => {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};

before(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const api = `http://127.0.0.1:${fake.address().port}`;
  await sql(`insert into auth.users (id, email) values ($1, 'fern@example.test'), ($2, 'oona@example.test') on conflict (id) do nothing`, [FERN, OONA]);
  vault = (await asUser(FERN, "select public.create_vault($1) as id", [VAULT_NAME]))[0].id;
  otherVault = (await asUser(OONA, "select public.create_vault('Oona only') as id"))[0].id;
  S.mail = await start({ RESEND_API_KEY: KEY, EMAIL_FROM: FROM, RESEND_API_URL: api, FEEDBACK_EMAIL: TO });
  S.nobody = await start({ RESEND_API_KEY: KEY, EMAIL_FROM: FROM, RESEND_API_URL: api });
});

after(() => {
  for (const { child } of servers) child.kill();
  fake.close();
});

// ---------------------------------------------------------------------------
// The top bar and the page

test("feedback page: the top bar has a Feedback button between search and the inbox, with a short form that sends this page", async () => {
  const h = await page(S.mail, `/v/${vault}`);
  const order = ['action="/search"', '<details class="menu-wrap feedback-pop">', '<details class="menu-wrap inbox">', '<details class="account menu-wrap">'].map((x) => h.indexOf(x));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), `in order: ${order}`);
  const pop = h.slice(order[1], order[2]);
  assert.match(pop, /<span class="feedback-label">Feedback<\/span><\/summary>/);
  assert.match(pop, /<form method="post" action="\/feedback" class="feedback-form">/);
  assert.match(pop, /<input type="hidden" name="csrf" value="[0-9a-f]+"><input type="hidden" name="page" value="\/v\/[0-9a-f-]{36}">/);
  assert.deepEqual([...pop.matchAll(/name="kind" value="(\w+)"/g)].map((m) => m[1]), ["bug", "idea", "question", "other"]);
  assert.match(pop, /<textarea id="feedback-pop-message" name="message" rows="4" required maxlength="5000"/);
  assert.match(pop, /<input type="checkbox" name="include_page" value="1" checked> Include this page/);
  assert.match(pop, /<a href="\/feedback">Your feedback<\/a>/);
  assert.match(pop, /Never paste secrets, tokens or variable values\./);
  assert.doesNotMatch(h, /<script/);
});

test("feedback page: with nothing sent, the page has the form at the top, Send in its header, and says what will show up", async () => {
  const h = await page(S.nobody, "/feedback");
  assert.match(h, /<h1>Feedback<\/h1>/);
  assert.ok(h.indexOf('<button class="primary" form="feedback-form">Send feedback</button>') < h.indexOf('<form method="post" action="/feedback" id="feedback-form"'));
  assert.match(h, /<strong>Nothing sent yet<\/strong>/);
  assert.match(h, new RegExp(`<option value="${vault}">Fern&#39;s &lt;b&gt;notes&lt;/b&gt;</option>`));
  assert.match(h, /aria-current="page"><svg[^>]*><path[^>]*\/><\/svg><span class="feedback-label">/, "the button is marked current");
});

test("feedback page: sending from the top bar stores it with the page and its vault, flashes success and lists it as New", async () => {
  calls.length = 0;
  const h0 = await page(S.mail, `/v/${vault}/file?path=notes.md`);
  const r = await post(S.mail, "/feedback", {
    csrf: csrfOf(h0), page: `/v/${vault}/file?path=notes.md`, include_page: "1", kind: "bug",
    message: "  The <em>diff</em> view drops a line.\nSteps: open a file.  ",
  });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/feedback");
  const rows = await mine();
  const f = rows.at(-1);
  assert.deepEqual(
    { kind: f.kind, message: f.message, vault: f.vault_id, context: f.context, source: f.source, agent: f.agent, status: f.status },
    { kind: "bug", message: "The <em>diff</em> view drops a line.\nSteps: open a file.", vault, context: `/v/${vault}/file?path=notes.md`, source: "web", agent: null, status: "new" },
  );
  const h = await page(S.mail, "/feedback");
  assert.match(h, new RegExp(`class="callout success flash" role="status">Sent\\. Your bug report \\(${f.id.slice(0, 8)}\\) went to the people who run this Reliquary`));
  assert.match(h, /<h2 id="sent">What you’ve sent<\/h2>/);
  assert.match(h, /<p class="feedback-text">The &lt;em&gt;diff&lt;\/em&gt; view drops a line\.\nSteps: open a file\.<\/p>/);
  assert.match(h, /Vault Fern&#39;s &lt;b&gt;notes&lt;\/b&gt;/);
  assert.match(h, /<td data-label="Status"><span class="badge" title="Sent; not read yet">New<\/span><\/td>/);
  assert.match(h, /<td data-label="Via">Web UI<\/td>/);
});

test("feedback page: without Include this page, neither the page nor its vault is sent", async () => {
  const h0 = await page(S.nobody, `/v/${vault}`);
  const r = await post(S.nobody, "/feedback", { csrf: csrfOf(h0), page: `/v/${vault}`, kind: "idea", message: "No page, please." });
  assert.equal(r.status, 303);
  const f = (await mine()).at(-1);
  assert.equal(f.message, "No page, please.");
  assert.equal(f.context, null);
  assert.equal(f.vault_id, null);
});

test("feedback page: the account menu's Send feedback opens the page with the page it was on, which Include the page you came from sends", async () => {
  const h = await page(S.nobody, "/activity?person=me");
  assert.match(h, /<li><a href="\/feedback\?from=%2Factivity%3Fperson%3Dme">Send feedback<\/a><\/li>/);
  const f = await page(S.nobody, "/feedback?from=%2Factivity%3Fperson%3Dme");
  assert.match(f, /<input type="hidden" name="page" value="\/activity\?person=me">/);
  assert.match(f, /<input type="checkbox" name="include_page" value="1" checked> <span>Include the page you came from <code>\/activity\?person=me<\/code>/);
  assert.doesNotMatch(await page(S.nobody, "/feedback?from=https%3A%2F%2Fevil.example%2F"), /Include the page you came from/, "only a local path");
  const r = await post(S.nobody, "/feedback", { csrf: csrfOf(f), page: "/activity?person=me", include_page: "1", vault: "", kind: "question", message: "From the account menu." });
  assert.equal(r.status, 303);
  const row = (await mine()).at(-1);
  assert.deepEqual({ message: row.message, context: row.context, vault: row.vault_id }, { message: "From the account menu.", context: "/activity?person=me", vault: null });
});

test("feedback page: a refusal comes back with the reason and a reference, the message kept, and nothing stored", async () => {
  const before = (await mine()).length;
  const cases = [
    [{ kind: "", message: "no kind" }, /choose what kind of feedback this is: bug, idea, question or other/i],
    [{ kind: "bug", message: "   " }, /Write a message: feedback can&#39;t be empty/],
    [{ kind: "bug", message: "not my vault", vault: otherVault }, /no vault with that id is available to you/i],
    [{ kind: "bug", message: "not a vault id", vault: "abc" }, /That vault isn’t one of yours/],
    [{ kind: "bug", message: "nul\u0000here" }, /The message has a NUL character in it/],
  ];
  for (const [fields, why] of cases) {
    const r = await send(S.mail, fields);
    assert.equal(r.status, 400, JSON.stringify(fields));
    const h = await r.text();
    assert.match(h, /<div class="callout danger" role="alert"><p class="callout-title"><strong>Not sent<\/strong><\/p><p>[^<]*\(ref [0-9a-f]{8}\)<\/p><\/div>/);
    assert.match(h, why);
    const kept = fields.message.replace("\u0000", "").trim();
    if (kept) assert.ok(h.includes(kept), `the message is kept: ${kept}`);
  }
  const long = await send(S.mail, { kind: "bug", message: "x".repeat(5001) });
  assert.equal(long.status, 303, "an over-long field goes back with the reason, as every form does");
  assert.equal((await mine()).length, before);
});

test("feedback page: sending needs the form token and this site's origin", async () => {
  const before = (await mine()).length;
  assert.equal((await post(S.mail, "/feedback", { kind: "bug", message: "no token" })).status, 403);
  const csrf = csrfOf(await page(S.mail, "/feedback"));
  assert.equal((await post(S.mail, "/feedback", { csrf, kind: "bug", message: "other origin" }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await mine()).length, before);
});

test("feedback page: the operator's status and reply show on the page; another person sees none of it", async () => {
  const f = (await mine()).find((x) => x.message.startsWith("The <em>diff</em>"));
  await sql("select private.set_feedback_status($1, 'planned'), private.set_feedback_reply($1, $2)", [f.id, "Thanks <b>Fern</b>, next week."]);
  const h = await page(S.mail, "/feedback");
  assert.match(h, /<span class="badge attention" title="The operator plans to act on it">Planned<\/span>/);
  assert.match(h, /<p class="feedback-text">Thanks &lt;b&gt;Fern&lt;\/b&gt;, next week\.<\/p>/);
  const oona = await start({}, OONA);
  const o = await page(oona, "/feedback");
  assert.match(o, /Nothing sent yet/);
  assert.doesNotMatch(o, /diff<\/em>|drops a line|Thanks/);
});

test("feedback page: what an agent sent is listed too, with the agent's name", async () => {
  await asUser(FERN, "select public.send_feedback('question', 'Sent by the agent.', null, null)", [], "Claude Code");
  const h = await page(S.nobody, "/feedback");
  assert.match(h, /<p class="feedback-text">Sent by the agent\.<\/p>[\s\S]*?<td data-label="Via">Agent: Claude Code<\/td>/);
});

// ---------------------------------------------------------------------------
// Notices

const noticesTo = () => calls.filter((c) => c.url === "/emails" && JSON.parse(c.body).tags?.[0]?.value === "feedback");

test("feedback notices: with a sender and FEEDBACK_EMAIL, the operator is emailed the kind, the first lines and the sender's email, once", async () => {
  calls.length = 0;
  answers = [];
  const r = await send(S.mail, { kind: "idea", message: "Line one <b>bold</b>\nLine two", vault });
  assert.equal(r.status, 303);
  const f = (await mine()).at(-1);
  await waitFor(async () => (await sql("select notified_at from public.feedback where id = $1", [f.id]))[0].notified_at !== null, "the notice");
  const sent = noticesTo().filter((c) => JSON.parse(c.body).html.includes(f.id));
  assert.equal(sent.length, 1);
  const c = sent[0];
  assert.equal(c.headers.authorization, `Bearer ${KEY}`);
  assert.match(c.headers["idempotency-key"], /^feedback\/[0-9a-f]{40}$/);
  const b = JSON.parse(c.body);
  assert.equal(b.from, FROM);
  assert.deepEqual(b.to, [TO]);
  assert.equal(b.subject, "Reliquary feedback (idea): Line one <b>bold</b>");
  assert.match(b.html, /Line one &lt;b&gt;bold&lt;\/b&gt;\nLine two/);
  assert.match(b.html, /fern@example\.test/);
  assert.match(b.html, /the web UI/);
  assert.match(b.html, /Fern&#39;s &lt;b&gt;notes&lt;\/b&gt;/);
  assert.match(b.html, new RegExp(`scripts/feedback\\.sh show ${f.id}`));
  // The earlier ones went too, each once.
  const ids = noticesTo().map((x) => /Id<\/th><td[^>]*>([0-9a-f-]{36})/.exec(JSON.parse(x.body).html)?.[1]);
  assert.equal(new Set(ids).size, ids.length, "no notice twice");
  assert.doesNotMatch(S.mail.log, /fern@example|ops@feedback|Line one/, "no address or message in the log");
  assert.equal(S.mail.log.includes(KEY), false);
});

test("feedback notices: an agent's feedback is emailed when someone next opens a page", async () => {
  calls.length = 0;
  const [{ id }] = await asUser(FERN, "select public.send_feedback('bug', 'Agent found a bug.', null, 'list_files ref 0badc0de') as id", [], "Cursor");
  const fresh = (S.fresh = await start({ RESEND_API_KEY: KEY, EMAIL_FROM: FROM, RESEND_API_URL: `http://127.0.0.1:${fake.address().port}`, FEEDBACK_EMAIL: TO }));
  await page(fresh, "/");
  await waitFor(async () => (await sql("select notified_at from public.feedback where id = $1", [id]))[0].notified_at !== null, "the notice");
  const b = JSON.parse(noticesTo().find((x) => JSON.parse(x.body).html.includes(id)).body);
  assert.match(b.html, /an agent \(Cursor\)/);
  assert.match(b.html, /list_files ref 0badc0de/);
});

test("feedback notices: when Resend fails the feedback is kept, and the notice goes once its claim lapses", async () => {
  calls.length = 0;
  answers = [{ status: 500, json: { name: "internal_server_error", message: "down" } }, { status: 500, json: { name: "internal_server_error", message: "down" } }];
  const r = await send(S.mail, { kind: "other", message: "Sent while Resend was down." });
  assert.equal(r.status, 303);
  const f = (await mine()).at(-1);
  await waitFor(async () => noticesTo().length >= 2, "two tries");
  await new Promise((r) => setTimeout(r, 200));
  let row = (await sql("select message, notified_at, notify_attempts from public.feedback where id = $1", [f.id]))[0];
  assert.deepEqual({ message: row.message, notified: row.notified_at !== null, attempts: row.notify_attempts }, { message: "Sent while Resend was down.", notified: false, attempts: 1 });
  assert.match(S.mail.log, /failure ref=[0-9a-f]{8} .*"where":"email sender \(Resend\)","why":"Resend answered 500/);
  // The claim lapses; the next form picks it up.
  await sql("update public.feedback set notify_claimed_at = now() - interval '11 minutes' where id = $1", [f.id]);
  await send(S.mail, { kind: "other", message: "Resend is back." });
  await waitFor(async () => (await sql("select notified_at from public.feedback where id = $1", [f.id]))[0].notified_at !== null, "the retried notice");
  row = (await sql("select notify_attempts from public.feedback where id = $1", [f.id]))[0];
  assert.equal(row.notify_attempts, 2);
});

test("feedback notices: without FEEDBACK_EMAIL outside the hosted service, nothing is emailed and nothing is claimed", async () => {
  // Only this file's servers with a notice address could send it: stop them.
  for (const { child, s } of servers) if (s === S.mail || s === S.fresh) child.kill();
  calls.length = 0;
  const r = await send(S.nobody, { kind: "bug", message: "Nobody is emailed about this." });
  assert.equal(r.status, 303);
  await page(S.nobody, "/");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(noticesTo().filter((c) => JSON.parse(c.body).html.includes("Nobody is emailed")).length, 0);
  const f = (await mine()).at(-1);
  assert.equal(f.message, "Nobody is emailed about this.");
  assert.equal(f.notify_attempts, 0);
});

test("feedback notices: where they go: FEEDBACK_EMAIL; else the hosted service's operator; a self-hosted instance only its own address", async () => {
  const { noticeTarget } = await import("../dist/feedback.js");
  const { OPERATOR } = await import("../dist/site.js");
  assert.deepEqual(noticeTarget({ FEEDBACK_EMAIL: " ops@x.example " }), { to: "ops@x.example" });
  assert.deepEqual(noticeTarget({ VERCEL: "1" }), { to: OPERATOR.contactEmail });
  assert.deepEqual(noticeTarget({ VERCEL: "1", FEEDBACK_EMAIL: "ops@x.example" }), { to: "ops@x.example" });
  assert.ok("off" in noticeTarget({ SELF_HOSTED: "1" }));
  assert.ok("off" in noticeTarget({ SELF_HOSTED: "1", VERCEL: "1" }), "a self-hosted instance never falls back to Red Mage");
  assert.deepEqual(noticeTarget({ SELF_HOSTED: "1", FEEDBACK_EMAIL: "me@selfhost.example" }), { to: "me@selfhost.example" });
  assert.ok("off" in noticeTarget({}));
  assert.match(noticeTarget({ FEEDBACK_EMAIL: "not an address" }).off, /FEEDBACK_EMAIL isn’t an email address/);
});
