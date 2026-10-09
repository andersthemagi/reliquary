// A request that fails where nothing was expected to (src/server.ts).
// registerTools() ran outside the try/finally that closes the request's
// database session and answers errors, so a throw from it left the request
// unanswered and the session's connection inside an open transaction; and
// nothing caught a throw from serve() itself. fault-register.mjs makes one
// registration throw in a server this file starts for itself.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { post, startServer } from "./own-server.mjs";

let server;
before(async () => {
  server = await startServer("./fault-register.mjs", { FAULT_REGISTER_TOOL: "list_links" });
});
after(() => server?.stop());

const callOn = (s, id) => post(s.origin, { jsonrpc: "2.0", id, method: "tools/call", params: { name: "list_vaults", arguments: {} } });
const call = (id) => callOn(server, id);

async function openTransactions() {
  const db = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await db.connect();
  try {
    const { rows } = await db.query(
      `select count(*)::int as n from pg_stat_activity where usename = current_user and pid <> pg_backend_pid() and state like 'idle in transaction%'`,
    );
    return rows[0].n;
  } finally {
    await db.end();
  }
}

test("registration failure: a tool call whose tools fail to register is answered with a failure and its reference", async () => {
  const r = await call(7);
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.equal(body.id, 7);
  assert.match(body.error.data.ref, /^[0-9a-f]{8}$/);
  assert.match(body.error.data.where, /^MCP server/);
  assert.match(body.error.message, new RegExp(`ref ${body.error.data.ref}\\)$`));
  const logged = new RegExp(`failure ref=${body.error.data.ref} `);
  for (let i = 0; i < 20 && !logged.test(server.log()); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(server.log(), logged, "the same reference is in the server log");
});

test("registration failure: the request's database connection is not left inside a transaction", async () => {
  await call(8);
  let open = 1;
  for (let i = 0; i < 20 && open > 0; i++) {
    open = await openTransactions();
    if (open > 0) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(open, 0);
});

// Last: before the fix this request ended the server process.
test("unhandled failure: a request that throws before any tool is registered is answered with a failure and its reference", async () => {
  // Building the request's MCP server happens in serve() outside its try;
  // fault-construct.mjs makes it throw. (A request target of `//` used to,
  // through new URL; that is a 400 now, errors.test.mjs.)
  const broken = await startServer("./fault-construct.mjs");
  try {
    const r = await callOn(broken, 9);
    assert.ok(r.status >= 400, `status ${r.status}`);
    const body = await r.json();
    assert.match(body.error.data.ref, /^[0-9a-f]{8}$/);
    assert.match(body.error.data.where, /^MCP server/);
  } finally {
    broken.stop();
  }
});
