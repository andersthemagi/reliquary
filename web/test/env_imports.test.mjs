// Importing .env files (docs/variables.md, "Imports"), over HTTP: the
// Variables page's paste, preview and apply, and pushes from the CLI through
// the env API, reviewed and applied in the web UI.
//
// This file starts its own servers from dist/, signed in as Ruth (and one as
// Sam), people no other test file uses. Ruth owns "Imp Own" (Sam edits it)
// and "Imp Push"; Sam owns "Imp Sam", which Ruth isn't in. Every value holds
// IMPVAL-; none may reach a page, a URL, an API answer or a server log.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

// An env API error (failure.ts): its code, and the reason, component and
// reference beside it.
const assertApiError = (body, code) => {
  assert.equal(body.error, code);
  assert.equal(typeof body.message, "string");
  assert.equal(typeof body.where, "string");
  assert.match(body.ref, /^[0-9a-f]{8}$/);
};

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const RUTH = "00000000-0000-0000-0000-0000000000f7";
const SAM = "00000000-0000-0000-0000-0000000000f8";
const KEY = randomBytes(32).toString("base64url");

const secrets = [];
const value = (label) => {
  const v = `IMPVAL-${label}-${randomBytes(6).toString("hex")}`;
  secrets.push(v);
  return v;
};

let vars;
let log = "";
const servers = [];
const ruth = { origin: "", cookie: "" };
const sam = { origin: "", cookie: "" };
const V = {};

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
  const loginFile = `/tmp/env-imports-login-${process.pid}-${port}`;
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

async function as(who, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    if (who.role) {
      await db.query(`set local role ${who.role}`);
    } else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.user, role: "authenticated" })]);
    }
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

const get = (path, s = ruth) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (path, s = ruth) => (await get(path, s)).text();
const csrfOf = async (s = ruth) => /name="csrf" value="([0-9a-f]+)"/.exec(await page("/", s))[1];
// Form posts; `fields` may repeat a name (an array of pairs).
const post = async (path, fields, { s = ruth, csrf = true, headers = {} } = {}) => {
  const body = new URLSearchParams(Array.isArray(fields) ? fields : Object.entries(fields));
  if (csrf) body.append("csrf", await csrfOf(s));
  return fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin, ...headers },
    body: body.toString(),
  });
};
const vp = (vault, rest = "") => `/v/${vault}/variables${rest}`;
const noValues = (h) => {
  for (const s of secrets) assert.equal(h.includes(s), false, "a value is on the page");
  assert.doesNotMatch(h, /IMPVAL-/);
};
const importOf = (location) => /\/imports\/([0-9a-f-]{36})$/.exec(location)[1];

// A CLI sign-in made in the database as consent and the token endpoint make
// it, with or without the push permission.
async function cliToken(user, origin, push) {
  const sha = (s) => createHash("sha256").update(s).digest("hex");
  const resource = `${origin}/api/env`;
  const client = `${origin}/cli/oauth-client.json`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  const redirect = "http://127.0.0.1:53682/callback";
  const [{ code }] = await as({ user }, "select public.create_cli_grant($1, $2, $3, $4, null, $5) as code", [client, redirect, resource, challenge, push]);
  const access = `rle_${randomBytes(32).toString("hex")}`;
  const refresh = `rlr_${randomBytes(32).toString("hex")}`;
  secrets.push(access, refresh, code);
  const [{ r }] = await as({ role: "reliquary_web" }, "select private.oauth_redeem_code($1, $2, $3, $4, $5, $6, $7) as r", [
    sha(code), client, redirect, resource, verifier, sha(access), sha(refresh),
  ]);
  assert.equal(r, "ok");
  return access;
}

const api = (path, token, init = {}) =>
  fetch(`${ruth.origin}/api/env${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
const pushTo = (vault, env, token, body, headers = { "content-type": "application/json" }) =>
  api(`/${vault}/${env}/imports`, token, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

before(async () => {
  process.env.DATABASE_URL = WEB_DB;
  const crypto = await import("../dist/secrets.js");
  vars = await import("../dist/variables.js");
  crypto.configureVariables({ VARIABLES_KEY: KEY });
  await startServer(ruth, RUTH);
  await startServer(sam, SAM);

  [{ id: V.own }] = await as({ user: RUTH }, "select public.create_vault('Imp Own') as id");
  [{ id: V.push }] = await as({ user: RUTH }, "select public.create_vault('Imp Push') as id");
  [{ id: V.sam }] = await as({ user: SAM }, "select public.create_vault('Imp Sam') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.own, SAM, RUTH]);
  await vars.setVariable(RUTH, V.own, "API_KEY", "development", value("existing"));
});

after(async () => {
  for (const s of servers) s.kill();
  const { pool } = await import("../dist/db.js");
  await pool.end();
});

// ---------------------------------------------------------------------------
// Paste, preview, apply

const pasted = {};
function pastedFile() {
  pasted.api = value("api");
  pasted.db = `postgres://u:${value("db")}@h/db?sslmode=require&x=1`;
  pasted.pem = `-----BEGIN KEY-----\n${value("pem")}\nline "two"\n-----END KEY-----`;
  pasted.single = `raw \\n ${value("single")}`;
  pasted.path = value("path");
  pasted.dup = value("dup");
  pasted.bad = value("bad");
  return [
    "\uFEFF# Team settings",
    `export API_KEY=${pasted.api} # rotated monthly`,
    `DATABASE_URL="${pasted.db}"`,
    `TLS_KEY="${pasted.pem.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`,
    `SINGLE='${pasted.single}'`,
    `PATH=${pasted.path}`,
    `MY-KEY=${pasted.bad}`,
    `DUP=${value("dup-first")}`,
    `DUP=${pasted.dup}`,
    "EMPTY=",
  ].join("\r\n");
}

test("env import: owners and editors get Import .env on the Variables page; the form offers the environments their role may set", async () => {
  const h = await page(vp(V.own));
  assert.match(h, new RegExp(`<a class="button" href="${vp(V.own, "/import")}">Import .env</a>`));
  const f = await page(vp(V.own, "/import"));
  assert.match(f, /<textarea id="ie" name="dotenv" class="secret-input"[^>]*autocomplete="off"[^>]*spellcheck="false"/);
  assert.match(f, /name="environment" value="development" checked> development/);
  assert.match(f, /name="environment" value="production"> production/);
  const e = await page(vp(V.own, "/import"), sam);
  assert.match(e, /name="environment" value="preview"> preview/);
  assert.doesNotMatch(e, /value="production"/);
  assert.match(e, /Only owners set values in production\./);
});

test("env import: a paste shows a preview naming each variable as new or replacing a value, with the lines not taken, and never a value", async () => {
  const r = await post(vp(V.own, "/import"), [["dotenv", pastedFile()], ["environment", "development"], ["environment", "preview"]]);
  assert.equal(r.status, 303);
  const location = r.headers.get("location");
  assert.match(location, new RegExp(`^${vp(V.own, "/imports/")}[0-9a-f-]{36}$`));
  noValues(location);
  pasted.id = importOf(location);
  const h = await page(location);
  noValues(h);
  assert.match(h, /<h1>Review an import you pasted<\/h1>/);
  assert.match(h, /5 variables for development, preview: 4 new names, 1 replacing a value\. Values aren’t shown here\./);
  assert.match(h, /<th>development<\/th><th>preview<\/th>/);
  assert.match(h, /<code>API_KEY<\/code><\/th><td data-label="development"><div><span class="badge attention">Replaces a value<\/span><\/div>/);
  for (const n of ["DATABASE_URL", "DUP", "SINGLE", "TLS_KEY"]) assert.match(h, new RegExp(`<code>${n}</code>`));
  assert.match(h, /<li>Line 6, <code>PATH<\/code>: changes how programs start, so it can&#39;t be a shared variable<\/li>/);
  assert.match(h, /<li>Line 7: the name isn&#39;t letters, digits and underscores/);
  assert.match(h, /<li>Line 8, <code>DUP<\/code>: given again on line 9, which is used<\/li>/);
  assert.match(h, /<li>Line 10, <code>EMPTY<\/code>: no value<\/li>/);
  assert.match(h, /<button class="primary">Apply: set 5 variables<\/button>/);
  assert.match(h, /<button class="danger">Discard<\/button>/);
  // Nothing is set yet.
  const names = (await vars.listVariables(RUTH, V.own)).variables.map((x) => x.name);
  assert.deepEqual(names, ["API_KEY"]);
});

test("env import: the confirm step needs the session's CSRF token and this origin", async () => {
  const path = vp(V.own, `/imports/${pasted.id}/apply`);
  assert.equal((await post(path, {}, { csrf: false })).status, 403);
  assert.equal((await post(path, {}, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await get(path)).status, 404);
  const [{ status }] = await sql("select status from public.env_imports where id = $1", [pasted.id]);
  assert.equal(status, "pending");
});

test("env import: applying sets every value in every environment, exactly as pasted, one log row per variable and environment", async () => {
  const r = await post(vp(V.own, `/imports/${pasted.id}/apply`), {});
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), vp(V.own));
  const h = await page(vp(V.own));
  assert.match(h, /Set 5 variables in development, preview\./);
  noValues(h);
  const want = { API_KEY: pasted.api, DATABASE_URL: pasted.db, TLS_KEY: pasted.pem, SINGLE: pasted.single, DUP: pasted.dup };
  for (const env of ["development", "preview"]) {
    for (const [name, v] of Object.entries(want)) {
      const got = await vars.revealVariable(RUTH, V.own, name, env);
      assert.equal(got.ok, true, `${name} in ${env}`);
      assert.equal(got.value, v, `${name} in ${env}`);
    }
  }
  const rows = await sql(
    "select action, environment, names from public.env_access_log where vault_id = $1 and detail ->> 'import' = $2 order by seq",
    [V.own, pasted.id],
  );
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.filter((x) => x.names[0] === "API_KEY").map((x) => `${x.action}/${x.environment}`), ["rotate/development", "set/preview"]);
  assert.equal((await sql("select count(*)::int as n from private.env_import_secrets where import_id = $1", [pasted.id]))[0].n, 0);
  // Applying again says so.
  const again = await post(vp(V.own, `/imports/${pasted.id}/apply`), {});
  assert.equal(again.headers.get("location"), vp(V.own, `/imports/${pasted.id}`));
  const after = await page(again.headers.get("location"));
  assert.match(after, /This import was already applied\./);
  assert.match(after, /This import was applied\./);
  assert.doesNotMatch(after, /Apply: set/);
});

test("env import: nothing importable re-renders the form with the reasons, without the pasted text", async () => {
  const secret = value("junk");
  const r = await post(vp(V.own, "/import"), [["dotenv", `PATH=${secret}\njust some text ${secret}\nB="never closed ${secret}`], ["environment", "development"]]);
  assert.equal(r.status, 400);
  const h = await r.text();
  noValues(h);
  assert.match(h, /Nothing in it could be imported\./);
  assert.match(h, /Line 1, <code>PATH<\/code>: changes how programs start/);
  assert.match(h, /Line 2: not NAME=value \(no = sign\)/);
  assert.match(h, /Line 3, <code>B<\/code>: the double quote opened here is never closed/);
  assert.match(h, /spellcheck="false" placeholder="[^"]*"><\/textarea>/);
});

test("env import: no environment, an empty paste and one over 512 KiB are refused", async () => {
  const none = await post(vp(V.own, "/import"), [["dotenv", `A=${value("x")}`]]);
  assert.equal(none.status, 400);
  assert.match(await none.text(), /Tick at least one environment\./);
  const empty = await post(vp(V.own, "/import"), [["dotenv", "  \n"], ["environment", "development"]]);
  assert.match(await empty.text(), /Paste the contents of a \.env file\./);
  const big = await post(vp(V.own, "/import"), [["dotenv", `A=${"x".repeat(600 * 1024)}`], ["environment", "development"]]);
  assert.equal(big.status, 413);
  assert.match(await big.text(), /over 512 KiB/);
});

test("env import: an editor can't import into production, even by posting it", async () => {
  const v = value("ed-prod");
  const r = await post(vp(V.own, "/import"), [["dotenv", `ED_PROD=${v}`], ["environment", "production"]], { s: sam });
  assert.equal(r.status, 403);
  const h = await r.text();
  noValues(h);
  assert.match(h, /Your role can’t set values in every environment you ticked\./);
  assert.equal((await sql("select count(*)::int as n from public.env_imports where vault_id = $1 and 'ED_PROD' = any(names)", [V.own]))[0].n, 0);
});

// The server's log line for a reference a page showed (failure.ts), once the
// server has had a moment to write it.
async function failureLine(text, where) {
  const ref = /\(ref ([0-9a-f]{8})\)/.exec(text)?.[1];
  assert.ok(ref, "the page shows a reference");
  const start = `failure ref=${ref} `;
  for (let i = 0; i < 20 && !log.includes(start); i++) await new Promise((r) => setTimeout(r, 100));
  const line = log.split("\n").find((l) => l.startsWith(start));
  assert.ok(line, `ref ${ref} is in the server log`);
  assert.ok(line.includes(`"where":"${where}"`), line);
  noValues(line);
  return line;
}

test("env import: a refused import says why with a reference whose log line says where it broke", async () => {
  const r = await post(vp(V.own, "/import"), [["dotenv", `ED_PROD_REF=${value("ed-prod-ref")}`], ["environment", "production"]], { s: sam });
  assert.equal(r.status, 403);
  const line = await failureLine(await r.text(), "database (function public.create_env_import)");
  assert.match(line, /"status":403/);
});

test("env import: a refused apply says why with a reference whose log line says where it broke", async () => {
  const pushed = await pushTo(V.own, "production", await cliToken(RUTH, ruth.origin, true), { variables: { PROD_ONLY: value("prod-only") } });
  assert.equal(pushed.status, 201);
  const id = (await pushed.json()).import;
  const r = await post(vp(V.own, `/imports/${id}/apply`), {}, { s: sam });
  assert.equal(r.status, 303);
  const h = await page(r.headers.get("location"), sam);
  assert.match(h, /<p class="callout danger flash" role="alert">Your role can’t set values in every environment of this import\. \(ref [0-9a-f]{8}\)<\/p>/);
  await failureLine(h, "database (function public.apply_env_import)");
  assert.equal((await post(vp(V.own, `/imports/${id}/reject`), {})).status, 303, "an owner rejects it, so nothing is left waiting");
});

test("env import: a draft is its author's: another member of the vault gets not found, and can't apply it", async () => {
  const r = await post(vp(V.own, "/import"), [["dotenv", `MINE=${value("mine")}`], ["environment", "development"]]);
  const id = importOf(r.headers.get("location"));
  assert.equal((await get(vp(V.own, `/imports/${id}`), sam)).status, 404);
  assert.equal((await post(vp(V.own, `/imports/${id}/apply`), {}, { s: sam })).status, 404);
  // Discard: the values go, and the page says so.
  const d = await post(vp(V.own, `/imports/${id}/reject`), {});
  assert.equal(d.status, 303);
  assert.match(await page(vp(V.own)), /The import is discarded; its values are gone\./);
  assert.match(await page(vp(V.own, `/imports/${id}`)), /This import was rejected or discarded; its values are gone\./);
  assert.equal((await sql("select count(*)::int as n from private.env_import_secrets where import_id = $1", [id]))[0].n, 0);
  assert.equal((await vars.listVariables(RUTH, V.own)).variables.some((x) => x.name === "MINE"), false);
});

test("env import: a vault you're not in is not found", async () => {
  assert.equal((await get(vp(V.sam, "/import"))).status, 404);
  assert.equal((await post(vp(V.sam, "/import"), [["dotenv", `X=${value("x")}`], ["environment", "development"]])).status, 404);
});

// ---------------------------------------------------------------------------
// Pushes from the CLI (the env API)

test("env push: a CLI sign-in allowed to push makes a pending import: names, what it replaces and where to approve it, no value", async () => {
  const token = await cliToken(RUTH, ruth.origin, true);
  await vars.setVariable(RUTH, V.push, "OLD_KEY", "development", value("old"));
  pasted.push1 = value("push1");
  pasted.push2 = `multi\nline ${value("push2")}`;
  const r = await pushTo(V.push, "development", token, {
    variables: { NEW_KEY: pasted.push1, OLD_KEY: pasted.push2 },
    refused: [{ line: 4, name: "PATH", reason: "changes how programs start, so it can't be a shared variable" }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get("cache-control"), "no-store, private");
  const text = await r.text();
  noValues(text);
  const b = JSON.parse(text);
  assert.equal(b.status, "pending");
  assert.deepEqual(b.names, ["NEW_KEY", "OLD_KEY"]);
  assert.deepEqual(b.overwrites, ["OLD_KEY"]);
  assert.equal(b.url, `${ruth.origin}/v/${V.push}/variables/imports/${b.import}`);
  pasted.pushId = b.import;
  const s = await api(`/imports/${b.import}`, token);
  assert.equal(s.status, 200);
  assert.equal((await s.json()).status, "pending");
  // Nothing is set.
  assert.deepEqual((await vars.revealVariable(RUTH, V.push, "NEW_KEY", "development")).error, "not_found");
});

test("env push: it waits on the Variables page and in Review, and the review page warns that an agent may have sent it", async () => {
  const h = await page(vp(V.push));
  assert.match(h, /An import from the CLI is waiting to be applied/);
  assert.match(h, new RegExp(`href="${vp(V.push, `/imports/${pasted.pushId}`)}">2 variables for development</a>`));
  const rv = await page("/inbox");
  assert.match(rv, /An import from the CLI is waiting to be applied/);
  assert.match(rv, /Imp Push · from you via the CLI/);
  assert.doesNotMatch(rv, /Nothing is waiting on you/);
  const p = await page(vp(V.push, `/imports/${pasted.pushId}`));
  noValues(p);
  assert.match(p, /<h1>Review an import from the CLI<\/h1>/);
  assert.match(p, /Sent by you with the Reliquary CLI/);
  assert.match(p, /an agent may have run it\. Check the names before you apply\./);
  assert.match(p, /<li>Line 4, <code>PATH<\/code>: changes how programs start/);
  assert.match(p, /<button class="danger">Reject<\/button>/);
});

test("env import tab: the Imports tab counts and lists imports from the CLI waiting, with who sent them, when they expire and Review", async () => {
  const h = await page(vp(V.push, "/imports"));
  noValues(h);
  assert.match(h, new RegExp(`<a href="${vp(V.push, "/imports")}" aria-current="page">Imports<span class="count">1</span></a>`));
  const rows = /<tbody>[\s\S]*?<\/tbody>/.exec(h)[0];
  assert.match(rows, new RegExp(`<a href="${vp(V.push, `/imports/${pasted.pushId}`)}">2 variables for development</a>`));
  assert.match(rows, /data-label="From">you <span class="muted">· CLI<\/span>/);
  assert.match(rows, /data-label="Expires"><time datetime="[^"]+" title="[^"]+ UTC">in \d+ h<\/time>/);
  assert.match(rows, />Review<\/a>/);
  // The count is on every tab of the vault's Variables.
  assert.match(await page(vp(V.push, "/log")), /Imports<span class="count">1<\/span>/);
});

test("env import review: Apply and Reject sit in the page header, above the list, and again under a long one", async () => {
  const p = await page(vp(V.push, `/imports/${pasted.pushId}`));
  assert.match(p, /<div class="page-actions"><span class="import-decide">[\s\S]*?<button class="danger">Reject<\/button>[\s\S]*?<button class="primary">Apply: set 2 variables<\/button>/);
  assert.ok(p.indexOf("Apply: set 2 variables") < p.indexOf("<table"), "Apply is above the list");
  assert.equal(p.split("Apply: set 2 variables").length - 1, 1, "a short import has one Apply");
  const long = Array.from({ length: 13 }, (_, i) => `LONG_${i}=${value(`long-${i}`)}`).join("\n");
  const r = await post(vp(V.own, "/import"), [["dotenv", long], ["environment", "development"]]);
  const id = importOf(r.headers.get("location"));
  const l = await page(vp(V.own, `/imports/${id}`));
  noValues(l);
  assert.equal(l.split('<button class="primary">Apply: set 13 variables</button>').length - 1, 2);
  assert.equal(l.split('<button class="danger">Discard</button>').length - 1, 2);
  assert.equal((await post(vp(V.own, `/imports/${id}/reject`), {})).status, 303);
});

test("env import words: the pages call a .env brought in at once an import, pasted or from the CLI, never a push or a draft", async () => {
  // The words people read: no markup, no command names, not the vault's own name.
  const words = (h) => h.replace(/<code>[^<]*<\/code>/g, "").replace(/<[^>]*>/g, " ").replaceAll("Imp Push", "");
  const main = (h) => words(/<main id="main">[\s\S]*<\/main>/.exec(h)[0]);
  for (const path of [vp(V.push), vp(V.push, "/imports"), vp(V.push, `/imports/${pasted.pushId}`), vp(V.push, "/log"), vp(V.own, "/import")]) {
    assert.doesNotMatch(main(await page(path)), /\bpush(es|ed)?\b|\bdrafts?\b/i, path);
  }
  const inbox = /<section class="callout attention pending-imports"[\s\S]*?<\/section>/.exec(await page("/inbox"))[0];
  assert.doesNotMatch(words(inbox), /\bpush(es|ed)?\b|\bdrafts?\b/i);
});

test("env push: a person applies it in the web UI; the CLI sees it applied, and the values decrypt as sent", async () => {
  const r = await post(vp(V.push, `/imports/${pasted.pushId}/apply`), {});
  assert.equal(r.status, 303);
  assert.equal((await vars.revealVariable(RUTH, V.push, "NEW_KEY", "development")).value, pasted.push1);
  assert.equal((await vars.revealVariable(RUTH, V.push, "OLD_KEY", "development")).value, pasted.push2);
  const token = await cliToken(RUTH, ruth.origin, false);
  const s = await (await api(`/imports/${pasted.pushId}`, token)).json();
  assert.equal(s.status, "applied");
  assert.doesNotMatch(await page(vp(V.push)), /waiting to be applied/);
});

test("env push: refused without the push permission, for an editor's production, for a vault outside the sign-in, and for bad input", async () => {
  const nopush = await cliToken(RUTH, ruth.origin, false);
  const r1 = await pushTo(V.push, "development", nopush, { variables: { A: value("a") } });
  assert.equal(r1.status, 403);
  assertApiError(await r1.json(), "push_not_allowed");

  const samToken = await cliToken(SAM, ruth.origin, true);
  const r2 = await pushTo(V.own, "production", samToken, { variables: { A: value("a") } });
  assert.equal(r2.status, 403);
  assertApiError(await r2.json(), "forbidden");
  assert.equal((await pushTo(V.own, "development", samToken, { variables: { SAM_DEV: value("sd") } })).status, 201);

  const token = await cliToken(RUTH, ruth.origin, true);
  assert.equal((await pushTo(V.sam, "development", token, { variables: { A: value("a") } })).status, 404);
  assert.equal((await pushTo(V.push, "staging", token, { variables: { A: value("a") } })).status, 404);
  for (const body of [{ variables: { PATH: value("p") } }, { variables: { "BAD-NAME": value("b") } }, { variables: {} }, { variables: { A: "" } }, { variables: { A: 1 } }, [], "not json"]) {
    const r = await pushTo(V.push, "development", token, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    const t = await r.text();
    noValues(t);
    assertApiError(JSON.parse(t), "invalid_request");
  }
  assert.equal((await pushTo(V.push, "development", token, "A=1", { "content-type": "text/plain" })).status, 415);
  const big = await pushTo(V.push, "development", token, { variables: { A: "x".repeat(1100 * 1024) } });
  assert.equal(big.status, 413);
  assert.equal((await api(`/${V.push}/development/imports`, token)).status, 405);
  assert.equal((await api(`/${V.push}/development/imports`, "nope", { method: "POST" })).status, 401);
});

test("env push: the status of a push is its author's alone", async () => {
  const samToken = await cliToken(SAM, ruth.origin, true);
  assert.equal((await api(`/imports/${pasted.pushId}`, samToken)).status, 404);
  assert.equal((await api(`/imports/not-a-uuid`, samToken)).status, 404);
});

// ---------------------------------------------------------------------------

test("env import: no value, key or token reaches the server log", async () => {
  await new Promise((r) => setTimeout(r, 200));
  assert.match(log, /POST \/v\/[0-9a-f-]+\/variables\/import 303/);
  assert.match(log, /POST \/api\/env\/:vault\/:environment\/imports 201 pending/);
  for (const s of secrets) assert.equal(log.includes(s), false, "a secret reached the log");
  assert.equal(log.includes(KEY), false, "the key reached the log");
  assert.doesNotMatch(log, /IMPVAL|rl[ecor]_[0-9a-f]{8}|dotenv=/);
});
