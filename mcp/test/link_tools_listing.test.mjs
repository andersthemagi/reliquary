// What tools/list offers as <link>.<tool> when the data behind it is not
// friendly (docs/design.md, "Links"; src/links-tools.ts): the same link name
// in two vaults one person reaches. link_proxy.test.mjs has the friendly
// path; the database side is supabase/tests/link_proxy_test.sql.
//
// Seeds its own people, vaults and links (a link is never called here, so
// its credential is random bytes), so no other file's counts move.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { connect as mcpConnect } from "./mcp-client.mjs";

const MCP = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
// test.sh puts Postgres at 54330 + 10 * slot and this server at 8788 + 10 * slot.
const PG_PORT = 54330 + (Number(MCP.port) - 8788);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;

const ALPHA = "00000000-0000-0000-0000-0000000000a1";
const BETA = "00000000-0000-0000-0000-0000000000a2";
// A hung request is the failure this file exists for: fail in seconds.
const QUICK = { timeout: 8000 };

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
const sql = async (q, params = []) => {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
};

const sealed = () => [randomBytes(12), randomBytes(32)];
async function addLink(owner, vault, name, tools) {
  const [nonce, ciphertext] = sealed();
  const [{ id }] = await as(owner, "select public.create_link($1, $2, 'https://upstream.example.test/mcp', 'k1', $3, $4) as id", [vault, name, nonce, ciphertext]);
  await as(owner, "select public.set_link_tools($1, $2::jsonb)", [id, JSON.stringify(tools)]);
  return id;
}

let alphaVault = "";
let betaVault = "";
let alphaLink = "";
let betaLink = "";
let alphaClient;

before(async () => {
  [{ id: alphaVault }] = await as(ALPHA, "select public.create_vault('Collide Alpha') as id");
  [{ id: betaVault }] = await as(BETA, "select public.create_vault('Collide Beta') as id");
  // ALPHA is an owner of one vault and an editor of the other: a read tool is
  // granted to both roles by default, so both links' tools are callable.
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [betaVault, ALPHA, BETA]);
  alphaLink = await addLink(ALPHA, alphaVault, "shared_name", [{ name: "search", is_write: false, description: "alpha-side search" }]);
  betaLink = await addLink(BETA, betaVault, "shared_name", [{ name: "search", is_write: false, description: "beta-side search" }]);
  const [{ t }] = await as(ALPHA, "select public.create_access_token('Alpha agent', 7) as t");
  alphaClient = await mcpConnect(MCP, t, "link-tools-listing-test");
});

after(async () => {
  await alphaClient?.close();
});

test("two vaults with a link of the same name and a tool of the same name: tools/list answers and offers the tool once", async () => {
  const tools = (await alphaClient.listTools({}, QUICK)).tools;
  assert.equal(tools.filter((t) => t.name === "shared_name.search").length, 1);
  assert.ok(tools.some((t) => t.name === "list_vaults"), "the fixed tools are still offered");
});

test("two vaults with a link of the same name: the same one is offered on every request (the lower link id)", async () => {
  const first = [alphaLink, betaLink].sort()[0];
  const want = first === alphaLink ? "alpha-side search" : "beta-side search";
  for (let i = 0; i < 3; i++) {
    const t = (await alphaClient.listTools({}, QUICK)).tools.find((x) => x.name === "shared_name.search");
    assert.match(t.description, new RegExp(want));
  }
});

test("two vaults with a link of the same name: the person's other requests still work", async () => {
  const r = await alphaClient.callTool({ name: "list_vaults", arguments: {} }, undefined, QUICK);
  assert.equal(r.isError ?? false, false);
  assert.match(r.content.map((c) => c.text).join("\n"), /Collide Alpha/);
});
