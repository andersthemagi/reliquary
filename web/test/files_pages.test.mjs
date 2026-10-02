// Files and folders pages (src/files.ts, and the erase page's crumb in
// src/vaultadmin.ts): the vault's sections as tabs on phones, folder policy
// badges, the root's rule line, the README box, empty vaults, the file
// page's meta and More menu, deleting behind a confirm page, the editor,
// New file following its folder's rule, and saves that say so as success.
// ui-audit.md package B. The database rules are unchanged (delete_test.sql).
//
// This file starts its own server from dist/, signed in as Bree, a person no
// other test file uses. Bree owns "Files main" (open, canon/ is canon, a
// README), "Files waiting" (canon, empty, one proposal) and "Files blank";
// she is an editor in Cal's "Files cal" and a viewer in Dora's "Files dora".

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const BREE = "00000000-0000-0000-0000-0000000008b1";
const CAL = "00000000-0000-0000-0000-0000000008b2";
const DORA = "00000000-0000-0000-0000-0000000008b3";

let child;
let log = "";
const s = { origin: "", cookie: "" };
const V = {};

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
const post = (path, fields) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin },
    body: new URLSearchParams(fields).toString(),
  });
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
const file = (v, path, extra = "") => `/v/${v}/file?path=${encodeURIComponent(path)}${extra}`;
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const live = async (v, path) =>
  (await sql("select count(*)::int as n from public.files where vault_id = $1 and path = $2 and deleted_at is null", [v, path]))[0].n;

// The fields of the form on `h` whose submit button says `label`.
function formFields(h, label) {
  const forms = h.split("<form ").slice(1).map((f) => f.slice(0, f.indexOf("</form>")));
  const form = forms.find((f) => f.includes(`>${label}</button>`));
  assert.ok(form, `a form with a "${label}" button`);
  const fields = {};
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]] = m[2];
  return { action: /action="([^"]+)"/.exec(form)[1], fields, form };
}

before(async () => {
  const port = await freePort();
  s.origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/files-pages-login-${process.pid}-${port}`;
  child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: BREE, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${s.origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];

  [{ id: V.main }] = await as(BREE, "select public.create_vault('Files main', 'open') as id");
  await as(BREE, "select public.set_policy($1, 'canon/', 'canon', 1)", [V.main]);
  await as(BREE, "select public.write_file($1, 'README.md', $2)", [V.main, "# Main vault\n\nStart here."]);
  await as(BREE, "select public.write_file($1, 'notes/a.md', 'Alpha')", [V.main]);
  await as(BREE, "select public.write_file($1, 'notes/gone.md', 'Going')", [V.main]);
  await as(BREE, "select public.write_file($1, 'notes/solo.md', 'Once')", [V.main]);
  const [{ id: first }] = await as(BREE, "select public.propose($1, 'canon/terms.md', 'Net 30.', 'first') as id", [V.main]);
  await as(BREE, "select public.decide($1, 'approve')", [first]);
  await as(BREE, "select public.propose($1, 'canon/terms.md', 'Net 60.', 'longer terms')", [V.main]);

  [{ id: V.waiting }] = await as(BREE, "select public.create_vault('Files waiting', 'canon') as id");
  await as(BREE, "select public.propose($1, 'first.md', 'Hello', 'the first file')", [V.waiting]);
  [{ id: V.blank }] = await as(BREE, "select public.create_vault('Files blank') as id");

  [{ id: V.cal }] = await as(CAL, "select public.create_vault('Files cal', 'open') as id");
  await as(CAL, "select public.write_file($1, 'cal.md', 'Cal text')", [V.cal]);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.cal, BREE, CAL]);
  [{ id: V.dora }] = await as(DORA, "select public.create_vault('Files dora', 'open') as id");
  await as(DORA, "select public.write_file($1, 'dora.md', 'Dora text')", [V.dora]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.dora, BREE, DORA]);
});

after(async () => {
  child?.kill();
});

// ---------------------------------------------------------------------------
// The vault's sections on phones

test("vault tabs: every vault page has the sections as tabs (for phones), the current one marked and the open proposals counted; Flags and Claims are under Settings, not here", async () => {
  const h = await page(`/v/${V.main}`);
  const tabs = /<div class="vault-tabs"><nav class="tabs" aria-label="Vault \(phone\)">([\s\S]*?)<\/nav><\/div>/.exec(h)?.[1];
  assert.ok(tabs, "a tabs row in the vault shell");
  assert.deepEqual([...tabs.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]), [
    `/v/${V.main}`, `/v/${V.main}/proposals`, `/v/${V.main}/changes`, `/v/${V.main}/variables`, `/v/${V.main}/links`,
    `/v/${V.main}/config`,
  ]);
  assert.match(tabs, new RegExp(`<a href="/v/${V.main}" aria-current="page">Files</a>`));
  assert.match(tabs, /Proposals<span class="count">1<\/span>/);
  const changes = await page(`/v/${V.main}/changes`);
  assert.match(changes, new RegExp(`aria-label="Vault \\(phone\\)">[\\s\\S]*?<a href="/v/${V.main}/changes" aria-current="page">Changes</a>`), "Changes is marked on its page");
  assert.doesNotMatch(/<nav class="side-links" aria-label="Vault">[\s\S]*?<\/nav>/.exec(changes)[0], /Activity|\/activity/, "the full log is under Diagnostics, not in the sidebar");
  const rules = await page(`/v/${V.main}/rules`);
  assert.match(rules, new RegExp(`aria-label="Vault \\(phone\\)">[\\s\\S]*?<a href="/v/${V.main}/config" aria-current="page">Settings</a>`), "Rules is under Settings");
  // Claims and the log moved under Settings, Diagnostics: they and the landing page mark Settings.
  // (Flags is not opened here: opening it marks this person's flags shown; flags_page.test.mjs covers it.)
  for (const rest of ["/diagnostics", "/claims", "/activity"]) {
    const d = await page(`/v/${V.main}${rest}`);
    assert.match(d, new RegExp(`aria-label="Vault \\(phone\\)">[\\s\\S]*?<a href="/v/${V.main}/config" aria-current="page">Settings</a>`), `${rest} is under Settings`);
    assert.doesNotMatch(/<nav class="side-links" aria-label="Vault">[\s\S]*?<\/nav>/.exec(d)[0], /\/flags|\/claims/, `${rest}: not in the sidebar`);
  }
});

test("vault tabs: the phone's Browse files holds only the folder tree, not the sections", async () => {
  const h = await page(file(V.main, "notes/a.md"));
  const mobile = /<details class="tree-mobile">([\s\S]*?)<\/details>\s*<div class="content">/.exec(h)?.[1];
  assert.ok(mobile);
  assert.match(mobile, /^<summary>Browse files<\/summary>\s*<nav class="tree" aria-label="Files \(phone\)">/);
  assert.doesNotMatch(mobile, /\/proposals"|\/config"|side-links/);
});

// ---------------------------------------------------------------------------
// Folder pages

test("folder: rows show each subfolder's policy as a badge, like its files", async () => {
  const h = await page(`/v/${V.main}`);
  assert.match(h, /canon\/<\/a><\/td><td><span class="badge policy canon" title="Canon: changes are proposals that people approve">Canon<\/span><\/td>/);
  assert.match(h, /notes\/<\/a><\/td><td><span class="badge policy open" title="Open: members and agents write directly">Open<\/span><\/td>/);
  assert.match(h, /README\.md<\/a><\/td><td><span class="badge policy open"/);
});

test("folder: the root states what files without a rule are, how many rules there are, and links to Rules and what canon means", async () => {
  const h = await page(`/v/${V.main}`);
  assert.match(h, new RegExp(
    `<p class="rule root-rule"><span>Files without a rule are</span> <span class="badge policy open"[^>]*>Open</span> <span>1 rule set · <a href="/v/${V.main}/rules">Rules</a> · <a href="/docs/concepts/canon-and-rules">What’s canon\\?</a></span></p>`,
  ));
  assert.match(await page(`/v/${V.blank}`), /<span>No rules set · <a href/);
});

test("folder: the README is boxed under the list with its name as the header bar, not a second heading", async () => {
  const h = await page(`/v/${V.main}`);
  assert.match(h, new RegExp(`<section class="readme" aria-label="README\\.md"><p class="readme-head"><a href="${re(file(V.main, "README.md"))}">README\\.md</a></p><div class="prose entry"><h1>Main vault</h1>`));
  assert.doesNotMatch(h, /<h2>README\.md<\/h2>/);
  assert.ok(h.indexOf("</table>") < h.indexOf('class="readme"'), "after the list");
});

test("folder: the root's header offers Search and New file, not Connect an agent; times are relative with the UTC time in the title", async () => {
  const h = await page(`/v/${V.main}`);
  const actions = /<div class="page-actions">([\s\S]*?)<\/div>/.exec(h)[1];
  assert.match(actions, new RegExp(`<a class="button vault-search-link" href="/v/${V.main}/search">Search</a>\\s*<a class="button primary" href="/v/${V.main}/new">New file</a>`));
  assert.doesNotMatch(h, /Connect an agent/);
  assert.match(h, /<td class="num small muted hide-sm"><time datetime="[^"]+" title="\d{4}-\d\d-\d\d \d\d:\d\d UTC">just now<\/time><\/td>/);
});

test("folder: an empty vault with a proposal waiting says so and links to it", async () => {
  const h = await page(`/v/${V.waiting}`);
  assert.match(h, new RegExp(`<div class="empty"><strong>No files yet</strong><p>1 proposal waits to add the first file\\.</p><p class="empty-action"><a class="button" href="/v/${V.waiting}/proposals">Review it</a></p></div>`));
});

test("folder: an empty vault with nothing waiting offers New file and Connect an agent to a writer", async () => {
  const h = await page(`/v/${V.blank}`);
  assert.match(h, /<strong>No files yet<\/strong><p>Create the first file, or connect an agent and ask it to write one\.<\/p>/);
  assert.match(h, new RegExp(`<a class="button" href="/v/${V.blank}/new">New file</a> <a class="button ghost" href="/connect">Connect an agent</a>`));
});

// ---------------------------------------------------------------------------
// File page

test("file: the breadcrumb runs vault, folder, file, the file being the current page", async () => {
  const h = await page(file(V.main, "notes/a.md"));
  assert.match(h, new RegExp(
    `<nav class="crumb" aria-label="Breadcrumb"><ol><li><a href="/v/${V.main}">Files main</a></li><li><a href="/v/${V.main}/tree\\?path=notes%2F">notes</a></li><li aria-current="page">a\\.md</li></ol></nav>`,
  ));
});

test("file: the meta says who wrote it last and when, relative, with the exact time in the title", async () => {
  const h = await page(file(V.main, "notes/a.md"));
  assert.match(h, /<p class="meta file-meta">Last written by you · <time datetime="[^"]+" title="\d{4}-\d\d-\d\d \d\d:\d\d UTC">just now<\/time><\/p>/);
});

test("file: an owner's More menu on an open file has Delete file and Erase content, each with what it does, before the primary Edit", async () => {
  const h = await page(file(V.main, "notes/a.md"));
  const actions = /<div class="page-actions">([\s\S]*?)<\/div>\s*<\/div>/.exec(h)[1];
  assert.match(actions, /<details class="menu-wrap action-menu file-more">\s*<summary class="button">More<\/summary>/);
  assert.match(actions, new RegExp(`<a class="menu-item danger" href="${re(file(V.main, "notes/a.md", "&amp;confirm=delete"))}"><span class="menu-item-title">Delete file…</span><span class="menu-item-meta">Removes the file; its history stays</span></a>`));
  assert.match(actions, new RegExp(`<a class="menu-item danger" href="/v/${V.main}/erase\\?path=notes%2Fa\\.md"><span class="menu-item-title">Erase content…</span><span class="menu-item-meta">Blanks every version; for personal data</span></a>`));
  assert.ok(actions.indexOf("file-more") < actions.indexOf(">Edit</a>"), "More before the primary action");
  assert.match(actions, /<a class="button primary" href="[^"]+">Edit<\/a>$/m);
});

test("file: on a canon file the menu proposes deleting; an editor has no Erase; a viewer has no menu", async () => {
  const canon = await page(file(V.main, "canon/terms.md"));
  assert.match(canon, new RegExp(`<a class="menu-item" href="${re(file(V.main, "canon/terms.md", "&amp;confirm=delete"))}"><span class="menu-item-title">Propose deleting…</span>`));
  const editor = await page(file(V.cal, "cal.md"));
  assert.match(editor, /Delete file…/);
  assert.doesNotMatch(editor, /Erase content|\/erase\?/);
  const viewer = await page(file(V.dora, "dora.md"));
  assert.doesNotMatch(viewer, /file-more|confirm=delete|\/erase\?/);
});

test("file: a canon file's waiting proposal is a warning callout with a link to review it", async () => {
  const h = await page(file(V.main, "canon/terms.md"));
  assert.match(h, /<div class="callout warning"><p>A proposed change to this file is waiting for review\. <a href="\/v\/[^"]+\/proposals\/[0-9a-f-]{36}">Review it<\/a><\/p><\/div>/);
  assert.ok(h.indexOf('aria-label="File view"') < h.indexOf("callout warning"), "under the page header's tabs");
});

// ---------------------------------------------------------------------------
// Delete behind a confirm page

test("delete: the editor has no delete form; the file page's menu leads to a confirm page", async () => {
  const edit = await page(`/v/${V.main}/edit?path=notes%2Fa.md`);
  assert.doesNotMatch(edit, /name="action" value="delete"|Delete this file|danger-zone/);
});

test("delete: the confirm page names the file, what goes and what stays, and a GET deletes nothing", async () => {
  const h = await page(file(V.main, "notes/gone.md", "&confirm=delete"));
  assert.match(h, /<h1>Delete gone\.md<\/h1>/);
  assert.match(h, new RegExp(`<li><a href="/v/${V.main}/tree\\?path=notes%2F">notes</a></li><li><a href="${re(file(V.main, "notes/gone.md"))}">gone\\.md</a></li><li aria-current="page">Delete</li>`));
  assert.match(h, /Deleting <code>notes\/gone\.md<\/code> removes it from the vault/);
  assert.match(h, /<li>Its 1 version and the activity log stay: who wrote what, and when\.<\/li>/);
  assert.match(h, new RegExp(`<a href="/v/${V.main}/erase\\?path=notes%2Fgone\\.md">erase it</a> instead`));
  assert.match(h, /<button class="danger solid">Delete gone\.md<\/button><a class="button quiet" href="[^"]+notes%2Fgone\.md">Cancel<\/a>/);
  assert.equal(await live(V.main, "notes/gone.md"), 1);
});

test("delete: confirming deletes the file and says so as a success", async () => {
  const { action, fields } = formFields(await page(file(V.main, "notes/gone.md", "&confirm=delete")), "Delete gone.md");
  assert.deepEqual({ ...fields, csrf: "" }, { csrf: "", path: "notes/gone.md", action: "delete" });
  const r = await post(action, fields);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), `/v/${V.main}`);
  assert.match(await page(r.headers.get("location")), /<p class="callout success flash" role="status">Deleted notes\/gone\.md\.<\/p>/);
  assert.equal(await live(V.main, "notes/gone.md"), 0);
});

test("delete: a viewer's confirm page is Not found; an editor's sends erasing to an owner", async () => {
  assert.equal((await get(file(V.dora, "dora.md", "&confirm=delete"))).status, 404);
  const h = await page(file(V.cal, "cal.md", "&confirm=delete"));
  assert.match(h, /To blank the text as well, ask an owner to erase it instead\./);
  assert.doesNotMatch(h, /\/erase\?/);
});

test("delete: a canon file's confirm page proposes, with a reason, and leaves the file", async () => {
  const h = await page(file(V.main, "canon/terms.md", "&confirm=delete"));
  assert.match(h, /<h1 class="path">Propose deleting terms\.md<\/h1>/);
  assert.match(h, /deleting it is a proposal\. The file stays, unchanged, until enough people approve it\./);
  const { action, fields } = formFields(h, "Propose deleting terms.md");
  assert.equal(fields.action, "propose-delete");
  const r = await post(action, { ...fields, reason: "Superseded" });
  assert.match(r.headers.get("location"), new RegExp(`^/v/${V.main}/proposals/[0-9a-f-]{36}$`));
  assert.match(await page(r.headers.get("location")), /<p class="callout success flash" role="status">Proposed\. It applies once enough people approve it\.<\/p>/);
  assert.equal(await live(V.main, "canon/terms.md"), 1);
});

// ---------------------------------------------------------------------------
// Editor and New file

test("edit: on a canon file the required Why comes before the text, and the page says it becomes a proposal", async () => {
  const h = await page(`/v/${V.main}/edit?path=canon%2Fterms.md`);
  assert.match(h, /<p class="page-desc">This file is canon, so your edit becomes a proposal that people approve\.<\/p>/);
  assert.ok(h.indexOf('<input id="r" type="text" name="reason" required') > 0);
  assert.ok(h.indexOf('name="reason"') < h.indexOf('<textarea id="content"'), "Why above the text");
  assert.match(h, new RegExp(`<li><a href="${re(file(V.main, "canon/terms.md"))}">terms\\.md</a></li><li aria-current="page">Propose a change</li>`));
});

test("edit: saving an open file says so as a success", async () => {
  const h = await page(`/v/${V.main}/edit?path=notes%2Fa.md`);
  const r = await post(`/v/${V.main}/file`, { csrf: csrfOf(h), action: "write", path: "notes/a.md", content: "Alpha two" });
  assert.equal(r.headers.get("location"), file(V.main, "notes/a.md"));
  assert.match(await page(r.headers.get("location")), /<p class="callout success flash" role="status">Saved notes\/a\.md\.<\/p>/);
});

test("new file: in a canon folder the page shows the rule, asks why, and the button says Propose file", async () => {
  const h = await page(`/v/${V.main}/new?dir=canon`);
  assert.match(h, /From the rule on <a href="[^"]+"><code>canon\/<\/code><\/a>, set by you <time/);
  assert.match(h, /<button class="primary" form="new-file">Propose file<\/button>/);
  assert.match(h, /<input id="r" type="text" name="reason" required/);
  assert.match(h, /<input id="p" type="text" name="path" value="canon\/" placeholder="canon\/new-file\.md" required/);
  assert.match(h, new RegExp(`<li><a href="/v/${V.main}/tree\\?path=canon%2F">canon</a></li><li aria-current="page">New file</li>`));
});

test("new file: in an open folder there's no Why field and the button says Create file", async () => {
  const h = await page(`/v/${V.main}/new?dir=notes%2F`);
  assert.match(h, /<p class="rule"><span class="badge policy open"[^>]*>Open<\/span> <span>The vault default\./);
  assert.match(h, /<button class="primary" form="new-file">Create file<\/button>/);
  assert.doesNotMatch(h, /<input id="r"/);
  assert.match(h, /<input type="hidden" name="reason" value="New file">/, "a path typed under canon still has a reason");
  const r = await post(`/v/${V.main}/file`, { csrf: csrfOf(h), action: "create", path: "notes/new.md", content: "N", reason: "New file" });
  assert.match(await page(r.headers.get("location")), /<p class="callout success flash" role="status">Saved notes\/new\.md\.<\/p>/);
});

// ---------------------------------------------------------------------------
// Erase, reached from the file

test("erase: the confirm page sits under the file (vault / folder / file / Erase), says its only version, and Cancel goes back to it", async () => {
  const h = await page(`/v/${V.main}/erase?path=notes%2Fsolo.md`);
  assert.match(h, new RegExp(`<li><a href="/v/${V.main}">Files main</a></li><li><a href="/v/${V.main}/tree\\?path=notes%2F">notes</a></li><li><a href="${re(file(V.main, "notes/solo.md"))}">solo\\.md</a></li><li aria-current="page">Erase</li>`));
  assert.match(h, /blanks the text of its only version, and of every proposal/);
  assert.match(h, new RegExp(`<a href="${re(file(V.main, "notes/solo.md", "&amp;confirm=delete"))}">delete it</a> instead`));
  assert.match(h, new RegExp(`<button class="danger solid">Erase solo\\.md</button><a class="button quiet" href="${re(file(V.main, "notes/solo.md"))}">Cancel</a>`));
  assert.match(h, new RegExp(`<li class="leaf"><a href="${re(file(V.main, "notes/solo.md"))}" aria-current="page">solo\\.md</a>`), "the tree marks the file");
});
