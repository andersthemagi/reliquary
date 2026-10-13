// Review-gated steps over MCP: what an agent is told when it completes a
// `gate: review` step, and how work_plan_status and request_work show one
// awaiting review. The rules (what may be linked, who approves, what stays
// unclaimable) are proved once in supabase/tests/review_gate_test.sql;
// here only the words an agent reads, and that the database's refusal of
// a bad link reaches it.
//
// Each test makes its own vault, owned by a fresh person with a fresh
// editor, so no test sees another's steps.

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

// A vault with canon/ under review, an owner and an editor with read-write
// tokens, and a plan: `brief` (gated), `build` waiting on it.
async function team(steps = [{ key: "brief", title: "Write the brief", gate: true }, { key: "build", title: "Build it", blocked_by: "brief" }]) {
  const [owner, editor] = [0, 1].map(() => `00000000-0000-4000-8000-${randomBytes(6).toString("hex")}`);
  const name = `Gate ${owner.slice(-6)}`;
  await sql("insert into auth.users (id, email) select u, right(u::text, 12) || '@example.test' from unnest($1::uuid[]) u", [[owner, editor]]);
  const [{ v }] = await sql("select public.create_vault($1) as v", [name], owner);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [v, editor, owner]);
  await sql("select public.set_policy($1, 'canon/', 'canon', 1)", [v], owner);
  const [{ t: ownerTok }] = await sql("select public.create_access_token('Gate owner', 7) as t", [], owner);
  const [{ t: editorTok }] = await sql("select public.create_access_token('Gate editor', 7) as t", [], editor);
  const t = { vault: name, id: v, ownerTok, editorTok };
  const lines = [`${TICKS}work_plan`];
  for (const s of steps) {
    lines.push(`- key: ${s.key}`, `  title: ${s.title}`);
    if (s.blocked_by) lines.push(`  blocked_by: ${s.blocked_by}`);
    if (s.gate) lines.push("  gate: review");
  }
  lines.push(TICKS, "");
  assert.equal((await call(ownerTok, "write_file", { vault: name, path: "plan.md", content: lines.join("\n") })).isError, false);
  const r = await call(ownerTok, "register_work_plan", { vault: name, path: "plan.md" });
  assert.equal(r.isError, false, r.text);
  return t;
}

async function claim(t, key) {
  const r = await call(t.editorTok, "claim_step", { vault: t.vault, path: "plan.md", key });
  assert.equal(r.isError, false, r.text);
  return { fence: Number(/fence (\d+)/.exec(r.text)[1]), secret: /secret: ([0-9a-f]{64})/.exec(r.text)[1] };
}

const complete = (t, key, c, extra = {}) => call(t.editorTok, "complete_step", { vault: t.vault, path: "plan.md", key, ...c, ...extra });

async function propose(t, path) {
  const r = await call(t.editorTok, "propose", { vault: t.vault, path, content: "the brief", reason: "the step's work" });
  assert.equal(r.isError, false, r.text);
  return /Proposal id ([0-9a-f-]{36})/.exec(r.text)[1];
}

test("review gate: completing a gated step says it awaits review, who approves it, and that no agent can", async () => {
  const t = await team();
  const r = await complete(t, "brief", await claim(t, "brief"));
  assert.equal(r.isError, false, r.text);
  assert.equal(
    r.text,
    "Completed step brief of plan.md. It has a review gate, so it awaits review, and the steps waiting on it stay blocked until it is approved: a person who can write plan.md approves it on the Tasks page; no agent can. Tell your person.",
  );
});

test("review gate: completing with a proposal says applying it approves the step", async () => {
  const t = await team();
  const c = await claim(t, "brief");
  const id = await propose(t, "canon/brief.md");
  const r = await complete(t, "brief", c, { proposal: id });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, new RegExp(`a person who can write plan\\.md approves it on the Tasks page, or applying proposal ${id} does; no agent can\\.`));
});

test("review gate: a proposal the database won't link is refused in its words, and the step stays claimed", async () => {
  const t = await team([{ key: "plain", title: "No gate" }]);
  const c = await claim(t, "plain");
  const id = await propose(t, "canon/plain.md");
  const r = await complete(t, "plain", c, { proposal: id });
  assert.equal(r.isError, true);
  assert.match(r.text, /step "plain" has no review gate, so it takes no proposal: complete it without one/);
  assert.equal((await complete(t, "plain", c)).isError, false);
});

test("review gate: work_plan_status shows the step awaiting review, who approves it, and what waits on it", async () => {
  const t = await team();
  const c = await claim(t, "brief");
  const id = await propose(t, "canon/brief.md");
  await complete(t, "brief", c, { proposal: id });
  const r = await call(t.editorTok, "work_plan_status", { vault: t.vault, path: "plan.md" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^plan\.md: 2 steps \(1 awaiting_review, 1 blocked\)\./);
  assert.match(r.text, new RegExp(`\\nbrief  awaiting review: a person who can write plan\\.md approves it on the Tasks page, or applying proposal ${id} does; no agent can\\n`));
  assert.match(r.text, /\nbuild  blocked, waiting on brief\n/);
});

test("review gate: asking for work while the only way on awaits review is a wait that names it; with nothing after it, the plan is complete", async () => {
  const t = await team();
  await complete(t, "brief", await claim(t, "brief"));
  const r = await call(t.editorTok, "request_work", { vault: t.vault, path: "plan.md" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /^Wait: /);
  assert.match(r.text, /\nbrief  awaiting review: a person who can write plan\.md approves it on the Tasks page; no agent can\n/);
  assert.match(r.text, /\nbuild  blocked, waiting on brief\n/);

  const solo = await team([{ key: "brief", title: "Write the brief", gate: true }]);
  await complete(solo, "brief", await claim(solo, "brief"));
  const done = await call(solo.editorTok, "request_work", { vault: solo.vault, path: "plan.md" });
  assert.equal(
    done.text,
    "Plan complete: no step of plan.md is left for an agent: each is done, cancelled or awaiting a person's review. Stop asking for work here.",
  );
});
