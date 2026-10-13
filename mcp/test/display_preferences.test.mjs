// How an agent sees people (20261014150000_display_preferences.sql): the
// "people:" line of a tool's answer names each person by display name and
// tag, from public.co_member_people, and never an email, whatever the
// person chose. The rule itself is proved in
// supabase/tests/display_preferences_test.sql; this checks what an agent
// is actually sent.
//
// Its own vault, "Shown As": Ivy owns it and writes in it, Ana (whose seed
// token the agent uses) is an editor.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import pg from "pg";
import { call as call_ } from "./mcp-client.mjs";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const { ANA_TOKEN, TEST_SUPER_URL: SUPER } = process.env;
const ANA = "00000000-0000-0000-0000-00000000000a";
const IVY = "e1000000-0000-0000-0000-0000000000e1";
const call = (name, args = {}) => call_(URL_, ANA_TOKEN, name, args);

async function as(user, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("insert into auth.users (id, email) values ($1, 'ivy@example.test') on conflict (id) do nothing", [IVY]);
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

const people = async () => {
  const r = await call("changes_since", { vault: "Shown As" });
  assert.equal(r.isError, false, r.text);
  return /^people: .*$/m.exec(r.text)[0];
};

before(async () => {
  const [{ id }] = await as(IVY, "select public.create_vault('Shown As') as id");
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("select test_support.add_member($1, $2, 'editor', $3)", [id, ANA, IVY]);
  } finally {
    await db.end();
  }
  await as(IVY, "select public.write_file($1, 'notes/ivy.md', 'From Ivy.')", [id]);
  await as(IVY, "select public.set_display_name('Ivy')");
});

test("display: an agent sees a co-member who shows their email by name and tag, never the email", async () => {
  const r = await call("changes_since", { vault: "Shown As" });
  assert.match(await people(), new RegExp(`=${IVY} "Ivy · e1000000"`));
  assert.ok(!r.text.includes("ivy@example.test"), r.text);
});

test("display: nor of a member who hides their email", async () => {
  await as(IVY, "select public.set_email_shown(false)");
  const r = await call("changes_since", { vault: "Shown As" });
  assert.match(r.text, new RegExp(`=${IVY} "Ivy · e1000000"`));
  assert.ok(!r.text.includes("ivy@example.test"), r.text);
});
