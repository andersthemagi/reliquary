// A path's named owners in the web app (src/pathowners.ts, and the Owners
// item and owner count on the Rules page, src/rules.ts): the owners page,
// naming someone behind a confirm page, removing them behind another, and
// every refusal said as a flash, never an error page. The database rules
// are path_ownership_test.sql's (F407-F409); these tests are about what
// the web app offers and asks first.
//
// This file starts its own servers from dist/, one signed in as Pat and one
// as Edda, people no other test file uses. Pat owns "Owners main": clients/
// canon with clients/acme/ canon inside it, legal/ canon (2 approvals) with
// Otto and Edda named, hr/ canon with Vio named, notes/ open. Edda and Otto
// are editors there, Vio a viewer; Ursa is in none of Pat's vaults and owns
// "Owners ursa".

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
const PAT = "00000000-0000-0000-0000-0000000009c1";
const EDDA = "00000000-0000-0000-0000-0000000009c2";
const VIO = "00000000-0000-0000-0000-0000000009c3";
const OTTO = "00000000-0000-0000-0000-0000000009c4";
const URSA = "00000000-0000-0000-0000-0000000009c5";

const V = {};
let pat;
let edda;

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

// A server from dist/, signed in as `user`.
async function start(user, name) {
  const port = await freePort();
  const s = { origin: `http://127.0.0.1:${port}`, cookie: "", log: "", child: null };
  const loginFile = `/tmp/path-owners-${name}-${process.pid}-${port}`;
  s.child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  s.child.stdout.on("data", (d) => (s.log += d));
  s.child.stderr.on("data", (d) => (s.log += d));
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
const post = (s, path, fields) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin },
    body: new URLSearchParams(fields).toString(),
  });
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
const re = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The flash on the page a redirect lands on.
const landed = async (s, r) => {
  assert.equal(r.status, 303);
  return page(s, r.headers.get("location"));
};
const flashOf = (h) => /<p class="callout (\w+) flash" role="(\w+)">([\s\S]*?)<\/p>/.exec(h)?.slice(1);

// The fields of the form on `h` whose submit button says `label`.
function formFields(h, label) {
  const forms = h.split("<form ").slice(1).map((f) => f.slice(0, f.indexOf("</form>")));
  const form = forms.find((f) => f.includes(`>${label}</button>`));
  assert.ok(form, `a form with a "${label}" button`);
  const fields = {};
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]] = m[2];
  return { action: /action="([^"]+)"/.exec(form)[1], fields, form };
}

const owners = (v, path) => `/v/${v}/rules/owners?path=${encodeURIComponent(path)}`;
const named = async (v, path) =>
  (await sql("select user_id from public.path_owners where vault_id = $1 and path = $2 order by user_id", [v, path])).map((r) => r.user_id);
const logged = async (v, event) =>
  (await sql("select path, detail->>'user_id' as user_id, actor from public.log where vault_id = $1 and event = $2 order by seq", [v, event]));

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'pat@example.test'), ($2, 'edda@example.test'), ($3, 'vio@example.test'),
       ($4, 'otto@example.test'), ($5, 'ursa@example.test') on conflict (id) do nothing`,
    [PAT, EDDA, VIO, OTTO, URSA],
  );
  pat = await start(PAT, "pat");
  edda = await start(EDDA, "edda");

  [{ id: V.main }] = await as(PAT, "select public.create_vault('Owners main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, EDDA, PAT]);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, OTTO, PAT]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.main, VIO, PAT]);
  for (const [path, policy, quorum] of [
    ["clients/", "canon", 1],
    ["clients/acme/", "canon", 1],
    ["legal/", "canon", 2],
    ["hr/", "canon", 1],
    ["notes/", "open", 1],
  ]) {
    await as(PAT, "select public.set_policy($1, $2, $3, $4)", [V.main, path, policy, quorum]);
  }
  await as(PAT, "select public.set_path_owner($1, 'legal/', $2)", [V.main, OTTO]);
  await as(PAT, "select public.set_path_owner($1, 'legal/', $2)", [V.main, EDDA]);
  await as(PAT, "select public.set_path_owner($1, 'hr/', $2)", [V.main, VIO]);

  [{ id: V.ursa }] = await as(URSA, "select public.create_vault('Owners ursa', 'open') as id");
  await as(URSA, "select public.set_policy($1, 'x/', 'canon', 1)", [V.ursa]);
});

after(async () => {
  pat?.child?.kill();
  edda?.child?.kill();
});

// ---------------------------------------------------------------------------
// The Rules page

test("owners page: an owner's Rules page has Owners in each rule's menu, and every member sees how many named owners a rule has", async () => {
  const h = await page(pat, `/v/${V.main}/rules`);
  const legal = /<tr>\s*<td data-label="Path"><code class="rule-path">legal\/<\/code>[\s\S]*?<\/tr>/.exec(h)[0];
  assert.match(legal, new RegExp(`<a class="rule-owners" href="${re(owners(V.main, "legal/"))}">2 named owners</a>`));
  assert.match(legal, new RegExp(`<a class="menu-item" href="${re(owners(V.main, "legal/"))}"><span class="menu-item-title">Owners</span><span class="menu-item-meta">2 named owners</span></a>`));
  assert.ok(legal.indexOf(">Change<") < legal.indexOf(">Owners<") && legal.indexOf(">Owners<") < legal.indexOf(">Remove<"), "between Change and Remove");
  const notes = /<tr>\s*<td data-label="Path"><code class="rule-path">notes\/<\/code>[\s\S]*?<\/tr>/.exec(h)[0];
  assert.doesNotMatch(notes, /rule-owners/, "no count where nobody is named");
  assert.match(notes, /<span class="menu-item-title">Owners<\/span><span class="menu-item-meta">Name people who write it directly<\/span>/);
  const e = await page(edda, `/v/${V.main}/rules`);
  assert.match(e, new RegExp(`<a class="rule-owners" href="${re(owners(V.main, "hr/"))}">1 named owner</a>`), "an editor sees the count");
  assert.doesNotMatch(e, /Actions for the rule/, "and no menu");
});

test("owners page: removing a rule with named owners says they go with it", async () => {
  const h = await page(pat, `/v/${V.main}/rules?remove=legal%2F`);
  assert.match(h, /<li>Its 2 named owners are removed with it\. Adding the rule again doesn’t bring them back: name them again from <strong>Owners<\/strong>\.<\/li>/);
  assert.deepEqual(await named(V.main, "legal/"), [EDDA, OTTO].sort(), "asking removes nothing");
});

// ---------------------------------------------------------------------------
// The owners page

test("owners page: lists a path's named owners with their role in the vault, a viewer as writing this path only, under the Rules crumb", async () => {
  const h = await page(pat, owners(V.main, "hr/"));
  assert.match(h, new RegExp(`<li><a href="/v/${V.main}/rules">Rules</a></li><li aria-current="page">Owners</li>`));
  assert.match(h, /<h1 class="path">Owners of hr\/<\/h1>/);
  assert.match(h, /theirs are the only approvals its quorum counts/);
  assert.match(h, /<span class="badge policy canon"[^>]*>Canon<\/span> <span>The rule on <code>hr\/<\/code>: changes need 1 approval\./);
  const row = /<tr><td>vio@example\.test[\s\S]*?<\/tr>/.exec(h)?.[0];
  assert.ok(row, "Vio's row, by email");
  assert.match(row, /<td class="small" data-label="Role in the vault">Viewer<span class="token-client">Writes and approves this path only; reads the rest<\/span><\/td>/);
  assert.match(row, /<td class="small" data-label="Named">by you · <time /);
  assert.match(row, new RegExp(`<a class="button quiet" href="${re(owners(V.main, "hr/"))}&amp;remove=${VIO}" aria-label="Remove vio@example\\.test as an owner of hr/">Remove</a>`));
  const legal = await page(pat, owners(V.main, "legal/"));
  assert.match(legal, /<td class="small" data-label="Role in the vault">Editor<\/td>/, "an editor is just an editor");
});

test("owners page: an owner gets Name an owner at the top and a form of the members not yet named, which only asks the next page", async () => {
  const h = await page(pat, owners(V.main, "legal/"));
  assert.match(h, /<div class="page-actions"><a class="button primary" href="#add-owner">Name an owner<\/a><\/div>/);
  const form = /<form method="get" action="([^"]+)" class="panel owner-form" id="add-owner"[\s\S]*?<\/form>/.exec(h);
  assert.ok(form, "a GET form: choosing someone grants nothing");
  assert.equal(form[1], `/v/${V.main}/rules/owners`);
  assert.match(form[0], /<input type="hidden" name="path" value="legal\/">/);
  const options = [...form[0].matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(options.sort(), [[PAT, "pat@example.test (Owner)"], [VIO, "vio@example.test (Viewer)"]].sort(), "Otto and Edda are named already");
  assert.match(form[0], /Any member can be named, a viewer too: they write this path, and only this path, directly\. You confirm on the next page\./);
});

test("owners page: an open rule says named owners make a difference once it's canon, and a path nobody owns says so", async () => {
  const h = await page(pat, owners(V.main, "notes/"));
  assert.match(h, /<code>notes\/<\/code> is open, so everyone with write access already writes it directly\. Named owners make a difference once its rule is canon\./);
  assert.match(h, /<div class="empty"><strong>No named owners<\/strong><p>Everyone with write access follows the rule on <code>notes\/<\/code>\. Name someone below to let them write it directly\.<\/p><\/div>/);
});

test("owners page: every member sees the owners; someone who isn't an owner gets no form and no Remove", async () => {
  const h = await page(edda, owners(V.main, "legal/"));
  assert.match(h, /otto@example\.test/);
  assert.match(h, /<p class="hint">Only owners name or remove a path’s owners\.<\/p>/);
  assert.doesNotMatch(h, /id="add-owner"|&amp;remove=|Name an owner/);
});

test("owners page: a path with no rule goes back to Rules, saying why", async () => {
  const h = await landed(pat, await get(pat, owners(V.main, "nowhere/")));
  assert.deepEqual(flashOf(h), ["warning", "status", "There’s no rule on nowhere/, so it can’t have named owners. Add a rule for it first, then name its owners from the rule’s menu."]);
});

test("owners page: another vault's owners look missing", async () => {
  assert.equal((await get(pat, owners(V.ursa, "x/"))).status, 404);
  assert.equal((await get(pat, `${owners(V.ursa, "x/")}&add=${PAT}`)).status, 404);
  assert.equal((await get(pat, owners("ffffffff-0000-4000-8000-00000000000f", "x/"))).status, 404);
});

// ---------------------------------------------------------------------------
// Naming an owner

test("name owner: the confirm page names them, says what changes, and opening it grants nothing", async () => {
  const r = await get(pat, `${owners(V.main, "clients/")}&add=${VIO}`);
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Name vio@example\.test an owner of clients\/\?<\/h1>/);
  assert.match(h, new RegExp(`<li><a href="/v/${V.main}/rules">Rules</a></li><li aria-current="page">Name an owner</li>`));
  assert.match(h, /vio@example\.test \(Viewer\) will write and delete <code>clients\/<\/code> directly, with no proposal and no review, and so will their agents\./);
  assert.match(h, /<li>From now on only named owners’ approvals count toward its 1 approval\. Until now any editor’s or owner’s did; they now propose and wait like anyone else\.<\/li>/);
  assert.match(h, /<li>They stay a viewer everywhere else in Owners main: this is write access to this path only\.<\/li>/);
  assert.match(h, /<li>The rule on <code>clients\/acme\/<\/code> inside it keeps its own owners: naming someone here doesn’t cover it\.<\/li>/);
  const { action, fields } = formFields(h, "Name vio@example.test owner of clients/");
  assert.equal(action, `/v/${V.main}/rules/owners`);
  assert.deepEqual({ ...fields, csrf: undefined }, { csrf: undefined, path: "clients/", user: VIO, action: "add", confirm: "1" });
  assert.match(h, new RegExp(`<button class="danger solid">Name vio@example\\.test owner of clients/</button><a class="button quiet" href="${re(owners(V.main, "clients/"))}">Cancel</a>`));
  assert.deepEqual(await named(V.main, "clients/"), [], "nothing granted by looking");
});

test("name owner: a form without the confirm page's field is sent to that page and grants nothing", async () => {
  const token = csrfOf(await page(pat, owners(V.main, "clients/")));
  const r = await post(pat, `/v/${V.main}/rules/owners`, { csrf: token, path: "clients/", user: VIO, action: "add" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), `${owners(V.main, "clients/")}&add=${VIO}`);
  assert.deepEqual(await named(V.main, "clients/"), []);
});

test("name owner: confirming names a viewer, says so as a success, logs it, and the page lists them as a viewer of this path only", async () => {
  const { action, fields } = formFields(await page(pat, `${owners(V.main, "clients/")}&add=${VIO}`), "Name vio@example.test owner of clients/");
  const r = await post(pat, action, fields);
  assert.equal(r.headers.get("location"), owners(V.main, "clients/"));
  const h = await landed(pat, r);
  assert.deepEqual(flashOf(h), ["success", "status", "vio@example.test is now a named owner of clients/: they, and their agents, write it directly."]);
  assert.deepEqual(await named(V.main, "clients/"), [VIO]);
  assert.deepEqual((await logged(V.main, "path_owner.add")).filter((l) => l.path === "clients/"), [{ path: "clients/", user_id: VIO, actor: PAT }]);
  assert.match(h, /<tr><td>vio@example\.test<\/td>\s*<td class="small" data-label="Role in the vault">Viewer<span class="token-client">Writes and approves this path only; reads the rest<\/span>/);
});

test("name owner: on a path that has owners already, the confirm page says their approval joins the others'", async () => {
  const h = await page(pat, `${owners(V.main, "legal/")}&add=${VIO}`);
  assert.match(h, /<li>Their approval counts toward its 2 approvals, with the other 2 named owners’\. Nobody else’s does\.<\/li>/);
  assert.doesNotMatch(h, /Until now any editor’s or owner’s did/);
  const one = await page(pat, `${owners(V.main, "hr/")}&add=${OTTO}`);
  assert.match(one, /<li>Their approval counts toward its 1 approval, with the other named owner’s\. Nobody else’s does\.<\/li>/);
  assert.deepEqual(await named(V.main, "legal/"), [EDDA, OTTO].sort());
});

test("name owner: someone already named is said to be, and nothing changes", async () => {
  const h = await landed(pat, await get(pat, `${owners(V.main, "legal/")}&add=${OTTO}`));
  assert.deepEqual(flashOf(h), ["info", "status", "otto@example.test is already a named owner of legal/."]);
});

test("name owner: someone who isn't a member can't be named: the confirm page sends you back, and the database refuses a crafted form", async () => {
  const back = await landed(pat, await get(pat, `${owners(V.main, "clients/")}&add=${URSA}`));
  assert.deepEqual(flashOf(back), ["warning", "status", "That person isn’t a member of this vault, so they can’t be named an owner. Invite them first."]);
  const token = csrfOf(back);
  const h = await landed(pat, await post(pat, `/v/${V.main}/rules/owners`, { csrf: token, path: "clients/", user: URSA, action: "add", confirm: "1" }));
  const [tone, , text] = flashOf(h);
  assert.equal(tone, "danger");
  assert.match(text, /^That person isn&#39;t a member of this vault\. \(ref ([0-9a-f]{8})\)$/);
  assert.deepEqual(await named(V.main, "clients/"), [VIO]);
});

test("name owner: a path with no rule can't get an owner: the refusal goes back to Rules in words, not an error page", async () => {
  const token = csrfOf(await page(pat, `/v/${V.main}/rules`));
  const r = await post(pat, `/v/${V.main}/rules/owners`, { csrf: token, path: "nowhere/", user: VIO, action: "add", confirm: "1" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), `/v/${V.main}/rules`);
  const [tone, , text] = flashOf(await landed(pat, r));
  assert.equal(tone, "danger");
  const m = /^Set a policy for nowhere\/ before naming an owner\. \(ref ([0-9a-f]{8})\)$/.exec(text);
  assert.ok(m, text);
  assert.match(pat.log, new RegExp(`failure ref=${m[1]} `), "the ref is in the server log");
  assert.deepEqual(await named(V.main, "nowhere/"), []);
});

test("name owner: an editor can't: no form, the confirm page sends them back, and the database refuses a crafted form", async () => {
  const back = await landed(edda, await get(edda, `${owners(V.main, "hr/")}&add=${OTTO}`));
  assert.deepEqual(flashOf(back), ["warning", "status", "Only owners name a path’s owners; ask an owner of this vault."]);
  const h = await landed(edda, await post(edda, `/v/${V.main}/rules/owners`, { csrf: csrfOf(back), path: "hr/", user: EDDA, action: "add", confirm: "1" }));
  const [tone, , text] = flashOf(h);
  assert.equal(tone, "danger");
  assert.match(text, /^Only owners name a path&#39;s owners\. \(ref [0-9a-f]{8}\)$/);
  assert.deepEqual(await named(V.main, "hr/"), [VIO]);
});

// ---------------------------------------------------------------------------
// Removing an owner

test("remove owner: the confirm page says what they go back to, and opening it removes nothing", async () => {
  const r = await get(pat, `${owners(V.main, "hr/")}&remove=${VIO}`);
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Remove vio@example\.test as an owner of hr\/\?<\/h1>/);
  assert.match(h, /vio@example\.test stops writing <code>hr\/<\/code> directly, and so do their agents\./);
  assert.match(h, /<li>They go back to reading it only, like the rest of Owners main\.<\/li>/);
  assert.match(h, /<li>They’re its last named owner, so any editor’s or owner’s approval counts toward its 1 approval again\.<\/li>/);
  const { fields } = formFields(h, "Remove vio@example.test as owner");
  assert.deepEqual({ ...fields, csrf: undefined }, { csrf: undefined, path: "hr/", user: VIO, action: "remove", confirm: "1" });
  const editor = await page(pat, `${owners(V.main, "legal/")}&remove=${OTTO}`);
  assert.match(editor, /<li>As an editor, they propose changes to it and wait for approval, like anyone else\.<\/li>/);
  assert.doesNotMatch(editor, /last named owner/, "Edda is still named");
  assert.deepEqual(await named(V.main, "hr/"), [VIO], "nothing removed by looking");
});

test("remove owner: a form without the confirm page's field is sent to that page and removes nothing", async () => {
  const token = csrfOf(await page(pat, owners(V.main, "hr/")));
  const r = await post(pat, `/v/${V.main}/rules/owners`, { csrf: token, path: "hr/", user: VIO, action: "remove" });
  assert.equal(r.headers.get("location"), `${owners(V.main, "hr/")}&remove=${VIO}`);
  assert.deepEqual(await named(V.main, "hr/"), [VIO]);
});

test("remove owner: an editor can't: the confirm page sends them back, and the database refuses a crafted form", async () => {
  const back = await landed(edda, await get(edda, `${owners(V.main, "legal/")}&remove=${OTTO}`));
  assert.deepEqual(flashOf(back), ["warning", "status", "Only owners remove a path’s owners; ask an owner of this vault."]);
  const h = await landed(edda, await post(edda, `/v/${V.main}/rules/owners`, { csrf: csrfOf(back), path: "legal/", user: OTTO, action: "remove", confirm: "1" }));
  const [tone, , text] = flashOf(h);
  assert.equal(tone, "danger");
  assert.match(text, /^Only owners remove a path&#39;s owners\. \(ref [0-9a-f]{8}\)$/);
  assert.deepEqual(await named(V.main, "legal/"), [EDDA, OTTO].sort());
});

test("remove owner: confirming removes them, says so as a success and logs it", async () => {
  const { action, fields } = formFields(await page(pat, `${owners(V.main, "hr/")}&remove=${VIO}`), "Remove vio@example.test as owner");
  const h = await landed(pat, await post(pat, action, fields));
  assert.deepEqual(flashOf(h), ["success", "status", "vio@example.test is no longer a named owner of hr/."]);
  assert.deepEqual(await named(V.main, "hr/"), []);
  assert.deepEqual(await logged(V.main, "path_owner.remove"), [{ path: "hr/", user_id: VIO, actor: PAT }]);
  assert.match(h, /<strong>No named owners<\/strong>/);
});

test("remove owner: someone who isn't named goes back with a warning, and a second removal changes nothing and names no id", async () => {
  const back = await landed(pat, await get(pat, `${owners(V.main, "hr/")}&remove=${VIO}`));
  assert.deepEqual(flashOf(back), ["warning", "status", "That person isn’t a named owner of hr/; they may have been removed already."]);
  const h = await landed(pat, await post(pat, `/v/${V.main}/rules/owners`, { csrf: csrfOf(back), path: "hr/", user: VIO, action: "remove", confirm: "1" }));
  assert.deepEqual(flashOf(h), ["warning", "status", "vio@example.test isn’t a named owner of hr/, so nothing changed; they may have been removed already."]);
  assert.equal((await logged(V.main, "path_owner.remove")).length, 1, "nothing more logged");
});

test("remove owner: a form that names no one, or no action, is refused with a reference and changes nothing", async () => {
  const token = csrfOf(await page(pat, owners(V.main, "legal/")));
  const noUser = flashOf(await landed(pat, await post(pat, `/v/${V.main}/rules/owners`, { csrf: token, path: "legal/", user: "nope", action: "remove", confirm: "1" })));
  assert.equal(noUser[0], "danger");
  assert.match(noUser[2], /^The form didn’t say which member, so nothing changed: choose them again\. \(ref [0-9a-f]{8}\)$/);
  const noAction = flashOf(await landed(pat, await post(pat, `/v/${V.main}/rules/owners`, { csrf: token, path: "legal/", user: OTTO, action: "grant", confirm: "1" })));
  assert.match(noAction[2], /^The form didn’t say whether to name or remove an owner, so nothing changed\. \(ref [0-9a-f]{8}\)$/);
  assert.deepEqual(await named(V.main, "legal/"), [EDDA, OTTO].sort());
});
