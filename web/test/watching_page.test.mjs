// Watching a folder or file for flags in the web app (src/watching.ts, and
// the button on folder and file pages in src/files.ts): Watch and Unwatch
// from a page, the Watching tab of a vault's Settings, and every refusal
// said as a flash, never an error page. The database rules are
// flags_test.sql's (F410, F411); these tests are about what the web app
// offers.
//
// This file starts its own server from dist/, signed in as Wren, a person no
// other test file uses. Wren is a viewer in Ola's "Watch main" (notes/a.md,
// notes/b.md, top.md; Ola watches notes/a.md herself), "Watch cap" and
// "Watch empty": watching isn't owner-gated, so a viewer is the case that
// matters. Wren isn't in Ola's "Watch ola".

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const WREN = "00000000-0000-0000-0000-0000000009d1";
const OLA = "00000000-0000-0000-0000-0000000009d2";

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
const file = (v, path) => `/v/${v}/file?path=${encodeURIComponent(path)}`;
const tree = (v, path) => `/v/${v}/tree?path=${encodeURIComponent(path)}`;
const watching = (v) => `/v/${v}/config/watching`;
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
  return { action: /action="([^"]+)"/.exec(form)[1], fields, form };
}
// The header's actions, from the page-actions div to the end of the title row.
const actionsOf = (h) => /<div class="page-actions">([\s\S]*?)<\/div>\s*<\/div>/.exec(h)?.[1] ?? "";
const watches = async (user, v) =>
  (await sql("select target from public.subscriptions where user_id = $1 and vault_id = $2 order by target", [user, v])).map((r) => r.target);

before(async () => {
  const port = await freePort();
  s.origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/watching-page-login-${process.pid}-${port}`;
  child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: WREN, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
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

  await sql(`insert into auth.users (id, email) values ($1, 'wren@example.test'), ($2, 'ola@example.test') on conflict (id) do nothing`, [WREN, OLA]);
  [{ id: V.main }] = await as(OLA, "select public.create_vault('Watch main', 'open') as id");
  for (const f of ["notes/a.md", "notes/b.md", "top.md"]) await as(OLA, "select public.write_file($1, $2, 'Text')", [V.main, f]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.main, WREN, OLA]);
  await as(OLA, "select public.create_subscription($1, 'path', 'notes/a.md')", [V.main]);
  [{ id: V.cap }] = await as(OLA, "select public.create_vault('Watch cap', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.cap, WREN, OLA]);
  [{ id: V.empty }] = await as(OLA, "select public.create_vault('Watch empty', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.empty, WREN, OLA]);
  [{ id: V.ola }] = await as(OLA, "select public.create_vault('Watch ola', 'open') as id");
  await as(OLA, "select public.write_file($1, 'x.md', 'Text')", [V.ola]);
});

after(async () => {
  child?.kill();
});

// ---------------------------------------------------------------------------
// The button on folder and file pages

test("watch button: a viewer's file page offers Watch, for that exact path, coming back to the page", async () => {
  const h = await page(file(V.main, "notes/a.md"));
  const { action, fields } = formFields(actionsOf(h), "Watch");
  assert.equal(action, watching(V.main));
  assert.deepEqual({ ...fields, csrf: undefined }, { csrf: undefined, action: "watch", path: "notes/a.md", back: file(V.main, "notes/a.md") });
  assert.doesNotMatch(h, /class="badge info"[^>]*>Watching/, "not watched yet: Ola's watch is hers");
});

test("watch button: watching a file comes back to it saying so, and the page then shows Watching with Unwatch", async () => {
  const h0 = await page(file(V.main, "notes/a.md"));
  const { action, fields } = formFields(h0, "Watch");
  const r = await post(action, fields);
  assert.equal(r.headers.get("location"), file(V.main, "notes/a.md"));
  const h = await landed(r);
  assert.deepEqual(flashOf(h), ["success", "status", "Watching notes/a.md. From now on, changes there are flagged to your agents."]);
  assert.deepEqual(await watches(WREN, V.main), ["notes/a.md"]);
  assert.match(h, /<div class="page-title"><h1 class="path">a\.md<\/h1><span class="badge info" title="Changes here are flagged to your agents\. Only you see this\.">Watching<\/span><\/div>/);
  const { fields: un } = formFields(actionsOf(h), "Unwatch");
  assert.equal(un.action, "unwatch");
  assert.match(un.subscription, /^[0-9a-f-]{36}$/);
  assert.match(h, /<button aria-label="Unwatch notes\/a\.md">Unwatch<\/button>/);
});

test("watch button: watching the same path again says you already do, and stores no second watch", async () => {
  const token = csrfOf(await page(file(V.main, "notes/a.md")));
  const h = await landed(await post(watching(V.main), { csrf: token, action: "watch", path: "notes/a.md", back: file(V.main, "notes/a.md") }));
  assert.deepEqual(flashOf(h), ["info", "status", "You already watch notes/a.md."]);
  assert.deepEqual(await watches(WREN, V.main), ["notes/a.md"]);
});

test("watch button: a folder has Watch too; a file in a watched folder says which folder covers it and offers no second watch", async () => {
  const f = await page(tree(V.main, "notes/"));
  const { action, fields } = formFields(actionsOf(f), "Watch");
  assert.equal(fields.path, "notes/");
  assert.equal(fields.back, tree(V.main, "notes/"));
  const h = await landed(await post(action, fields));
  assert.deepEqual(flashOf(h), ["success", "status", "Watching notes/. From now on, changes there are flagged to your agents."]);
  const b = await page(file(V.main, "notes/b.md"));
  assert.match(b, /<span class="badge info" title="Your watch on notes\/ covers this\. Only you see it\.">Watching via notes\/<\/span>/);
  assert.doesNotMatch(actionsOf(b), /config\/watching/, "no Watch or Unwatch here");
  assert.deepEqual(await watches(WREN, V.main), ["notes/", "notes/a.md"]);
});

test("watch button: the vault's top folder has no Watch: a vault's root isn't a path", async () => {
  assert.doesNotMatch(await page(`/v/${V.main}`), /config\/watching/);
});

test("watch button: Unwatch stops it and comes back, saying so", async () => {
  const h0 = await page(file(V.main, "notes/a.md"));
  const { action, fields } = formFields(actionsOf(h0), "Unwatch");
  const h = await landed(await post(action, fields));
  assert.deepEqual(flashOf(h), ["success", "status", "Stopped watching notes/a.md."]);
  assert.deepEqual(await watches(WREN, V.main), ["notes/"]);
  assert.deepEqual(await watches(OLA, V.main), ["notes/a.md"], "Ola's own watch on the same file stays");
});

test("watch button: stopping a watch you don't have is a warning, not an error; someone else's is the same, and stays", async () => {
  const token = csrfOf(await page(file(V.main, "top.md")));
  const never = await landed(await post(watching(V.main), { csrf: token, action: "unwatch", subscription: randomUUID(), back: file(V.main, "top.md") }));
  assert.deepEqual(flashOf(never), ["warning", "status", "You weren’t watching that, so nothing changed. It may have been stopped already, in another tab."]);
  const [{ id: olas }] = await sql("select id from public.subscriptions where user_id = $1 and vault_id = $2", [OLA, V.main]);
  const theirs = await landed(await post(watching(V.main), { csrf: token, action: "unwatch", subscription: olas, back: file(V.main, "top.md") }));
  assert.deepEqual(flashOf(theirs), ["warning", "status", "You weren’t watching that, so nothing changed. It may have been stopped already, in another tab."]);
  assert.deepEqual(await watches(OLA, V.main), ["notes/a.md"]);
  const broken = flashOf(await landed(await post(watching(V.main), { csrf: token, action: "unwatch", subscription: "nope", back: file(V.main, "top.md") })));
  assert.equal(broken[0], "danger");
  const m = /^The form didn’t say which watch to stop, so nothing changed: reload the page and try again\. \(ref ([0-9a-f]{8})\)$/.exec(broken[2]);
  assert.ok(m, broken[2]);
  assert.match(log, new RegExp(`failure ref=${m[1]} `), "the ref is in the server log");
});

test("watch button: coming back goes only to a page of the same vault", async () => {
  const token = csrfOf(await page(file(V.main, "top.md")));
  for (const back of ["https://example.test/x", "//example.test/x", `/v/${V.cap}/config/watching`, "/settings"]) {
    const r = await post(watching(V.main), { csrf: token, action: "watch", path: "top.md", back });
    assert.equal(r.headers.get("location"), watching(V.main), back);
  }
  const [{ id }] = await sql("select id from public.subscriptions where user_id = $1 and vault_id = $2 and target = 'top.md'", [WREN, V.main]);
  await post(watching(V.main), { csrf: token, action: "unwatch", subscription: id, back: file(V.main, "top.md") });
  assert.deepEqual(await watches(WREN, V.main), ["notes/"]);
});

// ---------------------------------------------------------------------------
// The Watching tab

test("watching tab: every member has Settings, Watching, listing only their own watches in the vault, each with Unwatch", async () => {
  const h = await page(watching(V.main));
  assert.match(h, /<h1>Settings<\/h1>/);
  assert.match(h, new RegExp(`<li><a href="/v/${V.main}/config">Settings</a></li><li aria-current="page">Watching</li>`));
  assert.match(h, new RegExp(`<a href="/v/${V.main}/config/watching" aria-current="page">Watching</a>`));
  assert.match(h, /Changes there are flagged to your agents when they ask \(<code>list_flags<\/code>\)\. Only you see this list\./);
  assert.match(h, new RegExp(`<a href="${re(tree(V.main, "notes/"))}"><code>notes/</code></a><span class="token-client">Folder, and everything in it</span>`));
  assert.doesNotMatch(h, /<code>notes\/a\.md<\/code>/, "Ola's watch isn't Wren's");
  const { action, fields } = formFields(h, "Unwatch");
  assert.equal(action, watching(V.main));
  assert.deepEqual({ ...fields, csrf: undefined, subscription: undefined }, { csrf: undefined, subscription: undefined, action: "unwatch", back: watching(V.main) });
  assert.match(h, /<button class="quiet" aria-label="Unwatch notes\/">Unwatch<\/button>/);
});

test("watching tab: with nothing watched, it says how to start, and the header offers Watch a path", async () => {
  const h = await page(watching(V.empty));
  assert.match(h, /<div class="empty"><strong>You don’t watch anything here<\/strong><p>Watch a folder or file from its page, or type one below\. Changes there are flagged to your agents from then on\.<\/p><\/div>/);
  assert.match(h, /<div class="page-actions"><a class="button primary" href="#watch-path">Watch a path<\/a><\/div>/);
});

test("watching tab: a typed path is watched, existing yet or not; one the database won't take is refused in its own words, with a reference", async () => {
  const token = csrfOf(await page(watching(V.empty)));
  const h = await landed(await post(watching(V.empty), { csrf: token, action: "watch", path: " clients/ ", back: watching(V.empty) }));
  assert.deepEqual(flashOf(h), ["success", "status", "Watching clients/. From now on, changes there are flagged to your agents."]);
  assert.match(h, /<code>clients\/<\/code><\/a><span class="token-client">Folder, and everything in it<\/span>/);
  const bad = flashOf(await landed(await post(watching(V.empty), { csrf: token, action: "watch", path: "/clients/", back: watching(V.empty) })));
  assert.equal(bad[0], "danger");
  assert.match(bad[2], /^A watched path starts with \/, but paths in a vault are relative: write clients\/ rather than \/clients\/\. \(ref [0-9a-f]{8}\)$/);
  const none = flashOf(await landed(await post(watching(V.empty), { csrf: token, action: "watch", path: "", back: watching(V.empty) })));
  assert.match(none[2], /^Say which path to watch: a folder ending in \/ \(like clients\/\) or a file \(like notes\/plan\.md\)\. \(ref [0-9a-f]{8}\)$/);
  assert.deepEqual(await watches(WREN, V.empty), ["clients/"]);
});

test("watching tab: at the most paths one person can watch, the database's refusal is shown as it says it, with a reference, and nothing is added", async () => {
  const [{ n }] = await as(WREN, "select count(public.create_subscription($1, 'path', 'cap/' || g || '/'))::int as n from generate_series(1, 100) g", [V.cap]);
  assert.equal(n, 100);
  const token = csrfOf(await page(watching(V.cap)));
  const r = await post(watching(V.cap), { csrf: token, action: "watch", path: "one-more/", back: watching(V.cap) });
  assert.equal(r.status, 303, "a flash on the page, not an error page");
  const [tone, role, text] = flashOf(await landed(r));
  assert.deepEqual([tone, role], ["danger", "alert"]);
  const m = /^You watch 100 paths in this vault already, the most one person can: stop watching one first\. \(ref ([0-9a-f]{8})\)$/.exec(text);
  assert.ok(m, text);
  assert.match(log, new RegExp(`failure ref=${m[1]} `), "the ref is in the server log");
  assert.equal((await watches(WREN, V.cap)).length, 100);
  const again = flashOf(await landed(await post(watching(V.cap), { csrf: token, action: "watch", path: "cap/7/", back: watching(V.cap) })));
  assert.deepEqual(again, ["info", "status", "You already watch cap/7/."], "watching one already watched still works at the cap");
});

test("watching tab: a vault you're not in looks missing, and watching there is refused the same way", async () => {
  assert.equal((await get(watching(V.ola))).status, 404);
  const token = csrfOf(await page(watching(V.main)));
  assert.equal((await post(watching(V.ola), { csrf: token, action: "watch", path: "x.md", back: watching(V.ola) })).status, 404);
  assert.deepEqual(await watches(WREN, V.ola), []);
});

test("watching tab: a form that says neither watch nor unwatch is refused with a reference and changes nothing", async () => {
  const token = csrfOf(await page(watching(V.main)));
  const [tone, , text] = flashOf(await landed(await post(watching(V.main), { csrf: token, action: "follow", path: "top.md", back: watching(V.main) })));
  assert.equal(tone, "danger");
  assert.match(text, /^The form didn’t say whether to watch or stop watching, so nothing changed\. \(ref [0-9a-f]{8}\)$/);
  assert.deepEqual(await watches(WREN, V.main), ["notes/"]);
});
