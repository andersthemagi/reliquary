// The Changes feed (src/changes.ts): what people and their agents did to a
// vault's content, in plain words, newest first and grouped by day. The log
// and who may read it are the database's (RLS, tested in supabase/tests and
// diff_activity.test.mjs); this file is about which events show, how they
// read, how repeat writes fold, how pages are cut, and that opening the page
// changes nothing.
//
// This file starts its own servers from dist/, signed in as Hana (an owner)
// and Jun (a viewer), people no other test file uses. Hana owns "Changes
// main" with Ivo (an editor) and Jun.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { collapse, dayLabel, PAGE_LINES } from "../dist/changes.js";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const HANA = "00000000-0000-0000-0000-0000000050a1";
const IVO = "00000000-0000-0000-0000-0000000050a2";
const JUN = "00000000-0000-0000-0000-0000000050a3";

const V = {};
const servers = [];
let hana;
let jun;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
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

// As a person in the web UI, or (with an agent name) as their agent.
async function as(user, q, params = [], agent = null) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    const claims = { sub: user, role: "authenticated", ...(agent ? { act: { sub: agent, name: agent } } : {}) };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

async function start(user, name) {
  const port = await freePort();
  const s = { origin: `http://127.0.0.1:${port}`, cookie: "", child: null };
  const loginFile = `/tmp/changes-page-${name}-${process.pid}-${port}`;
  s.child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(s);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${s.origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];
  return s;
}

const get = (s, path) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (s, path) => (await get(s, path)).text();
const changesUrl = (v) => `/v/${v}/changes`;
const q = encodeURIComponent;
const text = (h) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

// The feed's lines, newest first, as plain text, with the day each sits under.
function lines(h) {
  const out = [];
  for (const sec of h.split('<section class="feed-day"').slice(1)) {
    const day = text(/<h2 id="[^"]+">([\s\S]*?)<\/h2>/.exec(sec)[1]);
    for (const m of sec.matchAll(/<li class="change"><span class="change-what">([\s\S]*?)<\/span><span class="change-when">/g)) out.push([day, text(m[1])]);
  }
  return out;
}
const rows = (h) => [...h.matchAll(/<li class="change">([\s\S]*?)<\/li>/g)].map((m) => m[1]);

// "Tuesday 29 September" for a date n days ago (UTC), by an independent route.
const daysAgo = (n) => {
  const d = new Date(Date.now() - n * 86_400_000);
  const s = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).replace(",", "");
  return d.getUTCFullYear() === new Date().getUTCFullYear() ? s : `${s} ${d.getUTCFullYear()}`;
};

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'hana@example.test'), ($2, 'ivo@example.test'), ($3, 'jun@example.test') on conflict (id) do nothing`,
    [HANA, IVO, JUN],
  );
  hana = await start(HANA, "hana");
  jun = await start(JUN, "jun");

  [{ id: V.main }] = await as(HANA, "select public.create_vault('Changes main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, IVO, HANA]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.main, JUN, HANA]);

  // Older days first: the log's order is its seq, so these go in before today's.
  await sql(
    `insert into public.log (vault_id, actor, event, path, at) values
       ($1, $2, 'file.delete', 'archive/old.md', now() - interval '3 days'),
       ($1, $3, 'file.write', 'archive/2026.md', now() - interval '1 day'),
       ($1, $3, 'file.write', 'archive/2026.md', now() - interval '1 day')`,
    [V.main, HANA, IVO],
  );

  await as(HANA, "select public.write_file($1, 'canon/rules.md', 'Rules v1')", [V.main]);
  await as(HANA, "select public.set_policy($1, 'canon/rules.md', 'canon', 1)", [V.main]);
  for (let i = 1; i <= 4; i++) await as(IVO, "select public.write_file($1, 'notes/plan.md', $2)", [V.main, `Plan ${i}`]);
  await as(IVO, "select public.write_file($1, 'notes/plan.md', 'Plan by agent')", [V.main], "Hermes on Linux");
  await as(HANA, "select public.write_file($1, 'notes/todo.md', 'Todo')", [V.main]);
  await as(HANA, "select public.write_file($1, 'tmp/scratch.md', 'Scratch')", [V.main]);
  await as(HANA, "select public.delete_file($1, 'tmp/scratch.md')", [V.main]);
  await as(HANA, "select public.write_file($1, 'secret.md', 'Shh')", [V.main]);
  await as(HANA, "select public.erase_file($1, 'secret.md')", [V.main]);
  // Housekeeping, not a change to content: Jun is made an editor, then a viewer again.
  await as(HANA, "select public.set_member($1, $2, 'editor')", [V.main, JUN]);
  await as(HANA, "select public.set_member($1, $2, 'viewer')", [V.main, JUN]);
  [{ id: V.proposal }] = await as(IVO, "select public.propose($1, 'canon/rules.md', 'Rules v2', 'tighten') as id", [V.main]);
  await as(HANA, "select public.comment_on_proposal($1, 'looks right')", [V.proposal]);
  await as(HANA, "select public.decide($1, 'approve')", [V.proposal]);

  // A page is cut in lines, not events: 33 files, then one file written 5 times, newest.
  [{ id: V.long }] = await as(HANA, "select public.create_vault('Changes long', 'open') as id");
  for (let i = 1; i <= 33; i++) await as(HANA, "select public.write_file($1, $2, 'x')", [V.long, `f${String(i).padStart(2, "0")}.md`]);
  for (let i = 1; i <= 5; i++) await as(HANA, "select public.write_file($1, 'z.md', $2)", [V.long, `z${i}`]);

  // A run longer than one read of the log (100 events) is still one line.
  [{ id: V.big }] = await as(HANA, "select public.create_vault('Changes big', 'open') as id");
  await as(HANA, "select public.write_file($1, 'big.md', 'v' || g) from generate_series(1, 130) g", [V.big]);
  await as(HANA, "select public.write_file($1, 'other.md', 'x')", [V.big]);

  [{ id: V.empty }] = await as(HANA, "select public.create_vault('Changes empty', 'open') as id");
  [{ id: V.jun }] = await as(JUN, "select public.create_vault('Changes jun-only', 'open') as id");
});

after(async () => {
  for (const s of servers) s.child?.kill();
});

// ---------------------------------------------------------------------------
// Which events, in what words

test("changes: content events only, newest first, grouped by day, each in plain words from the reader's side", async () => {
  const h = await page(hana, changesUrl(V.main));
  assert.match(h, /<h1>Changes<\/h1>/);
  assert.deepEqual(lines(h), [
    ["Today", "ivo@example.test wrote canon/rules.md, from an approved proposal"],
    ["Today", "You approved the proposal on canon/rules.md"],
    ["Today", "You commented on the proposal on canon/rules.md"],
    ["Today", "ivo@example.test opened a proposal on canon/rules.md"],
    ["Today", "You erased the content of secret.md"],
    ["Today", "You wrote secret.md"],
    ["Today", "You deleted tmp/scratch.md"],
    ["Today", "You wrote tmp/scratch.md"],
    ["Today", "You wrote notes/todo.md"],
    ["Today", "ivo@example.test’s agent Hermes on Linux wrote notes/plan.md"],
    ["Today", "ivo@example.test wrote notes/plan.md 4 times"],
    ["Today", "You wrote canon/rules.md"],
    ["Yesterday", "ivo@example.test wrote archive/2026.md 2 times"],
    [daysAgo(3), "You deleted archive/old.md"],
  ]);
  // The vault recorded more than that (its creation, a rule, a member change): those are the Log's.
  const kept = await sql("select distinct event from public.log where vault_id = $1 and event in ('vault.create', 'policy.set', 'member.set') order by 1", [V.main]);
  assert.deepEqual(kept.map((r) => r.event), ["member.set", "policy.set", "vault.create"], "the log holds the events this page leaves out");
  assert.doesNotMatch(h, /Changed a rule|Changed members|Created the vault|Went stale/);
});

test("changes: you and your agent read as You and Your agent", async () => {
  await as(HANA, "select public.write_file($1, 'agent-note.md', 'by my agent')", [V.main], "Claude Code");
  const [first] = lines(await page(hana, changesUrl(V.main)));
  assert.deepEqual(first, ["Today", "Your agent Claude Code wrote agent-note.md"]);
  // Jun, a viewer, reads the same feed with Hana named, not "You".
  assert.deepEqual(lines(await page(jun, changesUrl(V.main)))[0], ["Today", "hana@example.test’s agent Claude Code wrote agent-note.md"]);
});

test("changes: a live file is a link, a deleted or erased one is text; a proposal's lines link to the proposal", async () => {
  const h = await page(hana, changesUrl(V.main));
  const byText = (needle) => rows(h).find((r) => text(r).includes(needle));
  assert.match(byText("wrote notes/todo.md"), new RegExp(`<a href="/v/${V.main}/file\\?path=${q("notes/todo.md")}">notes/todo\\.md</a>`));
  assert.doesNotMatch(byText("wrote tmp/scratch.md"), /<a /, "deleted: nothing to open");
  assert.doesNotMatch(byText("wrote secret.md"), /<a /, "erased: nothing to open");
  assert.doesNotMatch(byText("deleted tmp/scratch.md"), /<a /);
  for (const needle of ["opened a proposal", "commented on the proposal", "approved the proposal", "from an approved proposal"]) {
    assert.match(byText(needle), new RegExp(`<a href="/v/${V.main}/proposals/${V.proposal}">`), needle);
  }
});

// ---------------------------------------------------------------------------
// Repeat writes fold

test("changes: only neighbours fold, so another actor, an agent or a file between two writes keeps them apart", () => {
  const at = new Date("2026-10-02T12:00:00Z");
  const w = (seq, o = {}) => ({ seq: String(seq), at, actor: "a", agent: null, event: "file.write", path: "p.md", proposal_id: null, ...o });
  const n = (rs) => collapse(rs).map((l) => l.n);
  assert.deepEqual(n([w(5), w(4), w(3)]), [3]);
  assert.deepEqual(n([w(5), w(4, { path: "q.md" }), w(3)]), [1, 1, 1], "another file between");
  assert.deepEqual(n([w(5), w(4, { actor: "b" }), w(3)]), [1, 1, 1], "another person between");
  assert.deepEqual(n([w(5), w(4, { agent: "Hermes" }), w(3)]), [1, 1, 1], "an agent between");
  assert.deepEqual(n([w(5), w(4, { event: "file.delete" })]), [1, 1], "a delete is not a write");
  assert.deepEqual(n([w(5, { event: "file.delete" }), w(4, { event: "file.delete" })]), [1, 1], "only writes fold");
  assert.deepEqual(n([w(5, { proposal_id: "x" }), w(4, { proposal_id: "x" })]), [1, 1], "a write that applied a proposal stands alone");
  assert.deepEqual(n([w(5, { at: new Date("2026-10-02T00:30:00Z") }), w(4, { at: new Date("2026-10-01T23:30:00Z") })]), [1, 1], "a run never crosses midnight UTC");
  const [run] = collapse([w(5), w(4), w(3)]);
  assert.deepEqual([run.seq, run.last], ["5", "3"], "a line keeps the newest and oldest event it holds");
});

test("changes: a run longer than one read of the log is still one line, and the page holds every line whole", async () => {
  const h = await page(hana, changesUrl(V.big));
  assert.deepEqual(lines(h), [
    ["Today", "You wrote other.md"],
    ["Today", "You wrote big.md 130 times"],
  ]);
  assert.doesNotMatch(h, /class="pager"/, "one page");
});

// ---------------------------------------------------------------------------
// Pages

test("changes: a page is cut in lines, not events, and Older and Newest follow without a gap or a repeat", async () => {
  assert.equal(PAGE_LINES, 30);
  const first = await page(hana, changesUrl(V.long));
  const a = lines(first).map(([, t]) => t);
  assert.equal(a.length, 30);
  assert.equal(a[0], "You wrote z.md 5 times");
  assert.equal(a[29], "You wrote f05.md");
  assert.doesNotMatch(first, />Newest</, "no Newest on the first page");
  const older = /<a class="older" href="([^"]+)">Older<\/a>/.exec(first)?.[1];
  assert.ok(older, "an Older link");
  const second = await page(hana, older);
  const b = lines(second).map(([, t]) => t);
  assert.deepEqual(b, ["You wrote f04.md", "You wrote f03.md", "You wrote f02.md", "You wrote f01.md"]);
  assert.match(second, new RegExp(`<a href="/v/${V.long}/changes">Newest</a>`));
  assert.doesNotMatch(second, />Older</, "the last page");
});

test("changes: a vault with no content changes says so, and a page past the last says where the list begins", async () => {
  const h = await page(hana, changesUrl(V.empty));
  assert.match(h, /<strong>Nothing has changed yet<\/strong>/);
  assert.equal(lines(h).length, 0);
  const past = await page(hana, `${changesUrl(V.main)}?before=1`);
  assert.match(past, /<strong>No older changes<\/strong>/);
  assert.match(past, new RegExp(`<a class="button" href="/v/${V.main}/changes">Back to the newest</a>`));
  // A malformed cursor is ignored, not an error.
  assert.deepEqual(lines(await page(hana, `${changesUrl(V.main)}?before=abc`)), lines(await page(hana, changesUrl(V.main))));
});

test("changes: days read Today, Yesterday, then the weekday and date, each a heading under the page's h1", async () => {
  const h = await page(hana, changesUrl(V.main));
  assert.deepEqual([...h.matchAll(/<h2 id="d-\d{4}-\d{2}-\d{2}">([^<]+)<\/h2>/g)].map((m) => m[1]), ["Today", "Yesterday", daysAgo(3)]);
  assert.equal((h.match(/<h1[ >]/g) ?? []).length, 1, "one h1");
  assert.ok(h.indexOf("<h1>Changes</h1>") < h.indexOf('<h2 id="d-'), "Changes, then its days");
  assert.equal(dayLabel("2026-10-02", new Date("2026-10-02T09:00:00Z")), "Today");
  assert.equal(dayLabel("2026-10-01", new Date("2026-10-02T00:00:01Z")), "Yesterday");
  assert.equal(dayLabel("2026-09-28", new Date("2026-10-02T09:00:00Z")), "Monday 28 September");
  assert.equal(dayLabel("2025-12-31", new Date("2026-10-02T09:00:00Z")), "Wednesday 31 December 2025");
});

// ---------------------------------------------------------------------------
// Who may read it, and what reading does

test("changes: a viewer reads it; a vault you're not in is 404", async () => {
  assert.equal((await get(jun, changesUrl(V.main))).status, 200);
  assert.equal((await get(hana, changesUrl(V.jun))).status, 404);
  assert.equal((await get(jun, changesUrl(V.empty))).status, 404);
});

test("changes: opening it marks no flag shown for anyone", async () => {
  const waiting = async (user) => (await as(user, "select public.list_flags($1, 200) as r", [V.main]))[0].r.flags.length;
  await as(HANA, "select public.create_subscription($1, 'path', 'notes/')", [V.main]);
  await as(IVO, "select public.write_file($1, 'notes/flagged.md', 'x')", [V.main]);
  const before = [await waiting(HANA), await waiting(IVO)];
  assert.ok(before[0] > 0, "Hana has flags waiting");
  for (const s of [hana, jun]) assert.equal((await get(s, changesUrl(V.main))).status, 200);
  assert.deepEqual([await waiting(HANA), await waiting(IVO)], before);
});

// ---------------------------------------------------------------------------
// The full log is the Log tab under Diagnostics, at the address Activity had

test("diagnostics: /activity and /log are the full log inside Diagnostics, as its Log tab, with the filters and every event", async () => {
  for (const path of [`/v/${V.main}/activity`, `/v/${V.main}/log`]) {
    const h = await page(hana, path);
    assert.match(h, /<h1>Settings<\/h1>/, path);
    assert.match(h, /<h2>Log<\/h2>/, path);
    assert.equal((h.match(/<h1[ >]/g) ?? []).length, 1, `${path}: one h1`);
    assert.match(h, new RegExp(`<a href="/v/${V.main}/diagnostics" aria-current="page">Diagnostics</a>`), `${path}: the Settings tab`);
    assert.match(h, new RegExp(`<nav class="tabs" aria-label="Diagnostics"><a href="/v/${V.main}/flags">Flags</a><a href="/v/${V.main}/claims">Claims</a><a href="/v/${V.main}/activity" aria-current="page">Log</a></nav>`), path);
    assert.match(h, new RegExp(`<form method="get" action="/v/${V.main}/activity" class="panel filters"`), `${path}: the filter form`);
    assert.match(h, /Every change to this vault, newest first\. This log can only be added to/, path);
    // Everything the Changes feed leaves out is here.
    for (const label of ["Created the vault", "Changed a rule", "Made jun@example.test a viewer", "Commented on a proposal"]) {
      assert.ok(h.includes(`>${label}</td>`) || h.includes(`>${label}</a></td>`), `${path}: ${label}`);
    }
  }
});

test("diagnostics: the Log links a write to its file only while the file is there, never to a deleted one's 404", async () => {
  const h = await page(hana, `/v/${V.main}/activity`);
  const pathCells = [...h.matchAll(/<td class="path-cell">([\s\S]*?)<\/td>/g)].map((m) => m[1]);
  assert.ok(pathCells.includes(`<a href="/v/${V.main}/file?path=${q("notes/plan.md")}">notes/plan.md</a>`), "a file that's there is linked");
  for (const gone of ["tmp/scratch.md", "archive/2026.md"]) {
    assert.ok(pathCells.includes(gone), `${gone}: written once, no file now, so plain text`);
    assert.ok(!h.includes(q(gone)), `${gone}: no link to it anywhere on the page`);
  }
});

test("diagnostics: the vault's own navigation has Changes where Activity was, and no entry for the log", async () => {
  const h = await page(hana, changesUrl(V.main));
  const navs = h.match(/<nav class="(?:side-links|tabs)" aria-label="Vault(?: \(phone\))?">[\s\S]*?<\/nav>/g);
  assert.equal(navs.length, 2, "the wide sidebar and the phone tabs");
  for (const nav of navs) {
    assert.match(nav, new RegExp(`<a href="/v/${V.main}/changes" aria-current="page">Changes</a>`));
    assert.doesNotMatch(nav, /Activity|\/activity|Log/);
  }
  assert.match(await page(hana, `/v/${V.main}/diagnostics`), /<dt><a href="[^"]+\/activity">Log<\/a><\/dt><dd>Every event the vault recorded/);
});
