// Lists that stop short say so and say how to go on: list_proposals shows the
// newest 100, list_my_feedback the newest 20, list_variables 2000 values. A
// list that cut itself without a word read as complete, and what lay past the
// cut could not be reached at all. The caps are the tools' own; the
// pagination is the tools', not the database's, so this seeds more rows than
// a cap and follows the tool's own words to the end.
//
// Seeds its own people and vault (Pam owns Limits; Quinn, an editor, proposes
// into it), so no other file's counts move.

import assert from "node:assert/strict";
import { before, test } from "node:test";
import pg from "pg";
import { call } from "./mcp-client.mjs";

const MCP = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const { TEST_SUPER_URL: SUPER } = process.env;
const PAM = "00000000-0000-0000-0000-0000fe120001";
const QUINN = "00000000-0000-0000-0000-0000fe120002";
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

async function sql(q, params = [], who = null) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    if (who) {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who, role: "authenticated" })]);
    }
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

let pam;
before(async () => {
  await sql("insert into auth.users (id, email) values ($1, 'pam@example.test'), ($2, 'quinn@example.test') on conflict do nothing", [PAM, QUINN]);
  await sql("select private.set_account_plan($1, 'alpha_tester')", [PAM]);
  const [{ id }] = await sql("select public.create_vault('Limits') as id", [], PAM);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [id, QUINN, PAM]);
  await sql("select public.set_policy($1, 'canon/', 'canon', 1)", [id], PAM);
  await sql("select public.propose($1, 'canon/p' || g || '.md', 'text', 'why') from generate_series(1, 101) g", [id], QUINN);
  await sql(
    `insert into public.feedback (user_id, kind, message, source, agent, created_at)
     select $1, 'idea', 'idea ' || g, 'agent', 'Limits agent', now() - g * interval '1 minute' from generate_series(1, 21) g`,
    [PAM],
  );
  await sql("insert into public.variables (vault_id, name, created_by) select $1, 'V' || lpad(g::text, 4, '0'), $2 from generate_series(1, 2001) g", [id, PAM]);
  await sql(
    "insert into public.variable_values (variable_id, vault_id, environment, updated_by) select id, vault_id, 'development', created_by from public.variables where vault_id = $1",
    [id],
  );
  await sql(
    "insert into public.env_imports (vault_id, environments, names, source, created_by, expires_at) select $1, array['development'], array['V0001'], 'cli', $2, now() + interval '1 day' from generate_series(1, 21)",
    [id, PAM],
  );
  pam = (await sql("select public.create_access_token('Pam rw', 30, null, 'write') as t", [], PAM))[0].t;
});

test("limits: list_proposals says when it showed only the newest 100, and before= goes on from the last one", async () => {
  const first = await call(MCP, pam, "list_proposals", { vault: "Limits" });
  assert.equal(first.isError, false, first.text);
  const ids = [...first.text.matchAll(new RegExp(`^(${ID})  write `, "gm"))].map((m) => m[1]);
  assert.equal(ids.length, 100);
  const more = new RegExp(`^more: the newest 100 are shown; pass before=(${ID}) for older ones\\.$`, "m").exec(first.text);
  assert.ok(more, "the cut is announced");
  assert.equal(more[1], ids[99]);
  const rest = await call(MCP, pam, "list_proposals", { vault: "Limits", before: more[1] });
  assert.equal(rest.isError, false, rest.text);
  const older = [...rest.text.matchAll(new RegExp(`^(${ID})  write `, "gm"))].map((m) => m[1]);
  assert.equal(older.length, 1);
  assert.equal(ids.includes(older[0]), false);
  assert.doesNotMatch(rest.text, /^more:/m);
  assert.equal((await call(MCP, pam, "list_proposals", { vault: "Limits", before: older[0] })).text, "No older proposals.");
});

test("limits: list_my_feedback says when it showed only the newest 20, and before= goes on from the last one", async () => {
  const first = await call(MCP, pam, "list_my_feedback");
  assert.equal(first.isError, false, first.text);
  assert.match(first.text, /^20 newest first\./);
  const more = new RegExp(`^more: the newest 20 are shown; pass before=(${ID}) for older ones\\.$`, "m").exec(first.text);
  assert.ok(more, "the cut is announced");
  const rest = await call(MCP, pam, "list_my_feedback", { before: more[1] });
  assert.equal(rest.isError, false, rest.text);
  assert.match(rest.text, /^1 newest first\./);
  assert.match(rest.text, /idea 21/);
  assert.doesNotMatch(rest.text, /^more:/m);
});

test("limits: list_variables says when it showed only 2000 values, and after= goes on from the last name shown", async () => {
  const first = await call(MCP, pam, "list_variables", { vault: "Limits" });
  assert.equal(first.isError, false, first.text);
  const names = [...first.text.matchAll(/^(V\d{4})$/gm)].map((m) => m[1]);
  assert.equal(names.length, 2000);
  assert.match(first.text, /^more: pass after="V2000" for the variables after V2000\.$/m);
  assert.equal(names.includes("V2001"), false);
  const rest = await call(MCP, pam, "list_variables", { vault: "Limits", after: "V2000" });
  assert.equal(rest.isError, false, rest.text);
  assert.deepEqual([...rest.text.matchAll(/^(V\d{4})$/gm)].map((m) => m[1]), ["V2001"]);
  assert.doesNotMatch(rest.text, /^more:/m);
});

test("limits: list_variables says when more pushes wait for a person than the 20 it lists", async () => {
  const r = await call(MCP, pam, "list_variables", { vault: "Limits", environment: "development", after: "V2000" });
  assert.equal(r.isError, false, r.text);
  assert.equal([...r.text.matchAll(/^ {2}development: V0001 \(sent /gm)].length, 20, "twenty pushes are listed");
  assert.match(r.text, /^ {2}\.\.\. and more are waiting than the 20 shown\.$/m);
});
