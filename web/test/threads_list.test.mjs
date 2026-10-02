// A vault's Threads page (src/threadspage.ts): the list of conversations
// between its members and their agents. Who may read or write a thread is
// proved once, in supabase/tests/vault_threads_test.sql; this file is about
// what a person sees: every member sees every thread, side threads marked in
// words, the ones addressed to them first, nothing from another vault, and
// that other people's and agents' words stay inert text.
//
// Noa owns "Threads main", Edda edits it and Rex only views it. Ola is in
// none of the vaults below but her own.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addPeople, as, EDDA, get, NOA, OLA, page, REX, sql, start, visibleText } from "./threads-harness.mjs";

const V = {};
const T = {};
let noa;
let edda;
let rex;
let ola;

const open = (user, vault, title, body, o = {}) =>
  as(
    user,
    "select public.open_thread($1, $2, $3, $4::uuid[], $5, $6::bigint, $7::uuid) as id",
    [vault, title, body, o.to ?? null, o.path ?? null, o.step ?? null, o.proposal ?? null],
    o.agent ?? null,
  ).then((r) => r[0].id);

const threads = (v) => `/v/${v}/threads`;
// The <li> of the list whose title link says `title`.
const rowOf = (h, title) => new RegExp(`<li[^>]*>(?:(?!</li>)[\\s\\S])*>${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</a>[\\s\\S]*?</li>`).exec(h)?.[0];
const titlesIn = (h) => [...h.matchAll(/<a class="name" href="\/v\/[0-9a-f-]+\/threads\/[0-9a-f-]+">([^<]*)<\/a>/g)].map((m) => m[1]);

before(async () => {
  await addPeople();
  noa = await start(NOA, "noa");
  edda = await start(EDDA, "edda");
  rex = await start(REX, "rex");
  ola = await start(OLA, "ola");

  [{ id: V.main }] = await as(NOA, "select public.create_vault('Threads main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3), test_support.add_member($1, $4, 'viewer', $3)", [V.main, EDDA, NOA, REX]);
  [{ id: V.other }] = await as(NOA, "select public.create_vault('Threads other', 'open') as id");
  [{ id: V.empty }] = await as(NOA, "select public.create_vault('Threads empty', 'open') as id");
  [{ id: V.ola }] = await as(OLA, "select public.create_vault('Threads Ola only', 'open') as id");
  [{ id: V.many }] = await as(NOA, "select public.create_vault('Threads many', 'open') as id");

  await as(NOA, "select public.write_file($1, 'notes/plan.md', 'The plan.')", [V.main]);
  await as(NOA, "select public.write_file($1, 'plans/launch.md', 'Launch.')", [V.main]);
  await as(NOA, "select public.set_policy($1, 'canon/', 'canon', 1)", [V.main]);
  const [{ id: proposal }] = await as(EDDA, "select public.propose($1, 'canon/brief.md', 'A brief.', 'brief') as id", [V.main]);
  const [{ v: version }] = await sql("select current_version_id as v from public.files where vault_id = $1 and path = 'plans/launch.md'", [V.main]);
  await as(NOA, `select public.register_work_plan($1, 'plans/launch.md', $2, '[{"key":"copy","title":"Write the copy"}]'::jsonb)`, [V.main, version]);
  const [{ id: step }] = await sql("select id from public.work_plan_steps where vault_id = $1 and key = 'copy'", [V.main]);

  // Oldest activity first; the posts at the end reorder it.
  T.resolved = await open(NOA, V.main, "Old question", "Is it Tuesday?");
  await as(NOA, "select public.resolve_thread($1)", [T.resolved]);
  T.later = await open(NOA, V.main, "About a file to come", "Not written yet.", { path: "notes/later.md" });
  T.task = await open(EDDA, V.main, "Copy review", "Who reviews the copy?", { step });
  T.proposal = await open(EDDA, V.main, "The brief", "Please look at the brief.", { proposal });
  T.sideRex = await open(EDDA, V.main, "Question for Rex", "Rex, can you check the colours?", { to: [REX], agent: "Hermes on Linux" });
  T.sideNoa = await open(EDDA, V.main, "Between Edda and Noa", "Noa, about the budget.", { to: [NOA] });
  T.hostile = await open(NOA, V.main, "<script>alert(1)</script> [click](javascript:alert(2))", "Text.");
  T.wide = await open(NOA, V.main, "Plan the launch", "Where do we start?", { path: "notes/plan.md" });
  await as(EDDA, "select public.post_message($1, 'With the copy.')", [T.wide]);
  await open(NOA, V.other, "Other vault thread", "Not for the main vault's list.");
  await open(OLA, V.ola, "Ola's own thread", "Hers.");
  await as(NOA, "select public.open_thread($1, 'Bulk ' || g, 'Filler.') from generate_series(1, 101) g", [V.many]);
});

after(async () => {
  for (const s of [noa, edda, rex, ola]) s?.child?.kill();
});

test("threads list: a vault with no threads says so in two sentences", async () => {
  const h = await page(noa, threads(V.empty));
  assert.match(h, /<h1>Threads<\/h1>/);
  assert.match(h, /<strong>No threads yet\.<\/strong><p>A thread is a conversation about the work, between the people in this vault and their agents\.<\/p>/);
  assert.doesNotMatch(h, /thread-rows/);
});

test("threads list: newest activity first, each row with its title, opener, message count, last activity and state", async () => {
  // Edda is addressed in none of them, so nothing is lifted to the top for her.
  assert.deepEqual(titlesIn(await page(edda, threads(V.main))), [
    "Plan the launch", "<script>alert(1)</script> [click](javascript:alert(2))", "Between Edda and Noa", "Question for Rex", "The brief", "Copy review",
    "About a file to come", "Old question",
  ].map((t) => t.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")));
  const h = await page(noa, threads(V.main));
  const wide = rowOf(h, "Plan the launch");
  assert.match(wide, /Opened by you · <time datetime="[^"]+" title="[^"]+ UTC">[^<]+<\/time>/);
  assert.match(wide, /2 messages · last <time/);
  assert.match(wide, /<span class="badge info">Open<\/span>/);
  const old = rowOf(h, "Old question");
  assert.match(old, /^<li class="is-resolved">/);
  assert.match(old, /<span class="badge success">Resolved<\/span>/);
  assert.match(old, /1 message · last/);
  assert.doesNotMatch(wide, /Side thread|Resolved/);
});

test("threads list: each row says what the thread is about, linked only to what is there", async () => {
  const h = await page(noa, threads(V.main));
  const enc = encodeURIComponent;
  assert.match(rowOf(h, "Plan the launch"), new RegExp(`About the file <a href="/v/${V.main}/file\\?path=${enc("notes/plan.md")}">notes/plan\\.md</a>`));
  assert.match(rowOf(h, "About a file to come"), /About the file <code>notes\/later\.md<\/code>/, "a file that isn't there yet is only text");
  assert.match(rowOf(h, "Copy review"), new RegExp(`About the task <a href="/v/${V.main}/file\\?path=${enc("plans/launch.md")}">Write the copy</a> in <code>plans/launch\\.md</code>`));
  assert.match(rowOf(h, "The brief"), new RegExp(`About the proposal for <a href="/v/${V.main}/proposals/[0-9a-f-]{36}">canon/brief\\.md</a>`));
  assert.doesNotMatch(rowOf(h, "Old question"), /About/);
});

test("threads list: who opened it, and the agent that opened it for them", async () => {
  const h = await page(noa, threads(V.main));
  assert.match(rowOf(h, "Question for Rex"), /Opened by edda@example\.test’s agent \(Hermes on Linux\)/);
  assert.match(rowOf(h, "The brief"), /Opened by edda@example\.test ·/);
  const mine = await page(edda, threads(V.main));
  assert.match(rowOf(mine, "Question for Rex"), /Opened by your agent \(Hermes on Linux\)/);
});

test("threads list: a side thread is marked in words, and every member of the vault sees it", async () => {
  // Noa isn't addressed in "Question for Rex", and Rex isn't in "Between Edda and Noa". Edda opened both
  // and is addressed in neither: whoever opened a side thread keeps it in view, like every other member.
  for (const [who, s, title, to] of [["Noa", noa, "Question for Rex", "Addressed to 1 person"], ["Edda", edda, "Between Edda and Noa", "Addressed to 1 person"], ["Rex", rex, "Between Edda and Noa", "Addressed to 1 person"]]) {
    const row = rowOf(await page(s, threads(V.main)), title);
    assert.ok(row, `${who} sees "${title}"`);
    assert.match(row, /<span class="badge side-thread" title="Addressed to some members\. Everyone in this vault can still read it\.">Side thread<\/span>/, `${who}: marked`);
    assert.match(row, new RegExp(to), `${who}: says to how many`);
  }
  assert.doesNotMatch(rowOf(await page(noa, threads(V.main)), "Plan the launch"), /Side thread/, "a vault-wide thread has no marker");
});

test("threads list: the threads addressed to you come first, under their own heading", async () => {
  const h = await page(rex, threads(V.main));
  assert.deepEqual([...h.matchAll(/<h([12])>([^<]*)<\/h\1>/g)].map((m) => m[2]), ["Threads", "Addressed to you", "Other threads"]);
  const [first, second] = h.split("<h2>Other threads</h2>");
  assert.deepEqual(titlesIn(first), ["Question for Rex"]);
  assert.match(rowOf(first, "Question for Rex"), /Side thread<\/span> Addressed to you · Opened by/);
  assert.ok(titlesIn(second).includes("Between Edda and Noa") && titlesIn(second).includes("Plan the launch"));
  assert.ok(!titlesIn(second).includes("Question for Rex"), "it is listed once");
  // Noa has one addressed to her; Edda has none, so no heading and one list.
  assert.deepEqual(titlesIn((await page(noa, threads(V.main))).split("<h2>Other threads</h2>")[0]), ["Between Edda and Noa"]);
  const e = await page(edda, threads(V.main));
  assert.doesNotMatch(e, /Addressed to you<\/h2>|Other threads/);
});

test("threads list: nothing from another vault, and a vault you are not in is Not found", async () => {
  const h = await page(noa, threads(V.main));
  assert.doesNotMatch(h, /Other vault thread|Ola&#39;s own thread|Bulk/);
  assert.match(await page(noa, threads(V.other)), /Other vault thread/);
  assert.doesNotMatch(await page(noa, threads(V.other)), /Plan the launch/);
  assert.equal((await get(ola, threads(V.main))).status, 404);
  assert.equal((await get(noa, threads(V.ola))).status, 404);
  assert.equal((await get(noa, "/v/not-a-vault/threads")).status, 404);
});

test("threads list: ?path= shows the threads about that file, and says so when there are none", async () => {
  const h = await page(noa, `${threads(V.main)}?path=${encodeURIComponent("notes/plan.md")}`);
  assert.deepEqual(titlesIn(h), ["Plan the launch"]);
  assert.match(h, new RegExp(`Showing threads about <code>notes/plan\\.md</code>\\. <a href="/v/${V.main}/threads">Show every thread</a>`));
  const none = await page(noa, `${threads(V.main)}?path=${encodeURIComponent("notes/nothing.md")}`);
  assert.match(none, /<strong>No threads about this file\.<\/strong>/);
  assert.match(none, new RegExp(`<a href="/v/${V.main}/threads">Show every thread in this vault</a>`));
});

test("threads list: older threads come on a second page, once each", async () => {
  const first = await page(noa, threads(V.many));
  assert.equal(titlesIn(first).length, 100);
  const next = /<a href="([^"]+)">Older threads<\/a>/.exec(first)?.[1];
  assert.ok(next, "a link to older threads");
  const second = await page(noa, next.replaceAll("&amp;", "&"));
  assert.deepEqual(titlesIn(second), ["Bulk 1"]);
  assert.doesNotMatch(second, /Older threads/);
  assert.ok(!titlesIn(first).includes("Bulk 1"));
});

test("threads list: the vault's Threads entry is in its navigation, marked on this page only", async () => {
  const h = await page(noa, threads(V.main));
  const navs = h.match(/<nav class="(?:side-links|tabs)" aria-label="Vault(?: \(phone\))?">[\s\S]*?<\/nav>/g);
  assert.equal(navs.length, 2, "the sidebar and the phone tabs");
  for (const nav of navs) assert.match(nav, new RegExp(`<a href="/v/${V.main}/threads" aria-current="page">Threads</a>`));
  const files = await page(noa, `/v/${V.main}`);
  assert.match(files, new RegExp(`<a href="/v/${V.main}/threads">Threads</a>`));
  assert.doesNotMatch(files, new RegExp(`/v/${V.main}/threads" aria-current`));
  assert.equal((h.match(/<h1[ >]/g) ?? []).length, 1, "one h1");
});

test("threads list: a title with markup or a markdown link is shown as the text it is", async () => {
  const h = await page(noa, threads(V.main));
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt; \[click\]\(javascript:alert\(2\)\)/);
  assert.doesNotMatch(h, /<script>alert|href="javascript:/);
});

test("threads list: no em dashes or straight apostrophes in the copy", async () => {
  for (const path of [threads(V.main), threads(V.empty), `${threads(V.main)}?path=notes%2Fnothing.md`]) {
    const text = visibleText(await page(rex, path));
    assert.doesNotMatch(text, /—/, `em dash on ${path}`);
    assert.doesNotMatch(text, /[a-z]'[a-z]/i, `straight apostrophe on ${path}`);
  }
});
