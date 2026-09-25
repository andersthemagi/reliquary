// Tool errors (docs/public/reference/errors.md): a failed call says in its
// first line what failed and why, then one compact line with what, where
// and a reference that finds the full record in the server log. Faults come
// from a test-only trigger on chosen paths in Eve's vault; every value they
// put in a failing row holds SEKRIT-, and none may reach the agent or the
// log. mcp/test.sh checks that each reference written to MCP_ERROR_REFS_FILE
// is in the server's log.

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const { EVE_HOME_RW, EVE_ALL_RO, TEST_SUPER_URL, MCP_ERROR_REFS_FILE } = process.env;
const MARK = `SEKRIT-${randomBytes(6).toString("hex")}`;
const DETAILS = /^\(what: Calling ([a-z_]+); where: ([^;]+)(?:; why: ([^;]+))?; ref ([0-9a-f]{8})\)$/;

async function call(token, name, args = {}) {
  const c = new Client({ name: "errors", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(URL_, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  try {
    const r = await c.callTool({ name, arguments: args });
    return { text: r.content.map((x) => x.text).join("\n"), isError: Boolean(r.isError) };
  } finally {
    await c.close();
  }
}

// The two lines of a tool error, the reference recorded for mcp/test.sh.
function parsed(text) {
  const [lead, details, ...rest] = text.split("\n");
  assert.equal(rest.length, 0, text);
  const m = DETAILS.exec(details);
  assert.ok(m, details);
  if (MCP_ERROR_REFS_FILE) appendFileSync(MCP_ERROR_REFS_FILE, `${m[4]}\n`);
  return { lead, tool: m[1], where: m[2], why: m[3], ref: m[4] };
}

async function sql(q) {
  const c = new pg.Client({ connectionString: TEST_SUPER_URL });
  await c.connect();
  try {
    return (await c.query(q)).rows;
  } finally {
    await c.end();
  }
}

before(async () => {
  await sql(`
    drop schema if exists test_faults_mcp cascade;
    create schema test_faults_mcp;
    create table test_faults_mcp.parent (v text primary key);
    create table test_faults_mcp.child (v text references test_faults_mcp.parent);
    create table test_faults_mcp.held (v int);
    create function test_faults_mcp.fire() returns trigger language plpgsql security definer set search_path = '' as $f$
    declare p text;
    begin
      select f.path into p from public.files f where f.id = new.file_id;
      if p = 'notes/errors-test-fk.md' then
        insert into test_faults_mcp.child values ('${MARK}-fk');
      elsif p = 'notes/errors-test-lock.md' then
        -- A real timeout from Postgres: lock_timeout is read when a wait
        -- begins, so setting it here applies to the wait below.
        perform set_config('lock_timeout', '300ms', true);
        perform 1 from test_faults_mcp.held;
      end if;
      return new;
    end $f$;
    create trigger test_fault_mcp before insert on public.file_versions for each row execute function test_faults_mcp.fire();
  `);
});

after(async () => {
  await sql("drop schema if exists test_faults_mcp cascade");
});

test("errors: a database error in a tool call says what, where, why and a reference, without the row's values", async () => {
  const r = await call(EVE_HOME_RW, "write_file", { vault: "Eve home", path: "notes/errors-test-fk.md", content: "x" });
  assert.equal(r.isError, true);
  const e = parsed(r.text);
  assert.equal(e.lead, 'Calling write_file failed: 23503 foreign key violation: insert or update on table "child" violates foreign key constraint "child_v_fkey".');
  assert.equal(e.tool, "write_file");
  assert.equal(e.where, "MCP tool write_file: database (function test_faults_mcp.fire)");
  assert.equal(e.why, undefined, "the reason is already in the first line");
  assert.equal(r.text.includes("SEKRIT"), false);
  assert.doesNotMatch(r.text, /went wrong|server_error/i);
});

test("errors: a timeout in the database names the SQLSTATE and the function that waited", async () => {
  const c = new pg.Client({ connectionString: TEST_SUPER_URL });
  await c.connect();
  try {
    await c.query("begin; lock table test_faults_mcp.held in access exclusive mode");
    const r = await call(EVE_HOME_RW, "write_file", { vault: "Eve home", path: "notes/errors-test-lock.md", content: "x" });
    assert.equal(r.isError, true);
    const e = parsed(r.text);
    assert.equal(e.lead, "Calling write_file failed: 55P03 lock timeout: waited too long for a lock another request held.");
    assert.equal(e.where, "MCP tool write_file: database (function test_faults_mcp.fire)");
  } finally {
    await c.query("rollback").catch(() => {});
    await c.end();
  }
});

test("errors: a refusal keeps its words first, with where and a reference after", async () => {
  const r = await call(EVE_ALL_RO, "write_file", { vault: "Eve home", path: "notes/errors-test-ro.md", content: "x" });
  assert.equal(r.isError, true);
  const e = parsed(r.text);
  assert.match(e.lead, /^Not allowed: /);
  assert.match(e.where, /^MCP tool write_file: database \(function [a-z_.]+\)$/);
  const missing = parsed((await call(EVE_HOME_RW, "read_file", { vault: "No such vault", path: "x" })).text);
  assert.equal(missing.lead, "No vault with that name or id is available to you. Use list_vaults to see yours.");
  assert.equal(missing.where, "MCP tool read_file: database (function private.vault_ref)");
});

test("errors: a request the server refuses before any tool runs says why, with a reference", async () => {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${EVE_HOME_RW}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: "{not json",
  });
  assert.equal(r.status, 400);
  const body = await r.json();
  assert.equal(body.error, "invalid JSON");
  assert.equal(body.where, "MCP server (request check)");
  assert.match(body.message, /failed: The request body isn’t valid JSON\.$/);
  assert.match(body.ref, /^[0-9a-f]{8}$/);
  if (MCP_ERROR_REFS_FILE) appendFileSync(MCP_ERROR_REFS_FILE, `${body.ref}\n`);
});
