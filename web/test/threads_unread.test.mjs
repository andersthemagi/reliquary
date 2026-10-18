// The Unread badge on a vault's Threads page (src/threadspage.ts, F971):
// a thread with a message from someone else, or from an agent, newer than
// the last one the person was shown says Unread, in words; opening the thread
// (src/threadview.ts) marks it read. Who may read or write the record is
// proved in supabase/tests/thread_reads_test.sql (F970).
//
// Noa owns "Threads unread", Edda edits it.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addPeople, as, EDDA, NOA, page, sql, start } from "./threads-harness.mjs";

const T = {};
let V;
let noa;
let edda;

const open = (user, title, body, agent = null) =>
  as(user, "select public.open_thread($1, $2, $3) as id", [V, title, body], agent).then((r) => r[0].id);
const threads = () => `/v/${V}/threads`;
const rowOf = (h, title) => new RegExp(`<li[^>]*>(?:(?!</li>)[\\s\\S])*>${title}</a>[\\s\\S]*?</li>`).exec(h)?.[0];
const UNREAD = /<span class="badge warning">Unread<\/span>/;

before(async () => {
  await addPeople();
  noa = await start(NOA, "noa");
  edda = await start(EDDA, "edda");
  [{ id: V }] = await as(NOA, "select public.create_vault('Threads unread', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V, EDDA, NOA]);
  T.eddas = await open(EDDA, "Opened by Edda", "Noa, have a look.");
  T.noas = await open(NOA, "Opened by Noa", "Only my own words.");
});

after(async () => {
  for (const s of [noa, edda]) s?.child?.kill();
});

test("threads unread: a thread never opened is unread when another member wrote in it, in words, and not when only your own message exists", async () => {
  const h = await page(noa, threads());
  assert.match(rowOf(h, "Opened by Edda"), UNREAD);
  assert.doesNotMatch(rowOf(h, "Opened by Noa"), UNREAD);
  const e = await page(edda, threads());
  assert.doesNotMatch(rowOf(e, "Opened by Edda"), UNREAD, "Edda's own message isn't news to her");
  assert.match(rowOf(e, "Opened by Noa"), UNREAD);
});

test("threads unread: opening the thread marks it read, and a later message from another member makes it unread again", async () => {
  await page(noa, `${threads()}/${T.eddas}`);
  assert.doesNotMatch(rowOf(await page(noa, threads()), "Opened by Edda"), UNREAD);
  await as(EDDA, "select public.post_message($1, 'And another thing.')", [T.eddas]);
  assert.match(rowOf(await page(noa, threads()), "Opened by Edda"), UNREAD);
  assert.doesNotMatch(rowOf(await page(edda, threads()), "Opened by Edda"), UNREAD, "the poster's own message, in person, isn't unread for them");
});

test("threads unread: a message your own agent posted is unread for you", async () => {
  await page(noa, `${threads()}/${T.noas}`);
  assert.doesNotMatch(rowOf(await page(noa, threads()), "Opened by Noa"), UNREAD);
  await as(NOA, "select public.post_message($1, 'Done, as asked.')", [T.noas], "Claude Code");
  assert.match(rowOf(await page(noa, threads()), "Opened by Noa"), UNREAD);
});

test("threads unread: the badge is words beside the state, never only a colour", async () => {
  const row = rowOf(await page(noa, threads()), "Opened by Noa");
  assert.match(row, /<span class="badge warning">Unread<\/span> <span class="badge info">Open<\/span>/);
});
