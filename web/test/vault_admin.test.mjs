// Vault settings: rename and default policy, export, delete, and erasing a
// file (src/vaultadmin.ts, src/export.ts), driven over HTTP. The database
// rules are in supabase/tests/vault_admin_test.sql.
//
// This file starts its own server from dist/, signed in as Vera, a person no
// other test file uses, so nothing here moves another file's counts. Vera
// owns "Admin Own" (files, a canon rule, a variable), "Admin Erase" and
// "Admin Doomed", and is an editor in Walt's "Admin Walt". Variable
// "ciphertexts" hold ADMINCT-, which no export may carry.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { gunzipSync } from "node:zlib";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const VERA = "00000000-0000-0000-0000-0000000000f7";
const WALT = "00000000-0000-0000-0000-0000000000f8";
const LONG = `deep/${"a".repeat(60)}/${"b".repeat(60)}/notes.md`;

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
const csrfOf = async () => /name="csrf" value="([0-9a-f]+)"/.exec(await page("/"))[1];
const post = async (path, fields, { csrf = true } = {}) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin },
    body: new URLSearchParams({ ...(csrf ? { csrf: await csrfOf() } : {}), ...fields }).toString(),
  });
const flashAfter = async (r) => {
  assert.equal(r.status, 303);
  const h = await page(r.headers.get("location"));
  // A refusal ends with its reference (failure.ts), different each time.
  return (/<p class="callout (?:info|success|warning|danger) flash" role="(?:status|alert)">([^<]*)<\/p>/.exec(h)?.[1] ?? "").replace(/ \(ref [0-9a-f]{8}\)$/, "");
};
const vaultRow = async (id) => (await sql("select name, default_policy from public.vaults where id = $1", [id]))[0];
const events = async (id, event) =>
  Number((await sql("select count(*)::int as n from public.log where vault_id = $1 and event = $2", [id, event]))[0].n);
const setVar = (user, vault, name, env) =>
  as(user, "select public.set_variable($1, $2, $3, 'k1', $4, $5)", [
    vault, name, env, Buffer.alloc(12), Buffer.from(`ADMINCT-${name}-${env}-padding`),
  ]);

// A minimal tar reader: regular files, with pax `path` records.
function untar(buf) {
  const out = new Map();
  let pax = null;
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    assert.equal(parseInt(h.subarray(148, 156).toString("ascii"), 8), sum, "tar header checksum");
    const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(h.subarray(124, 136).toString("ascii"), 8);
    const type = String.fromCharCode(h[156]);
    assert.equal(h.subarray(257, 263).toString("ascii"), "ustar\0");
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1] ?? null;
      continue;
    }
    assert.equal(type, "0");
    out.set(pax ?? name, body);
    pax = null;
  }
  return out;
}

before(async () => {
  const port = await freePort();
  s.origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/vault-admin-login-${process.pid}-${port}`;
  child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: VERA, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
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

  [{ id: V.own }] = await as(VERA, "select public.create_vault('Admin Own') as id");
  [{ id: V.erase }] = await as(VERA, "select public.create_vault('Admin Erase') as id");
  [{ id: V.doomed }] = await as(VERA, "select public.create_vault('Admin Doomed') as id");
  [{ id: V.walt }] = await as(WALT, "select public.create_vault('Admin Walt') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.walt, VERA, WALT]);
  await as(WALT, "select public.write_file($1, 'walt.md', 'Walt text')", [V.walt]);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.doomed, WALT, VERA]);

  await as(VERA, "select public.set_policy($1, 'canon/', 'canon', 1)", [V.own]);
  await as(VERA, "select public.write_file($1, 'notes/a.md', 'Alpha one')", [V.own]);
  await as(VERA, "select public.write_file($1, 'notes/a.md', 'Alpha — two')", [V.own]);
  await as(VERA, "select public.write_file($1, $2, 'Deep text')", [V.own, LONG]);
  await as(VERA, "select public.write_file($1, 'gone.md', 'Deleted text')", [V.own]);
  await as(VERA, "select public.delete_file($1, 'gone.md')", [V.own]);
  await setVar(VERA, V.own, "API_KEY", "development");
  await setVar(VERA, V.own, "API_KEY", "production");

  await as(VERA, "select public.write_file($1, 'people/pat.md', 'Pat, born 1990')", [V.erase]);
  await as(VERA, "select public.write_file($1, 'people/pat.md', 'Pat, born 1991')", [V.erase]);

  await as(VERA, "select public.write_file($1, 'doomed.md', 'Doomed text')", [V.doomed]);
  await setVar(VERA, V.doomed, "DOOMED_KEY", "development");
  await as(VERA, "select public.create_access_token('Doomed only', 30, array[$1]::uuid[], 'write')", [V.doomed]);
});

after(async () => {
  child?.kill();
});

// ---------------------------------------------------------------------------
// Settings

test("vault settings: the sidebar links to Settings, which holds Rules, rename and default policy, Export and a Danger zone", async () => {
  const home = await page(`/v/${V.own}`);
  assert.equal(home.split(`href="/v/${V.own}/config"`).length - 1, 2, "the wide sidebar and the phone tabs");
  const sideLinks = home.match(/<nav class="(?:side-links|tabs)" aria-label="Vault(?: \(phone\))?">[\s\S]*?<\/nav>/g);
  assert.equal(sideLinks.length, 2);
  for (const nav of sideLinks) assert.doesNotMatch(nav, /\/rules"/, "Rules moved under Settings");
  const h = await page(`/v/${V.own}/config`);
  assert.match(h, new RegExp(`href="/v/${V.own}/config" aria-current="page">Settings`));
  assert.match(h, /<h1>Settings<\/h1>/);
  assert.match(h, new RegExp(`<form method="post" action="/v/${V.own}/config" class="panel choice-form" id="general">`));
  assert.match(h, /<input id="vn" type="text" name="name" value="Admin Own" required maxlength="100">/);
  assert.match(h, /name="default_policy" value="open" checked>/);
  assert.match(h, new RegExp(`href="/v/${V.own}/rules">Rules</a>`));
  assert.match(h, new RegExp(`href="/v/${V.own}/config/export">Export this vault</a>`));
  assert.match(h, /<h2>Danger zone<\/h2>\s*<div class="danger-zone">/);
  assert.match(h, new RegExp(`<a class="button danger" href="/v/${V.own}/config/delete">Delete vault</a>`));
});

test("vault settings: the Rules page marks Settings as current", async () => {
  assert.match(await page(`/v/${V.own}/rules`), new RegExp(`href="/v/${V.own}/config" aria-current="page">Settings`));
});

test("vault settings: an editor sees the default, and no rename form, export or danger zone", async () => {
  const h = await page(`/v/${V.walt}/config`);
  assert.match(h, /Only owners rename a vault or change its default\./);
  assert.match(h, /Owners can export this vault\./);
  assert.doesNotMatch(h, /id="general"|Danger zone|settings\/delete|settings\/export"/);
});

test("vault settings: saving asks for confirmation first, and nothing changes until then", async () => {
  const r = await post(`/v/${V.own}/config`, { name: "Admin Renamed", default_policy: "canon" });
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Confirm changes<\/h1>/);
  assert.match(h, /Rename <strong>Admin Own<\/strong> to <strong>Admin Renamed<\/strong>/);
  assert.match(h, /Files no rule covers become canon/);
  assert.match(h, /<input type="hidden" name="confirm" value="1">/);
  assert.deepEqual(await vaultRow(V.own), { name: "Admin Own", default_policy: "open" });
  assert.equal(await events(V.own, "vault.rename"), 0);
});

test("vault settings: confirming renames the vault and changes its default, each logged", async () => {
  const flash = await flashAfter(await post(`/v/${V.own}/config`, { name: "Admin Renamed", default_policy: "canon", confirm: "1" }));
  assert.equal(flash, "Renamed to Admin Renamed. Files with no rule are canon now.");
  assert.deepEqual(await vaultRow(V.own), { name: "Admin Renamed", default_policy: "canon" });
  assert.equal(await events(V.own, "vault.rename"), 1);
  assert.equal(await events(V.own, "vault.default_policy"), 1);
  assert.match(await page(`/v/${V.own}/activity`), /Renamed the vault/);
  await post(`/v/${V.own}/config`, { name: "Admin Renamed", default_policy: "open", confirm: "1" });
  assert.equal((await vaultRow(V.own)).default_policy, "open");
});

test("vault settings: unchanged fields change nothing", async () => {
  assert.equal(await flashAfter(await post(`/v/${V.own}/config`, { name: "Admin Renamed", default_policy: "open" })), "Nothing changed.");
});

test("vault settings: a blank name is refused with the database's reason", async () => {
  const flash = await flashAfter(await post(`/v/${V.own}/config`, { name: "  ", default_policy: "open", confirm: "1" }));
  assert.equal(flash, "A vault name is 1 to 100 characters.");
  assert.equal((await vaultRow(V.own)).name, "Admin Renamed");
});

test("vault settings: an editor's forged rename is refused by the database", async () => {
  const flash = await flashAfter(await post(`/v/${V.walt}/config`, { name: "Vera's now", default_policy: "canon", confirm: "1" }));
  assert.equal(flash, "Only owners rename a vault.");
  assert.deepEqual(await vaultRow(V.walt), { name: "Admin Walt", default_policy: "open" });
});

test("vault settings: a post without the form token changes nothing", async () => {
  const r = await post(`/v/${V.own}/config`, { name: "No token", default_policy: "open", confirm: "1" }, { csrf: false });
  assert.equal(r.status, 403);
  assert.equal((await vaultRow(V.own)).name, "Admin Renamed");
});

// Flash messages (html.ts placeFlash, flash.ts): the tone, and the place.
const flashPage = async (r) => {
  assert.equal(r.status, 303);
  return page(r.headers.get("location"));
};

test("flash: a change that was made shows as success, right under the page title in the content column", async () => {
  const h = await flashPage(await post(`/v/${V.own}/config`, { name: "Admin Renamed", default_policy: "canon", confirm: "1" }));
  assert.match(h, /<div class="content">\s*<div class="page-head">[\s\S]*?<h1>Settings<\/h1>[\s\S]*?<\/div>\s*<p class="callout success flash" role="status">Files with no rule are canon now\.<\/p>/);
  assert.ok(h.indexOf("callout success flash") > h.indexOf('<aside class="side">'), "not above the sidebar");
  assert.equal(h.split("flash").length - 1, 1, "shown once");
  await post(`/v/${V.own}/config`, { name: "Admin Renamed", default_policy: "open", confirm: "1" });
});

test("flash: a refusal shows in danger tone as an alert, with its reference", async () => {
  const h = await flashPage(await post(`/v/${V.walt}/config`, { name: "Vera's now", default_policy: "canon", confirm: "1" }));
  assert.match(h, /<p class="callout danger flash" role="alert">Only owners rename a vault\. \(ref [0-9a-f]{8}\)<\/p>/);
});

test("flash: a message that is neither done nor refused shows as information", async () => {
  const h = await flashPage(await post(`/v/${V.own}/config`, { name: "Admin Renamed", default_policy: "open" }));
  assert.match(h, /<p class="callout info flash" role="status">Nothing changed\.<\/p>/);
});

test("flash: a field over its limit is refused before the database, in danger tone", async () => {
  const r = await post(`/v/${V.own}/config`, { name: "x".repeat(201), default_policy: "open", confirm: "1" });
  assert.match(await flashPage(r), /<p class="callout danger flash" role="alert">/);
  assert.equal((await vaultRow(V.own)).name, "Admin Renamed");
});

// ---------------------------------------------------------------------------
// Export

test("export: the page says what the archive holds, and that variable values are not exported", async () => {
  const h = await page(`/v/${V.own}/config/export`);
  assert.match(h, /A <code>\.tar\.gz<\/code> of 2 files/);
  assert.match(h, /<strong>Variable values are not exported\.<\/strong>/);
  assert.match(h, /reliquary-export\.json/);
  assert.match(h, new RegExp(`<form method="post" action="/v/${V.own}/config/export" id="export"`));
  assert.match(h, /<button class="primary" form="export">Download export<\/button>/);
});

test("export: a GET never downloads, and a post without the form token neither", async () => {
  const g = await get(`/v/${V.own}/config/export`);
  assert.match(g.headers.get("content-type"), /text\/html/);
  const r = await post(`/v/${V.own}/config/export`, {}, { csrf: false });
  assert.equal(r.status, 403);
  assert.equal(await events(V.own, "vault.export"), 0);
});

test("export: the owner downloads a .tar.gz of current files and a manifest, no-store, logged as vault.export", async () => {
  const r = await post(`/v/${V.own}/config/export`, {});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "application/gzip");
  assert.equal(r.headers.get("cache-control"), "no-store");
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(r.headers.get("content-disposition"), `attachment; filename="admin-renamed-${day}.tar.gz"`);
  const raw = Buffer.from(await r.arrayBuffer());
  const files = untar(gunzipSync(raw));
  const root = `admin-renamed-${day}`;
  assert.deepEqual([...files.keys()].sort(), [`${root}/files/${LONG}`, `${root}/files/notes/a.md`, `${root}/reliquary-export.json`].sort());
  assert.equal(files.get(`${root}/files/notes/a.md`).toString("utf8"), "Alpha — two");
  assert.equal(files.get(`${root}/files/${LONG}`).toString("utf8"), "Deep text");
  const m = JSON.parse(files.get(`${root}/reliquary-export.json`).toString("utf8"));
  assert.equal(m.format, "reliquary-export/1");
  assert.equal(m.vault.name, "Admin Renamed");
  assert.equal(m.vault.id, V.own);
  assert.deepEqual(m.rules, [{ path: "canon/", policy: "canon", quorum: 1 }]);
  assert.deepEqual(m.variables, { values_included: false, names: [{ name: "API_KEY", environments: ["development", "production"] }] });
  const a = m.files.find((f) => f.path === "notes/a.md");
  assert.equal(a.sha256, createHash("sha256").update("Alpha — two").digest("hex"));
  assert.equal(a.bytes, Buffer.byteLength("Alpha — two"));
  assert.match(m.not_included, /Environment variable values are never exported/);
  assert.equal(await events(V.own, "vault.export"), 1);
  assert.equal(gunzipSync(raw).includes("ADMINCT-"), false, "no ciphertext in the archive");
  assert.equal(gunzipSync(raw).includes("Deleted text"), false, "no deleted file");
});

test("export: an editor gets no download; the database refuses a forged post", async () => {
  assert.match(await page(`/v/${V.walt}/config/export`), /Only owners export a vault\./);
  const r = await post(`/v/${V.walt}/config/export`, {});
  assert.equal(await flashAfter(r), "Only owners export a vault.");
  assert.equal(await events(V.walt, "vault.export"), 0);
});

// ---------------------------------------------------------------------------
// Erase

test("erase: an owner's file page has a More menu with Erase; an editor's has none", async () => {
  const h = await page(`/v/${V.erase}/file?path=people/pat.md`);
  assert.match(h, /<details class="menu-wrap action-menu file-more">\s*<summary class="button">More<\/summary>/);
  assert.match(h, new RegExp(`<a class="menu-item danger" href="/v/${V.erase}/erase\\?path=people%2Fpat\\.md"><span class="menu-item-title">Erase content…</span>`));
  assert.doesNotMatch(await page(`/v/${V.walt}/file?path=walt.md`), /\/erase\?|Erase content/);
});

test("erase: the confirm page explains that every version is blanked and the log keeps its sequence, and asks for the path", async () => {
  const h = await page(`/v/${V.erase}/erase?path=people%2Fpat.md`);
  assert.match(h, /blanks the text of all 2 versions, and of every proposal, review note and comment on it/);
  assert.match(h, /The activity log keeps its entries, in order/);
  assert.match(h, /Type <strong>people\/pat\.md<\/strong> to confirm/);
  assert.match(h, /<input id="confirm-typed" type="text" name="confirm_path" required/);
  assert.equal((await get(`/v/${V.erase}/erase?path=nope.md`)).status, 404);
});

test("erase: a wrong path erases nothing", async () => {
  const r = await post(`/v/${V.erase}/erase`, { path: "people/pat.md", confirm_path: "people/pat" });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /That isn’t the file’s path\. Nothing was erased\./);
  assert.equal(await events(V.erase, "file.erase"), 0);
});

test("erase: an editor's forged post is refused by the database", async () => {
  const flash = await flashAfter(await post(`/v/${V.walt}/erase`, { path: "walt.md", confirm_path: "walt.md" }));
  assert.equal(flash, "Only owners erase.");
  assert.equal((await sql("select count(*)::int as n from public.file_versions where vault_id = $1 and body = 'Walt text'", [V.walt]))[0].n, 1);
});

test("erase: typing the path blanks every version and the log gains one entry", async () => {
  const before = await sql("select count(*)::int as n, max(seq) as top from public.log where vault_id = $1", [V.erase]);
  const flash = await flashAfter(await post(`/v/${V.erase}/erase`, { path: "people/pat.md", confirm_path: "people/pat.md" }));
  assert.equal(flash, "Erased people/pat.md: 2 versions blanked.");
  const rows = await sql("select body, erased_at from public.file_versions where vault_id = $1", [V.erase]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((v) => v.body === null && v.erased_at), "every version blanked");
  const afterRows = await sql("select count(*)::int as n from public.log where vault_id = $1 and seq <= $2", [V.erase, before[0].top]);
  assert.equal(afterRows[0].n, before[0].n, "earlier log rows kept");
  assert.equal(await events(V.erase, "file.erase"), 1);
});

// ---------------------------------------------------------------------------
// Delete

test("delete vault: the confirm page says what goes, offers export first, and asks for the name", async () => {
  const h = await page(`/v/${V.doomed}/config/delete`);
  assert.match(h, /<h1>Delete Admin Doomed<\/h1>/);
  assert.match(h, /for all 2 members: 1 file with every earlier version, 0 open proposals, the activity log, and 1 environment variable/);
  assert.match(h, new RegExp(`<a href="/v/${V.doomed}/config/export">Export it first</a>`));
  assert.match(h, /Type <strong>Admin Doomed<\/strong> to confirm/);
  assert.match(h, /<button class="danger">Delete this vault<\/button>/);
  assert.match(await page(`/v/${V.walt}/config/delete`), /Only owners delete a vault\./);
});

test("delete vault: a wrong name deletes nothing", async () => {
  const r = await post(`/v/${V.doomed}/config/delete`, { confirm_name: "admin doomed" });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /That isn’t the vault’s name\. Nothing was deleted\./);
  assert.ok(await vaultRow(V.doomed));
});

test("delete vault: an editor's forged post is refused by the database", async () => {
  const flash = await flashAfter(await post(`/v/${V.walt}/config/delete`, { confirm_name: "Admin Walt" }));
  assert.equal(flash, "Only owners delete a vault.");
  assert.ok(await vaultRow(V.walt));
});

test("delete vault: typing the name deletes it, its variables and its tokens' access, and lands on Home", async () => {
  const r = await post(`/v/${V.doomed}/config/delete`, { confirm_name: "Admin Doomed" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/");
  const home = await page("/");
  assert.match(home, /Deleted Admin Doomed\. Its files, history and variables are gone\./);
  assert.doesNotMatch(home, new RegExp(V.doomed));
  assert.equal(await vaultRow(V.doomed), undefined);
  const [left] = await sql(
    `select (select count(*) from public.log where vault_id = $1)::int as log,
            (select count(*) from public.variables where vault_id = $1)::int as variables,
            (select count(*) from public.file_versions where vault_id = $1)::int as versions,
            (select revoked_at is not null from public.access_tokens where name = 'Doomed only') as revoked`,
    [V.doomed],
  );
  assert.deepEqual(left, { log: 0, variables: 0, versions: 0, revoked: true });
  assert.equal((await get(`/v/${V.doomed}`)).status, 404);
  assert.equal((await get(`/v/${V.doomed}/config`)).status, 404);
});

test("vault settings: no file text, typed name or vault name in the server log", async () => {
  assert.doesNotMatch(log, /Alpha|Deep text|Doomed text|Pat, born|ADMINCT-|Admin Doomed|Admin Renamed/);
});
