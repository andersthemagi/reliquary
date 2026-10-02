// An agent's delete proposal over MCP: `propose` with `delete: true` on a
// canon file leaves the file in place until a person approves, and then it
// is gone. The database rules are in supabase/tests/delete_test.sql.
//
// Seeds its own person (Pia) and vault straight in the database, so no other
// file's counts move. The approval is Pia's, as the person (no act claim),
// the way the web UI decides.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { connect } from "./mcp-client.mjs";

const MCP = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
// test.sh puts Postgres at 54330 + 10 * slot and this server at 8788 + 10 * slot.
const PG_PORT = 54330 + (Number(MCP.port) - 8788);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const PIA = "00000000-0000-0000-0000-0000000001a8";
const VAULT = "Pia delete";

let vault = "";
let client;

async function asPia(q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: PIA, role: "authenticated" })]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
}

before(async () => {
  [{ id: vault }] = await asPia("select public.create_vault($1, 'open') as id", [VAULT]);
  await asPia("select public.set_policy($1, 'canon/', 'canon', 1)", [vault]);
  const [{ id: first }] = await asPia("select public.propose($1, 'canon/old-rates.md', 'Old rates.', 'first') as id", [vault]);
  await asPia("select public.decide($1, 'approve')", [first]);
  const [{ t }] = await asPia("select public.create_access_token('Pia agent', 7) as t");
  client = await connect(MCP, t, "propose-delete");
});

after(async () => {
  await client?.close();
});

let proposal = "";

test("propose delete: an agent proposes deleting a canon file, and the file stays until a person approves", async () => {
  const r = await call("propose", { vault: VAULT, path: "canon/old-rates.md", delete: true, reason: "superseded" });
  assert.equal(r.isError, false, r.text);
  const m = r.text.match(/^Proposed\. Proposal id ([0-9a-f-]{36})\. It is waiting for people to approve it\.$/);
  assert.ok(m, r.text);
  proposal = m[1];
  const read = await call("read_file", { vault: VAULT, path: "canon/old-rates.md" });
  assert.equal(read.isError, false, read.text);
  assert.match(read.text, /Old rates\./);
  assert.match((await call("list_files", { vault: VAULT })).text, /canon\/old-rates\.md/);
  const open = await call("list_proposals", { vault: VAULT });
  assert.match(open.text, new RegExp(proposal));
});

test("propose delete: a person approves, and the file is gone from read_file, list_files and the log says so", async () => {
  assert.ok(proposal, "the proposal from the previous test");
  await asPia("select public.decide($1, 'approve')", [proposal]);
  assert.equal((await call("read_file", { vault: VAULT, path: "canon/old-rates.md" })).isError, true);
  assert.doesNotMatch((await call("list_files", { vault: VAULT })).text, /canon\/old-rates\.md/);
  assert.match((await call("changes_since", { vault: VAULT })).text, /file\.delete canon\/old-rates\.md/);
  assert.match((await call("list_proposals", { vault: VAULT, status: "applied" })).text, new RegExp(proposal));
});

test("propose delete: without delete or content, propose refuses", async () => {
  const r = await call("propose", { vault: VAULT, path: "canon/nothing.md", reason: "empty" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Give content, or set delete to true\./);
});
