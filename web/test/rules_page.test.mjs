// The Rules page and a vault's own search (src/rules.ts), ui-audit.md
// package J: rules in tree order, the table first, Approvals needed as a
// number refused in the form when out of range, who set each rule and
// when, Change and Remove in a menu, Remove through a confirm page, saves
// and removals said as successes; the vault search's scope, box and link
// to searching all vaults. The database rules are unchanged (core_test.sql,
// rule_paths_test.sql).
//
// This file starts its own server from dist/, signed in as Jo, a person no
// other test file uses. Jo owns "Rules main" (open, five rules, files and a
// waiting proposal under clients/), "Rules two" (canon, docs/ open and
// docs/drafts/ canon) and "Rules blank"; she is an editor in Kit's "Rules
// kit".

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
const JO = "00000000-0000-0000-0000-000000000af1";
const KIT = "00000000-0000-0000-0000-000000000af2";

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
const re = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const at = (h, needle) => {
  const i = h.indexOf(needle);
  assert.ok(i >= 0, `page has ${needle}`);
  return i;
};
const rulesOf = (v) => `/v/${v}/rules`;
const ruleRow = async (v, path) =>
  (await sql("select policy, quorum from public.path_policies where vault_id = $1 and path = $2", [v, path]))[0];
// The flash on the page a redirect lands on.
const landed = async (r) => {
  assert.equal(r.status, 303);
  return page(r.headers.get("location"));
};
const flashOf = (h) => /<p class="callout (\w+) flash" role="(\w+)">([\s\S]*?)<\/p>/.exec(h)?.slice(1);

// The fields of the form on `h` whose submit button says `label`.
function formFields(h, label) {
  const forms = h.split("<form ").slice(1).map((f) => f.slice(0, f.indexOf("</form>")));
  const form = forms.find((f) => f.includes(`>${label}</button>`));
  assert.ok(form, `a form with a "${label}" button`);
  const fields = {};
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]] = m[2];
  return { action: /action="([^"]+)"/.exec(form)[1], fields };
}

before(async () => {
  const port = await freePort();
  s.origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/rules-page-login-${process.pid}-${port}`;
  child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: JO, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
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

  [{ id: V.main }] = await as(JO, "select public.create_vault('Rules main', 'open') as id");
  for (const f of ["clients/a.md", "clients/b.md", "clients/acme/x.md", "clients/acme/brief.md", "notes/n.md"]) {
    await as(JO, "select public.write_file($1, $2, $3)", [V.main, f, f === "notes/n.md" ? "The zanzibar plan." : "Text"]);
  }
  // Set in an order unlike the page's, so the page's order is its own.
  for (const [path, policy, quorum] of [
    ["notes/", "open", 1],
    ["clients-old/", "canon", 1],
    ["clients/acme/brief.md", "canon", 1],
    ["clients/", "canon", 2],
    ["clients/acme/", "open", 1],
  ]) {
    await as(JO, "select public.set_policy($1, $2, $3, $4)", [V.main, path, policy, quorum]);
  }
  await as(JO, "select public.propose($1, 'clients/c.md', 'New client', 'a new client')", [V.main]);

  [{ id: V.two }] = await as(JO, "select public.create_vault('Rules two', 'canon') as id");
  await as(JO, "select public.set_policy($1, 'docs/', 'open', 1)", [V.two]);
  await as(JO, "select public.set_policy($1, 'docs/drafts/', 'canon', 1)", [V.two]);
  await as(JO, "select public.write_file($1, 'docs/a.md', 'Doc')", [V.two]);

  [{ id: V.blank }] = await as(JO, "select public.create_vault('Rules blank', 'open') as id");

  [{ id: V.kit }] = await as(KIT, "select public.create_vault('Rules kit', 'open') as id");
  await as(KIT, "select public.set_policy($1, 'kit/', 'canon', 1)", [V.kit]);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.kit, JO, KIT]);
});

after(async () => {
  child?.kill();
});

// ---------------------------------------------------------------------------
// The page

test("rules: listed in tree order, each folder's rules under it, saying what each covers and which rule it overrides", async () => {
  const h = await page(rulesOf(V.main));
  const order = [...h.matchAll(/<code class="rule-path">([^<]+)<\/code>/g)].map((m) => m[1]);
  assert.deepEqual(order, ["clients/", "clients/acme/", "clients/acme/brief.md", "clients-old/", "notes/"]);
  assert.match(h, /<code class="rule-path">clients\/<\/code><span class="rule-scope">Folder<\/span>/);
  assert.match(h, /<code class="rule-path">clients\/acme\/<\/code><span class="rule-scope">Folder · overrides <code>clients\/<\/code><\/span>/);
  assert.match(h, /<code class="rule-path">clients\/acme\/brief\.md<\/code><span class="rule-scope">File · overrides <code>clients\/acme\/<\/code><\/span>/);
});

test("rules: the header has the crumb and Add rule; the rules table comes first, then the form, then the checker", async () => {
  const h = await page(rulesOf(V.main));
  assert.match(h, new RegExp(`<nav class="crumb" aria-label="Breadcrumb"><ol><li><a href="/v/${V.main}">Rules main</a></li><li><a href="/v/${V.main}/config">Settings</a></li><li aria-current="page">Rules</li></ol></nav>`));
  assert.match(h, /<div class="page-actions"><a class="button primary" href="#add-rule">Add rule<\/a><\/div>/);
  assert.match(h, /<p class="page-desc">Everything is <span class="badge policy open"[^>]*>Open<\/span> unless a rule says otherwise; the most specific rule wins\.<\/p>/);
  assert.ok(at(h, '<div class="page-actions">') < at(h, '<table class="table-stack rules-table">'));
  assert.ok(at(h, '<table class="table-stack rules-table">') < at(h, 'id="add-rule"'));
  assert.ok(at(h, 'id="add-rule"') < at(h, "What applies to a path?"));
});

test("rules: every row labels its cells for phones", async () => {
  const h = await page(rulesOf(V.main));
  const row = /<tr>\s*<td data-label="Path"><code class="rule-path">clients\/<\/code>[\s\S]*?<\/tr>/.exec(h)?.[0];
  assert.ok(row);
  for (const label of ["Path", "Policy", "Approvals needed", "Set by"]) assert.match(row, new RegExp(`data-label="${label}"`));
  assert.match(row, /<td data-label="Approvals needed" class="num">2<\/td>/);
  const open = /<tr>\s*<td data-label="Path"><code class="rule-path">notes\/<\/code>[\s\S]*?<\/tr>/.exec(h)[0];
  assert.match(open, /<td data-label="Approvals needed" class="num"><span class="muted">Not needed<\/span><\/td>/);
});

test("rules: each rule says who set it and when, relative with the exact time on hover", async () => {
  const h = await page(rulesOf(V.main));
  const row = /<tr>\s*<td data-label="Path"><code class="rule-path">clients\/<\/code>[\s\S]*?<\/tr>/.exec(h)[0];
  assert.match(row, /<td data-label="Set by" class="small muted">you · <time datetime="\d{4}-\d\d-\d\dT[^"]+" title="\d{4}-\d\d-\d\d \d\d:\d\d UTC">just now<\/time><\/td>/);
});

test("rules: owners get Change and Remove for each rule in one menu", async () => {
  const h = await page(rulesOf(V.main));
  const row = /<tr>\s*<td data-label="Path"><code class="rule-path">clients\/<\/code>[\s\S]*?<\/tr>/.exec(h)[0];
  assert.match(row, /<summary class="button quiet icon-button" aria-label="Actions for the rule on clients\/"/);
  assert.match(row, new RegExp(`<a class="menu-item" href="/v/${V.main}/rules\\?change=clients%2F#add-rule"><span class="menu-item-title">Change</span>`));
  assert.match(row, new RegExp(`<a class="menu-item danger" href="/v/${V.main}/rules\\?remove=clients%2F"><span class="menu-item-title">Remove</span>`));
});

test("rules: Approvals needed is a number input from 1 to 20", async () => {
  const h = await page(rulesOf(V.main));
  assert.match(h, /<label for="qq">Approvals needed<\/label><input id="qq" class="narrow" type="number" name="quorum" min="1" max="20" step="1" required value="1" aria-describedby="qq-hint">/);
  assert.match(h, /<p class="hint" id="qq-hint">For canon: how many different people must approve a change, 1 to 20\./);
});

test("rules: approvals outside 1 to 20 are refused in the form, with a ref in the server log, the typed values kept and nothing saved", async () => {
  const token = csrfOf(await page(rulesOf(V.main)));
  for (const quorum of ["21", "0", "1.5", "two", ""]) {
    const r = await post(rulesOf(V.main), { csrf: token, path: "q/", policy: "canon", quorum });
    assert.equal(r.status, 400, quorum);
    const h = await r.text();
    const m = /<p class="callout danger" role="alert" id="rule-error">Approvals needed is a whole number from 1 to 20: how many different people must approve a change\. Nothing was saved\. \(ref ([0-9a-f]{8})\)<\/p>/.exec(h);
    assert.ok(m, quorum);
    assert.match(log, new RegExp(`failure ref=${m[1]} `), "the ref is in the server log");
    assert.match(h, new RegExp(`name="quorum" min="1" max="20" step="1" required value="${re(quorum)}" aria-invalid="true" aria-describedby="rule-error qq-hint">`), quorum);
    assert.match(h, /name="path" placeholder="clients\/" required value="q\/" aria-describedby="pp-hint">/, "the path is kept, not marked");
    assert.ok(at(h, 'id="add-rule"') < at(h, '<table class="table-stack rules-table">'), "the refused form is on the first screen");
    assert.doesNotMatch(h, /page-actions/, "no Add rule while the form is first");
  }
  assert.equal(await ruleRow(V.main, "q/"), undefined);
});

test("rules: the page that answers a refused save keeps the top bar's vault switcher and inbox", async () => {
  const token = csrfOf(await page(rulesOf(V.main)));
  const r = await post(rulesOf(V.main), { csrf: token, path: "q/", policy: "canon", quorum: "21" });
  assert.equal(r.status, 400);
  const h = await r.text();
  assert.match(h, /<details class="menu-wrap vault-switch">/);
  assert.match(h, /<details class="menu-wrap inbox">/);
});

test("rules: an open rule needs no approvals, so the number is not checked", async () => {
  const token = csrfOf(await page(rulesOf(V.main)));
  const h = await landed(await post(rulesOf(V.main), { csrf: token, path: "scratch/", policy: "open", quorum: "99" }));
  assert.deepEqual(flashOf(h), ["success", "status", "scratch/ is now open: members and agents write there directly."]);
  assert.deepEqual(await ruleRow(V.main, "scratch/"), { policy: "open", quorum: 1 });
});

test("rules: saving a canon rule says so as a success, with the approvals it needs", async () => {
  const token = csrfOf(await page(rulesOf(V.main)));
  const h = await landed(await post(rulesOf(V.main), { csrf: token, path: "legal/", policy: "canon", quorum: "3" }));
  assert.deepEqual(flashOf(h), ["success", "status", "legal/ is now canon: changes need 3 approvals."]);
  assert.deepEqual(await ruleRow(V.main, "legal/"), { policy: "canon", quorum: 3 });
});

test("rules: Change fills the form with the rule as it is, first on the page", async () => {
  const h = await page(`${rulesOf(V.main)}?change=clients%2F`);
  assert.match(h, /<h2 id="add-rule-title" class="form-title">Change the rule on <code>clients\/<\/code><\/h2>/);
  assert.match(h, /name="path" placeholder="clients\/" required value="clients\/"/);
  assert.match(h, /<option value="canon">Canon<\/option><option value="open">Open<\/option>/, "canon stays selected");
  assert.match(h, /name="quorum" min="1" max="20" step="1" required value="2"/);
  assert.match(h, new RegExp(`<button class="primary">Save rule</button><a class="button quiet" href="/v/${V.main}/rules">Cancel</a>`));
  assert.ok(at(h, 'id="add-rule"') < at(h, '<table class="table-stack rules-table">'));
});

test("rules: Remove asks first, naming what the path follows next, the files that change, the rules inside and the proposals waiting", async () => {
  const r = await get(`${rulesOf(V.main)}?remove=clients%2F`);
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Remove the rule on clients\/\?<\/h1>/);
  assert.match(h, new RegExp(`<li><a href="/v/${V.main}/rules">Rules</a></li><li aria-current="page">Remove rule</li>`));
  assert.match(h, /<code>clients\/<\/code> is <span class="badge policy canon"[^>]*>Canon<\/span>, with 2 approvals needed\. Without this rule it follows the vault default\./);
  assert.match(h, /<li>2 files there become <span class="badge policy open"[^>]*>Open<\/span>, from the vault default\.<\/li>/);
  assert.match(h, /<li>2 rules inside it stay as they are\.<\/li>/);
  assert.match(h, /<li>1 proposal waiting there stays open; each approval counts against the rule in force when it is given\.<\/li>/);
  const { action, fields } = formFields(h, "Remove the rule on clients/");
  assert.equal(action, rulesOf(V.main));
  assert.deepEqual({ path: fields.path, policy: fields.policy }, { path: "clients/", policy: "" });
  assert.match(h, new RegExp(`<button class="danger solid">Remove the rule on clients/</button><a class="button quiet" href="/v/${V.main}/rules">Cancel</a>`));
  assert.deepEqual(await ruleRow(V.main, "clients/"), { policy: "canon", quorum: 2 }, "asking removes nothing");
});

test("rules: Remove under a parent rule says the parent applies, and a folder with no files says so", async () => {
  const h = await page(`${rulesOf(V.two)}?remove=docs%2Fdrafts%2F`);
  assert.match(h, /Without this rule it follows the rule on <code>docs\/<\/code>\./);
  assert.match(h, /<li>No files are there yet; files added later follow the rule on <code>docs\/<\/code>\.<\/li>/);
  const top = await page(`${rulesOf(V.two)}?remove=docs%2F`);
  assert.match(top, /<li>1 file there becomes <span class="badge policy canon"[^>]*>Canon<\/span>, with 1 approval needed, from the vault default\.<\/li>/);
  assert.match(top, /<li>The rule on <code>docs\/drafts\/<\/code> inside it stays as it is\.<\/li>/);
});

test("rules: confirming removes the rule and says, as a success, what the path follows now", async () => {
  const { action, fields } = formFields(await page(`${rulesOf(V.two)}?remove=docs%2Fdrafts%2F`), "Remove the rule on docs/drafts/");
  const h = await landed(await post(action, fields));
  assert.deepEqual(flashOf(h), ["success", "status", "Removed the rule on docs/drafts/. It now follows the rule on docs/ (open)."]);
  assert.equal(await ruleRow(V.two, "docs/drafts/"), undefined);
  const { fields: last } = formFields(await page(`${rulesOf(V.two)}?remove=docs%2F`), "Remove the rule on docs/");
  const h2 = await landed(await post(rulesOf(V.two), last));
  assert.deepEqual(flashOf(h2), ["success", "status", "Removed the rule on docs/. It now follows the vault default (canon)."]);
});

test("rules: Remove for a path with no rule goes back to Rules with a warning", async () => {
  const h = await landed(await get(`${rulesOf(V.main)}?remove=nowhere%2F`));
  assert.deepEqual(flashOf(h), ["warning", "status", "There’s no rule on nowhere/ to remove; it may have been removed already."]);
});

test("rules: people who aren't owners see the rules without Add rule, Change or Remove, and Remove sends them back", async () => {
  const h = await page(rulesOf(V.kit));
  assert.match(h, /<code class="rule-path">kit\/<\/code>/);
  assert.doesNotMatch(h, /Add rule|id="add-rule"|\?remove=|\?change=|Actions for the rule/);
  assert.match(h, /Only owners change rules\./);
  const back = await landed(await get(`${rulesOf(V.kit)}?remove=kit%2F`));
  assert.deepEqual(flashOf(back), ["warning", "status", "Only owners remove rules; ask an owner of this vault."]);
  assert.deepEqual(await ruleRow(V.kit, "kit/"), { policy: "canon", quorum: 1 });
});

test("rules: with no rules, the page says what every path is and offers Add rule", async () => {
  const h = await page(rulesOf(V.blank));
  assert.match(h, /<div class="empty"><strong>No rules yet<\/strong><p>Every path is <span class="badge policy open"[^>]*>Open<\/span>, the vault default\. Add a rule to make a folder like clients\/ canon\.<\/p><p class="empty-action"><a class="button" href="#add-rule">Add rule<\/a><\/p><\/div>/);
});

test("rules: the confirm page for someone else's vault looks missing", async () => {
  const none = "ffffffff-0000-4000-8000-00000000000f";
  assert.equal((await get(`/v/${none}/rules?remove=a%2F`)).status, 404);
});

// ---------------------------------------------------------------------------
// A vault's own search

test("search: a vault's search says it covers only that vault, has its own box, and links to search all vaults with the same words", async () => {
  const h = await page(`/v/${V.main}/search?q=zanzibar`);
  assert.match(h, new RegExp(`<nav class="crumb" aria-label="Breadcrumb"><ol><li><a href="/v/${V.main}">Rules main</a></li><li aria-current="page">Search</li></ol></nav>`));
  assert.match(h, /<h1>Search this vault<\/h1>/);
  assert.match(h, /<p class="page-desc">Only files in Rules main\. The search at the top of every page looks in all your vaults\.<\/p>/);
  assert.match(h, /<div class="page-actions"><a class="button" href="\/search\?q=zanzibar">Search all vaults<\/a><\/div>/);
  assert.match(h, new RegExp(`<form class="search-page" method="get" action="/v/${V.main}/search" role="search">\\s*<label for="vq">Search file names and text in Rules main</label>`));
  assert.match(h, /<input id="vq" type="search" name="q" value="zanzibar" maxlength="200">/);
  assert.match(h, /1 result for “zanzibar” in Rules main/);
  assert.match(h, /notes\/n\.md<\/a> <span class="badge policy open"/);
});

test("search: nothing found in the vault offers searching all vaults", async () => {
  const h = await page(`/v/${V.main}/search?q=qqxxnothing`);
  assert.match(h, /<div class="empty"><strong>Nothing matches “qqxxnothing” in Rules main<\/strong><p>Try fewer words, or part of a file name, or look in all your vaults\.<\/p><p class="empty-action"><a class="button" href="\/search\?q=qqxxnothing">Search all vaults<\/a><\/p><\/div>/);
});

test("search: with no words yet, Search all vaults goes to the all-vaults page", async () => {
  const h = await page(`/v/${V.main}/search`);
  assert.match(h, /<a class="button" href="\/search">Search all vaults<\/a>/);
  assert.doesNotMatch(h, /class="rows results"|Nothing matches/);
});
