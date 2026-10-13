// A task awaiting review in list_flags over MCP. Who is flagged, and for
// how long, is proved once in supabase/tests/review_flags_test.sql; here
// only the wiring: the flag line names the plan and the task inside the
// fence, and the response says who approves it.
//
// Its own vault and people, so its flags reach no other file's connections.

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { call as call_ } from "./mcp-client.mjs";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const SUPER = process.env.TEST_SUPER_URL;
const call = (token, name, args = {}) => call_(URL_, token, name, args);
const TICKS = "`".repeat(3);

async function sql(q, params = [], as = null) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    if (as) {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: as, role: "authenticated" })]);
    }
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

test("review flags: list_flags names the plan and the task awaiting review inside the fence, and says the person approves it on Tasks", async () => {
  const [owner, editor] = [0, 1].map(() => `00000000-0000-4000-8000-${randomBytes(6).toString("hex")}`);
  const vault = `Review flags ${owner.slice(-6)}`;
  await sql("insert into auth.users (id, email) select u, right(u::text, 12) || '@example.test' from unnest($1::uuid[]) u", [[owner, editor]]);
  const [{ v }] = await sql("select public.create_vault($1) as v", [vault], owner);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, editor, owner]);
  const [{ t: ownerTok }] = await sql("select public.create_access_token('Review flags owner', 7) as t", [], owner);
  const [{ t: editorTok }] = await sql("select public.create_access_token('Review flags editor', 7) as t", [], editor);
  const plan = [`${TICKS}work_plan`, "- key: brief", "  title: Write the brief", "  gate: review", TICKS, ""].join("\n");
  assert.equal((await call(ownerTok, "write_file", { vault, path: "plans/rf.md", content: plan })).isError, false);
  assert.equal((await call(ownerTok, "register_work_plan", { vault, path: "plans/rf.md" })).isError, false);

  const c = await call(editorTok, "claim_step", { vault, path: "plans/rf.md", key: "brief" });
  const fence = Number(/fence (\d+)/.exec(c.text)[1]);
  const secret = /secret: ([0-9a-f]{64})/.exec(c.text)[1];
  assert.equal((await call(editorTok, "complete_step", { vault, path: "plans/rf.md", key: "brief", fence, secret })).isError, false);

  const f = await call(ownerTok, "list_flags", { vault });
  assert.equal(f.isError, false, f.text);
  assert.match(
    f.text,
    /\nNOTE-([0-9a-f]{12})\n {2}\d+ {2}responsibility\/step_review {2}step\.complete plans\/rf\.md {2}by .+ {2}plan plans\/rf\.md {2}task brief: Write the brief\nEND-\1\n/,
  );
  assert.match(f.text, /\nA task awaiting review waits for your person: they approve it on the plan's page in Tasks \(no agent can\), and work_plan_status shows it\.\n/);
  assert.doesNotMatch(f.text, /cite a file that moved/);
});
