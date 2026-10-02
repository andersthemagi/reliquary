// Flags over MCP (docs/design.md, "Notifications"; 20260928150000_flags.sql):
// list_flags and advance_flags format the underlying SQL functions; access
// control itself is supabase/tests/flags_test.sql's job (owner, editor,
// viewer, outsider, revoked and wrongly scoped connections, a CLI sign-in,
// an agent without a connection). This file proves the MCP wiring: the
// right categories show up, your own agent's own actions never flag
// themselves, advancing moves the watermark, and no tool watches or
// unwatches a path -- that needs the person in the web app.
//
// Seeds its own people and vault, so no other file's counts move.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { connect } from "./mcp-client.mjs";

const MCP = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
// test.sh puts Postgres at 54330 + 10 * slot and this server at 8788 + 10 * slot.
const PG_PORT = 54330 + (Number(MCP.port) - 8788);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const NIA = "00000000-0000-0000-0000-0000000000f6";
const OMAR = "00000000-0000-0000-0000-0000000000f7";

async function as(who, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    if (who.role) await db.query(`set local role ${who.role}`);
    else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.user, role: "authenticated" })]);
    }
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

let vault = "";
let proposalId = "";
let niaToken = "";
let client;

before(async () => {
  [{ id: vault }] = await as({ user: NIA }, "select public.create_vault('Flags Vault') as id");
  await as({ role: "postgres" }, "select test_support.add_member($1, $2, 'editor', $3)", [vault, OMAR, NIA]);
  await as({ user: NIA }, "select public.set_policy($1, 'canon/', 'canon', 1)", [vault]);
  await as({ user: NIA }, "select public.create_subscription($1, 'path', 'notes/') as id", [vault]);
  // The token, so its "began" cutoff (its own created_at) falls before what
  // follows: a fresh connection is still told what's waiting on its person
  // (category 3 has no such cutoff), but a working-set or subscription flag
  // needs the event to be no older than the connection itself.
  [{ t: niaToken }] = await as({ user: NIA }, "select public.create_access_token('Nia agent', 7) as t");
  [{ id: proposalId }] = await as({ user: OMAR }, "select public.propose($1, 'canon/plan.md', 'draft', 'why') as id", [vault]);
  await as({ user: OMAR }, "select public.write_file($1, 'notes/scratch.md', 'hi') as id", [vault]);
  client = await connect(MCP, niaToken, "flags-test");
});

after(async () => {
  await client?.close();
});

test("list_flags: a proposal waiting on you, and a change on a path you watch", async () => {
  const r = await call("list_flags", { vault: "Flags Vault" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /watermark was 0/);
  assert.match(r.text, /responsibility\/review\s+proposal\.open canon\/plan\.md/);
  assert.match(r.text, new RegExp(`proposal ${proposalId}`));
  assert.match(r.text, /subscription\/path\s+file\.write notes\/scratch\.md/);
  assert.match(r.text, /watching notes\//);
  assert.match(r.text, /through: \d+/);
  assert.match(r.text, /Call advance_flags\(vault, through\)/);
});

test("list_flags: your own agent's own actions never flag themselves", async () => {
  const w = await call("write_file", { vault: "Flags Vault", path: "notes/own.md", content: "mine" });
  assert.equal(w.isError, false, w.text);
  const r = await call("list_flags", { vault: "Flags Vault" });
  assert.equal(r.text.includes("notes/own.md"), false, r.text);
});

test("advance_flags: moves the watermark forward; list_flags then sees nothing new", async () => {
  const first = await call("list_flags", { vault: "Flags Vault" });
  const through = Number(/through: (\d+)/.exec(first.text)[1]);
  const adv = await call("advance_flags", { vault: "Flags Vault", through });
  assert.equal(adv.isError, false, adv.text);
  assert.match(adv.text, new RegExp(`shown through ${through}`));
  const second = await call("list_flags", { vault: "Flags Vault" });
  assert.match(second.text, /No new flags/);
});

test("advance_flags: refuses to move past the vault's latest entry", async () => {
  const r = await call("advance_flags", { vault: "Flags Vault", through: 999_999 });
  assert.equal(r.isError, true);
  assert.match(r.text, /latest entry/);
});

test("list_subscriptions: what you watch, and no tool watches or unwatches for you", async () => {
  const r = await call("list_subscriptions", { vault: "Flags Vault" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^notes\/  since /m);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names.filter((n) => /subscri|watch/.test(n)), ["list_subscriptions"]);
});

test("list_flags and advance_flags: no MCP tool can decide a proposal", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names.filter((n) => /decide|approve/.test(n)), []);
});
