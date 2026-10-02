// Round trips per tool call (docs/research/server-load.md, "Third pass"):
// every tool, called through the official client over an in-memory
// transport, on one Session against the test database with a pool that
// counts what each call sends. A call costs begin-with-resolve and commit,
// plus the tool's own queries; this checks the tool's own queries. Seed:
// Gus's all-vaults read-write token (seed.sql); the vault is this file's own.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import pg from "pg";
import { Session, tokenRef } from "../dist/db.js";
import { registerTools } from "../dist/tools.js";

const { GUS_RW, TEST_DATABASE_URL } = process.env;
const RESOURCE = "http://127.0.0.1/mcp";
const VAULT = `Round trips ${process.pid}`;

const db = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
const n = { roundTrips: 0 };
// The first word of each query sent, in order.
const sent = [];
const wrapped = new WeakSet();
db.on("acquire", (client) => {
  if (wrapped.has(client)) return;
  wrapped.add(client);
  const query = client.query.bind(client);
  client.query = (...args) => {
    n.roundTrips++;
    sent.push(String(typeof args[0] === "string" ? args[0] : args[0]?.text).trim().split(/\s/)[0]);
    return query(...args);
  };
});

let session;
let client;
before(async () => {
  session = new Session(tokenRef(GUS_RW, RESOURCE), db);
  const id = await session.open();
  const server = new McpServer({ name: "reliquary-test", version: "0" });
  registerTools(server, id, (fn) => session.run(fn));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: "round-trips", version: "0" });
  await client.connect(clientSide);
  // The first call uses the transaction open() began; start from a later one.
  await client.callTool({ name: "create_vault", arguments: { name: VAULT } });
  await client.callTool({ name: "write_file", arguments: { vault: VAULT, path: "notes/a.md", content: "alpha workshop\nbeta" } });
});
after(async () => {
  await client?.close();
  await session?.close();
  await db.end();
});

// The tool's own queries: everything the call sent but begin-with-resolve,
// commit, and after a call that succeeded, the flags hint's count (one
// query; its own test is below).
async function own(name, args) {
  const start = n.roundTrips;
  const r = await client.callTool({ name, arguments: args });
  const isError = r.isError === true;
  return { queries: n.roundTrips - start - (isError ? 2 : 3), text: r.content[0].text, isError };
}

test("round trips: every tool that names a vault finds it in its own query (one query each, was two)", async () => {
  const counts = {};
  for (const [name, args] of [
    ["list_files", { vault: VAULT }],
    ["read_file", { vault: VAULT, path: "notes/a.md" }],
    ["search", { vault: VAULT, query: "workshop" }],
    ["write_file", { vault: VAULT, path: "notes/b.md", content: "bravo" }],
    ["delete_file", { vault: VAULT, path: "notes/b.md" }],
    ["propose", { vault: VAULT, path: "notes/c.md", content: "charlie", reason: "why" }],
    ["list_proposals", { vault: VAULT }],
    ["changes_since", { vault: VAULT }],
    ["list_variables", { vault: VAULT }],
  ]) {
    const r = await own(name, args);
    assert.equal(r.isError, false, `${name}: ${r.text}`);
    counts[name] = r.queries;
  }
  assert.deepEqual(counts, {
    list_files: 1,
    read_file: 1,
    search: 1,
    write_file: 1,
    delete_file: 1,
    propose: 1,
    list_proposals: 1,
    changes_since: 1, // was three: the vault, the events, their notes
    list_variables: 1,
  });
});

test("round trips: read_proposal reads the proposal and its thread in one query (was two)", async () => {
  const list = await own("list_proposals", { vault: VAULT });
  const pid = /^([0-9a-f-]{36})  write notes\/c\.md/m.exec(list.text)[1];
  await client.callTool({ name: "comment_on_proposal", arguments: { proposal_id: pid, comment: "a note" } });
  const r = await own("read_proposal", { proposal_id: pid });
  assert.equal(r.queries, 1);
  assert.match(r.text, /thread, oldest first \(1\):\ncomment by .* \(you\) via Gus all rw, revision 1, \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ:/);
});

test("round trips: no vault by that name or id is still the same answer, in the same one query", async () => {
  for (const vault of ["No such vault", "00000000-0000-0000-0000-000000000000", "not-a-uuid"]) {
    for (const [name, args] of [
      ["list_files", { vault }],
      ["search", { vault, query: "x" }],
      ["write_file", { vault, path: "x.md", content: "x" }],
      ["changes_since", { vault }],
      ["list_variables", { vault }],
    ]) {
      const r = await own(name, args);
      assert.equal(r.isError, true, name);
      assert.equal(r.text.split("\n")[0], "No vault with that name or id is available to you. Use list_vaults to see yours.", name);
      assert.match(r.text, /\n\(what: Calling [a-z_]+; where: MCP tool [a-z_]+: database \(function private.vault_ref\); ref [0-9a-f]{8}\)$/, name);
      // The failed call's query, then rollback instead of commit.
      assert.equal(r.queries, 1, name);
    }
  }
});

test("round trips: an empty result in a vault that exists is not \"no vault\"", async () => {
  assert.equal((await own("list_files", { vault: VAULT, prefix: "nothing/" })).text, "No files.");
  assert.equal((await own("search", { vault: VAULT, query: "zzzz" })).text, "No matches.");
  assert.equal((await own("changes_since", { vault: VAULT, cursor: 1e12 })).text, "No changes after 1000000000000.");
  assert.equal((await own("list_proposals", { vault: VAULT, status: "rejected" })).text, "No rejected proposals.");
  assert.equal((await own("read_file", { vault: VAULT, path: "missing.md" })).text, "No file at that path. Use list_files to see the vault's.");
});

test("round trips: the flags hint is one more query, after the tool's own and before commit; none after a failed call or one naming no vault", async () => {
  const queries = async (name, args) => {
    const start = sent.length;
    await client.callTool({ name, arguments: args });
    return sent.slice(start);
  };
  assert.deepEqual(await queries("list_files", { vault: VAULT }), ["begin;", "select", "savepoint", "commit"]);
  assert.deepEqual(await queries("list_files", { vault: "No such vault" }), ["begin;", "select", "rollback"]);
  assert.deepEqual(await queries("list_vaults", {}), ["begin;", "select", "commit"]);
});
