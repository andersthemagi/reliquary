// A registered plan gains new steps over MCP (register_work_plan on a newer
// version of the plan file, issue #262): what an agent is told. Which
// changes are refused, the kept states and the stored counts are proved in
// supabase/tests/work_plan_gains_steps_test.sql; here, that the answer
// names the new steps, a refusal names the steps at fault in words, and
// work_plan_status says who added steps last.
//
// Seed: test/seed.sql's "Team" vault (Ben editor, Cal viewer). Each test
// uses its own path.

import assert from "node:assert/strict";
import { test } from "node:test";
import { call as call_ } from "./mcp-client.mjs";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const { BEN_TOKEN, CAL_TOKEN } = process.env;
const call = (token, name, args = {}) => call_(URL_, token, name, args);
const TICKS = "`".repeat(3);

function planFile(steps) {
  const lines = ["# A plan", "", `${TICKS}work_plan`];
  for (const s of steps) {
    lines.push(`- key: ${s.key}`, `  title: ${s.title}`);
    if (s.blockedBy) lines.push(`  blocked_by: ${s.blockedBy}`);
  }
  lines.push(TICKS, "");
  return lines.join("\n");
}
async function putPlan(path, steps) {
  const w = await call(BEN_TOKEN, "write_file", { vault: "Team", path, content: planFile(steps) });
  assert.equal(w.isError, false, w.text);
  return /^version: (\S+)$/m.exec((await call(BEN_TOKEN, "read_file", { vault: "Team", path })).text)[1];
}
const register = (path) => call(BEN_TOKEN, "register_work_plan", { vault: "Team", path });
const status = (path) => call(CAL_TOKEN, "work_plan_status", { vault: "Team", path });

const FIRST = [
  { key: "fetch", title: "Fetch the data" },
  { key: "clean", title: "Clean it", blockedBy: "fetch" },
];

test("gains steps: registering a newer plan file adds its new steps, names them, and status says who added them", async () => {
  const path = "plans/gs-adds.md";
  await putPlan(path, FIRST);
  assert.equal((await register(path)).isError, false);
  const v2 = await putPlan(path, [...FIRST, { key: "chart", title: "Chart it", blockedBy: "clean" }, { key: "tidy", title: "Tidy up" }]);

  const r = await register(path);
  assert.equal(r.isError, false, r.text);
  assert.equal(
    r.text,
    `Updated the work plan at ${path} to version ${v2}: 2 new steps (chart, tidy), and the 2 registered keep their state. Call work_plan_status to see which are ready.`,
  );
  const s = await status(path);
  assert.match(
    s.text,
    new RegExp(`^${path}: 4 steps \\(2 ready, 2 blocked\\)\\. Registered by p1 at \\S+Z; steps last added by p1 at \\S+Z, from version ${v2}\\.\\n`),
  );
  assert.match(s.text, /\nchart {2}blocked, waiting on clean\n/);
});

test("gains steps: a step removed from the file or changed in it is refused by name, and nothing is added", async () => {
  const path = "plans/gs-refused.md";
  await putPlan(path, FIRST);
  assert.equal((await register(path)).isError, false);

  await putPlan(path, [FIRST[0], { key: "new", title: "New" }]);
  const removed = await register(path);
  assert.equal(removed.isError, true);
  assert.match(removed.text, /^a registered plan only gains steps, and these registered steps are missing from the file: clean\. Put them back, then register it again/);

  await putPlan(path, [FIRST[0], { ...FIRST[1], title: "Scrub it" }, { key: "new", title: "New" }]);
  const changed = await register(path);
  assert.equal(changed.isError, true);
  assert.match(changed.text, /^steps already registered can't change, and these differ from the plan as registered \(title, gate, blocked_by, cites, due, priority, notes or for\): clean\. Put them back as registered; only new steps can be added/);
  assert.match((await status(path)).text, new RegExp(`^${path}: 2 steps `));
});

test("gains steps: registering the version already registered is refused in words", async () => {
  const path = "plans/gs-same.md";
  await putPlan(path, FIRST);
  assert.equal((await register(path)).isError, false);
  const again = await register(path);
  assert.equal(again.isError, true);
  assert.match(again.text, /^plans\/gs-same\.md is already registered from this version: change the file to add steps, then register it again/);
});
