// Contract: docs/parity.md accounts for every MCP tool. The parity table
// lists each action with its web route and its MCP tool; a tool the server
// offers that the table doesn't name (or a table entry for a tool that no
// longer exists) fails here, so the table can't silently drift from the
// tool list. test.sh mounts docs/ read-only and sets PARITY_FILE.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const PARITY = process.env.PARITY_FILE ?? new URL("../../docs/parity.md", import.meta.url);

async function liveTools() {
  const c = new Client({ name: "parity", version: "0.0.0" });
  await c.connect(
    new StreamableHTTPClientTransport(URL_, { requestInit: { headers: { Authorization: `Bearer ${process.env.ANA_TOKEN}` } } }),
  );
  const names = (await c.listTools()).tools.map((t) => t.name);
  await c.close();
  return names.sort();
}

// The backticked names in the "MCP" column of every table in the file.
function listedTools() {
  const names = new Set();
  let col = -1;
  for (const line of readFileSync(PARITY, "utf8").split("\n")) {
    if (!line.startsWith("|")) {
      col = -1;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (col === -1) {
      col = cells.indexOf("MCP");
      if (col === -1) col = -2; // a table without an MCP column: skip it
      continue;
    }
    if (col < 0 || /^:?-+:?$/.test(cells[0])) continue;
    for (const [, name] of (cells[col] ?? "").matchAll(/`([a-z_]+)`/g)) names.add(name);
  }
  return [...names].sort();
}

test("parity: every MCP tool is in docs/parity.md", async () => {
  const listed = listedTools();
  assert.ok(listed.length > 0, "no MCP column found in docs/parity.md");
  const missing = (await liveTools()).filter((n) => !listed.includes(n));
  assert.deepEqual(missing, [], "add these tools to docs/parity.md (MCP column)");
});

test("parity: docs/parity.md names no MCP tool that doesn't exist", async () => {
  const live = await liveTools();
  const stale = listedTools().filter((n) => !live.includes(n));
  assert.deepEqual(stale, [], "docs/parity.md names tools the server doesn't offer");
});
