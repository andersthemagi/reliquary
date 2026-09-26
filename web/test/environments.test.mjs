// Custom environments in the web UI (docs/variables.md, "Environments"):
// the Environments page of src/variablespage.ts over src/variables.ts,
// driven over HTTP. The database's rules are in
// supabase/tests/variables_keys_test.sql.
//
// This file starts its own servers from dist/, signed in as Rhea (an owner)
// and Sol (her editor), people no other test file uses, with their own
// vault. Every value holds ENVVAL-; none may reach a page, a URL or a
// server log.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const RHEA = "00000000-0000-0000-0000-0000000000c2";
const SOL = "00000000-0000-0000-0000-0000000000c3";
const KEY = randomBytes(32).toString("base64url");

const secrets = [];
const value = (label) => {
  const v = `ENVVAL-${label}-${randomBytes(6).toString("hex")}`;
  secrets.push(v);
  return v;
};

let vars;
let log = "";
const servers = [];
const owner = { origin: "", cookie: "" };
const editor = { origin: "", cookie: "" };
let vault = "";
const vals = {};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function startServer(into, user) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/environments-login-${process.pid}-${port}`;
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env,
      DATABASE_URL: WEB_DB,
      LOCAL_USER_ID: user,
      LOGIN_FILE: loginFile,
      HOST: "127.0.0.1",
      PORT: String(port),
      MCP_RESOURCE: "https://mcp.reliquary.test/mcp",
      PUBLIC_URL: "",
      VARIABLES_KEY: KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  servers.push(child);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  into.origin = origin;
  into.cookie = r.headers.get("set-cookie").split(";")[0];
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

const get = (path, s = owner) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (path, s = owner) => (await get(path, s)).text();
const csrfOf = async (s = owner) => /name="csrf" value="([0-9a-f]+)"/.exec(await page("/", s))[1];
const post = async (path, fields, { s = owner, csrf = true } = {}) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin },
    body: new URLSearchParams({ ...(csrf ? { csrf: await csrfOf(s) } : {}), ...fields }).toString(),
  });
const vp = (rest = "") => `/v/${vault}/variables${rest}`;
const envs = async () =>
  (await sql("select name, owners_only from public.environments where vault_id = $1 order by name", [vault]))
    .map((r) => `${r.name}${r.owners_only ? "*" : ""}`)
    .join(",");
const noValues = (h) => {
  for (const s of secrets) assert.equal(h.includes(s), false, "a value is on the page");
  assert.doesNotMatch(h, /ENVVAL-/);
};

before(async () => {
  process.env.DATABASE_URL = WEB_DB;
  const crypto = await import("../dist/secrets.js");
  vars = await import("../dist/variables.js");
  crypto.configureVariables({ VARIABLES_KEY: KEY });
  await startServer(owner, RHEA);
  await startServer(editor, SOL);
  [{ id: vault }] = await as(RHEA, "select public.create_vault('Env Admin') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [vault, SOL, RHEA]);
  vals.dev = value("dev");
  await vars.setVariable(RHEA, vault, "API_KEY", "development", vals.dev);
});

after(async () => {
  for (const s of servers) s.kill();
  const { pool } = await import("../dist/db.js");
  await pool.end();
});

test("environments page: owners get Environments on the Variables page; editors don't, and are refused the page", async () => {
  assert.match(await page(vp()), new RegExp(`href="${vp("/environments")}"`));
  assert.doesNotMatch(await page(vp(), editor), /\/environments"/);
  const r = await get(vp("/environments"), editor);
  assert.equal(r.status, 403);
  assert.match(await r.text(), /Only owners manage a vault’s environments/);
  const h = await page(vp("/environments"));
  assert.match(h, /<strong>development<\/strong> <span class="badge">Default<\/span><\/th>\s*<td data-label="Values">1 value<\/td>/);
  assert.match(h, /<strong>production<\/strong> <span class="badge">Default<\/span><\/th>[\s\S]*?<td data-label="Who can set"><span class="badge var-owners" title="Only owners set, reveal or read values here">Owners only<\/span><\/td>/);
  assert.doesNotMatch(h, /environments\/rename\?name=development/);
});

test("environments page: an owner adds one, owners-only or not; it becomes a column on Variables where values can be set", async () => {
  let r = await post(vp("/environments"), { name: "staging" });
  assert.equal(r.status, 303);
  r = await post(vp("/environments"), { name: "audit", owners_only: "1" });
  assert.equal(r.status, 303);
  assert.equal(await envs(), "audit*,development,preview,production*,staging");
  const cols = /<thead>[\s\S]*?<\/thead>/.exec(await page(vp()))[0];
  assert.match(cols, /<span class="var-env">staging<\/span><\/th>/);
  assert.match(cols, /<span class="var-env">audit<\/span> <span class="badge var-owners"[^>]*>Owners only<\/span><\/th>/);
  vals.stage = value("stage");
  r = await post(vp("/set"), { name: "STAGE_KEY", environment: "staging", value: vals.stage });
  assert.equal(r.status, 303);
  // Sol, an editor, may set staging but not the owners-only audit.
  const form = await page(vp("/set"), editor);
  assert.match(form, /<input type="radio" name="environment" value="staging" required> staging/);
  assert.match(form, /<input type="radio" name="environment" value="audit" disabled> audit/);
  r = await post(vp("/set"), { name: "SOL_KEY", environment: "audit", value: value("sol") }, { s: editor });
  assert.equal(r.status, 403);
});

test("environments page: a bad, taken or default name is refused with the database's reason, and nothing is added", async () => {
  const before = await envs();
  for (const [name, want] of [["Bad Name", /An environment name is lowercase letters/], ["staging", /There is already an environment named staging/], ["production", /There is already an environment named production/]]) {
    const r = await post(vp("/environments"), { name });
    assert.equal(r.status, 400);
    assert.match(await r.text(), want);
  }
  const r = await post(vp("/environments"), { name: "sneaky" }, { s: editor });
  assert.equal(r.status, 403);
  const noCsrf = await post(vp("/environments"), { name: "nocsrf" }, { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal(await envs(), before);
});

test("environments page: rename moves its values, which reveal under the new name; the defaults can't be renamed", async () => {
  assert.match(await page(vp("/environments/rename?name=staging")), /Its 1 value moves with it/);
  let r = await post(vp("/environments/rename"), { from: "staging", to: "qa" });
  assert.equal(r.status, 303);
  assert.equal(await envs(), "audit*,development,preview,production*,qa");
  const reveal = await post(vp("/reveal"), { name: "STAGE_KEY", environment: "qa" });
  assert.equal(reveal.status, 200);
  assert.ok((await reveal.text()).includes(vals.stage));
  r = await post(vp("/environments/rename"), { from: "production", to: "prod" });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /default environments \(development, preview, production\) keep their names/);
  r = await post(vp("/environments/rename"), { from: "qa", to: "q" }, { s: editor });
  assert.equal(r.status, 403);
  assert.equal(await envs(), "audit*,development,preview,production*,qa");
});

test("environments page: delete asks for the name typed; a wrong name deletes nothing, the right one destroys its values", async () => {
  const confirm = await page(vp("/environments/delete?name=qa"));
  assert.match(confirm, /This destroys the 1 value in <strong>qa<\/strong> \(<code>STAGE_KEY<\/code>\)/);
  assert.match(confirm, /Type <strong>qa<\/strong> to confirm/);
  let r = await post(vp("/environments/delete"), { name: "qa", confirm_name: "q" });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /That isn’t the environment’s name\. Nothing was deleted\./);
  assert.match(await envs(), /qa/);
  r = await post(vp("/environments/delete"), { name: "qa", confirm_name: "qa" }, { s: editor });
  assert.equal(r.status, 403);
  r = await post(vp("/environments/delete"), { name: "qa", confirm_name: "qa" });
  assert.equal(r.status, 303);
  assert.equal(await envs(), "audit*,development,preview,production*");
  assert.equal((await sql("select count(*)::int as n from public.variables where vault_id = $1 and name = 'STAGE_KEY'", [vault]))[0].n, 0);
});

test("environments page: a default holding values offers no Delete, and is refused if asked; an empty one can go", async () => {
  const h = await page(vp("/environments"));
  assert.doesNotMatch(h, /environments\/delete\?name=development/);
  assert.match(h, /environments\/delete\?name=preview/);
  let r = await post(vp("/environments/delete"), { name: "development", confirm_name: "development" });
  assert.equal(r.status, 400);
  assert.match(await r.text(), /Development still holds values; a default environment is deleted only when empty/);
  r = await post(vp("/environments/delete"), { name: "preview", confirm_name: "preview" });
  assert.equal(r.status, 303);
  assert.equal(await envs(), "audit*,development,production*");
});

test("environments page: the access log shows each change, and no value reached a page, URL or the server log", async () => {
  const h = await page(vp("/log"));
  assert.match(h, /Environment added/);
  assert.match(h, /Environment renamed <span class="muted">from staging<\/span>/);
  assert.match(h, /Environment deleted <span class="muted">1 value destroyed<\/span>/);
  noValues(h);
  noValues(await page(vp("/environments")));
  noValues(log);
});
