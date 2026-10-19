// Emails about threads (src/threademails.ts): the members a thread reaches
// are emailed that it needs reading, with Resend faked by a server in this
// file (RESEND_API_URL), and the choice to turn them off on Account
// settings. Who is queued, and how a batch is cut, is proved in
// supabase/tests/thread_emails_test.sql; this is what a member gets.
//
// Its own people and vault: Pia owns "Mail Team", Quin edits it, Rae views
// it. Each gets a server of their own (start-as.mjs) with the fake sender.

import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { after, before, test } from "node:test";
import pg from "pg";
import { startAs } from "./start-as.mjs";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const PIA = "98100000-0000-0000-0000-000000000981";
const QUIN = "98200000-0000-0000-0000-000000000982";
const RAE = "98300000-0000-0000-0000-000000000983";
const EMAILS = { [PIA]: "pia@mail.example.test", [QUIN]: "quin@mail.example.test", [RAE]: "rae@mail.example.test" };
const KEY = `re_test_${randomBytes(16).toString("hex")}`;
const FROM = "Reliquary <no-reply@notify.example.test>";
// Something a message could try to carry into an email: it must never.
const SECRET_TEXT = "SEKRIT-in-a-message";

const S = {};
let team = "";
const calls = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: randomUUID() }));
  });
});

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

const page = async (who, path) => (await fetch(S[who].url + path, { headers: { cookie: S[who].cookie }, redirect: "manual" })).text();
const post = async (who, path, fields) => {
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(await page(who, "/settings"))[1];
  return fetch(S[who].url + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: S[who].url },
    body: new URLSearchParams({ csrf, ...fields }).toString(),
  });
};
// The thread has been quiet long enough, and no claim stands.
const quiet = () => sql("update private.thread_emails set queued_at = now() - interval '3 minutes', claimed_at = null");
const unsent = () => sql("select count(*)::int as n from private.thread_emails where sent_at is null and vault_id = $1", [team]).then((r) => r[0].n);
const waitFor = async (cond, what) => {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const sentTo = (addr) => calls.filter((c) => c.url === "/emails" && c.body.tags?.[0]?.value === "thread" && c.body.to[0] === addr);

before(async () => {
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const MAIL = { RESEND_API_KEY: KEY, EMAIL_FROM: FROM, RESEND_API_URL: `http://127.0.0.1:${fake.address().port}`, NETLIFY: "", SELF_HOSTED: "" };
  for (const [id, email] of Object.entries(EMAILS)) await sql("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [id, email]);
  [{ id: team }] = await as(PIA, "select public.create_vault('Mail Team') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [team, QUIN, PIA]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [team, RAE, PIA]);
  await as(PIA, "select public.set_display_name('Pia')");
  S.pia = await startAs(PIA, MAIL);
  S.quin = await startAs(QUIN, MAIL);
  S.rae = await startAs(RAE, MAIL);
});

after(() => {
  for (const s of Object.values(S)) s.stop();
  fake.close();
});

test("thread emails in the web app: a thread for the whole vault emails every other member once, with the vault, the title, who wrote and a link, and never the message", async () => {
  const [{ id: thread }] = await as(PIA, `select public.open_thread($1, 'Pick your roles', 'Who takes what? ${SECRET_TEXT}') as id`, [team]);
  await quiet();
  await page("pia", "/");
  await waitFor(async () => (await unsent()) === 0, "the emails to go out");
  for (const who of [QUIN, RAE]) {
    const sent = sentTo(EMAILS[who]);
    assert.equal(sent.length, 1, who);
    const { headers, body: b } = sent[0];
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.match(headers["idempotency-key"], /^thread\/[0-9a-f]{40}$/);
    assert.equal(b.from, FROM);
    assert.equal(b.subject, "New thread in Mail Team: Pick your roles");
    assert.match(b.html, /<p>Pia opened a thread in <strong>Mail Team<\/strong> on Reliquary:<\/p>/);
    assert.match(b.html, /“Pick your roles”/);
    assert.match(b.html, new RegExp(`<a href="http://127\\.0\\.0\\.1:\\d+/v/${team}/threads/${thread}">Read the thread</a>`));
    assert.doesNotMatch(b.html, new RegExp(SECRET_TEXT));
    assert.doesNotMatch(b.subject, new RegExp(SECRET_TEXT));
  }
  assert.equal(sentTo(EMAILS[PIA]).length, 0);
  for (const s of Object.values(S)) assert.doesNotMatch(s.log(), new RegExp(`${SECRET_TEXT}|${KEY}|@mail\\.example\\.test`));
});

test("thread emails in the web app: several messages while the thread is quiet make one email saying how many", async () => {
  calls.length = 0;
  const [{ id: thread }] = await as(PIA, "select public.open_thread($1, 'Standup', 'First.') as id", [team]);
  await as(QUIN, "select public.post_message($1, 'Second.')", [thread]);
  await as(PIA, "select public.post_message($1, 'Third.')", [thread]);
  await quiet();
  await page("rae", "/");
  await waitFor(async () => (await unsent()) === 0, "the emails to go out");
  const sent = sentTo(EMAILS[RAE]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.subject, "New thread in Mail Team: Standup");
  assert.match(sent[0].body.html, /<p>Pia opened a thread, with 3 messages so far in <strong>Mail Team<\/strong>/);
  const quin = sentTo(EMAILS[QUIN]);
  assert.equal(quin.length, 1);
  assert.match(quin[0].body.html, /opened a thread, with 2 messages so far/);
});

test("thread emails in the web app: a side thread emails only the members it is addressed to", async () => {
  calls.length = 0;
  await as(PIA, "select public.open_thread($1, 'Just us', 'Quin, a word?', array[$2]::uuid[])", [team, QUIN]);
  await quiet();
  await page("quin", "/");
  await waitFor(async () => (await unsent()) === 0, "the email to go out");
  assert.equal(sentTo(EMAILS[QUIN]).length, 1);
  assert.equal(sentTo(EMAILS[RAE]).length, 0);
  assert.equal(sentTo(EMAILS[PIA]).length, 0);
});

test("thread emails in the web app: Email me about threads on Account settings turns them off, and the page shows the choice", async () => {
  assert.match(await page("rae", "/settings"), /<input type="checkbox" name="thread_emails" value="1" checked>/);
  const r = await post("rae", "/settings/thread-emails", {});
  assert.equal(r.status, 303);
  assert.match(await page("rae", "/settings"), /<input type="checkbox" name="thread_emails" value="1">/);
  calls.length = 0;
  await as(PIA, "select public.open_thread($1, 'After Rae opted out', 'Anyone?') as id", [team]);
  await quiet();
  await page("pia", "/");
  await waitFor(async () => sentTo(EMAILS[QUIN]).length === 1, "Quin's email");
  assert.equal(sentTo(EMAILS[RAE]).length, 0);
  await post("rae", "/settings/thread-emails", { thread_emails: "1" });
  assert.match(await page("rae", "/settings"), /<input type="checkbox" name="thread_emails" value="1" checked>/);
});
