// Health and keepalive (docs/research/hosting.md, section 6). The GitHub
// keepalive hits /healthz?db=1 every 6 hours so the free Supabase project
// never pauses. It answers only `ok` or `unavailable`, and with
// KEEPALIVE_TOKEN set it needs the x-keepalive header.
//
// The shared server (test.sh) runs without a token. This file starts its own
// servers from dist/ for the token and database-down cases, on free ports.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { after, test } from "node:test";
import pg from "pg";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const BASE = URL_.origin;
// test.sh puts Postgres at 54330 + 10 * slot and the server at 8788 + 10 * slot.
const PG_PORT = 54330 + (Number(URL_.port) - 8788);
const PG_URL = process.env.PG_URL ?? `postgres://reliquary_mcp:test@127.0.0.1:${PG_PORT}/postgres`;
const TOKEN = "keepalive-test-token-3f9a";

const children = [];
after(() => children.forEach((c) => c.kill()));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

// Starts dist/server.js with extra env; resolves with its origin once /healthz answers.
async function startServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: PG_URL, HOST: "127.0.0.1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push(child);
  const origin = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    const up = await fetch(`${origin}/healthz`).then((r) => r.ok, () => false);
    if (up) return { origin, log: () => log };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server did not start: ${log}`);
}

async function get(url, headers = {}) {
  const r = await fetch(url, { headers });
  return { status: r.status, body: await r.text(), cache: r.headers.get("cache-control") };
}

test("healthz: plain /healthz answers ok without touching the database", async () => {
  const dead = await startServer({ DATABASE_URL: "postgres://reliquary_mcp:test@127.0.0.1:1/postgres" });
  assert.deepEqual(await get(`${dead.origin}/healthz`), { status: 200, body: "ok", cache: "no-store" });
});

test("healthz: ?db=1 runs a query and answers ok", async () => {
  const r = await get(`${BASE}/healthz?db=1`);
  assert.equal(r.status, 200);
  assert.equal(r.body, "ok");
  assert.equal(r.cache, "no-store");
});

test("healthz: ?db=1 with the database down answers 503 unavailable and nothing else", async () => {
  const dead = await startServer({ DATABASE_URL: "postgres://reliquary_mcp:test@127.0.0.1:1/postgres" });
  const r = await get(`${dead.origin}/healthz?db=1`);
  assert.equal(r.status, 503);
  assert.equal(r.body, "unavailable");
  assert.doesNotMatch(dead.log(), /ECONNREFUSED|127\.0\.0\.1:1\b/, "no error text in the log either");
});

test("healthz: with KEEPALIVE_TOKEN set, ?db=1 needs the x-keepalive header", async () => {
  const s = await startServer({ KEEPALIVE_TOKEN: TOKEN });
  const missing = await get(`${s.origin}/healthz?db=1`);
  assert.equal(missing.status, 401);
  assert.doesNotMatch(missing.body, /ok|unavailable/);
  assert.equal((await get(`${s.origin}/healthz?db=1`, { "x-keepalive": "wrong" })).status, 401);
  assert.equal((await get(`${s.origin}/healthz?db=1`, { "x-keepalive": TOKEN.slice(0, -1) })).status, 401);
  assert.equal((await get(`${s.origin}/healthz?db=1`, { "x-keepalive": `${TOKEN}x` })).status, 401);
  assert.deepEqual(await get(`${s.origin}/healthz?db=1`, { "x-keepalive": TOKEN }), {
    status: 200,
    body: "ok",
    cache: "no-store",
  });
  // Plain liveness stays open, and the token never reaches the log.
  assert.equal((await get(`${s.origin}/healthz`)).status, 200);
  assert.doesNotMatch(s.log(), new RegExp(TOKEN));
});

test("healthz: without KEEPALIVE_TOKEN, ?db=1 ignores any header", async () => {
  const r = await get(`${BASE}/healthz?db=1`, { "x-keepalive": "anything" });
  assert.equal(r.status, 200);
  assert.equal(r.body, "ok");
});

test("timeout: the MCP role's login session has a 10s statement_timeout", async () => {
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  try {
    const { rows } = await db.query("show statement_timeout");
    assert.equal(rows[0].statement_timeout, "10s");
    await db.query("begin");
    await db.query("set local role authenticated");
    const inTx = await db.query("show statement_timeout");
    assert.equal(inTx.rows[0].statement_timeout, "10s", "switching role keeps the login role's timeout");
    await db.query("rollback");
  } finally {
    await db.end();
  }
});
