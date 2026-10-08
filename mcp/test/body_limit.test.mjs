// The request body limit (src/server.ts, readJson): a body over it is answered
// with a 400 that names the limit, delivered rather than reset, and file text
// at its own limit still fits once JSON has escaped it. Seed: Gus's all-vaults
// read-write token (seed.sql); the vault is this file's own.

import assert from "node:assert/strict";
import { test } from "node:test";
import { call } from "./mcp-client.mjs";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const { GUS_RW } = process.env;
const VAULT = `Body limit ${process.pid}`;

const rpc = (body) =>
  fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${GUS_RW}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body,
  });

test("body limit: a body over the limit gets a 400 that names it, not a reset connection", async () => {
  const padding = "x".repeat(3 * 1024 * 1024 + 128 * 1024);
  const r = await rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { padding } }));
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, "body too large");
  assert.match(body.message, /over 3 MiB, so nothing was run/);
  assert.match(body.ref, /^[0-9a-f]{8}$/);
});

test("body limit: file text near its own limit fits once JSON has escaped it", async () => {
  assert.equal((await call(URL_, GUS_RW, "create_vault", { name: VAULT })).isError, false);
  // 1,000,000 characters of newlines: two bytes each in JSON, a body twice the old 1 MiB limit.
  const content = "\n".repeat(1_000_000);
  const r = await call(URL_, GUS_RW, "write_file", { vault: VAULT, path: "notes/long.md", content });
  assert.equal(r.isError, false, r.text);
});
