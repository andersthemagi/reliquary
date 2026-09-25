// Rate limits on the MCP endpoint (src/ratelimit.ts,
// supabase/migrations/20260925200000_rate_limits.sql), against mcp/test.sh's
// rate-limit server: 3 tool calls per 2-second window and 5 a day per token,
// 3 401s a minute per address, addresses from x-real-ip. Each test makes its
// own person's tokens (in the database, as the Tokens page does) and sends
// from addresses of its own (documentation ranges; test.sh checks none
// reaches the log).

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { before, test } from "node:test";
import pg from "pg";

const { MCP_RL_URL: URL_, TEST_SUPER_URL: SUPER } = process.env;
let n = 0;
const addr = () => `198.51.100.${(++n % 250) + 1}`;

async function sql(q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
}

// A personal token for a fresh person with a vault of their own.
async function token() {
  const user = `00000000-0000-4000-8000-${randomBytes(6).toString("hex")}`;
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    await db.query("select public.create_vault($1)", [`Rate ${user.slice(-6)}`]);
    const { rows } = await db.query("select public.create_access_token('Rate limits', 7) as t");
    await db.query("commit");
    return rows[0].t;
  } finally {
    await db.end();
  }
}

const rpc = (body, { tok, from = addr() } = {}) =>
  fetch(URL_, {
    method: "POST",
    headers: {
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-real-ip": from,
    },
    body: JSON.stringify(body),
  });
let id = 0;
const call = (tok, from) => rpc({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "list_vaults", arguments: {} } }, { tok, from });

// 429 with Retry-After, and a JSON-RPC error telling the agent to wait.
async function limited(r, { max, min = 1, rpcId = null } = {}) {
  assert.equal(r.status, 429);
  const wait = Number(r.headers.get("retry-after"));
  assert.ok(Number.isInteger(wait) && wait >= min && wait <= max, `Retry-After ${r.headers.get("retry-after")}`);
  const body = await r.json();
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.id, rpcId);
  assert.equal(body.error.code, -32029);
  assert.equal(body.error.message, `Rate limit reached. Wait ${wait} seconds, then retry.`);
  assert.equal(body.error.data.retry_after, wait);
  assert.equal(body.error.data.where, "rate limit");
  assert.match(body.error.data.ref, /^[0-9a-f]{8}$/);
  return wait;
}

// Waits for the start of the next 2-second window, so a test's calls land in one.
const nextWindow = () => new Promise((r) => setTimeout(r, 2000 - (Date.now() % 2000) + 50));

before(() => assert.ok(URL_ && SUPER, "run through mcp/test.sh (the rate-limit server)"));

test("rate limits: tool calls per token: the 4th in a window is refused with 429, Retry-After and a JSON-RPC error to wait", async () => {
  const tok = await token();
  await nextWindow();
  for (let i = 0; i < 3; i++) assert.equal((await call(tok)).status, 200);
  const r = await call(tok);
  await limited(r, { max: 2, rpcId: id });
});

test("rate limits: tool calls per token per day: past the day's 5, Retry-After waits for the day, not the window", async () => {
  const tok = await token();
  await nextWindow();
  for (let i = 0; i < 3; i++) assert.equal((await call(tok)).status, 200);
  await nextWindow();
  for (let i = 0; i < 2; i++) assert.equal((await call(tok)).status, 200);
  const wait = await limited(await call(tok), { max: 86400, rpcId: id });
  const toMidnight = 86400 - (Math.floor(Date.now() / 1000) % 86400);
  assert.ok(Math.abs(wait - toMidnight) <= 2, `waits for the day's end (${wait} s, ${toMidnight} s to midnight UTC)`);
});

test("rate limits: tool calls per token: a batch counts each call, another token is unaffected, and listing tools isn't counted", async () => {
  const tok = await token();
  const other = await token();
  await nextWindow();
  const batch = [1, 2, 3, 4].map((i) => ({ jsonrpc: "2.0", id: 1000 + i, method: "tools/call", params: { name: "list_vaults", arguments: {} } }));
  await limited(await rpc(batch, { tok }), { max: 2, rpcId: null });
  assert.equal((await call(other)).status, 200);
  for (let i = 0; i < 5; i++) assert.equal((await rpc({ jsonrpc: "2.0", id: ++id, method: "tools/list" }, { tok })).status, 200);
  assert.equal((await call(tok)).status, 200, "the refused batch counted nothing");
});

test("rate limits: 401s per address: the 4th request without a live token from one address is a 429; other addresses still get 401", async () => {
  const from = addr();
  const bogus = `rlq_${"0".repeat(64)}`;
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { from })).status, 401);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { from, tok: bogus })).status, 401);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_vaults" } }, { from, tok: bogus })).status, 401);
  await limited(await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { from }), { max: 60 });
  // Known to this instance now: refused again, without a token or with a bad one.
  await limited(await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { from }), { max: 60 });
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { from: addr() })).status, 401);
  // A live token from that address still works.
  assert.equal((await call(await token(), from)).status, 200);
});

test("rate limits: IPv6 addresses count by their /64", async () => {
  const a = "2001:db8:1:2::a";
  for (let i = 0; i < 3; i++) assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { from: a })).status, 401);
  await limited(await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { from: "2001:db8:1:2:ffff::1" }), { max: 60 });
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { from: "2001:db8:1:3::a" })).status, 401);
});

test("rate limits: with the counter out of reach, tool calls go through (fail open)", async () => {
  const tok = await token();
  await sql("revoke execute on function private.rate_limit_token(text, text[], int[], int[], int[]) from reliquary_mcp");
  try {
    await nextWindow();
    for (let i = 0; i < 6; i++) assert.equal((await call(tok)).status, 200);
  } finally {
    await sql("grant execute on function private.rate_limit_token(text, text[], int[], int[], int[]) to reliquary_mcp");
  }
});

test("rate limits: counters hold no token, hash or address: every key is 64 hex digits", async () => {
  const rows = await sql("select key from private.rate_limits");
  assert.ok(rows.length > 0);
  for (const { key } of rows) {
    assert.match(key, /^[0-9a-f]{64}$/);
  }
});
