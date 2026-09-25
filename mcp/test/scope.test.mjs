// Scoped, expiring tokens over MCP. The database enforces scope and access
// (supabase/migrations/20260924160000_token_scope.sql); these check that the
// server passes the token through and that agents see the result.
// Seed: the "Token scope" block at the end of test/seed.sql.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const env = process.env;
const ANA = "00000000-0000-0000-0000-00000000000a";

// test.sh puts Postgres 54330 + 10 * slot and the server 8788 + 10 * slot.
const PG_URL =
  env.PG_URL ?? `postgres://reliquary_mcp:test@127.0.0.1:${54330 + (Number(URL_.port) - 8788)}/postgres`;

async function connect(token, name = "scope-test") {
  const client = new Client({ name, version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(URL_, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
}

// An error's reference differs per call, and its details name the tool
// (failure.ts); everything else must be the same as for a missing vault.
const REF = /ref [0-9a-f]{8}/;
const ANY_TOOL = /(Calling|MCP tool) [a-z_]+/g;

// Ana's own view of her tokens, as the web UI sees it (person, no agent).
async function asAna(sql, params = []) {
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ANA })]);
    const { rows } = await db.query(sql, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

const tools = (token) =>
  fetch(URL_, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

test("read-only: lists only its vault, as a viewer", async () => {
  const c = await connect(env.ANA_TEAM_RO);
  const r = await call(c, "list_vaults");
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Team \(viewer\) id=/);
  assert.doesNotMatch(r.text, /Workshop/);
  await c.close();
});

test("read-only: reads and searches", async () => {
  const c = await connect(env.ANA_TEAM_RO);
  const r = await call(c, "read_file", { vault: "Team", path: "notes/standup.md" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Standup is at 10:00/);
  assert.match((await call(c, "search", { vault: "Team", query: "standup" })).text, /notes\/standup\.md/);
  await c.close();
});

test("read-only: cannot write, propose, delete or revise", async () => {
  const c = await connect(env.ANA_TEAM_RO);
  const w = await call(c, "write_file", { vault: "Team", path: "notes/ro.md", content: "x" });
  assert.equal(w.isError, true);
  assert.match(w.text, /Not allowed/);
  const p = await call(c, "propose", { vault: "Team", path: "canon/ro.md", content: "x", reason: "x" });
  assert.equal(p.isError, true);
  const d = await call(c, "propose", { vault: "Team", path: "notes/standup.md", reason: "x", delete: true });
  assert.equal(d.isError, true);
  const v = await call(c, "revise_proposal", { proposal_id: env.CHANGES_PROPOSAL, content: "x" });
  assert.equal(v.isError, true);
  assert.doesNotMatch((await call(c, "list_files", { vault: "Team" })).text, /notes\/ro\.md/);
  await c.close();
});

test("scoped: a token for Workshop cannot see Team at all", async () => {
  const c = await connect(env.ANA_WS_RW);
  const vaults = await call(c, "list_vaults");
  assert.match(vaults.text, /^Workshop \(owner\) id=/);
  assert.doesNotMatch(vaults.text, /Team/);
  const missing = await call(c, "read_file", { vault: "00000000-0000-0000-0000-000000000000", path: "x" });
  for (const vault of ["Team", env.TEAM_VAULT]) {
    assert.equal((await call(c, "read_file", { vault, path: "notes/standup.md" })).text.replace(ANY_TOOL, "$1 x").replace(REF, "ref"), missing.text.replace(ANY_TOOL, "$1 x").replace(REF, "ref"));
    assert.equal((await call(c, "search", { vault, query: "standup" })).text.replace(ANY_TOOL, "$1 x").replace(REF, "ref"), missing.text.replace(ANY_TOOL, "$1 x").replace(REF, "ref"));
    assert.equal((await call(c, "changes_since", { vault })).text.replace(ANY_TOOL, "$1 x").replace(REF, "ref"), missing.text.replace(ANY_TOOL, "$1 x").replace(REF, "ref"));
    assert.equal((await call(c, "list_proposals", { vault })).text.replace(ANY_TOOL, "$1 x").replace(REF, "ref"), missing.text.replace(ANY_TOOL, "$1 x").replace(REF, "ref"));
    assert.equal((await call(c, "write_file", { vault, path: "notes/ws.md", content: "x" })).text.replace(ANY_TOOL, "$1 x").replace(REF, "ref"), missing.text.replace(ANY_TOOL, "$1 x").replace(REF, "ref"));
  }
  await c.close();
});

test("scoped: a read-write token writes in its own vault", async () => {
  const c = await connect(env.ANA_WS_RW);
  const w = await call(c, "write_file", { vault: "Workshop", path: "notes/bench.md", content: "Bench is oak." });
  assert.equal(w.isError, false, w.text);
  const log = await call(c, "changes_since", { vault: "Workshop" });
  assert.match(log.text, /file\.write notes\/bench\.md\s+by \S+ via Workshop writer/);
  await c.close();
});

test("client name and last use are recorded for the Tokens page", async () => {
  const c = await connect(env.ANA_WS_RW, "Scope Test Client");
  await call(c, "list_vaults");
  await c.close();
  const [row] = await asAna(
    "select client_name, last_used_at from public.access_tokens where name = 'Workshop writer'",
  );
  assert.equal(row.client_name, "Scope Test Client");
  assert.ok(Date.now() - row.last_used_at.getTime() < 60_000);
});

test("revoked mid-session: the next request is refused", async () => {
  const c = await connect(env.ANA_REVOKE);
  assert.equal((await call(c, "list_vaults")).isError, false);
  const [{ id }] = await asAna("select id from public.access_tokens where name = 'To revoke'");
  await asAna("select public.revoke_access_token($1)", [id]);
  assert.equal((await tools(env.ANA_REVOKE)).status, 401);
  await assert.rejects(call(c, "list_vaults"));
  await c.close().catch(() => {});
});

test("expired: refused before any tool runs", async () => {
  assert.equal((await tools(env.ANA_EXPIRED)).status, 401);
});
