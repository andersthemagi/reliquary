// Pushes (docs/variables.md, "Imports") over MCP: `list_variables` names the
// pushes waiting for a person, never a value, and no tool creates, applies
// or rejects one. Seeds its own person (Una) and vault in the database; the
// "ciphertext" is a marker, so a test can prove no tool returns it.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";

const MCP = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const WEB = process.env.WEB_AS_URL ?? "http://127.0.0.1:8789";
const PG_PORT = 54330 + (Number(MCP.port) - 8788);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const UNA = "00000000-0000-0000-0000-0000000000e7";
const MARKER = "CIPHERTEXT-MARKER-push";

const sha = (s) => createHash("sha256").update(s).digest("hex");
let vault = "";
const clients = [];

async function as(who, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    if (who.role) await db.query(`set local role ${who.role}`);
    else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.user, role: "authenticated", ...(who.act ? { act: who.act } : {}) })]);
    }
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

// A CLI sign-in allowed to push, as consent and the token endpoint make it.
async function pushGrant(user) {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest().toString("base64url");
  const redirect = "http://127.0.0.1:53682/callback";
  const client = `${WEB}/cli/oauth-client.json`;
  const resource = `${WEB}/api/env`;
  const [{ code }] = await as({ user }, "select public.create_cli_grant($1, $2, $3, $4, null, true) as code", [client, redirect, resource, challenge]);
  const access = `rle_${randomBytes(32).toString("hex")}`;
  await as({ role: "reliquary_web" }, "select private.oauth_redeem_code($1, $2, $3, $4, $5, $6, $7)", [
    sha(code), client, redirect, resource, verifier, sha(access), sha(`${access}-r`),
  ]);
  const [{ id }] = await as({ role: "postgres" }, "select grant_id as id from private.oauth_tokens where token_hash = $1", [sha(access)]);
  return id;
}

async function connect(token) {
  const c = new Client({ name: "env-imports-test", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(MCP, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(c);
  return async (name, args = {}) => {
    const r = await c.callTool({ name, arguments: args });
    return { text: r.content.map((x) => x.text).join("\n"), isError: Boolean(r.isError) };
  };
}

let write;
let read;

before(async () => {
  [{ id: vault }] = await as({ user: UNA }, "select public.create_vault('Push Vault') as id");
  const grant = await pushGrant(UNA);
  const items = ["GITHUB_TOKEN", "OPENAI_API_KEY"].map((name) => ({
    name,
    environment: "development",
    key_id: "k1",
    nonce: Buffer.alloc(12).toString("base64"),
    ciphertext: Buffer.from(`${MARKER}-${name}`).toString("base64"),
  }));
  const [{ r }] = await as(
    { user: UNA, act: { sub: grant, name: "Reliquary CLI", tok: grant } },
    "select public.create_env_import($1, array['development'], $2::jsonb) as r",
    [vault, JSON.stringify(items)],
  );
  assert.equal(r.ok, true);
  const [{ t: w }] = await as({ user: UNA }, "select public.create_access_token('Una agent', 7) as t");
  const [{ t: ro }] = await as({ user: UNA }, "select public.create_access_token('Una reader', 7, null, 'read') as t");
  write = await connect(w);
  read = await connect(ro);
});

after(async () => {
  for (const c of clients) await c.close();
});

test("pushes over MCP: list_variables names the pushes waiting for a person, never a value", async () => {
  const r = await write("list_variables", { vault: "Push Vault" });
  assert.equal(r.isError, false);
  assert.match(r.text, /No variables\./);
  assert.match(r.text, /Waiting for a person to apply them in the web UI:\n {2}development: GITHUB_TOKEN, OPENAI_API_KEY \(sent \S+ by 00000000-0000-0000-0000-0000000000e7 \(your person\), expires \S+\)/);
  assert.doesNotMatch(r.text, /CIPHERTEXT|MARKER/);
});

test("pushes over MCP: another environment has none waiting, and a read-only agent sees none", async () => {
  assert.doesNotMatch((await write("list_variables", { vault: "Push Vault", environment: "production" })).text, /Waiting/);
  assert.doesNotMatch((await read("list_variables", { vault: "Push Vault" })).text, /Waiting|GITHUB_TOKEN/);
});

test("pushes over MCP: no tool sends, applies or rejects a push, and list_variables says how to send one", async () => {
  const { tools } = await clients[0].listTools();
  const names = tools.map((t) => t.name);
  assert.equal(names.some((n) => /push|import|apply|reject|set_variable|reveal/.test(n)), false, names.join(", "));
  const lv = tools.find((t) => t.name === "list_variables");
  assert.match(lv.description, /env push --env <environment> --file \.env/);
  assert.match(lv.description, /never read the file's values into the conversation/);
});
