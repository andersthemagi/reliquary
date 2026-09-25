// Plans and limits over MCP: a refusal reaches the agent as a clear error,
// and list_vaults notes a vault near a limit. The database decides and
// counts (supabase/tests/plans_test.sql).
// Seed: the "Plans and limits" block at the end of test/seed.sql (Pat, on
// "MCP small": 1 vault, 2 people, 100 bytes a vault; Pat full holds 90).

import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const { PAT_RW } = process.env;

async function call(name, args = {}) {
  const c = new Client({ name: "plans", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(URL_, { requestInit: { headers: { Authorization: `Bearer ${PAT_RW}` } } }));
  try {
    const r = await c.callTool({ name, arguments: args });
    return { text: r.content.map((x) => x.text).join("\n"), isError: Boolean(r.isError) };
  } finally {
    await c.close();
  }
}

test("plans: list_vaults notes a vault near its storage limit, with its usage", async () => {
  const r = await call("list_vaults");
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Pat full \(owner\) id=[0-9a-f-]{36}; limits: storage 90 bytes of 100 bytes$/m);
});

test("plans: a write past the storage limit reaches the agent as a clear refusal, and nothing is written", async () => {
  const r = await call("write_file", { vault: "Pat full", path: "notes/more.md", content: "m".repeat(20) });
  assert.equal(r.isError, true);
  assert.equal(r.text,
    "Limit reached: Pat full has 90 bytes of its 100 bytes storage limit on the MCP small plan, and this needs 20 bytes more. Erase files you no longer need (deleting a file keeps its history) or delete variables, then try again");
  const files = await call("list_files", { vault: "Pat full" });
  assert.doesNotMatch(files.text, /more\.md/);
});

test("plans: a proposal that wouldn't fit is refused when made", async () => {
  const r = await call("propose", { vault: "Pat full", path: "notes/p.md", content: "p".repeat(20), reason: "more" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Limit reached: Pat full has 90 bytes of its 100 bytes storage limit/);
});

test("plans: create_vault at the account's vault limit reaches the agent as a clear refusal", async () => {
  const r = await call("create_vault", { name: "Pat second" });
  assert.equal(r.isError, true);
  assert.equal(r.text,
    "Limit reached: you're at your 1-vault limit on the MCP small plan (you own 1): delete a vault you no longer need, or ask for a bigger plan");
  assert.doesNotMatch((await call("list_vaults")).text, /Pat second/);
});
