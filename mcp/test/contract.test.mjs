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

// A dotted name is a <link>.<tool> entry (links-tools.ts's registerUpstreamLinkTools):
// identity-dependent (different vaults, different grants -- its own name
// check constraints forbid a dot in either a link's or a discovered
// tool's own name, so this can't collide with a fixed tool). The fixed
// set below is the same, enumerable, identity-independent list for
// everyone; a granted-vs-ungranted <link>.<tool> is proven by
// mcp/test/link_proxy.test.mjs instead of snapshotted here.
const isFixed = (name) => !name.includes(".");

async function toolSurface(token) {
  const client = new Client({ name: "contract", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(URL_, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  const { tools } = await client.listTools();
  await client.close();
  return tools
    .filter((t) => isFixed(t.name))
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

test("contract: a read-only token sees the same fixed tools; the database refuses, not the list", async () => {
  const full = (await toolSurface(process.env.ANA_TOKEN)).map((t) => t.name);
  const readOnly = (await toolSurface(process.env.ANA_TEAM_RO)).map((t) => t.name);
  assert.deepEqual(readOnly, full);
});

// The snapshot records whatever the tools say, so a new tool that says
// nothing would be approved along with the rest. These two fail it instead.
// MCP's defaults for a tool with no annotations are destructive and
// open-world, which makes a host ask before calls that only read or add.
test("contract: every fixed tool says outright whether it reads or destroys, and that it stays inside Reliquary", async () => {
  const problems = [];
  for (const t of await toolSurface(process.env.ANA_TOKEN)) {
    const a = t.annotations ?? {};
    if (a.openWorldHint !== false) problems.push(`${t.name}: openWorldHint is not false`);
    if (a.readOnlyHint !== true && typeof a.destructiveHint !== "boolean") problems.push(`${t.name}: neither readOnlyHint is true nor destructiveHint stated`);
    if (a.readOnlyHint === true && a.destructiveHint === true) problems.push(`${t.name}: read-only and destructive at once`);
  }
  assert.deepEqual(problems, []);
});

test("contract: every argument of every fixed tool has a description an agent can read", async () => {
  const problems = [];
  for (const t of await toolSurface(process.env.ANA_TOKEN)) {
    for (const [name, schema] of Object.entries(t.inputSchema?.properties ?? {})) {
      if (!String(schema.description ?? "").trim()) problems.push(`${t.name}.${name}`);
    }
  }
  assert.deepEqual(problems, []);
});
