// Environment variables over MCP (docs/variables.md): `list_variables` gives
// names, environments and who set them, never a value; the MCP app refuses
// to hold VARIABLES_KEY; a CLI token is useless here and an MCP token is
// useless at the web app's env API (test.sh runs the web app as the
// authorization server, at WEB_AS_URL).
//
// Seeds its own people (Uma, Ivy) and vaults straight in the database, so no
// other file's counts move. The "ciphertext" stored here is a marker, so a
// test can prove no tool returns it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { connect } from "./mcp-client.mjs";

const MCP = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const RESOURCE = process.env.MCP_RESOURCE ?? MCP.href;
const WEB = process.env.WEB_AS_URL ?? "http://127.0.0.1:8789";
// test.sh puts Postgres at 54330 + 10 * slot and this server at 8788 + 10 * slot.
const PG_PORT = 54330 + (Number(MCP.port) - 8788);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const UMA = "00000000-0000-0000-0000-0000000000f4";
const IVY = "00000000-0000-0000-0000-0000000000f5";
const MARKER = "CIPHERTEXT-MARKER-mcp";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const b64url = (buf) => buf.toString("base64url");

let vault = "";
let ivyVault = "";
let umaToken = "";
let client;

async function as(who, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    if (who.role) await db.query(`set local role ${who.role}`);
    else {
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

const setv = (user, v, name, env) =>
  as({ user }, "select public.set_variable($1, $2, $3, 'k1', $4, $5)", [v, name, env, Buffer.alloc(12), Buffer.from(`${MARKER}-${name}-${env}`)]);

// Consent as the person, then the token endpoint's redemption, straight in
// the database. kind: 'cli' (the env API) or 'oauth' (this MCP server).
async function grantToken(user, kind) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirect = kind === "cli" ? "http://127.0.0.1:53682/callback" : "https://app.client.test/callback";
  const client = kind === "cli" ? `${WEB}/cli/oauth-client.json` : "https://app.client.test/client.json";
  const resource = kind === "cli" ? `${WEB}/api/env` : RESOURCE;
  const [{ code }] =
    kind === "cli"
      ? await as({ user }, "select public.create_cli_grant($1, $2, $3, $4, null) as code", [client, redirect, resource, challenge])
      : await as({ user }, "select public.create_oauth_grant('Chat', $1, $2, $3, $4, null, 'read') as code", [client, redirect, resource, challenge]);
  const access = `${kind === "cli" ? "rle" : "rlo"}_${randomBytes(32).toString("hex")}`;
  const [{ r }] = await as({ role: "reliquary_web" }, "select private.oauth_redeem_code($1, $2, $3, $4, $5, $6, $7) as r", [
    sha(code), client, redirect, resource, verifier, sha(access), sha(`${access}-refresh`),
  ]);
  assert.equal(r, "ok");
  return access;
}

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
}

const mcpPost = (token) =>
  fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

before(async () => {
  [{ id: vault }] = await as({ user: UMA }, "select public.create_vault('Var Vault') as id");
  [{ id: ivyVault }] = await as({ user: IVY }, "select public.create_vault('Ivy Vault') as id");
  await as({ role: "postgres" }, "select test_support.add_member($1, $2, 'editor', $3)", [vault, IVY, UMA]);
  await setv(UMA, vault, "STRIPE_KEY", "production");
  await setv(IVY, vault, "STRIPE_KEY", "development");
  await setv(IVY, vault, "DATABASE_URL", "development");
  await setv(IVY, ivyVault, "IVY_ONLY", "development");
  [{ t: umaToken }] = await as({ user: UMA }, "select public.create_access_token('Uma agent', 7) as t");
  client = await connect(MCP, umaToken, "variables-test");
});

after(async () => {
  await client?.close();
});

test("list_variables: names, environments and who set them, never a value", async () => {
  const r = await call("list_variables", { vault: "Var Vault" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Environments: development, preview, production \(owners only\)\./);
  assert.match(r.text, /Names only; values never leave Reliquary over MCP\./);
  assert.match(r.text, /^DATABASE_URL\n {2}development {2}set \S+ by 0{8}-0{4}-0{4}-0{4}-0{10}f5$/m);
  assert.match(r.text, /^STRIPE_KEY\n {2}development {2}set \S+ by \S+f5\n {2}production {2}set \S+ by \S+f4 \(your person\)$/m);
  assert.equal(r.text.includes("CIPHERTEXT"), false);
  assert.equal(r.text.includes(Buffer.from(MARKER).toString("base64").slice(0, 16)), false);
  assert.equal(r.text.includes(Buffer.from(MARKER).toString("hex").slice(0, 16)), false);
});

test("list_variables: one environment", async () => {
  const r = await call("list_variables", { vault: vault, environment: "production" });
  assert.equal(r.isError, false);
  assert.match(r.text, /^STRIPE_KEY\n {2}production /m);
  assert.doesNotMatch(r.text, /DATABASE_URL|development {2}set/);
});

test("list_variables: an unknown environment names the ones there are", async () => {
  const r = await call("list_variables", { vault: vault, environment: "staging" });
  assert.equal(r.isError, true);
  assert.match(r.text, /No environment named staging\. This vault has: development, preview, production\./);
});

test("list_variables: another person's vault is not found", async () => {
  const r = await call("list_variables", { vault: ivyVault });
  assert.equal(r.isError, true);
  assert.match(r.text, /No vault with that name or id/);
});

test("list_variables: no MCP tool can set, reveal or read a value", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names.filter((n) => /variable|secret|env/.test(n)), ["list_variables"]);
});

test("cli token: useless at /mcp", async () => {
  const token = await grantToken(UMA, "cli");
  // It works where it belongs, which proves it's a live token...
  const ok = await fetch(`${WEB}/api/env/vaults`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).vaults.map((v) => v.name), ["Var Vault"]);
  // ...and not here.
  const r = await mcpPost(token);
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /error="invalid_token"/);
});

test("mcp token: useless at the env API, personal or OAuth", async () => {
  const oauth = await grantToken(UMA, "oauth");
  assert.equal((await mcpPost(oauth)).status, 200);
  for (const t of [umaToken, oauth]) {
    const r = await fetch(`${WEB}/api/env/vaults`, { headers: { authorization: `Bearer ${t}` } });
    assert.equal(r.status, 401);
    const v = await fetch(`${WEB}/api/env/${vault}/development`, { headers: { authorization: `Bearer ${t}` } });
    assert.equal(v.status, 401);
  }
});

test("mcp app: refuses to start with VARIABLES_KEY set, without printing it", () => {
  const key = `${randomBytes(24).toString("base64url")}KEYMARK`;
  const r = spawnSync(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: "postgres://reliquary_mcp:test@127.0.0.1:1/postgres", PORT: "1", VARIABLES_KEY: key },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to start: VARIABLES_KEY is set, and only the web app may hold it/);
  assert.equal((r.stdout + r.stderr).includes(key), false);
});

test("mcp app: refuses to start with VARIABLES_KEYS set, without printing it", () => {
  const key = `k2:${randomBytes(24).toString("base64url")}KEYMARK`;
  const r = spawnSync(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: "postgres://reliquary_mcp:test@127.0.0.1:1/postgres", PORT: "1", VARIABLES_KEYS: key },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to start: VARIABLES_KEYS is set, and only the web app may hold it/);
  assert.equal((r.stdout + r.stderr).includes("KEYMARK"), false);
});
