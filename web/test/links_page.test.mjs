// The Links page (docs/design.md, "Links"): src/linkspage.ts driven over
// HTTP. Add, edit and delete are owners' only, in person, matching
// 20260928120000_links.sql's own hostile tests (supabase/tests/links_test.sql)
// for the database side; this file proves the web UI on top of it: the form,
// the credential never appearing on a page once saved, the edit and delete
// confirm flows, and that a server with no VARIABLES_KEY still lists links
// but can't add one.
//
// This file starts its own servers from dist/, signed in as Lu, a person no
// other test file uses. Lu owns "Links Own" and "Links Empty"; Mo is an
// editor there. Every credential holds LINKVAL-; none may reach a page or a
// server log.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const LU = "00000000-0000-0000-0000-000000000ba1";
const MO = "00000000-0000-0000-0000-000000000ba2";
const KEY = randomBytes(32).toString("base64url");

const secrets = [];
const credential = (label) => {
  const v = `LINKVAL-${label}-${randomBytes(6).toString("hex")}`;
  secrets.push(v);
  return v;
};

let log = "";
const servers = [];
const main = { origin: "", cookie: "" }; // signed in as Lu (owner)
const bare = { origin: "", cookie: "" }; // signed in as Lu, no VARIABLES_KEY
const moss = { origin: "", cookie: "" }; // signed in as Mo (editor)
const disco = { origin: "", cookie: "" }; // signed in as Lu, LINK_DISCOVERY_ALLOW_LOOPBACK=1
const V = {};

// A minimal, standards-shaped MCP fixture for the one server that discovers
// against something real (web/test/discovery.test.mjs is where the
// handshake itself, paging and failure modes are exercised in depth).
let mcpFixture;
let mcpBase = "";
function mcpRpc(id, result) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
async function startMcpFixture() {
  mcpFixture = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.method === "initialize") {
      res.writeHead(200, { "content-type": "application/json" }).end(mcpRpc(body.id, { protocolVersion: body.params.protocolVersion, capabilities: {} }));
    } else if (body.method === "notifications/initialized") {
      res.writeHead(202).end();
    } else if (body.method === "tools/list") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        mcpRpc(body.id, { tools: [{ name: "list_issues", annotations: { readOnlyHint: true } }, { name: "create_issue" }] }),
      );
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => mcpFixture.listen(0, "127.0.0.1", r));
  mcpBase = `https://127.0.0.1:${mcpFixture.address().port}/mcp`; // plain http under the hood: LINK_DISCOVERY_ALLOW_LOOPBACK's own carve-out
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function startServer(into, user, extra) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/links-page-login-${process.pid}-${port}`;
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "", ...extra },
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

const get = (path, s = main) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (path, s = main) => (await get(path, s)).text();
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
const post = async (path, fields, { s = main, csrf } = {}) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin },
    body: new URLSearchParams({ ...(csrf ? { csrf } : {}), ...fields }).toString(),
  });
const lp = (vault, rest = "") => `/v/${vault}/links${rest}`;
const landed = async (r, s = main) => {
  assert.equal(r.status, 303);
  return page(r.headers.get("location"), s);
};
const flashOf = (h) => /<p class="callout (\w+) flash" role="(\w+)">([\s\S]*?)<\/p>/.exec(h)?.slice(1);
const noCredentials = (h) => {
  for (const v of secrets) assert.equal(h.includes(v), false, "a credential is on the page");
  assert.doesNotMatch(h, /LINKVAL-/);
};
const linkRow = async (v, name) => (await sql("select id, name, url from public.links where vault_id = $1 and name = $2", [v, name]))[0];

before(async () => {
  process.env.DATABASE_URL = WEB_DB;
  const crypto = await import("../dist/secrets.js");
  crypto.configureVariables({ VARIABLES_KEY: KEY });
  await startMcpFixture();
  await startServer(main, LU, { VARIABLES_KEY: KEY });
  await startServer(bare, LU, { VARIABLES_KEY: "" });
  await startServer(moss, MO, { VARIABLES_KEY: KEY });
  await startServer(disco, LU, { VARIABLES_KEY: KEY, LINK_DISCOVERY_ALLOW_LOOPBACK: "1" });

  [{ id: V.own }] = await as(LU, "select public.create_vault('Links Own') as id");
  [{ id: V.empty }] = await as(LU, "select public.create_vault('Links Empty') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.own, MO, LU]);
});

after(async () => {
  mcpFixture.closeAllConnections();
  mcpFixture.close();
  for (const c of servers) c.kill();
});

test("links page: an empty vault says so, and offers Add link to an owner", async () => {
  const h = await page(lp(V.empty));
  assert.match(h, /No links yet/);
  assert.match(h, /Add link/);
});

test("links page: owner adds a link; the credential never appears on any page", async () => {
  const h1 = await page(lp(V.own));
  const cred = credential("linear");
  // A loopback address (refused as not public, no test allowance on this
  // server) stands in for "an upstream discovery doesn't reach": deliberate
  // and fast, not a stand-in for a working server. web/test/discovery.test.mjs
  // is where a real MCP handshake is exercised.
  const r = await post(lp(V.own), { op: "save", name: "linear", url: "https://127.0.0.1/mcp", credential: cred }, { csrf: csrfOf(h1) });
  const h2 = await landed(r);
  const flash = flashOf(h2);
  assert.equal(flash?.[0], "warning");
  assert.equal(flash?.[1], "status");
  assert.match(flash?.[2] ?? "", /^Added linear, but its tools couldn’t be discovered\. This link’s address isn’t public\. \(ref [0-9a-f]{8}\)$/);
  assert.match(h2, /linear/);
  assert.match(h2, /https:\/\/127\.0\.0\.1\/mcp/);
  noCredentials(h2);

  const row = await linkRow(V.own, "linear");
  assert.ok(row, "the link was stored");
  const sealed = await sql("select key_id, nonce, ciphertext from private.link_secrets where link_id = $1", [row.id]);
  assert.equal(sealed.length, 1);
});

test("discovery: adding a link on a server with LINK_DISCOVERY_ALLOW_LOOPBACK reaches the fixture and stores its tools", async () => {
  const h1 = await page(lp(V.own), disco);
  const cred = credential("zendesk");
  const r = await post(lp(V.own), { op: "save", name: "zendesk", url: mcpBase, credential: cred }, { s: disco, csrf: csrfOf(h1) });
  const h2 = await landed(r, disco);
  const flash = flashOf(h2);
  assert.deepEqual(flash?.slice(0, 2), ["success", "status"]);
  assert.equal(flash?.[2], "Added zendesk. Discovered 2 tools.");
  noCredentials(h2);

  const row = await linkRow(V.own, "zendesk");
  const tools = await sql("select tool_name, is_write from public.link_tools where link_id = $1 order by tool_name", [row.id]);
  assert.deepEqual(tools, [
    { tool_name: "create_issue", is_write: true },
    { tool_name: "list_issues", is_write: false },
  ]);
  const grants = await sql("select role, tool_name, enabled from public.link_grants where link_id = $1 order by role, tool_name", [row.id]);
  assert.deepEqual(grants, [
    { role: "editor", tool_name: "create_issue", enabled: false },
    { role: "editor", tool_name: "list_issues", enabled: true },
    { role: "owner", tool_name: "create_issue", enabled: false },
    { role: "owner", tool_name: "list_issues", enabled: true },
  ]);
});

test("links page: a stored credential opens back to what was sent, scoped to its vault", async () => {
  const crypto = await import("../dist/secrets.js");
  const row = await linkRow(V.own, "linear");
  const [sealedRow] = await sql("select key_id, nonce, ciphertext from private.link_secrets where link_id = $1", [row.id]);
  const sealed = { keyId: sealedRow.key_id, nonce: sealedRow.nonce, ciphertext: sealedRow.ciphertext };
  const opened = crypto.openLink(sealed, V.own);
  assert.match(opened, /^LINKVAL-linear-/);
  assert.throws(() => crypto.openLink(sealed, V.empty), /could not be decrypted/);
});

test("links page: an editor sees a link but not the Add form or its actions", async () => {
  const h = await page(lp(V.own), moss);
  assert.match(h, /linear/);
  assert.doesNotMatch(h, /id="add-link"/);
  assert.doesNotMatch(h, />Edit</);
  assert.doesNotMatch(h, />Delete</);
});

test("links page: an editor's direct POST to add a link is refused by the database, not silently accepted", async () => {
  const h1 = await page(lp(V.own), moss);
  const r = await post(lp(V.own), { op: "save", name: "stripe", url: "https://api.stripe.com", credential: credential("stripe") }, { s: moss, csrf: csrfOf(h1) });
  const h2 = await landed(r, moss);
  assert.match(flashOf(h2)?.[2] ?? "", /only owners add links/i);
  assert.equal(await linkRow(V.own, "stripe"), undefined);
});

test("links page: owner edits a link's name and url; the credential is untouched", async () => {
  const before = await linkRow(V.own, "linear");
  const h1 = await page(lp(V.own, `?edit=${before.id}`));
  assert.match(h1, /value="linear"/);
  assert.match(h1, /value="https:\/\/127\.0\.0\.1\/mcp"/);
  assert.doesNotMatch(h1, /name="credential"/);
  const r = await post(lp(V.own), { op: "save", link_id: before.id, name: "linear2", url: "https://api2.linear.app" }, { csrf: csrfOf(h1) });
  const h2 = await landed(r);
  assert.match(flashOf(h2)?.[2] ?? "", /Saved changes to linear2/);
  const after = await linkRow(V.own, "linear2");
  assert.equal(after.id, before.id);
  assert.equal(after.url, "https://api2.linear.app");
  const [sealedRow] = await sql("select nonce from private.link_secrets where link_id = $1", [before.id]);
  assert.ok(sealedRow, "the credential row survives an edit");
});

test("links page: deleting goes through a confirm page, not a bare button", async () => {
  const row = await linkRow(V.own, "linear2");
  const h1 = await page(lp(V.own, `?delete=${row.id}`));
  assert.match(h1, /Delete the link linear2/);
  assert.match(h1, /<button class="danger solid">Delete linear2<\/button>/);
  const r = await post(lp(V.own), { op: "delete", link_id: row.id }, { csrf: csrfOf(h1) });
  const h2 = await landed(r);
  assert.match(flashOf(h2)?.[2] ?? "", /Deleted linear2/);
  assert.equal(await linkRow(V.own, "linear2"), undefined);
  assert.equal((await sql("select 1 from private.link_secrets where link_id = $1", [row.id])).length, 0);
});

test("links page: without VARIABLES_KEY, links still list but Add is disabled", async () => {
  const [{ id: bareVault }] = await as(LU, "select public.create_vault('Links Bare') as id");
  const h = await page(lp(bareVault), bare);
  assert.match(h, /no key for encrypting credentials/);
  assert.match(h, /<button class="primary" disabled>Add link<\/button>/);
});
