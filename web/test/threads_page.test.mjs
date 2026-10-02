// One thread in the web app (src/threadview.ts, src/threadnew.ts,
// src/threadcite.ts): reading it, posting to it, resolving and reopening it,
// and opening a new one. Who may write is proved once, in
// supabase/tests/vault_threads_test.sql; this file is about what a person
// sees and that the database's answers reach them: no form for a viewer and a
// forced post refused with its reference, a thread of another vault Not
// found, a side thread readable by every member, and that people's and
// agents' words, and what they cite, stay inert text.
//
// Noa owns "Thread pages" and "Thread pages other", Edda edits the first and
// Rex only views it. Ola is in neither.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addPeople, as, csrfOf, EDDA, flashOf, get, landed, NOA, OLA, page, post, REX, sql, start, visibleText } from "./threads-harness.mjs";

const { describe } = await import("../dist/errorpage.js");

const V = {};
const T = {};
const P = {};
const NOPE = "00000000-0000-4000-8000-000000000001";
let noa;
let edda;
let rex;
let ola;

const thread = (v, t, rest = "") => `/v/${v}/threads/${t}${rest}`;
const open = (user, vault, title, body, o = {}) =>
  as(user, "select public.open_thread($1, $2, $3, $4::uuid[], $5) as id", [vault, title, body, o.to ?? null, o.path ?? null], o.agent ?? null).then((r) => r[0].id);
const say = (user, t, body, agent = null) => as(user, "select public.post_message($1, $2) as id", [t, body], agent).then((r) => r[0].id);
const count = async (t) => Number((await sql("select count(*) as n from public.thread_messages where thread_id = $1", [t]))[0].n);
const threadsIn = async (v) => Number((await sql("select count(*) as n from public.threads where vault_id = $1", [v]))[0].n);
const bodiesOf = (h) => [...h.matchAll(/<li id="message-(\d+)"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => ({ id: m[1], html: m[2] }));
const refusal = (h) => /<div class="callout danger" role="alert">([\s\S]*?)<\/div>/.exec(h)?.[1];

before(async () => {
  await addPeople();
  noa = await start(NOA, "noa");
  edda = await start(EDDA, "edda");
  rex = await start(REX, "rex");
  ola = await start(OLA, "ola");

  [{ id: V.main }] = await as(NOA, "select public.create_vault('Thread pages', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3), test_support.add_member($1, $4, 'viewer', $3)", [V.main, EDDA, NOA, REX]);
  [{ id: V.other }] = await as(NOA, "select public.create_vault('Thread pages other', 'open') as id");
  [{ id: V.ola }] = await as(OLA, "select public.create_vault('Thread pages Ola only', 'open') as id");

  await as(NOA, "select public.write_file($1, 'notes/draft.md', 'A draft.')", [V.main]);
  await as(NOA, "select public.write_file($1, 'plans/launch.md', 'Launch.')", [V.main]);
  await as(NOA, "select public.write_file($1, 'secret/other-only.md', 'Elsewhere.')", [V.other]);
  await as(NOA, "select public.set_policy($1, 'canon/', 'canon', 1)", [V.main]);
  await as(NOA, "select public.set_policy($1, 'secret/', 'canon', 1)", [V.other]);
  [{ id: P.own }] = await as(EDDA, "select public.propose($1, 'canon/brief.md', 'A brief.', 'brief') as id", [V.main]);
  [{ id: P.other }] = await as(NOA, "select public.propose($1, 'secret/plan.md', 'Hidden plan.', 'plan') as id", [V.other]);
  const [{ v: version }] = await sql("select current_version_id as v from public.files where vault_id = $1 and path = 'plans/launch.md'", [V.main]);
  await as(NOA, `select public.register_work_plan($1, 'plans/launch.md', $2, '[{"key":"copy","title":"Write the copy"}]'::jsonb)`, [V.main, version]);

  T.talk = await open(NOA, V.main, "Launch copy", "Is the copy ready?", { path: "notes/draft.md" });
  await say(EDDA, T.talk, "Nearly.\nOne more pass.");
  await say(EDDA, T.talk, "Agent note from Edda's side.", "Hermes on Linux");
  T.side = await open(EDDA, V.main, "Budget", "Noa, can we talk about the budget?", { to: [NOA] });
  T.other = await open(NOA, V.other, "Other vault thread", "Only in the other vault.");
  T.olas = await open(OLA, V.ola, "Ola's thread", "Hers.");
  T.state = await open(NOA, V.main, "To resolve", "Open for now.");
  T.long = await open(NOA, V.main, "A long one", "Message 1.");
  await as(EDDA, "select public.post_message($1, 'Filler ' || g) from generate_series(2, 201) g", [T.long]);

  T.hostile = await open(EDDA, V.main, "Hostile words", "<script>alert(1)</script>", { agent: "Hermes on Linux" });
  for (const text of [
    "[click me](javascript:alert(2)) and ![pic](https://evil.test/p.png)",
    `**bold** <img src=x onerror=alert(3)> &amp; "quotes" 'single'`,
    'file:<b>x</b> task:<i>#a proposal:"><svg onload=alert(4)>',
  ]) await say(EDDA, T.hostile, text, "Hermes on Linux");

  T.cites = await open(EDDA, V.main, "Citations", `See file:notes/draft.md. Also (file:notes/missing.md), proposal:${P.own}, task:plans/launch.md#copy, and task:plans/launch.md#nope;`);
  await say(EDDA, T.cites, `Elsewhere: proposal:${P.other}`);
  await say(EDDA, T.cites, `Nowhere: proposal:${NOPE}`);
  await say(EDDA, T.cites, "Another vault's file: file:secret/other-only.md, and a made-up one: file:../../etc/passwd");

  T.redacted = await open(EDDA, V.main, "Pasted by mistake", "The password is hunter2");
  await say(NOA, T.redacted, "I will redact that.");
  const [{ id: secret }] = await sql("select min(id) as id from public.thread_messages where thread_id = $1", [T.redacted]);
  await as(NOA, "select public.redact_message($1)", [secret]);
});

after(async () => {
  for (const s of [noa, edda, rex, ola]) s?.child?.kill();
});

// Reading -------------------------------------------------------------------

test("thread page: the thread, then its messages oldest first, each with who wrote it and when", async () => {
  const h = await page(noa, thread(V.main, T.talk));
  assert.match(h, /<h1 class="path">Launch copy<\/h1>/);
  assert.match(h, /<span class="badge info">Open<\/span>/);
  assert.match(h, new RegExp(`<li><a href="/v/${V.main}/threads">Threads</a></li><li aria-current="page">Launch copy</li>`));
  assert.match(h, /Opened by you <time datetime="[^"]+" title="[^"]+ UTC">[^<]+<\/time>/);
  assert.match(h, new RegExp(`About the file <a href="/v/${V.main}/file\\?path=notes%2Fdraft\\.md">notes/draft\\.md</a>`));
  const msgs = bodiesOf(h);
  assert.equal(msgs.length, 3);
  assert.match(msgs[0].html, /^\s*<p class="small muted">you · <time[^>]*>[^<]+<\/time>[^<]*(?:<a [^>]*>[^<]*<\/a>)?<\/p>\s*<p>Is the copy ready\?<\/p>/);
  assert.match(msgs[1].html, /edda@example\.test · <time/);
  assert.match(msgs[1].html, /<p>Nearly\.\nOne more pass\.<\/p>/, "line breaks are kept in the text");
  assert.ok(Number(msgs[0].id) < Number(msgs[1].id) && Number(msgs[1].id) < Number(msgs[2].id));
  assert.match(h, new RegExp(`<a href="/v/${V.main}/threads" aria-current="page">Threads</a>`), "the vault's Threads entry is current");
  assert.deepEqual([...h.matchAll(/<h([1-6])[ >]/g)].map((m) => m[1]), ["1", "2", "2"], "headings in order: title, Messages, Reply");
  assert.equal((h.match(/<h1[ >]/g) ?? []).length, 1);
});

test("thread page: a message an agent wrote says so in words and sits on a tinted ground", async () => {
  const h = await page(noa, thread(V.main, T.talk));
  assert.match(h, /<li id="message-\d+" class="by-agent">\s*<p class="small muted">edda@example\.test via Hermes on Linux · /);
  assert.equal((h.match(/class="by-agent"/g) ?? []).length, 1);
});

test("thread page: a side thread is readable by a member who isn't addressed, and says who it is addressed to", async () => {
  // Budget is addressed to Noa. Rex (a viewer) and Edda (who opened it) aren't.
  for (const [who, s, to] of [["Rex", rex, "noa@example.test"], ["Edda", edda, "noa@example.test"], ["Noa", noa, "you"]]) {
    const r = await get(s, thread(V.main, T.side));
    assert.equal(r.status, 200, `${who} reads it`);
    const h = await r.text();
    assert.match(h, /<span class="badge side-thread"[^>]*>Side thread<\/span>/, `${who}: marked`);
    assert.match(h, new RegExp(`<strong>Side thread\\.</strong> It is addressed to ${to}\\. Only the addressed members are told about new messages\\. Everyone in this vault can still read it, and so can their agents\\.`));
    assert.match(h, /Noa, can we talk about the budget\?/);
  }
  assert.doesNotMatch(await page(noa, thread(V.main, T.talk)), /Side thread/, "a vault-wide thread has no banner");
});

test("thread page: another vault's thread is Not found from any address, to someone in both or in neither", async () => {
  assert.equal((await get(noa, thread(V.main, T.other))).status, 404, "Noa is in both vaults, and the address names the wrong one");
  assert.equal((await get(noa, thread(V.other, T.talk))).status, 404);
  assert.equal((await get(ola, thread(V.main, T.talk))).status, 404, "Ola is in neither");
  assert.equal((await get(ola, thread(V.ola, T.talk))).status, 404, "nor does her own vault's address help");
  assert.equal((await get(noa, thread(V.main, "not-a-thread"))).status, 404);
  assert.equal((await get(noa, thread(V.main, NOPE))).status, 404);
  assert.equal((await get(noa, thread(V.main, T.talk, "/nothing"))).status, 404);
  assert.equal((await get(noa, thread(V.other, T.other))).status, 200, "the right address works");
  const missing = await page(ola, thread(V.main, T.talk));
  assert.doesNotMatch(missing, /Launch copy|Is the copy ready/, "the answer says nothing about the thread");
});

test("thread page: words are escaped text, markup and markdown links are inert", async () => {
  const h = await page(rex, thread(V.main, T.hostile));
  assert.match(h, /<p>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
  assert.match(h, /<p>\[click me\]\(javascript:alert\(2\)\) and !\[pic\]\(https:\/\/evil\.test\/p\.png\)<\/p>/);
  assert.match(h, /<p>\*\*bold\*\* &lt;img src=x onerror=alert\(3\)&gt; &amp;amp; &quot;quotes&quot; &#39;single&#39;<\/p>/);
  assert.match(h, /<p>file:&lt;b&gt;x&lt;\/b&gt; task:&lt;i&gt;#a proposal:&quot;&gt;&lt;svg onload=alert\(4\)&gt;<\/p>/);
  assert.doesNotMatch(h, /<script|<img src|<svg onload|<b>x|<i>#a|href="javascript:|<a [^>]*evil/);
  assert.equal((h.match(/class="by-agent"/g) ?? []).length, 4, "all four came through the agent and say so");
});

test("thread page: a citation links to what exists in this vault, and everything else stays text", async () => {
  const h = await page(rex, thread(V.main, T.cites));
  const first = bodiesOf(h)[0].html;
  assert.match(first, new RegExp(`See <a href="/v/${V.main}/file\\?path=notes%2Fdraft\\.md">file:notes/draft\\.md</a>\\. Also \\(file:notes/missing\\.md\\), `), "a file there links, the full stop is outside it; a missing one doesn't");
  assert.match(first, new RegExp(`<a href="/v/${V.main}/proposals/${P.own}">proposal:${P.own}</a>, `));
  assert.match(first, new RegExp(`<a href="/v/${V.main}/file\\?path=plans%2Flaunch\\.md">task:plans/launch\\.md#copy</a>, and task:plans/launch\\.md#nope;`), "a task links to its plan's file; one that isn't in the plan doesn't");
  assert.equal((first.match(/<a /g) ?? []).length, 3);
});

test("thread page: a citation of another vault's proposal or file stays plain text and says nothing about it", async () => {
  const h = await page(noa, thread(V.main, T.cites)); // Noa can read both vaults, so only this vault's address decides
  const [, other, nowhere, elsewhere] = bodiesOf(h);
  assert.match(other.html, new RegExp(`<p>Elsewhere: proposal:${P.other}</p>`));
  assert.match(nowhere.html, new RegExp(`<p>Nowhere: proposal:${NOPE}</p>`));
  assert.match(elsewhere.html, /<p>Another vault&#39;s file: file:secret\/other-only\.md, and a made-up one: file:\.\.\/\.\.\/etc\/passwd<\/p>/);
  for (const m of [other, nowhere, elsewhere]) assert.doesNotMatch(m.html, /<a href="\/v\/[^"]*\/(?:file|proposals)/);
  // The top bar's inbox lists what waits on Noa in every vault, so look only at the page's own content.
  const content = h.slice(h.indexOf('<main id="main">'));
  assert.doesNotMatch(content, new RegExp(`proposals/${P.other}`));
  assert.doesNotMatch(content, /secret\/plan\.md|Hidden plan|path=secret/, "nothing of the other vault's proposal or file leaks");
});

test("thread page: a redacted message shows who redacted it and when, never the text", async () => {
  for (const s of [rex, noa]) {
    const h = await page(s, thread(V.main, T.redacted));
    const [first, second] = bodiesOf(h);
    assert.match(first.html, /<p class="small muted">edda@example\.test · <time[^>]*>[^<]+<\/time><\/p>\s*<p class="muted small redacted">Redacted by (?:you|noa@example\.test) <time[^>]*>[^<]+<\/time>\. The text was removed for everyone, agents included\.<\/p>/);
    assert.match(second.html, /I will redact that\./);
    assert.doesNotMatch(h, /hunter2|The password is/);
  }
});

test("thread page: past 200 messages the rest are on a second page, and the reply form is on the last", async () => {
  const first = await page(noa, thread(V.main, T.long));
  assert.equal(bodiesOf(first).length, 200);
  assert.doesNotMatch(first, /id="reply-form"/);
  const next = /<a href="([^"]+)">Later messages<\/a>/.exec(first)?.[1];
  assert.ok(next);
  const second = await page(noa, next);
  assert.deepEqual(bodiesOf(second).map((m) => /<p>(.*?)<\/p>$/.exec(m.html.trim())[1]), ["Filler 201"]);
  assert.match(second, /id="reply-form"/);
  assert.match(second, new RegExp(`<a href="/v/${V.main}/threads/${T.long}">From the first message</a>`));
});

// Posting --------------------------------------------------------------------

test("post: a message joins the end of the thread, with a success flash, and the agent can see it", async () => {
  const t = await open(NOA, V.main, "Posting here", "First.");
  const h = await page(edda, thread(V.main, t));
  const r = await post(edda, thread(V.main, t, "/post"), { csrf: csrfOf(h), body: "Second line.\r\nSecond para." });
  assert.equal(r.status, 303);
  assert.match(r.headers.get("location"), new RegExp(`^/v/${V.main}/threads/${t}#message-\\d+$`));
  const after = await landed(edda, r);
  assert.deepEqual(flashOf(after)?.slice(0, 1), ["success"]);
  assert.match(flashOf(after)[2], /Message posted\./);
  const msgs = bodiesOf(after);
  assert.equal(msgs.length, 2);
  assert.match(msgs[1].html, /<p class="small muted">you · .*<\/p>\s*<p>Second line\.\nSecond para\.<\/p>/s);
  const [row] = await sql("select author, agent, body from public.thread_messages where thread_id = $1 order by id desc limit 1", [t]);
  assert.deepEqual({ author: row.author, agent: row.agent, body: row.body }, { author: EDDA, agent: null, body: "Second line.\nSecond para." });
});

test("post: an empty message or one with a control character is refused with its reason and reference, and what was typed stays in the box", async () => {
  const t = await open(NOA, V.main, "Refusals", "First.");
  const token = csrfOf(await page(noa, thread(V.main, t)));
  const before = await count(t);
  const empty = await post(noa, thread(V.main, t, "/post"), { csrf: token, body: " \r\n " });
  assert.equal(empty.status, 400);
  assert.match(refusal(await empty.text()), /A message needs some text\. \(ref [0-9a-f]{8}\)/);
  const typed = "Keep this \u0001 text";
  const control = await post(noa, thread(V.main, t, "/post"), { csrf: token, body: typed });
  assert.equal(control.status, 400);
  const h = await control.text();
  assert.match(refusal(h), /A message can&#39;t contain control characters other than line breaks and tabs\. \(ref [0-9a-f]{8}\)/);
  assert.match(h, /<a href="#reply">Back to your message<\/a>/);
  assert.ok(h.includes(`>${typed}</textarea>`), "the typed text is still in the box");
  assert.equal(await count(t), before, "nothing was stored");
});

test("post: a viewer sees no form, only a note; a forced post is refused by the database and stores nothing", async () => {
  const h = await page(rex, thread(V.main, T.talk));
  assert.doesNotMatch(h, /name="body"|\/post"|\/resolve"|\/reopen"|id="reply-form"/);
  assert.match(h, /<p class="muted small">Viewers can read threads but not post in them\.<\/p>/);
  assert.doesNotMatch(h, />Reply<\/a>|Resolve thread/);
  const before = await count(T.talk);
  const r = await post(rex, thread(V.main, T.talk, "/post"), { csrf: csrfOf(h), body: "Me too" });
  assert.equal(r.status, 400);
  assert.match(refusal(await r.text()), /Only editors and owners write in threads, and their agents need a read-write connection; viewers read them\. \(ref [0-9a-f]{8}\)/);
  assert.equal(await count(T.talk), before);
  assert.doesNotMatch(await page(rex, thread(V.main, T.talk)), /Me too/);
});

test("post: a thread of another vault is Not found at this vault's address, and nothing is posted", async () => {
  const token = csrfOf(await page(noa, thread(V.main, T.talk)));
  const before = await count(T.other);
  for (const [v, t] of [[V.main, T.other], [V.other, T.talk], [V.main, NOPE], [V.main, "not-a-thread"]]) {
    for (const action of ["post", "resolve", "reopen"]) {
      assert.equal((await post(noa, thread(v, t, `/${action}`), { csrf: token, body: "peek" })).status, 404, `${action} ${v}/${t}`);
    }
  }
  assert.equal(await count(T.other), before);
  assert.equal((await sql("select resolved_at from public.threads where id = $1", [T.other]))[0].resolved_at, null);
});

// Resolving and reopening ------------------------------------------------------

test("resolve and reopen: a writer resolves a thread, it takes no message, and reopening brings the form back", async () => {
  const token = csrfOf(await page(noa, thread(V.main, T.state)));
  const resolved = await landed(noa, await post(noa, thread(V.main, T.state, "/resolve"), { csrf: token }));
  assert.match(flashOf(resolved)[2], /Thread resolved\. It takes no new messages until it is reopened\./);
  assert.match(resolved, /<span class="badge success">Resolved<\/span>/);
  assert.match(resolved, /<span>Resolved by you <time/);
  assert.doesNotMatch(resolved, /id="reply-form"/);
  assert.match(resolved, /This thread is resolved\. Reopen it to post again\./);
  assert.match(resolved, new RegExp(`action="/v/${V.main}/threads/${T.state}/reopen"[^>]*>[\\s\\S]*?<button>Reopen thread</button>`));
  const refused = await post(noa, thread(V.main, T.state, "/post"), { csrf: token, body: "Still here?" });
  assert.equal(refused.status, 400);
  assert.match(refusal(await refused.text()), /This thread is resolved: reopen it to post again\. \(ref [0-9a-f]{8}\)/);
  const again = await post(noa, thread(V.main, T.state, "/resolve"), { csrf: token });
  assert.match(flashOf(await landed(noa, again))[2], /This thread is already resolved\. \(ref [0-9a-f]{8}\)/);

  const reopened = await landed(noa, await post(noa, thread(V.main, T.state, "/reopen"), { csrf: token }));
  assert.match(flashOf(reopened)[2], /Thread reopened\./);
  assert.match(reopened, /<span class="badge info">Open<\/span>/);
  assert.doesNotMatch(reopened, /Resolved by/);
  assert.match(reopened, /id="reply-form"/);
  const posted = await post(noa, thread(V.main, T.state, "/post"), { csrf: token, body: "Back again." });
  assert.equal(posted.status, 303);
});

test("resolve and reopen: a viewer's forced request is refused by the database and changes nothing", async () => {
  const token = csrfOf(await page(rex, thread(V.main, T.talk)));
  const r = await post(rex, thread(V.main, T.talk, "/resolve"), { csrf: token });
  assert.match(flashOf(await landed(rex, r))[2], /Only editors and owners write in threads, and their agents need a read-write connection; viewers read them\. \(ref [0-9a-f]{8}\)/);
  assert.equal((await sql("select resolved_at from public.threads where id = $1", [T.talk]))[0].resolved_at, null);
});

// Opening --------------------------------------------------------------------

test("open: the form asks for a title and a first message, offers the other members, and says what addressing and an agent's delay mean", async () => {
  const h = await page(noa, `/v/${V.main}/threads/new`);
  assert.match(h, /<h1>New thread<\/h1>/);
  assert.match(h, /<input id="t-title" type="text" name="title" value="" maxlength="200" required>/);
  assert.match(h, /<textarea id="t-body" name="body" class="short" maxlength="4000" required><\/textarea>/);
  assert.match(h, /<input id="t-path" type="text" name="path" value="" placeholder="notes\/plan\.md" aria-describedby="t-path-hint">/);
  assert.match(h, /<legend>Address it to \(optional\)<\/legend>/);
  const boxes = [...h.matchAll(/<input type="checkbox" name="to" value="([0-9a-f-]+)"> ([^<]*) <span class="muted small">(\w+)<\/span>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(boxes, [[EDDA, "edda@example.test", "editor"], [REX, "rex@example.test", "viewer"]], "every other member, with their role, not you");
  assert.match(h, /Leave everyone unticked to address the whole vault\. Addressing decides who is told about the thread, never who can read it: everyone in this vault can read every thread, and so can their agents\./);
  assert.match(h, /An agent sees a new message on its next tool call, not instantly\. Secrets belong in <a href="\/v\/[0-9a-f-]+\/variables">variables<\/a>, never in a thread\./);
  assert.match(await page(noa, `/v/${V.main}/threads/new?path=notes%2Fdraft.md`), /name="path" value="notes\/draft\.md"/);
});

test("open: a title, a message, a file and the people to tell open a side thread with the person as its opener", async () => {
  const token = csrfOf(await page(edda, `/v/${V.main}/threads/new`));
  const r = await post(edda, `/v/${V.main}/threads`, { csrf: token, title: "  Colours  ", body: "Rex, which blue?\r\nThanks.", path: " notes/draft.md ", to: [REX, NOA] });
  assert.equal(r.status, 303);
  const h = await landed(edda, r);
  assert.match(flashOf(h)[2], /Thread opened\./);
  assert.match(h, /<h1 class="path">Colours<\/h1>/);
  assert.match(h, /It is addressed to (?:noa@example\.test, rex@example\.test|rex@example\.test, noa@example\.test)/);
  assert.match(h, /Opened by you /);
  assert.match(h, /Rex, which blue\?\nThanks\./);
  const id = /\/threads\/([0-9a-f-]{36})$/.exec(r.headers.get("location"))[1];
  const [row] = await sql("select opened_by, agent, anchor_path, (select array_agg(user_id order by user_id) from public.thread_addressees where thread_id = $1) as to_ from public.threads where id = $1", [id]);
  assert.deepEqual({ by: row.opened_by, agent: row.agent, path: row.anchor_path, to: row.to_ }, { by: EDDA, agent: null, path: "notes/draft.md", to: [NOA, REX] });
  const plain = await post(edda, `/v/${V.main}/threads`, { csrf: token, title: "For everyone", body: "Hello." });
  const h2 = await landed(edda, plain);
  assert.doesNotMatch(h2, /Side thread/);
  assert.equal((await sql("select count(*) as n from public.thread_addressees where thread_id = $1", [/\/threads\/([0-9a-f-]{36})$/.exec(plain.headers.get("location"))[1]]))[0].n, "0");
});

test("open: a refused thread comes back on its form with the reason and everything that was typed, and stores nothing", async () => {
  const token = csrfOf(await page(noa, `/v/${V.main}/threads/new`));
  const before = await threadsIn(V.main);
  const typed = { csrf: token, title: "", body: "Typed message", path: "notes/draft.md", to: [REX] };
  const noTitle = await post(noa, `/v/${V.main}/threads`, typed);
  assert.equal(noTitle.status, 400);
  const h = await noTitle.text();
  assert.match(refusal(h), /A thread needs a title\. \(ref [0-9a-f]{8}\)/);
  assert.match(h, /<textarea id="t-body"[^>]*>Typed message<\/textarea>/);
  assert.match(h, /name="path" value="notes\/draft\.md"/);
  assert.match(h, new RegExp(`name="to" value="${REX}" checked>`));
  assert.doesNotMatch(h, new RegExp(`name="to" value="${EDDA}" checked`));
  const stranger = await post(noa, `/v/${V.main}/threads`, { ...typed, title: "T", to: [OLA] });
  assert.match(refusal(await stranger.text()), /Every addressee must be a member of this vault\. \(ref [0-9a-f]{8}\)/);
  const garbled = await post(noa, `/v/${V.main}/threads`, { ...typed, title: "T", to: ["not-an-id"] });
  assert.equal(garbled.status, 400);
  assert.match(refusal(await garbled.text()), /An addressee wasn’t one of this vault’s members, so no thread was opened\. \(ref [0-9a-f]{8}\)/);
  const longTitle = await post(noa, `/v/${V.main}/threads`, { ...typed, title: "t".repeat(201) });
  assert.match(refusal(await longTitle.text()), /A thread&#39;s title is at most 200 characters, and this one has 201\. \(ref [0-9a-f]{8}\)/);
  const badPath = await post(noa, `/v/${V.main}/threads`, { ...typed, title: "T", path: "../x" });
  assert.match(refusal(await badPath.text()), /\(ref [0-9a-f]{8}\)/);
  assert.equal(await threadsIn(V.main), before);
});

test("open: a viewer is sent back to the list by the form's address, and a forced post is refused by the database", async () => {
  const r = await get(rex, `/v/${V.main}/threads/new`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), `/v/${V.main}/threads`);
  const list = await landed(rex, r);
  assert.match(flashOf(list)[2], /Only editors and owners open threads; viewers read them\./);
  assert.doesNotMatch(list, /New thread/);
  const before = await threadsIn(V.main);
  const forced = await post(rex, `/v/${V.main}/threads`, { csrf: csrfOf(list), title: "Sneaky", body: "Hi" });
  assert.equal(forced.status, 400);
  assert.match(refusal(await forced.text()), /Only editors and owners write in threads, and their agents need a read-write connection; viewers read them\. \(ref [0-9a-f]{8}\)/);
  assert.equal(await threadsIn(V.main), before);
  assert.equal((await get(ola, `/v/${V.main}/threads/new`)).status, 404);
  assert.equal((await post(ola, `/v/${V.main}/threads`, { csrf: csrfOf(await page(ola, "/")), title: "x", body: "y" })).status, 404);
});

test("threads: writers get a New thread button on the list, with the file filled in when the list is for one file", async () => {
  assert.match(await page(noa, `/v/${V.main}/threads`), new RegExp(`<a class="button primary" href="/v/${V.main}/threads/new">New thread</a>`));
  assert.match(await page(edda, `/v/${V.main}/threads?path=notes%2Fdraft.md`), new RegExp(`href="/v/${V.main}/threads/new\\?path=notes%2Fdraft\\.md">New thread</a>`));
  assert.doesNotMatch(await page(rex, `/v/${V.main}/threads`), /New thread/);
});

test("threads: no em dashes or straight apostrophes in the copy of the thread page and the form", async () => {
  for (const [s, path] of [[noa, thread(V.main, T.talk)], [rex, thread(V.main, T.talk)], [noa, thread(V.main, T.side)], [noa, `/v/${V.main}/threads/new`]]) {
    const text = visibleText(await page(s, path));
    assert.doesNotMatch(text.replace("Agent note from Edda's side.", ""), /—|[a-z]'[a-z]/i, path);
  }
});

test("errors: a request about a thread is described by what it does, and its log line holds ids only", () => {
  const vid = "3f2a9c1d-0000-4000-8000-000000000000";
  const tid = "7b1e2f40-0000-4000-8000-000000000000";
  const of = (method, path) => describe(method, new URL(`http://x${path}`), new URLSearchParams());
  assert.equal(of("GET", `/v/${vid}/threads`).what, "Opening the threads of vault 3f2a9c1d");
  assert.equal(of("POST", `/v/${vid}/threads`).what, "Opening a thread in vault 3f2a9c1d");
  assert.equal(of("GET", `/v/${vid}/threads/new`).what, "Opening New thread in vault 3f2a9c1d");
  assert.equal(of("GET", `/v/${vid}/threads/${tid}`).what, "Opening thread 7b1e2f40 in vault 3f2a9c1d");
  assert.equal(of("POST", `/v/${vid}/threads/${tid}/post`).what, "Posting in thread 7b1e2f40 in vault 3f2a9c1d");
  assert.equal(of("POST", `/v/${vid}/threads/${tid}/resolve`).what, "Resolving thread 7b1e2f40 in vault 3f2a9c1d");
  assert.equal(of("POST", `/v/${vid}/threads/${tid}/reopen`).what, "Reopening thread 7b1e2f40 in vault 3f2a9c1d");
  assert.equal(of("POST", `/v/${vid}/threads/${tid}/post`).log, `POST /v/:id/threads/:id/post ${vid} ${tid}`);
});
