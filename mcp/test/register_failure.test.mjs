// A request that fails where nothing was expected to (src/server.ts).
// registerTools() ran outside the try/finally that closes the request's
// database session and answers errors, so a throw from it left the request
// unanswered and the session's connection inside an open transaction; and
// nothing caught a throw from serve() itself. fault-register.mjs makes one
// registration throw in a server this file starts for itself.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import pg from "pg";

const { GUS_RW, TEST_DATABASE_URL } = process.env;
const FAULT = fileURLToPath(new URL("./fault-register.mjs", import.meta.url));

let child;
let log = "";
let origin = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

before(async () => {
  const port = await freePort();
  child = spawn(process.execPath, ["--import", FAULT, "dist/server.js"], {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, HOST: "127.0.0.1", PORT: String(port), FAULT_REGISTER_TOOL: "list_links" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start: ${log}`);
});
after(() => child?.kill());

const post = (body) =>
  fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${GUS_RW}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

async function openTransactions() {
  const db = new pg.Client({ connectionString: TEST_DATABASE_URL });
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
  const r = await post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_vaults", arguments: {} } });
  assert.equal(r.status, 500);
  const body = await r.json();
  assert.equal(body.id, 7);
  assert.match(body.error.data.ref, /^[0-9a-f]{8}$/);
  assert.match(body.error.data.where, /^MCP server/);
  assert.match(body.error.message, new RegExp(`ref ${body.error.data.ref}\\)$`));
  const logged = new RegExp(`failure ref=${body.error.data.ref} `);
  for (let i = 0; i < 20 && !logged.test(log); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(log, logged, "the same reference is in the server log");
});

test("registration failure: the request's database connection is not left inside a transaction", async () => {
  await post({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "list_vaults", arguments: {} } });
  let open = 1;
  for (let i = 0; i < 20 && open > 0; i++) {
    open = await openTransactions();
    if (open > 0) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(open, 0);
});

// Last: before the fix this request ended the server process.
test("unhandled failure: a request that throws before any tool is registered is answered with a failure and its reference", async () => {
  // serve() parses the request target first, and `//` has no host: new URL throws.
  const { status, body } = await new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port: new URL(origin).port, path: "//", timeout: 8000 }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("timeout", () => req.destroy(new Error("no answer in 8 s")));
    req.on("error", reject);
  });
  assert.ok(status >= 400, `status ${status}`);
  assert.match(body.error.data.ref, /^[0-9a-f]{8}$/);
  assert.match(body.error.data.where, /^MCP server/);
});
