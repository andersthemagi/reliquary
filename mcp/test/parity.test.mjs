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

// A <link>.<tool> name (tools.ts's registerLinkTools) is identity-
// dependent -- who's granted one legitimately varies -- so docs/parity.md
// doesn't enumerate instances of it, it has one row for the pattern
// itself, literally `<link>.<tool>` (design.md's own placeholder). That
// text can't match the plain-name regex below (it has < > . in it), so it
// never pollutes the listed set; it's checked for separately.
const DYNAMIC_PLACEHOLDER = "<link>.<tool>";
const isDynamic = (name) => name.includes(".");

// The backticked names in the "MCP" column of every table in the file,
// and whether the dynamic placeholder itself is listed anywhere.
function listedTools() {
  const names = new Set();
  let dynamicListed = false;
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
    const cell = cells[col] ?? "";
    for (const [, name] of cell.matchAll(/`([a-z_]+)`/g)) names.add(name);
    if (cell.includes(`\`${DYNAMIC_PLACEHOLDER}\``)) dynamicListed = true;
  }
  return { names: [...names].sort(), dynamicListed };
}

test("parity: every MCP tool is in docs/parity.md", async () => {
  const { names: listed, dynamicListed } = listedTools();
  assert.ok(listed.length > 0, "no MCP column found in docs/parity.md");
  const live = await liveTools();
  const missing = live.filter((n) => !isDynamic(n) && !listed.includes(n));
  assert.deepEqual(missing, [], "add these tools to docs/parity.md (MCP column)");
  if (live.some(isDynamic)) {
    assert.ok(dynamicListed, `a <link>.<tool> tool is live, but docs/parity.md has no \`${DYNAMIC_PLACEHOLDER}\` row`);
  }
});

test("parity: docs/parity.md names no MCP tool that doesn't exist", async () => {
  const live = await liveTools();
  const stale = listedTools().names.filter((n) => !live.includes(n));
  assert.deepEqual(stale, [], "docs/parity.md names tools the server doesn't offer");
});
