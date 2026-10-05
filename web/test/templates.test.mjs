// Vault templates (web/src/templates.ts, docs/public/concepts/templates.md).
//
// Ana (local sign-in, WEB_URL) creates one vault per template through the
// New vault form; each is checked against its definition in the database,
// as Ana, and deleted at the end. The atomicity and agent tests run
// applyTemplate() in this process, as a person of their own (TESTER) who
// shares nothing with the seed, so no other test's lists or counts move.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import pg from "pg";
import { asPerson, usePool } from "../dist/db.js";
import { applyTemplate, templateById, TEMPLATES } from "../dist/templates.js";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { LOGIN_FILE, TEST_DATABASE_URL, WEB_AUTH_A_URL: A, FAKE_AUTH_URL } = process.env;
const ANA = "00000000-0000-0000-0000-00000000000a";
const TESTER = "00000000-0000-0000-0000-0000000007e1";
const NEWCOMER = "00000000-0000-0000-0000-0000000007e2";
let cookie = "";
const made = []; // [user, vault id, name], deleted in after()

const db = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 2 });
usePool(db);

const get = (path) => fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
const page = async (path) => (await get(path)).text();
const post = (path, fields) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams(fields).toString(),
  });
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});
after(async () => {
  for (const [user, id, name] of made) {
    await asPerson(user, (c) => c.query("select public.delete_vault($1, $2)", [id, name]));
  }
  await db.end();
});

// A vault's files, rules and default, as its owner sees them.
const contents = (user, id) =>
  asPerson(user, async (c) => ({
    files: (
      await c.query(
        `select f.path, v.body from public.files f join public.file_versions v on v.id = f.current_version_id
          where f.vault_id = $1 and f.deleted_at is null order by f.path collate "C"`,
        [id],
      )
    ).rows,
    rules: (await c.query(`select path, policy, quorum from public.path_policies where vault_id = $1 order by path collate "C"`, [id])).rows,
    def: (await c.query(`select default_policy from public.vaults where id = $1`, [id])).rows[0].default_policy,
    proposals: (await c.query(`select count(*)::int as n from public.proposals where vault_id = $1`, [id])).rows[0].n,
  }));
const vaultsNamed = (user, name) =>
  asPerson(user, async (c) => (await c.query(`select count(*)::int as n from public.vaults where name = $1`, [name])).rows[0].n);

async function createFromForm(name, template, policy) {
  const token = csrfOf(await page("/vaults/new"));
  const r = await post("/vaults/new", { csrf: token, name, template, default_policy: policy });
  assert.equal(r.status, 303);
  const loc = r.headers.get("location");
  assert.match(loc, /^\/v\/[0-9a-f-]{36}$/, `created ${name}`);
  const id = loc.slice(3);
  made.push([ANA, id, name]);
  return { loc, id };
}

// The form -----------------------------------------------------------------------

test("templates: the New vault form offers Blank, checked, then each template with its folders and suggested variable names", async () => {
  const h = await page("/vaults/new");
  assert.match(h, /<legend>Start from<\/legend>/);
  assert.match(h, /<input type="radio" name="template" value="blank" checked>\s*<span class="choice-card-body"><span class="choice-card-title">Blank<\/span>/);
  for (const id of ["client", "personal", "product"]) {
    const t = templateById(id);
    assert.match(h, new RegExp(`<input type="radio" name="template" value="${id}">\\s*<span class="choice-card-body"><span class="choice-card-title">${t.name}</span>`));
  }
  assert.match(h, /<span>Canon: <code>brief\/, decisions\/, canon\/<\/code><\/span><span>Open: <code>notes\/<\/code><\/span><span>README for agents<\/span><\/span><span class="choice-card-vars">Suggested variables: <code>DATABASE_URL, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SENTRY_DSN<\/code><\/span>/);
  assert.match(h, /<span>Canon: <code>specs\/, decisions\/<\/code><\/span><span>Open: <code>notes\/<\/code><\/span>/);
  assert.match(h, /Suggested variables are names only/);
  assert.equal((h.match(/name="template"/g) ?? []).length, TEMPLATES.length);
  assert.doesNotMatch(h, /<script/i);
});

test("template cards: each choice is a card the whole of which picks it, saying what it is for in one line", async () => {
  const h = await page("/vaults/new");
  assert.match(h, /<fieldset class="choice-cards template-cards" aria-describedby="template-hint">\s*<legend>Start from<\/legend>\s*<p class="hint" id="template-hint">/);
  const cards = [...h.matchAll(/<label class="choice-card"><input type="radio" name="template" value="([a-z]+)"[^>]*>[\s\S]*?<\/label>/g)];
  assert.deepEqual(cards.map((c) => c[1]), TEMPLATES.map((t) => t.id));
  for (const t of TEMPLATES) {
    assert.ok(t.summary.length <= 100 && !/\n/.test(t.summary), `${t.id}: one line`);
    const card = cards.find((c) => c[1] === t.id)[0];
    assert.ok(card.includes(`<span class="choice-card-text">${t.summary}</span>`), `${t.id}: its summary`);
  }
  assert.doesNotMatch(cards.find((c) => c[1] === "blank")[0], /choice-card-rules/, "Blank has no folders to list");
});

test("template cards: the default policy is two cards, each explained in a line, with what it applies to", async () => {
  const h = await page("/vaults/new");
  assert.match(h, /<legend>Files without a rule are<\/legend>\s*<p class="hint" id="policy-hint">Templates set rules for their folders; this applies to everything else/);
  assert.match(h, /<span class="choice-card-title">Open<\/span>\s*<span class="choice-card-text">Members and their agents write directly\. Every change is logged\.<\/span>/);
  assert.match(h, /<span class="choice-card-title">Canon<\/span>\s*<span class="choice-card-text">Every change is a proposal a person approves before it applies\.<\/span>/);
  assert.doesNotMatch(h, /<legend>Default policy<\/legend>/);
});

test("templates: Home's first-vault empty state mentions templates", async () => {
  // A person with no vaults, signed in on the AUTH_MODE=supabase instance A
  // (web/test.sh) with a session minted by the fake Auth.
  const minted = await fetch(`${FAKE_AUTH_URL}/_mint`, {
    method: "POST",
    body: JSON.stringify({ sub: NEWCOMER, session_id: "templates-newcomer" }),
  });
  const token = (await minted.json()).token;
  const h = await (await fetch(`${A}/`, { headers: { cookie: `__Host-rlq_at=${token}` }, redirect: "manual" })).text();
  assert.match(h, /<div class="empty first-vault"><strong>Create your first vault\.<\/strong>/);
  assert.match(h, /Start blank, or from a template: a client engagement, personal projects or a product team, with folders, rules and a README that tells agents how to work there\./);
});

// Each template ------------------------------------------------------------------

async function createsExactly(id, policy) {
  const t = templateById(id);
  const byPath = (a, b) => (a.path < b.path ? -1 : 1);
  const name = `Zz template ${id}`;
  const { loc, id: vault } = await createFromForm(name, id, policy);
  const got = await contents(ANA, vault);
  assert.deepEqual(got.files, [...t.files].sort(byPath).map((f) => ({ path: f.path, body: f.body })));
  assert.deepEqual(got.rules, [...t.rules].sort(byPath));
  assert.equal(got.def, policy);
  assert.equal(got.proposals, 0, "nothing waits for review");
  const h = await page(loc);
  assert.match(h, new RegExp(`Created ${name} from the ${t.name} template\\. You’re its owner\\. Start with README\\.md\\.`));
}

// Client engagement with a canon default: its files are written before the
// default turns canon, so the README at the top is canon afterwards.
test("templates: Client engagement creates exactly its files and rules, with the default I chose", () => createsExactly("client", "canon"));
test("templates: Personal projects creates exactly its files and rules, with the default I chose", () => createsExactly("personal", "open"));
test("templates: Product team creates exactly its files and rules, with the default I chose", () => createsExactly("product", "open"));

test("templates: the canon folders really are canon, and an open folder is written directly", async () => {
  const vault = made.find(([, , n]) => n === "Zz template client")[1];
  let token = csrfOf(await page(`/v/${vault}/new`));
  let r = await post(`/v/${vault}/file`, { csrf: token, action: "create", path: "decisions/2026-01-15-hosting.md", content: "Host it in the EU.", reason: "first decision" });
  assert.match(r.headers.get("location"), /\/proposals\/[0-9a-f-]{36}$/, "a proposal, not a write");
  token = csrfOf(await page(`/v/${vault}/new`));
  r = await post(`/v/${vault}/file`, { csrf: token, action: "create", path: "notes/2026-01-15-kickoff.md", content: "Kickoff went well." });
  assert.doesNotMatch(r.headers.get("location"), /\/proposals\//, "written directly");
  const got = await contents(ANA, vault);
  assert.ok(got.files.some((f) => f.path === "notes/2026-01-15-kickoff.md"));
  assert.ok(!got.files.some((f) => f.path === "decisions/2026-01-15-hosting.md"));
});

test("templates: a README with variables frames them as examples to keep or delete, and says what to do when npx is missing", () => {
  for (const t of TEMPLATES.filter((x) => x.variables.length)) {
    const readme = t.files.find((f) => f.path === "README.md")?.body ?? "";
    assert.match(readme, /Examples of names this kind of project often needs, not a list to finish: keep the ones your project reads, delete the rest and add your own\./, t.name);
  }
  for (const t of TEMPLATES.filter((x) => x.files.length)) {
    const readme = t.files.find((f) => f.path === "README.md")?.body ?? "";
    assert.match(readme, /If this machine has no `npx`, ask your person to run it, or to paste the `\.env` into \*\*Import \.env\*\* on the vault's Variables page\./, t.name);
  }
});

test("templates: every README tells agents to propose to canon, write notes, never paste secrets and use reliquary env push", () => {
  for (const t of TEMPLATES.filter((x) => x.files.length)) {
    const readme = t.files.find((f) => f.path === "README.md")?.body ?? "";
    assert.match(readme, /^# How to use this vault/, t.name);
    if (t.rules.some((r) => r.policy === "canon")) assert.match(readme, /use `propose` with a short reason\. A person approves it/, t.name);
    assert.match(readme, /write there directly with `write_file`/, t.name);
    assert.match(readme, /Never put a secret \(an API key, a password, a token, a connection string\) in a file/, t.name);
    assert.match(readme, /`npx @reliquary-ai\/cli env push --env development --file \.env`/, t.name);
    for (const v of t.variables) assert.match(readme, new RegExp(`- \\[ \\] \`${v}\``), `${t.name}: ${v} on the checklist`);
    // Rules cover every folder a template writes into.
    for (const f of t.files.filter((x) => x.path.includes("/"))) {
      assert.ok(t.rules.some((r) => f.path.startsWith(r.path)), `${t.name}: ${f.path} has a rule`);
    }
  }
});

test("templates: suggested variables are names only, never values", () => {
  for (const t of TEMPLATES) {
    for (const v of t.variables) assert.match(v, /^[A-Z][A-Z0-9_]*$/, `${t.name}: ${v}`);
    for (const f of t.files) assert.doesNotMatch(f.body, /\b[A-Z][A-Z0-9_]*=\S/, `${t.name}: ${f.path} holds no NAME=value`);
  }
});

test("templates: Blank, chosen or left out, makes an empty vault with no rules", async () => {
  const { id } = await createFromForm("Zz template blank", "blank", "open");
  const got = await contents(ANA, id);
  assert.deepEqual([got.files, got.rules, got.def], [[], [], "open"]);
});

test("templates: an unknown template is refused with a reason, and nothing is created", async () => {
  const token = csrfOf(await page("/vaults/new"));
  const r = await post("/vaults/new", { csrf: token, name: "Zz template bogus", template: "bogus", default_policy: "open" });
  assert.equal(r.status, 400, "the form again, with its reason");
  assert.match(await r.text(), /Choose one of the templates on the form\./);
  assert.equal(await vaultsNamed(ANA, "Zz template bogus"), 0);
});

// Atomic, and people only --------------------------------------------------------

test("templates: applying is atomic: a failure after the files are written leaves no vault and no membership", async () => {
  const name = "Template atomic";
  const broken = { ...templateById("client"), rules: [...templateById("client").rules, { path: "bad/", policy: "sometimes", quorum: 1 }] };
  await assert.rejects(asPerson(TESTER, (c) => applyTemplate(c, name, "canon", broken)));
  assert.equal(await vaultsNamed(TESTER, name), 0);
  const left = await asPerson(TESTER, async (c) => (await c.query(`select count(*)::int as n from public.vault_members where user_id = $1`, [TESTER])).rows[0].n);
  assert.equal(left, 0, "no membership left behind");
});

// As the MCP server runs a call: the person, with act.tok set to their token.
async function asAgent(user, tokenId, fn) {
  const c = await db.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: user, role: "authenticated", act: { sub: tokenId, name: "Template agent", tok: tokenId } }),
    ]);
    const result = await fn(c);
    await c.query("commit");
    return result;
  } catch (err) {
    await c.query("rollback");
    throw err;
  } finally {
    c.release();
  }
}

test("templates: an agent can't apply a template with rules, even with an all-vaults read-write token; nothing is created", async () => {
  const tokenId = await asPerson(TESTER, async (c) => {
    await c.query(`select public.create_access_token('templates agent', 30, null, 'write')`);
    return (await c.query(`select id from public.access_tokens where name = 'templates agent'`)).rows[0].id;
  });
  for (const t of TEMPLATES.filter((x) => x.rules.length)) {
    const name = `Agent ${t.id}`;
    await assert.rejects(asAgent(TESTER, tokenId, (c) => applyTemplate(c, name, "open", t)), (e) => e.code === "42501", t.name);
    assert.equal(await vaultsNamed(TESTER, name), 0, `${t.name}: no vault`);
  }
  // The same token may still create a blank vault: it's the rules that stop it.
  const id = await asAgent(TESTER, tokenId, (c) => applyTemplate(c, "Agent blank", "open", templateById("blank")));
  made.push([TESTER, id, "Agent blank"]);
  assert.equal(await vaultsNamed(TESTER, "Agent blank"), 1);
});
