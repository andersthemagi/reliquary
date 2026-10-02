// Redacting a thread message in the web app (src/threadredact.ts): the owner's
// Redact… link, the confirm page that changes nothing, and the post that
// blanks the text for everyone. That only an owner, in person, may redact is
// proved once, in supabase/tests/vault_threads_test.sql ("redact:"); this
// file is about what a person is offered and told, that a forced request is
// refused with its reference, and that a message of another thread or vault
// can't be reached from this thread's address.
//
// Noa owns "Redact main" and "Redact other", Edda edits the first and Rex
// only views it. Ola is in neither.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addPeople, as, csrfOf, EDDA, flashOf, get, landed, NOA, OLA, page, post, REX, sql, start, visibleText } from "./threads-harness.mjs";

const { describe } = await import("../dist/errorpage.js");

const V = {};
const T = {};
const M = {};
let noa;
let edda;
let rex;
let ola;

const thread = (v, t, rest = "") => `/v/${v}/threads/${t}${rest}`;
const confirm = (m) => `?redact=${m}`;
const row = async (m) => (await sql("select body, redacted_by, author, at from public.thread_messages where id = $1", [m]))[0];
const logged = async (v) => sql("select actor, agent, detail from public.log where vault_id = $1 and event = 'thread.redact' order by seq", [v]);

before(async () => {
  await addPeople();
  noa = await start(NOA, "noa");
  edda = await start(EDDA, "edda");
  rex = await start(REX, "rex");
  ola = await start(OLA, "ola");

  [{ id: V.main }] = await as(NOA, "select public.create_vault('Redact main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3), test_support.add_member($1, $4, 'viewer', $3)", [V.main, EDDA, NOA, REX]);
  [{ id: V.other }] = await as(NOA, "select public.create_vault('Redact other', 'open') as id");

  const open = (user, vault, title, body) => as(user, "select public.open_thread($1, $2, $3) as id", [vault, title, body]).then((r) => r[0].id);
  const msg = (user, t, body, agent = null) => as(user, "select public.post_message($1, $2) as id", [t, body], agent).then((r) => r[0].id);
  T.main = await open(EDDA, V.main, "Pasted a key", "The key is hunter2 <script>alert(1)</script>");
  [{ id: M.first }] = await sql("select min(id) as id from public.thread_messages where thread_id = $1", [T.main]);
  M.agent = await msg(EDDA, T.main, "From my agent: token abc123", "Hermes on Linux");
  M.plain = await msg(NOA, T.main, "Thanks, I will check.");
  T.sibling = await open(EDDA, V.main, "A sibling thread", "Not this one.");
  [{ id: M.sibling }] = await sql("select min(id) as id from public.thread_messages where thread_id = $1", [T.sibling]);
  T.other = await open(NOA, V.other, "Other vault", "Elsewhere secret.");
  [{ id: M.other }] = await sql("select min(id) as id from public.thread_messages where thread_id = $1", [T.other]);
});

after(async () => {
  for (const s of [noa, edda, rex, ola]) s?.child?.kill();
});

test("redact: only an owner is offered Redact…, on each message that still has its text", async () => {
  const h = await page(noa, thread(V.main, T.main));
  const links = [...h.matchAll(/<a href="([^"]+)" aria-label="Redact the message from ([^"]+)">Redact…<\/a>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(links, [
    [thread(V.main, T.main, confirm(M.first)), "edda@example.test"],
    [thread(V.main, T.main, confirm(M.agent)), "edda@example.test via Hermes on Linux"],
    [thread(V.main, T.main, confirm(M.plain)), "you"],
  ]);
  for (const [who, s] of [["Edda", edda], ["Rex", rex]]) assert.doesNotMatch(await page(s, thread(V.main, T.main)), /Redact…|\?redact=/, `${who} is offered none`);
});

test("redact: the confirm page names the message and what redacting does, and a visit changes nothing", async () => {
  const r = await get(noa, thread(V.main, T.main, confirm(M.first)));
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Redact this message\?<\/h1>/);
  assert.match(h, /This blanks the message from edda@example\.test: <q>The key is hunter2 &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/q>/, "the text quoted, escaped");
  assert.match(h, /<li>Its text is removed for everyone in this vault, agents included, and it can’t be restored\.<\/li>/);
  assert.match(h, /<li>The message keeps its place in the thread, who wrote it and when, and says that you redacted it, and when\.<\/li>/);
  assert.match(h, /<li>Activity records that you redacted a message, never its text\.<\/li>/);
  assert.match(h, /<li>It doesn’t take back what anyone, or any agent, has already read or copied\. If it held a secret, change the secret too: secrets belong in variables, never in a thread\.<\/li>/);
  assert.match(h, new RegExp(`<form method="post" action="/v/${V.main}/threads/${T.main}/redact" class="panel confirm">`));
  assert.match(h, new RegExp(`name="message" value="${M.first}"`));
  assert.match(h, /<button class="danger solid">Redact message<\/button><a class="button quiet" href="[^"]+#message-\d+">Cancel<\/a>/);
  assert.match(h, new RegExp(`<li><a href="/v/${V.main}/threads">Threads</a></li><li><a href="/v/${V.main}/threads/${T.main}">Pasted a key</a></li><li aria-current="page">Redact</li>`));
  assert.doesNotMatch(h, /<script>alert/);
  assert.equal((await row(M.first)).body, "The key is hunter2 <script>alert(1)</script>", "nothing changed");
  assert.deepEqual(await logged(V.main), []);
});

test("redact: a form without the confirm page's field is sent to the confirm page instead of redacting", async () => {
  const token = csrfOf(await page(noa, thread(V.main, T.main)));
  const r = await post(noa, thread(V.main, T.main, "/redact"), { csrf: token, message: M.plain });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), thread(V.main, T.main, confirm(M.plain)));
  assert.equal((await row(M.plain)).body, "Thanks, I will check.");
});

test("redact: an editor and a viewer are turned back from the confirm page, and a forced post is refused by the database with its reference", async () => {
  for (const [who, s] of [["Edda", edda], ["Rex", rex]]) {
    const r = await get(s, thread(V.main, T.main, confirm(M.agent)));
    assert.equal(r.status, 303, who);
    assert.equal(r.headers.get("location"), thread(V.main, T.main));
    assert.match(flashOf(await landed(s, r))[2], /Only owners redact messages\./);
    const forced = await post(s, thread(V.main, T.main, "/redact"), { csrf: csrfOf(await page(s, thread(V.main, T.main))), message: M.agent, confirm: "1" });
    assert.match(flashOf(await landed(s, forced))[2], /Only owners redact messages\. \(ref [0-9a-f]{8}\)/, `${who}'s forced post`);
  }
  assert.equal((await row(M.agent)).body, "From my agent: token abc123", "nothing changed");
  assert.deepEqual(await logged(V.main), []);
});

test("redact: a message of another thread or vault is not in this thread, the same as one that doesn't exist, and nothing changes", async () => {
  const token = csrfOf(await page(noa, thread(V.main, T.main)));
  const answers = [];
  for (const m of [M.sibling, M.other, "999999999", "not-a-number"]) {
    const c = await get(noa, thread(V.main, T.main, confirm(m)));
    assert.equal(c.status, 303, `confirm ${m}`);
    const note = flashOf(await landed(noa, c))[2];
    const p = await post(noa, thread(V.main, T.main, "/redact"), { csrf: token, message: m, confirm: "1" });
    answers.push([c.headers.get("location"), note, p.headers.get("location"), flashOf(await landed(noa, p))[2]]);
  }
  for (const a of answers) assert.deepEqual(a, answers[0], "the same answer whatever the id");
  assert.equal(answers[0][1], "That message isn’t in this thread.");
  assert.equal((await row(M.sibling)).body, "Not this one.");
  assert.equal((await row(M.other)).body, "Elsewhere secret.");
});

test("redact: a thread of another vault, or from outside the vault, is Not found", async () => {
  const token = csrfOf(await page(noa, thread(V.main, T.main)));
  assert.equal((await get(noa, thread(V.main, T.other, confirm(M.other)))).status, 404, "Noa is in both vaults");
  assert.equal((await post(noa, thread(V.main, T.other, "/redact"), { csrf: token, message: M.other, confirm: "1" })).status, 404);
  assert.equal((await get(ola, thread(V.main, T.main, confirm(M.first)))).status, 404, "Ola is in neither");
  assert.equal((await post(ola, thread(V.main, T.main, "/redact"), { csrf: csrfOf(await page(ola, "/")), message: M.first, confirm: "1" })).status, 404);
  assert.equal((await row(M.other)).body, "Elsewhere secret.");
  assert.equal((await row(M.first)).body, "The key is hunter2 <script>alert(1)</script>");
});

test("redact: confirming blanks the text for everyone and keeps the message's place, author and time, saying who redacted it", async () => {
  const before = await row(M.first);
  const token = csrfOf(await page(noa, thread(V.main, T.main)));
  const r = await post(noa, thread(V.main, T.main, "/redact"), { csrf: token, message: M.first, confirm: "1" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), thread(V.main, T.main));
  const h = await landed(noa, r);
  assert.match(flashOf(h)[2], /Message redacted\. Its text is gone for everyone\./);
  const after = await row(M.first);
  assert.deepEqual({ body: after.body, by: after.redacted_by, author: after.author, at: after.at }, { body: null, by: NOA, author: before.author, at: before.at });
  for (const [who, s] of [["Noa", noa], ["Rex", rex], ["Edda", edda]]) {
    const view = await page(s, thread(V.main, T.main));
    const items = [...view.matchAll(/<li id="message-(\d+)"/g)].map((m) => m[1]);
    assert.deepEqual(items, [M.first, M.agent, M.plain], `${who}: the message keeps its place`);
    assert.match(view, /<p class="muted small redacted">Redacted by (?:you|noa@example\.test) <time[^>]*>[^<]+<\/time>\. The text was removed for everyone, agents included\.<\/p>/, who);
    assert.doesNotMatch(view, /hunter2/, `${who}: the text is gone`);
  }
  assert.doesNotMatch(h, new RegExp(`\\?redact=${M.first}"`), "no Redact… left on it");
  assert.match(h, new RegExp(`\\?redact=${M.agent}"`), "the others still have theirs");
  const log = await logged(V.main);
  assert.equal(log.length, 1);
  assert.deepEqual({ actor: log[0].actor, agent: log[0].agent, detail: log[0].detail }, { actor: NOA, agent: null, detail: { thread: T.main, message: Number(M.first) } });
  assert.equal((await sql("select count(*) as n from public.log where vault_id = $1 and detail::text like '%hunter2%'", [V.main]))[0].n, "0", "the log never held the text");
});

test("redact: a redacted message can't be redacted again, and the confirm page says so", async () => {
  const c = await get(noa, thread(V.main, T.main, confirm(M.first)));
  assert.equal(c.status, 303);
  assert.match(flashOf(await landed(noa, c))[2], /That message is already redacted\./);
  const p = await post(noa, thread(V.main, T.main, "/redact"), { csrf: csrfOf(await page(noa, thread(V.main, T.main))), message: M.first, confirm: "1" });
  assert.match(flashOf(await landed(noa, p))[2], /This message is already redacted\. \(ref [0-9a-f]{8}\)/);
  assert.equal((await logged(V.main)).length, 1, "nothing more was logged");
});

test("redact: no em dashes or straight apostrophes in the confirm page's copy", async () => {
  const text = visibleText(await page(noa, thread(V.main, T.main, confirm(M.agent))));
  assert.doesNotMatch(text.replace("From my agent: token abc123", ""), /—|[a-z]'[a-z]/i);
});

test("errors: a redaction request is described by what it does, and its log line holds ids only", () => {
  const vid = "3f2a9c1d-0000-4000-8000-000000000000";
  const tid = "7b1e2f40-0000-4000-8000-000000000000";
  const of = (method, path) => describe(method, new URL(`http://x${path}`), new URLSearchParams());
  assert.equal(of("GET", `/v/${vid}/threads/${tid}?redact=12`).what, "Opening the redact page of thread 7b1e2f40 in vault 3f2a9c1d");
  assert.equal(of("POST", `/v/${vid}/threads/${tid}/redact`).what, "Redacting a message in thread 7b1e2f40 in vault 3f2a9c1d");
  assert.equal(of("POST", `/v/${vid}/threads/${tid}/redact`).log, `POST /v/:id/threads/:id/redact ${vid} ${tid}`);
});
