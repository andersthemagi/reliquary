// A vault's Overview (src/overview.ts) and its Files item (src/files.ts,
// vaultShell): /v/:id opens on cards for what waits on the reader, the tasks
// in progress and who holds them, the latest changes and the people, with the
// root README under them; the folder list moved to /v/:id/files. What each
// card reads is decided elsewhere (RLS, list_flags, work_plan_status, the
// Changes feed); this file is about what a person sees and where it links.
//
// This file starts its own servers from dist/, signed in as Ola (an owner)
// and Pim (a viewer), people no other test file uses. Ola owns "Overview
// main" with Enzo (an editor, who proposes and holds a task through his
// agent) and Pim, and "Overview blank", which has nothing in it.

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
const OLA = "00000000-0000-0000-0000-000000007ab1";
const ENZO = "00000000-0000-0000-0000-000000007ab2";
const PIM = "00000000-0000-0000-0000-000000007ab3";

const V = {};
let ola;
let pim;
const servers = [];

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

async function as(user, q, params = [], act = null) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", ...(act ? { act } : {}) })]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

// A server from dist/, signed in as `user`.
async function start(user, name) {
  const port = await freePort();
  const s = { origin: `http://127.0.0.1:${port}`, cookie: "", child: null };
  const loginFile = `/tmp/overview-${name}-${process.pid}-${port}`;
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
const re = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One card by its title, up to the next card or the end of the grid.
function section(h, title) {
  const start = h.indexOf(`<section class="overview-section" aria-label="${title}">`);
  assert.ok(start >= 0, `a section titled ${title}`);
  return h.slice(start, h.indexOf("</section>", start));
}
const glance = (h) => /<p class="overview-glance">([\s\S]*?)<\/p>/.exec(h)?.[1] ?? "";
const unread = async (user, vault) => (await as(user, "select jsonb_array_length(public.list_flags($1, 200) -> 'flags') as n", [vault]))[0].n;

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'ola@example.test'), ($2, 'enzo@example.test'), ($3, 'pim@example.test') on conflict (id) do nothing`,
    [OLA, ENZO, PIM],
  );
  ola = await start(OLA, "ola");
  pim = await start(PIM, "pim");

  [{ id: V.main }] = await as(OLA, "select public.create_vault('Overview main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, ENZO, OLA]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.main, PIM, OLA]);
  await as(OLA, "select public.write_file($1, 'README.md', $2)", [V.main, "# Start here\n\nThe brief is in notes/."]);
  await as(OLA, "select public.write_file($1, 'notes/brief.md', 'The brief')", [V.main]);
  await as(OLA, "select public.write_file($1, 'notes/sources.md', 'The sources')", [V.main]);
  await as(OLA, "select public.write_file($1, 'notes/people.md', 'Who to ask')", [V.main]);
  await as(OLA, "select public.set_policy($1, 'canon/', 'canon', 1)", [V.main]);
  [{ id: V.proposal }] = await as(ENZO, "select public.propose($1, 'canon/terms.md', 'Net 30.', 'terms') as id", [V.main]);
  await as(ENZO, "select public.write_file($1, 'plans/work.md', 'The plan')", [V.main]);
  const [{ v }] = await sql("select current_version_id as v from public.files where vault_id = $1 and path = 'plans/work.md'", [V.main]);
  await as(ENZO, "select public.register_work_plan($1, 'plans/work.md', $2, $3::jsonb)", [
    V.main,
    v,
    JSON.stringify([{ key: "draft", title: "Draft the brief" }, { key: "check", title: "Check the sources" }]),
  ]);
  await as(ENZO, "select public.claim_step($1, 'plans/work.md', 'draft', null)", [V.main], { sub: "tok-enzo", name: "Claude Code" });

  [{ id: V.blank }] = await as(OLA, "select public.create_vault('Overview blank', 'open') as id");
});

after(() => {
  for (const s of servers) s.child?.kill();
});

// ---------------------------------------------------------------------------
// The page

test("overview: the vault opens on its name with Connect an agent and New file, a line of facts, In progress and Recent changes each with See all, then the README", async () => {
  const h = await page(ola, `/v/${V.main}`);
  assert.match(h, /<h1>Overview main<\/h1>/);
  const actions = /<div class="page-actions">([\s\S]*?)<\/div>/.exec(h)[1];
  assert.match(actions, new RegExp(`<a class="button" href="/connect">Connect an agent</a>\\s*<a class="button primary" href="/v/${V.main}/new">New file</a>`));
  assert.ok(h.indexOf('class="overview-glance"') < h.indexOf("overview-section"), "the facts come first, under the title");
  const sections = [...h.matchAll(/<h2>([^<]+)<\/h2><a class="see-all" href="([^"]+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(sections, [
    ["Waiting on you", `/v/${V.main}/proposals`],
    ["In progress", `/v/${V.main}/tasks`],
    ["Recent changes", `/v/${V.main}/changes`],
  ]);
  assert.match(h, /<div class="overview-cols">/);
  assert.match(h, new RegExp(`<section class="readme" aria-label="README\\.md"><p class="readme-head"><a href="${re(`/v/${V.main}/file?path=README.md`)}">README\\.md</a></p><div class="prose entry"><h1>Start here</h1>`));
  assert.ok(h.indexOf("overview-cols") < h.indexOf('class="readme"'), "the README comes after the lists");
  assert.doesNotMatch(h, /<table class="folder-list">/, "the file list is on Files");
});

// ---------------------------------------------------------------------------
// Files, its own item

test("files item: the sidebar starts Overview, Files; Files is the folder list at /files, its subfolders unchanged at /tree", async () => {
  const h = await page(ola, `/v/${V.main}`);
  const side = /<nav class="side-links" aria-label="Vault">([\s\S]*?)<\/nav>/.exec(h)[1];
  assert.deepEqual([...side.matchAll(/<a href="([^"]+)"[^>]*>/g)].slice(0, 2).map((m) => m[1]), [`/v/${V.main}`, `/v/${V.main}/files`]);
  assert.match(side, new RegExp(`<a href="/v/${V.main}" aria-current="page"><svg class="icon"[^>]*aria-hidden="true"[\\s\\S]*?<span class="side-label">Overview</span>`));
  const files = await page(ola, `/v/${V.main}/files`);
  assert.match(files, /<h1>Files<\/h1>/);
  assert.match(files, /<table class="folder-list">[\s\S]*?notes\/<\/a>/);
  assert.match(files, new RegExp(`<a class="dir" href="/v/${V.main}/tree\\?path=notes%2F">notes/</a>`));
  assert.match(files, new RegExp(`<a href="/v/${V.main}/files" aria-current="page"><svg`), "Files is marked on its page");
  const tabs = /aria-label="Vault \(phone\)">([\s\S]*?)<\/nav>/.exec(files)[1];
  assert.deepEqual([...tabs.matchAll(/<a href="([^"]+)"/g)].slice(0, 2).map((m) => m[1]), [`/v/${V.main}`, `/v/${V.main}/files`], "the phone tabs follow the same order");
});

test("files item: a file's breadcrumb starts at the vault's Overview, and a file page marks Files", async () => {
  const h = await page(ola, `/v/${V.main}/file?path=notes%2Fbrief.md`);
  assert.match(h, new RegExp(`<a href="/v/${V.main}">Overview main</a>`));
  assert.match(h, new RegExp(`<a href="/v/${V.main}/files" aria-current="page"><svg`));
});

// ---------------------------------------------------------------------------
// The cards

test("lists: Waiting on you lists the proposal waiting for this person's review, and the facts link the unread flags without marking them seen", async () => {
  const before = await unread(OLA, V.main);
  assert.ok(before > 0, "a proposal waiting on Ola is a flag for her");
  const h = await page(ola, `/v/${V.main}`);
  assert.match(section(h, "Waiting on you"), new RegExp(`<a href="/v/${V.main}/proposals/${V.proposal}">Create canon/terms\\.md</a> <span class="muted">enzo@example\\.test · `));
  assert.match(glance(h), new RegExp(`<a href="/v/${V.main}/changes">${before} unread flags?</a>`));
  assert.doesNotMatch(glance(h), /Nothing waiting on you/);
  assert.equal(await unread(OLA, V.main), before, "opening the Overview leaves the flags unread");
});

test("lists: In progress names who holds each task, a person via their agent, and the facts say how many are ready", async () => {
  const h = await page(ola, `/v/${V.main}`);
  assert.match(section(h, "In progress"), new RegExp(`<a href="/v/${V.main}/tasks/plan\\?path=plans%2Fwork\\.md">Draft the brief</a> <span class="muted">enzo@example\\.test via Claude Code</span>`));
  assert.match(glance(h), new RegExp(`<a href="/v/${V.main}/tasks">1 task ready to pick up</a>`));
});

test("lists: Recent changes says the latest changes in plain words, newest first", async () => {
  const c = section(await page(ola, `/v/${V.main}`), "Recent changes");
  const lines = [...c.matchAll(/<span class="change-what">([\s\S]*?)<\/span><span class="change-when">/g)].map((m) => m[1].replace(/<[^>]+>/g, ""));
  assert.equal(lines.length, 5, "the latest five");
  assert.equal(lines[0], "enzo@example.test wrote plans/work.md");
  assert.ok(lines.includes("enzo@example.test opened a proposal on canon/terms.md"));
});

test("lists: the facts count the members, by role on hover, and, for an owner, the vault's agent connections", async () => {
  const g = glance(await page(ola, `/v/${V.main}`));
  assert.match(g, new RegExp(`<a href="/v/${V.main}/config/members" title="1 owner, 1 editor, 1 viewer">3 members</a>`));
  assert.match(g, /<a href="\/connect">0 agent connections<\/a>/);
});

// ---------------------------------------------------------------------------
// Nothing to show, and viewers

test("quiet: in a vault with nothing in it and no agent connected, the facts say nothing is waiting and each list says so in one quiet line", async () => {
  const h = await page(ola, `/v/${V.blank}`);
  assert.doesNotMatch(h, /aria-label="Waiting on you"/, "no list when nothing is waiting");
  assert.match(glance(h), /<span>Nothing waiting on you<\/span>/);
  assert.doesNotMatch(glance(h), /ready to pick up/);
  assert.match(section(h, "In progress"), /<p class="muted">Nobody is working on a task\.<\/p>/);
  assert.match(section(h, "Recent changes"), /<p class="muted">Nothing has changed yet\.<\/p>/);
  assert.match(glance(h), />1 member<\/a>/);
  assert.doesNotMatch(h, /class="readme"/, "no README, no box");
});

test("quiet: a viewer gets the Overview with Connect an agent but no New file, and their own connections counted", async () => {
  const r = await get(pim, `/v/${V.main}`);
  assert.equal(r.status, 200);
  const h = await r.text();
  const actions = /<div class="page-actions">([\s\S]*?)<\/div>/.exec(h)[1];
  assert.match(actions, /<a class="button" href="\/connect">Connect an agent<\/a>/);
  assert.doesNotMatch(actions, /New file/);
  assert.match(glance(h), /Nothing waiting on you/);
  assert.match(glance(h), /<a href="\/connect">Your agents: 0 connections<\/a>/);
  assert.match(section(h, "In progress"), /enzo@example\.test via Claude Code/);
});
