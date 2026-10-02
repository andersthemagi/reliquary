// Invite-only admission over MCP: create_vault from an account nobody
// admitted reaches the agent as a clear refusal (the rules are in
// supabase/tests/admission_test.sql).
//
// Una exists only here, with an all-vaults read-write token made in
// before(). The suite's database is open (supabase/tests/support.sql); this
// file turns invite-only on in before() and off again in after(). test.sh
// runs one file at a time, so no other file sees it on.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { call as call_ } from "./mcp-client.mjs";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const SUPER = process.env.TEST_SUPER_URL;
const UNA = "00000000-0000-0000-0000-000000000ad3";
let token = "";

async function sql(q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
}

const call = (name, args = {}) => call_(URL_, token, name, args);

before(async () => {
  await sql("insert into auth.users (id, email) values ($1, 'una@example.test') on conflict (id) do nothing", [UNA]);
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: UNA, role: "authenticated" })]);
    token = (await db.query("select public.create_access_token('Una all rw', 30, null, 'write') as t")).rows[0].t;
    await db.query("commit");
  } finally {
    await db.end();
  }
  await sql("select private.set_invite_only(true)");
});

after(async () => {
  await sql("select private.set_invite_only(false)");
});

test("admission: create_vault from an account nobody admitted reaches the agent as a clear refusal, and creates nothing", async () => {
  const r = await call("create_vault", { name: "Una's own" });
  assert.equal(r.isError, true);
  const [first, second] = r.text.split("\n");
  assert.equal(first,
    "Not admitted: your account can't create vaults yet: Reliquary is invite-only during alpha. Open an invite link someone sent you and join their vault (that admits your account), or ask the operator to admit you");
  assert.match(second, /^\(what: .*; where: MCP tool create_vault.*; ref [0-9a-f]{8}\)$/);
  const [{ n }] = await sql("select count(*)::int as n from public.vaults where created_by = $1", [UNA]);
  assert.equal(n, 0);
});

test("admission: once the operator admits the account, its agent's create_vault works", async () => {
  await sql("select private.admit_account($1)", [UNA]);
  const r = await call("create_vault", { name: "Una's own" });
  assert.equal(r.isError, false, r.text);
  const [{ n }] = await sql("select count(*)::int as n from public.vaults where created_by = $1", [UNA]);
  assert.equal(n, 1);
});
