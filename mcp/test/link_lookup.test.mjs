// Which requests look up <link>.<tool> tools (src/tools.ts needsLinkTools,
// src/server.ts). The lookup is a query, and on a tools/call it ran in the
// transaction the Session opened for the call and committed it, so the tool
// then began a second one (a second token resolve, about three round trips
// more than docs/research/server-load.md counts). Only tools/list and a call
// to a name with a dot can reach a link tool. spy-link-lookups.mjs makes a
// server this file starts for itself print a line per lookup.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { post, startServer } from "./own-server.mjs";

let server;
before(async () => {
  server = await startServer("./spy-link-lookups.mjs");
});
after(() => server?.stop());

const lookups = () => (server.log().match(/link-tool lookup/g) ?? []).length;
// The lookup happens before the answer, but the log is read from a pipe.
const settle = () => new Promise((r) => setTimeout(r, 250));

async function lookupsBy(message) {
  const before = lookups();
  const r = await post(server.origin, message);
  await r.text();
  await settle();
  return lookups() - before;
}

const call = (name) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "lookup-test", version: "0" } } };

test("link tool lookup: tools/list looks them up, once", async () => {
  assert.equal(await lookupsBy({ jsonrpc: "2.0", id: 1, method: "tools/list" }), 1);
});

test("link tool lookup: a call to a name with a dot looks them up, once", async () => {
  assert.equal(await lookupsBy(call("nothing_linked.search")), 1);
});

test("link tool lookup: a call to a fixed tool doesn't", async () => {
  assert.equal(await lookupsBy(call("list_vaults")), 0);
});

test("link tool lookup: initialize doesn't", async () => {
  assert.equal(await lookupsBy(initialize), 0);
});

test("link tool lookup: a batch with one tools/list in it looks them up once", async () => {
  assert.equal(await lookupsBy([call("list_vaults"), { jsonrpc: "2.0", id: 2, method: "tools/list" }]), 1);
});
