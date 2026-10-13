// The "canon moved" signal over MCP: what an agent sees in work_plan_status
// and list_flags once a file a step cites has a newer version. Which steps
// move and who is flagged is proved once, in SQL
// (supabase/tests/canon_moved_test.sql); here, only the wiring: the state
// line says so outside the fence, the moved path stays inside it, and the
// flag names the plan to read.
//
// Its own vault and people (Pia registers, Quin edits the cited file), so
// the flags it raises reach no other file's connections.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import pg from "pg";
import { connect } from "./mcp-client.mjs";

const MCP = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const PG_PORT = 54330 + (Number(MCP.port) - 8788);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const PIA = "00000000-0000-0000-0000-000000c3a601";
const QUIN = "00000000-0000-0000-0000-000000c3a602";
const VAULT = "Canon Moved Vault";
const TICKS = "`".repeat(3);

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

let vault = "";
let client;
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: { vault: VAULT, ...args } });
  return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
}

// Writes `path` as Quin and returns its new version.
async function quinWrites(path, content) {
  await as({ user: QUIN }, "select public.write_file($1, $2, $3)", [vault, path, content]);
  return (await as({ role: "postgres" }, "select current_version_id as v from public.files where vault_id = $1 and path = $2", [vault, path]))[0].v;
}

// A plan at `plan` whose one step cites `cited` at `version`, registered by Pia.
async function planCiting(plan, cited, version) {
  const body = ["# Plan", "", `${TICKS}work_plan`, "- key: use-it", "  title: Use the note", `  cites: ${cited}@${version}`, TICKS, ""].join("\n");
  assert.equal((await call("write_file", { path: plan, content: body })).isError, false);
  const r = await call("register_work_plan", { path: plan });
  assert.equal(r.isError, false, r.text);
}

before(async () => {
  [{ id: vault }] = await as({ user: PIA }, `select public.create_vault('${VAULT}') as id`);
  await as({ role: "postgres" }, "select test_support.add_member($1, $2, 'editor', $3)", [vault, QUIN, PIA]);
  const [{ t }] = await as({ user: PIA }, "select public.create_access_token('Pia agent', 7) as t");
  client = await connect(MCP, t, "canon-moved-test");
});

after(async () => {
  await client?.close();
});

test("canon moved: a step citing a file that has a newer version reads as context moved, naming the file inside the fence", async () => {
  const v1 = await quinWrites("notes/cm-status.md", "first");
  await planCiting("plans/cm-status.md", "notes/cm-status.md", v1);
  assert.doesNotMatch((await call("work_plan_status", { path: "plans/cm-status.md" })).text, /context moved/);

  await quinWrites("notes/cm-status.md", "second");
  const s = await call("work_plan_status", { path: "plans/cm-status.md" });
  assert.equal(s.isError, false, s.text);
  assert.match(
    s.text,
    new RegExp(`\\nuse-it {2}ready, context moved \\(1 cited file has a newer version\\)\\nNOTE-([0-9a-f]{12})\\nUse the note\\ncites: notes/cm-status\\.md@${v1}\\nmoved: notes/cm-status\\.md\\nEND-\\1`),
  );
});

test("canon moved: list_flags tells the plan's registrant which file moved and which plan cites it", async () => {
  const v1 = await quinWrites("notes/cm-flag.md", "first");
  await planCiting("plans/cm-flag.md", "notes/cm-flag.md", v1);
  const before = await call("list_flags", { limit: 200 });
  await call("advance_flags", { through: Number(/through: (\d+)/.exec(before.text)[1]) });

  await quinWrites("notes/cm-flag.md", "second");
  const f = await call("list_flags", { limit: 200 });
  assert.equal(f.isError, false, f.text);
  assert.match(f.text, /\n {2}\d+ {2}working_set\/cite_moved {2}file\.write notes\/cm-flag\.md {2}by .+ {2}plan plans\/cm-flag\.md\n/);
  assert.match(f.text, /\nwork_plan_status shows which steps of a plan cite a file that moved\.\n/);
});
