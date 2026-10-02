// Links over MCP (docs/design.md, "Links"; 20260928120000_links.sql):
// list_links names and urls only, never the credential. No MCP tool adds,
// edits or deletes a link, or grants its tools -- the ceiling, owners in
// person, same as vault admin. Access control itself is
// supabase/tests/links_test.sql's job; this file proves the read path.
//
// Seeds its own people and vault, so no other file's counts move.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { connect } from "./mcp-client.mjs";

const MCP = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
// test.sh puts Postgres at 54330 + 10 * slot and this server at 8788 + 10 * slot.
const PG_PORT = 54330 + (Number(MCP.port) - 8788);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const RIO = "00000000-0000-0000-0000-0000000000f8";
const MARKER = "CIPHERTEXT-MARKER-linear";

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

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
}

let vault = "";
let rioToken = "";
let client;

before(async () => {
  [{ id: vault }] = await as({ user: RIO }, "select public.create_vault('Links Vault') as id");
  await as(
    { user: RIO },
    "select public.create_link($1, 'linear', 'https://api.linear.app', 'k1', decode($2, 'hex'), decode($3, 'hex')) as id",
    [vault, "00".repeat(12), Buffer.from(MARKER).toString("hex")],
  );
  [{ t: rioToken }] = await as({ user: RIO }, "select public.create_access_token('Rio agent', 7) as t");
  client = await connect(MCP, rioToken, "links-test");
});

after(async () => {
  await client?.close();
});

test("list_links: name and url, never the credential", async () => {
  const r = await call("list_links", { vault: "Links Vault" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^linear {2}https:\/\/api\.linear\.app {2}added by/m);
  assert.equal(r.text.includes("CIPHERTEXT"), false);
  assert.equal(r.text.includes(Buffer.from(MARKER).toString("hex").slice(0, 16)), false);
});

test("list_links: an empty vault says so", async () => {
  const [{ id: other }] = await as({ user: RIO }, "select public.create_vault('Empty Links Vault') as id");
  const r = await call("list_links", { vault: other });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /No links\./);
});

test("list_links: no MCP tool adds, edits, deletes or grants a link", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names.filter((n) => /link/.test(n)), ["list_links"]);
});
