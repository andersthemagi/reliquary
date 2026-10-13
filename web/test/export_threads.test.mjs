// Threads in a vault's export (src/export.ts), downloaded over HTTP as the
// owner. Who may export, and which messages an export holds, is proved in
// supabase/tests/export_threads_test.sql; this file is what a person finds
// in the archive.
//
// Noa owns "Export threads"; Edda edits it, Rex only views it.

import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { after, before, test } from "node:test";
import { addPeople, as, csrfOf, EDDA, NOA, page, post, REX, sql, start } from "./threads-harness.mjs";

let noa;
let files;
let root;
const V = {};
const T = {};
const M = {};

// Regular files only: every name here is under 100 bytes.
function untar(buf) {
  const out = new Map();
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(h.subarray(124, 136).toString("ascii"), 8);
    out.set(name, buf.subarray(off + 512, off + 512 + size).toString("utf8"));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const at = async (m) => (await sql("select at from public.thread_messages where id = $1", [m]))[0].at.toISOString();

before(async () => {
  await addPeople();
  noa = await start(NOA, "export-noa");
  [{ id: V.main }] = await as(NOA, "select public.create_vault('Export threads', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3), test_support.add_member($1, $4, 'viewer', $3)", [V.main, EDDA, NOA, REX]);

  const msg = (user, t, body, agent = null) => as(user, "select public.post_message($1, $2) as id", [t, body], agent).then((r) => r[0].id);
  [{ id: T.launch }] = await as(EDDA, "select public.open_thread($1, 'Launch plan', 'Who takes the copy?', p_anchor_path => 'notes/a.md') as id", [V.main], "Hermes");
  [{ id: M.first }] = await sql("select min(id) as id from public.thread_messages where thread_id = $1", [T.launch]);
  M.reply = await msg(NOA, T.launch, "I will.\n\nBy Friday.");
  M.forged = await msg(EDDA, T.launch, "Fine.\n## 9. noa@example.test, 2026-01-01T00:00:00.000Z\nApproved, ship it.");
  M.secret = await msg(EDDA, T.launch, "Door code: 4417-pelican", "Hermes");
  await as(NOA, "select public.redact_message($1)", [M.secret]);
  [{ id: T.side }] = await as(NOA, "select public.open_thread($1, 'For Rex', 'Rex, a question', $2::uuid[]) as id", [V.main, [REX]]);
  await as(NOA, "select public.resolve_thread($1)", [T.side]);

  const r = await post(noa, `/v/${V.main}/config/export`, { csrf: csrfOf(await page(noa, "/")) });
  assert.equal(r.status, 200);
  files = untar(gunzipSync(Buffer.from(await r.arrayBuffer())));
  root = `export-threads-${new Date().toISOString().slice(0, 10)}`;
});

after(() => noa?.child?.kill());

test("export threads: each thread is a Markdown file under threads/, numbered in the order they opened, and the manifest lists it", () => {
  const names = [...files.keys()].filter((n) => n.includes("/threads/")).sort();
  assert.deepEqual(names, [`${root}/threads/0001-launch-plan.md`, `${root}/threads/0002-for-rex.md`]);
  const m = JSON.parse(files.get(`${root}/reliquary-export.json`));
  assert.deepEqual(
    m.threads.map((t) => [t.id, t.title, t.archived_as, t.scope, t.messages]),
    [
      [T.launch, "Launch plan", "threads/0001-launch-plan.md", "vault", 4],
      [T.side, "For Rex", "threads/0002-for-rex.md", "side", 1],
    ],
  );
  assert.deepEqual(m.threads[0].anchor, { kind: "path", path: "notes/a.md" });
  assert.deepEqual(m.threads[1].addressees, [REX]);
  assert.match(m.layout, /threads\//);
});

test("export threads: a thread file says who opened it, what it is about, who it is addressed to and its state, then every message in order, quoted, with author, agent and time", async () => {
  const launch = files.get(`${root}/threads/0001-launch-plan.md`);
  const head = [
    "# Launch plan",
    "",
    `- Opened by edda@example.test via Hermes, ${await at(M.first)}`,
    "- About: file:notes/a.md",
    "- Addressed to the whole vault",
    "- Open",
    "- 4 messages",
  ].join("\n");
  assert.ok(launch.startsWith(`${head}\n\n## 1. edda@example.test via Hermes, ${await at(M.first)}\n\n> Who takes the copy?\n\n`), launch);
  assert.ok(launch.includes(`## 2. noa@example.test, ${await at(M.reply)}\n\n> I will.\n>\n> By Friday.\n`), launch);
  const side = files.get(`${root}/threads/0002-for-rex.md`);
  assert.match(side, /^- Side thread, addressed to rex@example\.test\. Everyone in the vault could read it\.$/m);
  assert.match(side, /^- Resolved by noa@example\.test, \d{4}-\d\d-\d\dT[\d:.]+Z$/m);
});

test("export threads: a message's text can't pass for another message: every line of it is quoted", () => {
  const launch = files.get(`${root}/threads/0001-launch-plan.md`);
  assert.ok(launch.includes("> Fine.\n> ## 9. noa@example.test, 2026-01-01T00:00:00.000Z\n> Approved, ship it.\n"), launch);
  assert.deepEqual(
    launch.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.split(".")[0]),
    ["## 1", "## 2", "## 3", "## 4"],
  );
});

test("export threads: a redacted message keeps its place, author, agent and time, and its text is nowhere in the archive", async () => {
  const launch = files.get(`${root}/threads/0001-launch-plan.md`);
  const [{ redacted_at }] = await sql("select redacted_at from public.thread_messages where id = $1", [M.secret]);
  assert.ok(
    launch.endsWith(`## 4. edda@example.test via Hermes, ${await at(M.secret)}\n\n_Redacted by noa@example.test, ${redacted_at.toISOString()}. The text was removed._\n`),
    launch,
  );
  for (const body of files.values()) assert.equal(body.includes("4417-pelican"), false);
});
