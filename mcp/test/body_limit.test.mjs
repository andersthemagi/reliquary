// The request body limit (src/server.ts, readJson): a body over it is answered
// with a 400 that names the limit, delivered rather than reset. Seed: Gus's
// all-vaults read-write token (seed.sql).

import assert from "node:assert/strict";
import { test } from "node:test";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const { GUS_RW } = process.env;

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
  assert.match(body.message, /over \d+ MiB, so nothing was run/);
  assert.match(body.ref, /^[0-9a-f]{8}$/);
});
