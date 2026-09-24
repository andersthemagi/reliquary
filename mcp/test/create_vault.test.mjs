// create_vault over MCP: an agent creates a vault for its person, but only
// through a token that reaches all of the person's vaults with read-write
// access. The database decides (supabase/tests/create_vault_test.sql); these
// check the tool passes it through and says what happened.
// Seed: the "Create vault and delete_file" block at the end of test/seed.sql.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const { EVE_ALL_RW, EVE_ALL_RO, EVE_HOME_RW } = process.env;
const EVE = "00000000-0000-0000-0000-00000000000e";

async function call(token, name, args = {}) {
  const c = new Client({ name: "create-vault", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(URL_, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  try {
    const r = await c.callTool({ name, arguments: args });
    return { text: r.content.map((x) => x.text).join("\n"), isError: Boolean(r.isError) };
  } finally {
    await c.close();
  }
}

test("create_vault: an all-vaults read-write token creates a vault its person owns", async () => {
  const r = await call(EVE_ALL_RW, "create_vault", { name: "Eve agent notes" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Created vault Eve agent notes id=[0-9a-f-]{36}, owned by your person, default policy open\./);
  assert.match(r.text, /made by Eve all rw/);
  const vaults = await call(EVE_ALL_RW, "list_vaults");
  assert.match(vaults.text, /^Eve agent notes \(owner\) id=/m);
});

test("create_vault: the log records the agent, acting as its person", async () => {
  const log = await call(EVE_ALL_RW, "changes_since", { vault: "Eve agent notes" });
  assert.equal(log.isError, false, log.text);
  // The feed names each person once (p1=<id>), then by label.
  assert.match(log.text, new RegExp(`^people: p1=${EVE} \\(your person\\)$`, "m"));
  assert.match(log.text, /vault\.create {2}by p1 via Eve all rw/);
});

test("create_vault: the agent works in the new vault; canon as the default means proposals", async () => {
  const r = await call(EVE_ALL_RW, "create_vault", { name: "Eve canon box", default_policy: "canon" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /default policy canon/);
  const w = await call(EVE_ALL_RW, "write_file", { vault: "Eve canon box", path: "brief.md", content: "x" });
  assert.equal(w.isError, true);
  assert.match(w.text, /brief\.md is canon: use propose/);
  const p = await call(EVE_ALL_RW, "propose", { vault: "Eve canon box", path: "brief.md", content: "Brief.", reason: "first" });
  assert.equal(p.isError, false, p.text);
});

test("create_vault: a read-only token is refused, and nothing is created", async () => {
  const r = await call(EVE_ALL_RO, "create_vault", { name: "Eve refused ro" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Not allowed: creating a vault needs a connection that reaches all your vaults with read-write access/);
  assert.doesNotMatch((await call(EVE_ALL_RW, "list_vaults")).text, /Eve refused/);
});

test("create_vault: a token scoped to chosen vaults is refused, even read-write", async () => {
  const r = await call(EVE_HOME_RW, "create_vault", { name: "Eve refused scoped" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Not allowed: creating a vault needs/);
  assert.doesNotMatch((await call(EVE_ALL_RW, "list_vaults")).text, /Eve refused/);
});

test("create_vault: a blank name or an unknown policy is refused with a reason", async () => {
  const blank = await call(EVE_ALL_RW, "create_vault", { name: "   " });
  assert.equal(blank.isError, true);
  assert.match(blank.text, /a vault name is 1 to 100 characters/);
  // Refused by the input schema (an error result or a protocol error,
  // depending on the SDK), before the database is asked.
  const odd = await call(EVE_ALL_RW, "create_vault", { name: "Odd", default_policy: "secret" }).catch((e) => ({
    isError: true,
    text: String(e),
  }));
  assert.equal(odd.isError, true);
});

test("create_vault: the agent still can't set rules or add members; there is no tool for either", async () => {
  const c = new Client({ name: "create-vault", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(URL_, { requestInit: { headers: { Authorization: `Bearer ${EVE_ALL_RW}` } } }));
  const names = (await c.listTools()).tools.map((t) => t.name);
  await c.close();
  assert.ok(!names.some((n) => /polic|rule|member|approve|decide|erase/.test(n)), names.join(", "));
});
