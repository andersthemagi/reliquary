// The Flags page in the web app (src/flagspage.ts): what public.list_flags
// returns for the signed-in person, in a vault, and that viewing it marks
// those flags shown (public.advance_flags) the same way an MCP client is
// told to (F412, F413). The database's own predicates are hostile-tested in
// supabase/tests/flags_test.sql; this file is about what the page shows and
// that it advances the person's own watermark, not a connection's.
//
// This file starts its own server from dist/, signed in as Fran, a person no
// other test file uses. Fran owns "Flags main" with Gil as editor.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const FRAN = "00000000-0000-0000-0000-0000000009f1";
const GIL = "00000000-0000-0000-0000-0000000009f2";

let child;
const s = { origin: "", cookie: "" };
const V = {};
const P = {};
const T = {};

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

const get = (path) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (path) => (await get(path)).text();
const flagsUrl = (v) => `/v/${v}/flags`;

before(async () => {
  const port = await freePort();
  s.origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/flags-page-login-${process.pid}-${port}`;
  child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: FRAN, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${s.origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];

  await sql(`insert into auth.users (id, email) values ($1, 'fran@example.test'), ($2, 'gil@example.test') on conflict (id) do nothing`, [FRAN, GIL]);

  [{ id: V.main }] = await as(FRAN, "select public.create_vault('Flags main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, GIL, FRAN]);
  for (const f of ["notes/a.md", "notes/b.md", "top.md", "review/doc.md"]) await as(FRAN, "select public.write_file($1, $2, 'Text')", [V.main, f]);
  await as(FRAN, "select public.set_policy($1, 'review/doc.md', 'canon', 2)", [V.main]);
  await as(FRAN, "select public.create_subscription($1, 'path', 'top.md')", [V.main]);
  await as(FRAN, "select public.create_subscription($1, 'path', 'sub/')", [V.main]);

  // Fran's own actions: never flagged to Fran (design.md, "What you did
  // yourself isn't flagged to you").
  [{ id: P.own }] = await as(FRAN, "select public.propose($1, 'review/doc.md', 'Text v2', 'tidy') as id", [V.main]);
  await as(FRAN, "select public.decide($1, 'approve')", [P.own]); // 1 of 2: still open, but Fran has now approved it
  [{ id: P.base }] = await as(FRAN, "select public.propose($1, 'notes/b.md', 'Text v2', '') as id", [V.main]);

  [{ id: V.empty }] = await as(FRAN, "select public.create_vault('Flags empty', 'open') as id");
  [{ id: V.ola }] = await as(GIL, "select public.create_vault('Flags gil-only', 'open') as id");

  // Its own vault, so the five flags V.main's tests count stay five.
  [{ id: V.thread }] = await as(FRAN, "select public.create_vault('Flags threads', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.thread, GIL, FRAN]);
  [{ id: T.open }] = await as(GIL, "select public.open_thread($1, 'Who owns the brief?', 'Asking the room.') as id", [V.thread]);
  await as(GIL, "select public.post_message($1, 'Still asking.')", [T.open]);

  // Gil's actions: what Fran's Flags page should show, oldest first.
  [{ id: P.review }] = await as(GIL, "select public.propose($1, 'notes/a.md', 'Text v2', '') as id", [V.main]); // responsibility/review
  await as(GIL, "select public.comment_on_proposal($1, 'looks good')", [P.own]); // working_set/proposal (Fran already approved, so not also review)
  await as(GIL, "select public.write_file($1, 'notes/b.md', 'Text v3')", [V.main]); // working_set/base_changed against P.base
  await as(GIL, "select public.write_file($1, 'top.md', 'Text v2')", [V.main]); // subscription/path, direct watch
  await as(GIL, "select public.write_file($1, 'sub/x.md', 'Text')", [V.main]); // subscription/path, via the sub/ folder watch
});

after(async () => {
  child?.kill();
});

test("flags page: a vault you're not in is 404", async () => {
  assert.equal((await get(flagsUrl(V.ola))).status, 404);
});

// Diagnostics (src/diagnostics.ts): Settings' tab for working out why
// something happened. This file's seed has flags waiting, which is what the
// landing page must leave alone.

test("diagnostics: Settings has a Diagnostics tab, and its page says what it is for and offers Flags, Claims and the Log, none of them current", async () => {
  assert.match(await page(`/v/${V.main}/config`), new RegExp(`<a href="/v/${V.main}/diagnostics">Diagnostics</a>`));
  const h = await page(`/v/${V.main}/diagnostics`);
  assert.match(h, /<h1>Settings<\/h1>/);
  assert.match(h, /<p class="page-desc">For working out why something happened; most people never need it\.<\/p>/);
  assert.match(h, new RegExp(`<a href="/v/${V.main}/diagnostics" aria-current="page">Diagnostics</a>`), "the Settings tab is current");
  assert.match(h, new RegExp(`href="/v/${V.main}/config" aria-current="page">Settings`), "the sidebar's Settings is current");
  const inner = /<nav class="tabs" aria-label="Diagnostics">([\s\S]*?)<\/nav>/.exec(h)?.[1];
  assert.ok(inner, "the inner tabs");
  assert.deepEqual([...inner.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]), [
    [`/v/${V.main}/flags`, "Flags"],
    [`/v/${V.main}/claims`, "Claims"],
    [`/v/${V.main}/activity`, "Log"],
  ]);
  assert.doesNotMatch(inner, /aria-current/, "no inner tab is the current page here");
});

test("diagnostics: opening the landing page marks no flags shown", async () => {
  const waiting = async () => (await as(FRAN, "select public.list_flags($1, 200) as r", [V.main]))[0].r.flags.length;
  const before = await waiting();
  assert.ok(before > 0, "this vault has flags waiting for Fran");
  assert.equal((await get(`/v/${V.main}/diagnostics`)).status, 200);
  assert.equal(await waiting(), before);
});

test("diagnostics: a vault you're not in is 404", async () => {
  assert.equal((await get(`/v/${V.ola}/diagnostics`)).status, 404);
});

test("diagnostics: /flags is the same page inside Diagnostics, with Flags and Diagnostics current and the headings in order", async () => {
  // A vault with nothing waiting, so this opens nothing of the seed's.
  const h = await page(flagsUrl(V.empty));
  assert.match(h, new RegExp(`<a href="/v/${V.empty}/diagnostics" aria-current="page">Diagnostics</a>`), "the Settings tab");
  assert.match(h, new RegExp(`<nav class="tabs" aria-label="Diagnostics"><a href="/v/${V.empty}/flags" aria-current="page">Flags</a><a href="/v/${V.empty}/claims">Claims</a><a href="/v/${V.empty}/activity">Log</a></nav>`));
  assert.match(h, new RegExp(`href="/v/${V.empty}/config" aria-current="page">Settings`), "the sidebar's Settings");
  assert.match(h, /For working out why something happened; most people never need it\./);
  assert.equal((h.match(/<h1[ >]/g) ?? []).length, 1, "one h1");
  assert.ok(h.indexOf("<h1>Settings</h1>") < h.indexOf("<h2>Flags</h2>"), "Settings, then Flags");
});

test("flags page: a vault with nothing waiting says so", async () => {
  const h = await page(flagsUrl(V.empty));
  assert.match(h, /<h2>Flags<\/h2>/);
  assert.match(h, /<strong>Nothing new<\/strong>/);
});

test("flags page: shows what waits on Fran, oldest first, none of it Fran's own actions", async () => {
  const h = await page(flagsUrl(V.main));
  const rows = [...h.matchAll(/<tr class="ev">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  assert.equal(rows.length, 5, h);

  assert.match(rows[0], /<span class="badge warning">Waiting on you<\/span>/);
  assert.match(rows[0], new RegExp(`<a href="/v/${V.main}/proposals/${P.review}">Proposed</a>`));
  assert.match(rows[0], /<td class="path-cell">notes\/a\.md<\/td>/);

  assert.match(rows[1], /<span class="badge info">Your proposal<\/span>/);
  assert.match(rows[1], new RegExp(`<a href="/v/${V.main}/proposals/${P.own}">Commented on a proposal</a>`));

  assert.match(rows[2], /<span class="badge info">File changed<\/span>/);
  assert.match(rows[2], new RegExp(`<a href="/v/${V.main}/proposals/${P.base}">Wrote</a>`));
  assert.match(rows[2], new RegExp(`<td class="path-cell"><a href="/v/${V.main}/file\\?path=notes%2Fb\\.md">notes/b\\.md</a></td>`));

  assert.match(rows[3], /<span class="badge info">Watching<\/span>/);
  assert.match(rows[3], />Wrote<\/td>/, "not linked to any proposal");
  assert.match(rows[3], new RegExp(`<td class="path-cell"><a href="/v/${V.main}/file\\?path=top\\.md">top\\.md</a></td>`));
  assert.doesNotMatch(rows[3], /token-client">via/, "watched exactly, no folder to name");

  assert.match(rows[4], /<span class="badge info">Watching<\/span>/);
  assert.match(rows[4], new RegExp(`<td class="path-cell"><a href="/v/${V.main}/file\\?path=sub%2Fx\\.md">sub/x\\.md</a><span class="token-client">via sub/</span></td>`));

  assert.match(h, /Your agents see the same flags over MCP/);
});

test("flags page: viewing it marks these shown; a second visit has nothing new until something else happens", async () => {
  assert.match(await page(flagsUrl(V.main)), /<strong>Nothing new<\/strong>/);
  await as(GIL, "select public.comment_on_proposal($1, 'one more thing')", [P.own]);
  const h = await page(flagsUrl(V.main));
  const rows = [...h.matchAll(/<tr class="ev">([\s\S]*?)<\/tr>/g)];
  assert.equal(rows.length, 1);
  assert.match(rows[0][1], new RegExp(`<a href="/v/${V.main}/proposals/${P.own}">Commented on a proposal</a>`));
});

test("flags page: a thread flag is badged Thread and links to its thread, not left as a bare Watching row", async () => {
  const h = await page(flagsUrl(V.thread));
  const rows = [...h.matchAll(/<tr class="ev">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
  assert.equal(rows.length, 2, h);
  for (const r of rows) {
    assert.match(r, /<span class="badge info">Thread<\/span>/);
    assert.doesNotMatch(r, /Watching/);
  }
  assert.match(rows[0], new RegExp(`<a href="/v/${V.thread}/threads/${T.open}(#message-\\d+)?">Opened a thread</a>`));
  assert.match(rows[1], new RegExp(`<a href="/v/${V.thread}/threads/${T.open}#message-\\d+">Posted in a thread</a>`));
});
