// The line on a file's page that says how many threads are about it
// (src/files.ts), and the Threads list it links to, filtered to the file.
// Who may read a thread is proved once, in supabase/tests/vault_threads_test.sql;
// this file is about what the file page shows: the count, only this vault's
// threads, only for a file that has some, never on the editor.
//
// Noa owns "File threads", Rex only views it. "File threads other" is Noa's
// too and has a file at the same path.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { addPeople, as, NOA, page, REX, sql, start, visibleText } from "./threads-harness.mjs";

const V = {};
let noa;
let rex;

const file = (v, path, rest = "") => `/v/${v}/file?path=${encodeURIComponent(path)}${rest}`;
const line = (h) => /<p class="meta file-meta">([\s\S]*?)<\/p>/.exec(h)?.[1];

before(async () => {
  await addPeople();
  noa = await start(NOA, "noa");
  rex = await start(REX, "rex");
  [{ id: V.main }] = await as(NOA, "select public.create_vault('File threads', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.main, REX, NOA]);
  [{ id: V.other }] = await as(NOA, "select public.create_vault('File threads other', 'open') as id");
  for (const v of [V.main, V.other]) for (const p of ["notes/two.md", "notes/one.md", "notes/quiet.md"]) await as(NOA, "select public.write_file($1, $2, 'Text.')", [v, p]);

  const open = (v, title, o = {}) => as(NOA, "select public.open_thread($1, $2, 'First message.', null, $3) as id", [v, title, o.path ?? null]).then((r) => r[0].id);
  await open(V.main, "First about two", { path: "notes/two.md" });
  const resolved = await open(V.main, "Second about two", { path: "notes/two.md" });
  await as(NOA, "select public.resolve_thread($1)", [resolved]);
  await open(V.main, "About one", { path: "notes/one.md" });
  await open(V.main, "About a file to come", { path: "notes/later.md" });
  await open(V.main, "About nothing");
  await open(V.other, "Other vault, same path", { path: "notes/quiet.md" });
  await open(V.other, "Other vault, same path again", { path: "notes/one.md" });
});

after(async () => {
  for (const s of [noa, rex]) s?.child?.kill();
});

test("file page threads: a file with threads says how many, open or resolved, and links to the list for that file", async () => {
  for (const [who, s] of [["Noa", noa], ["Rex", rex]]) {
    const h = await page(s, file(V.main, "notes/two.md"));
    assert.match(line(h), new RegExp(`^Last written by [^<]+ · <time[^>]*>[^<]+</time> · <a href="/v/${V.main}/threads\\?path=notes%2Ftwo\\.md">2 threads about this file</a>$`), who);
  }
  assert.match(line(await page(noa, file(V.main, "notes/one.md"))), /<a href="[^"]+">1 thread about this file<\/a>$/, "one is singular");
});

test("file page threads: the link opens the threads about that file, as many as the line said", async () => {
  const h = await page(noa, file(V.main, "notes/two.md"));
  const href = /<a href="([^"]+)">2 threads about this file<\/a>/.exec(h)[1];
  const list = await page(noa, href);
  const titles = [...list.matchAll(/<a class="name" href="[^"]+">([^<]*)<\/a>/g)].map((m) => m[1]);
  assert.deepEqual(titles, ["Second about two", "First about two"]);
  assert.match(list, /<span class="badge success">Resolved<\/span>/);
});

test("file page threads: a file with no thread in this vault says nothing, even when another vault has one at the same path", async () => {
  // notes/quiet.md has a thread only in "File threads other".
  const h = await page(noa, file(V.main, "notes/quiet.md"));
  assert.doesNotMatch(line(h), /thread/);
  assert.doesNotMatch(h, /about this file/);
});

test("file page threads: only this vault's threads about the path are counted", async () => {
  // notes/one.md has a thread in each vault, so an unscoped count would say 2.
  assert.match(line(await page(noa, file(V.main, "notes/one.md"))), /<a [^>]*>1 thread about this file<\/a>$/);
  assert.match(line(await page(noa, file(V.other, "notes/quiet.md"))), /<a [^>]*>1 thread about this file<\/a>$/);
  assert.doesNotMatch(await page(noa, file(V.main, "notes/two.md")), /Other vault/);
});

test("file page threads: the editor says nothing about threads", async () => {
  const edit = await page(noa, `/v/${V.main}/edit?path=${encodeURIComponent("notes/two.md")}`);
  assert.match(edit, /<h1 class="path">Edit two\.md<\/h1>/);
  assert.doesNotMatch(edit, /about this file|threads\?path=/);
});

test("file page threads: no em dashes or straight apostrophes in the line", async () => {
  const text = visibleText(line(await page(noa, file(V.main, "notes/two.md"))));
  assert.doesNotMatch(text, /—|[a-z]'[a-z]/i);
});
