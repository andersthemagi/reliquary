// The Claims page in the web app (src/claimspage.ts): a vault's active
// claims (path, holder, time left), and Break behind a confirm page for an
// owner or editor. The database's own predicates (who may break, the
// identity and lease rules) are hostile-tested in
// supabase/tests/path_claims_test.sql; this file is about what the page
// shows, who gets the Break action, and the confirm-then-act flow -- the
// wiring, not the access rule itself (test-audit skill).
//
// This file starts its own servers from dist/, one signed in as Noa (an
// owner) and one as Rex (a viewer), people no other test file uses. Noa
// owns "Claims main" with Edda (an editor, who holds the claims below) and
// Rex (a viewer).

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
const NOA = "00000000-0000-0000-0000-0000000009b1";
const EDDA = "00000000-0000-0000-0000-0000000009b2";
const REX = "00000000-0000-0000-0000-0000000009b3";

const V = {};
let noa;
let rex;

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
  const s = { origin: `http://127.0.0.1:${port}`, cookie: "", child: null };
  const loginFile = `/tmp/claims-page-${name}-${process.pid}-${port}`;
  s.child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
const landed = async (s, r) => {
  assert.equal(r.status, 303);
  return page(s, r.headers.get("location"));
};
const flashOf = (h) => /<p class="callout (\w+) flash" role="(\w+)">([\s\S]*?)<\/p>/.exec(h)?.slice(1);
function formFields(h, label) {
  const forms = h.split("<form ").slice(1).map((f) => f.slice(0, f.indexOf("</form>")));
  const form = forms.find((f) => f.includes(`>${label}</button>`));
  assert.ok(form, `a form with a "${label}" button`);
  const fields = {};
  for (const m of form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[m[1]] = m[2];
  return { action: /action="([^"]+)"/.exec(form)[1], fields };
}

const claimsUrl = (v) => `/v/${v}/claims`;
const active = async (v) => (await sql("select path from public.path_claims where vault_id = $1 and expires_at > now() order by path", [v])).map((r) => r.path);
const logged = async (v, event) => (await sql("select path, actor from public.log where vault_id = $1 and event = $2 order by seq", [v, event]));

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'noa@example.test'), ($2, 'edda@example.test'), ($3, 'rex@example.test') on conflict (id) do nothing`,
    [NOA, EDDA, REX],
  );
  noa = await start(NOA, "noa");
  rex = await start(REX, "rex");

  [{ id: V.main }] = await as(NOA, "select public.create_vault('Claims main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, EDDA, NOA]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.main, REX, NOA]);
  await as(EDDA, "select public.write_file($1, 'notes/draft.md', 'Text')", [V.main]);
  await as(EDDA, "select public.claim_path($1, 'notes/draft.md', 'tidying this up')", [V.main]);

  [{ id: V.empty }] = await as(NOA, "select public.create_vault('Claims empty', 'open') as id");
  [{ id: V.ola }] = await as(REX, "select public.create_vault('Claims rex-only', 'open') as id");

  // A vault of its own, so V.main's single claim stays single: a claim on a
  // file that's there and one that isn't.
  [{ id: V.rows }] = await as(NOA, "select public.create_vault('Claims rows', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.rows, EDDA, NOA]);
  await as(EDDA, "select public.write_file($1, 'mine.md', 'Text')", [V.rows]);
  await as(EDDA, "select public.claim_path($1, 'planned.md')", [V.rows]);
  await as(NOA, "select public.claim_path($1, 'mine.md')", [V.rows]);
});

after(async () => {
  noa?.child?.kill();
  rex?.child?.kill();
});

test("claims page: a vault you're not in is 404", async () => {
  assert.equal((await get(noa, claimsUrl(V.ola))).status, 404);
});

test("claims page: a vault with nothing claimed says so", async () => {
  const h = await page(noa, claimsUrl(V.empty));
  assert.match(h, /<h2>Claims<\/h2>/);
  assert.match(h, /<strong>No active claims<\/strong>/);
});

test("claims page: lists the path (linked to the file), holder and label", async () => {
  const h = await page(noa, claimsUrl(V.main));
  const row = /<tr><td data-label="Path">[\s\S]*?<\/tr>/.exec(h)[0];
  assert.match(row, new RegExp(`<a href="/v/${V.main}/file\\?path=notes%2Fdraft\\.md">notes/draft\\.md</a>`));
  assert.match(row, /edda@example\.test/);
  assert.match(row, /<span class="token-client">tidying this up<\/span>/);
  assert.match(h, /Your agents see and take the same claims over MCP/);
});

// One row of the claims table, found by its path rather than its position.
const rowOf = (h, path) => h.split("<tr>").find((r) => r.startsWith("<td") && r.includes(path)) ?? assert.fail(`a row for ${path}`);

test("claims page: a claim on a path with no file there is plain text saying so, not a link to a page that doesn't exist", async () => {
  const h = await page(noa, claimsUrl(V.rows));
  assert.match(rowOf(h, "mine.md"), new RegExp(`<a href="/v/${V.rows}/file\\?path=mine\\.md">mine\\.md</a>`));
  const planned = rowOf(h, "planned.md");
  assert.doesNotMatch(planned, /<a href="[^"]*path=planned/);
  assert.match(planned, /planned\.md<span class="token-client">no file there yet<\/span>/);
});

// Claims is a tab of Diagnostics (src/diagnostics.ts): the page at its old
// address, now behind Settings' frame.

test("diagnostics: /claims is the same page inside Diagnostics, with Claims and Diagnostics current and the headings in order", async () => {
  const h = await page(noa, claimsUrl(V.main));
  assert.match(h, new RegExp(`<a href="/v/${V.main}/diagnostics" aria-current="page">Diagnostics</a>`), "the Settings tab");
  assert.match(h, new RegExp(`<nav class="tabs" aria-label="Diagnostics"><a href="/v/${V.main}/flags">Flags</a><a href="/v/${V.main}/claims" aria-current="page">Claims</a><a href="/v/${V.main}/activity">Log</a></nav>`));
  assert.match(h, new RegExp(`href="/v/${V.main}/config" aria-current="page">Settings`), "the sidebar's Settings");
  assert.match(h, /For working out why something happened; most people never need it\./);
  assert.equal((h.match(/<h1[ >]/g) ?? []).length, 1, "one h1");
  assert.ok(h.indexOf("<h1>Settings</h1>") < h.indexOf("<h2>Claims</h2>"), "Settings, then Claims");
});

test("diagnostics: Flags and Claims, and a count of active claims, are not in the vault's navigation", async () => {
  const h = await page(noa, `/v/${V.main}`);
  assert.deepEqual(await active(V.main), ["notes/draft.md"], "this vault has an active claim to count");
  const navs = h.match(/<nav class="(?:side-links|tabs)" aria-label="Vault(?: \(phone\))?">[\s\S]*?<\/nav>/g);
  assert.equal(navs.length, 2, "the wide sidebar and the phone tabs");
  for (const nav of navs) {
    assert.doesNotMatch(nav, /\/flags|\/claims|Flags|Claims/);
    assert.doesNotMatch(nav, /class="count"/, "no count badge");
  }
});

test("diagnostics: a viewer has the Diagnostics tab and its page", async () => {
  assert.match(await page(rex, `/v/${V.main}/config`), new RegExp(`<a href="/v/${V.main}/diagnostics">Diagnostics</a>`));
  const h = await page(rex, `/v/${V.main}/diagnostics`);
  assert.match(h, new RegExp(`<a href="/v/${V.main}/claims">Claims</a>`));
  assert.equal((await get(rex, `/v/${V.main}/claims`)).status, 200);
});

test("claims page: a viewer sees the list but no Break action", async () => {
  const h = await page(rex, claimsUrl(V.main));
  assert.match(h, /notes\/draft\.md/);
  assert.doesNotMatch(h, /Break</, "no Break link");
  assert.doesNotMatch(h, /row-actions/, "no actions column at all for a viewer");
});

test("break: the confirm page says what happens, and opening it breaks nothing", async () => {
  const h = await page(noa, `${claimsUrl(V.main)}?break=${encodeURIComponent("notes/draft.md")}`);
  assert.match(h, /<h1>Break the claim on notes\/draft\.md\?<\/h1>/);
  assert.match(
    h,
    new RegExp(`<li><a href="/v/${V.main}/config">Settings</a></li><li><a href="/v/${V.main}/diagnostics">Diagnostics</a></li><li><a href="/v/${V.main}/claims">Claims</a></li><li aria-current="page">Break</li>`),
    "it sits under Claims, in Diagnostics",
  );
  assert.doesNotMatch(h, /aria-label="Diagnostics"/, "a confirm page has no tabs");
  assert.match(h, /edda@example\.test \(tidying this up\) loses this claim; they, and their agent, can claim <code>notes\/draft\.md<\/code> again once they’re ready\./);
  assert.match(h, /<li>Nothing about the file itself changes: a claim is a courtesy signal, not an access gate\.<\/li>/);
  const { fields } = formFields(h, "Break the claim on notes/draft.md");
  assert.deepEqual({ ...fields, csrf: undefined }, { csrf: undefined, path: "notes/draft.md", action: "break", confirm: "1" });
  assert.deepEqual(await active(V.main), ["notes/draft.md"], "asking breaks nothing");
});

test("break: a form without the confirm page's field is sent to that page and breaks nothing", async () => {
  const token = csrfOf(await page(noa, claimsUrl(V.main)));
  const r = await post(noa, `/v/${V.main}/claims`, { csrf: token, path: "notes/draft.md", action: "break" });
  assert.equal(r.headers.get("location"), `${claimsUrl(V.main)}?break=${encodeURIComponent("notes/draft.md")}`);
  assert.deepEqual(await active(V.main), ["notes/draft.md"]);
});

test("break: a viewer can't: the confirm page sends them back, and the database refuses a crafted form", async () => {
  const back = await landed(rex, await get(rex, `${claimsUrl(V.main)}?break=${encodeURIComponent("notes/draft.md")}`));
  assert.deepEqual(flashOf(back), ["warning", "status", "Only an owner or editor breaks a claim."]);
  const h = await landed(rex, await post(rex, `/v/${V.main}/claims`, { csrf: csrfOf(back), path: "notes/draft.md", action: "break", confirm: "1" }));
  const [tone, , text] = flashOf(h);
  assert.equal(tone, "danger");
  assert.match(text, /\(ref [0-9a-f]{8}\)$/);
  assert.deepEqual(await active(V.main), ["notes/draft.md"], "nothing broken");
});

test("break: confirming it breaks the claim, says so as a success, logs it, and it's no longer listed", async () => {
  const { action, fields } = formFields(await page(noa, `${claimsUrl(V.main)}?break=${encodeURIComponent("notes/draft.md")}`), "Break the claim on notes/draft.md");
  const h = await landed(noa, await post(noa, action, fields));
  assert.deepEqual(flashOf(h), ["success", "status", "The claim on notes/draft.md is broken; it’s free to claim again."]);
  assert.deepEqual(await active(V.main), []);
  assert.deepEqual(await logged(V.main, "claim.break"), [{ path: "notes/draft.md", actor: NOA }]);
  assert.match(h, /<strong>No active claims<\/strong>/);
});

test("break: a claim already gone goes back with a warning, and a second attempt changes nothing", async () => {
  const back = await landed(noa, await get(noa, `${claimsUrl(V.main)}?break=${encodeURIComponent("notes/draft.md")}`));
  assert.deepEqual(flashOf(back), [
    "warning",
    "status",
    "There’s no active claim on notes/draft.md to break; it may have been released or expired already.",
  ]);
  const h = await landed(noa, await post(noa, `/v/${V.main}/claims`, { csrf: csrfOf(back), path: "notes/draft.md", action: "break", confirm: "1" }));
  const [tone, , text] = flashOf(h);
  assert.equal(tone, "danger");
  assert.match(text, /^No active claim on this path\. \(ref [0-9a-f]{8}\)$/);
  assert.equal((await logged(V.main, "claim.break")).length, 1, "nothing more logged");
});

test("break: a form naming no action is refused with a reference and changes nothing", async () => {
  await as(EDDA, "select public.claim_path($1, 'notes/draft.md')", [V.main]);
  const token = csrfOf(await page(noa, claimsUrl(V.main)));
  const h = await landed(noa, await post(noa, `/v/${V.main}/claims`, { csrf: token, path: "notes/draft.md", action: "nope" }));
  const [tone, , text] = flashOf(h);
  assert.equal(tone, "danger");
  assert.match(text, /^The form didn’t say what to do, so nothing changed\. \(ref [0-9a-f]{8}\)$/);
  assert.deepEqual(await active(V.main), ["notes/draft.md"]);
});
