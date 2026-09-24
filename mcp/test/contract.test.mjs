// Contract: the MCP tool surface agents depend on. Names, titles,
// descriptions, input schemas and annotations are compared to a checked-in
// snapshot (contract.snapshot.json), so renaming a tool, changing a
// parameter or rewording what an agent is told fails here until the
// snapshot is updated on purpose:
//
//   UPDATE_SNAPSHOTS=1 ./mcp/test.sh
//
// then review the snapshot diff and commit it with a Changes-behaviour
// trailer (see docs/research/testing-strategy.md).

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const SNAPSHOT = new URL("./contract.snapshot.json", import.meta.url);

async function toolSurface(token) {
  const client = new Client({ name: "contract", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(URL_, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  const { tools } = await client.listTools();
  await client.close();
  return tools
    .map(({ name, title, description, inputSchema, annotations }) => ({
      name,
      title: title ?? null,
      description: description ?? null,
      inputSchema: inputSchema ?? null,
      annotations: annotations ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

test("contract: the MCP tool list matches the approved snapshot", async () => {
  const actual = await toolSurface(process.env.ANA_TOKEN);
  if (process.env.UPDATE_SNAPSHOTS === "1") {
    writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 2) + "\n");
    return;
  }
  assert.ok(existsSync(SNAPSHOT), "no snapshot: run UPDATE_SNAPSHOTS=1 ./mcp/test.sh and commit it");
  const expected = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
  const names = (l) => l.map((t) => t.name);
  const added = names(actual).filter((n) => !names(expected).includes(n));
  const removed = names(expected).filter((n) => !names(actual).includes(n));
  assert.deepEqual({ added, removed }, { added: [], removed: [] }, "tools were added or removed");
  for (const want of expected) {
    const got = actual.find((t) => t.name === want.name);
    assert.deepEqual(got, want, `tool ${want.name} changed; if intended, update the snapshot`);
  }
});

test("contract: a read-only token sees the same tools; the database refuses, not the list", async () => {
  const full = (await toolSurface(process.env.ANA_TOKEN)).map((t) => t.name);
  const readOnly = (await toolSurface(process.env.ANA_TEAM_RO)).map((t) => t.name);
  assert.deepEqual(readOnly, full);
});
