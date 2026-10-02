// The work plan block's grammar (docs/design.md "Claims and work plans",
// item 6; CL-3.1): finding the fenced ```work_plan block in a plan file,
// parsing its steps, and refusing a malformed one with the line and
// reason. Pure parsing, no database and no server: unlike every other
// file here, this one needs neither mcp/test.sh's containers nor a
// token, just the compiled module.

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWorkPlanBlock, renderWorkPlanBlock } from "../dist/workplan-format.js";

const VERSION_A = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const VERSION_B = "1b6f8f3e-0000-4000-8000-000000000001";

function assertRefused(text, snippet) {
  const r = parseWorkPlanBlock(text);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes(snippet)), `expected an error mentioning "${snippet}", got ${JSON.stringify(r.errors)}`);
}

test("workplan_format: a valid block parses and round-trips", () => {
  const text = [
    "# A plan", "", "Some prose above the block.", "",
    "```work_plan",
    "- key: fetch-data",
    "  title: Fetch raw data from the api",
    `  cites: docs/data-source.md@${VERSION_A}`,
    "- key: clean-data",
    "  title: Clean and normalize",
    "  blocked_by: fetch-data",
    `  cites: docs/data-source.md@${VERSION_A}, docs/schema.md@${VERSION_B}`,
    "  gate: review",
    "```",
    "", "Prose below.",
  ].join("\n");

  const first = parseWorkPlanBlock(text);
  assert.equal(first.ok, true);
  assert.equal(first.plan.steps.length, 2);
  assert.equal(first.plan.steps[0].key, "fetch-data");
  assert.deepEqual(first.plan.steps[1].blockedBy, ["fetch-data"]);
  assert.deepEqual(first.plan.steps[1].cites, [
    { path: "docs/data-source.md", version: VERSION_A },
    { path: "docs/schema.md", version: VERSION_B },
  ]);
  assert.equal(first.plan.steps[1].gate, "review");
  assert.equal(first.plan.steps[0].gate, null);

  const rendered = renderWorkPlanBlock(first.plan);
  const second = parseWorkPlanBlock(rendered);
  assert.equal(second.ok, true);
  const strip = (steps) => steps.map(({ line, ...rest }) => rest);
  assert.deepEqual(strip(second.plan.steps), strip(first.plan.steps));
});

test("workplan_format: no block is refused", () => {
  assertRefused("# A plan\n\nNo fenced block here.\n", "no ```work_plan block");
});

test("workplan_format: a second block is refused, naming the first", () => {
  const text = ["```work_plan", "- key: a", "  title: A", "```", "```work_plan", "- key: b", "  title: B", "```"].join("\n");
  assertRefused(text, "a second ```work_plan block (the first opened at line 1)");
});

test("workplan_format: an unterminated block is refused at its opening line", () => {
  assertRefused(["prose", "```work_plan", "- key: a", "  title: A"].join("\n"), "line 2: unterminated");
});

test("workplan_format: a duplicate key is refused, naming both lines", () => {
  const text = ["```work_plan", "- key: a", "  title: First", "- key: a", "  title: Second", "```"].join("\n");
  assertRefused(text, 'duplicate step key "a" (first used at line 2)');
});

test("workplan_format: an unknown blocker is refused", () => {
  const text = ["```work_plan", "- key: a", "  title: A", "  blocked_by: nope", "```"].join("\n");
  assertRefused(text, 'blocked by unknown step "nope"');
});

test("workplan_format: a step can't be blocked by itself", () => {
  const text = ["```work_plan", "- key: a", "  title: A", "  blocked_by: a", "```"].join("\n");
  assertRefused(text, 'step "a" can\'t be blocked by itself');
});

test("workplan_format: a longer cycle is refused", () => {
  const text = [
    "```work_plan",
    "- key: a", "  title: A", "  blocked_by: b",
    "- key: b", "  title: B", "  blocked_by: a",
    "```",
  ].join("\n");
  assertRefused(text, "a cycle in blocked_by");
});

test("workplan_format: an unknown field is refused", () => {
  assertRefused(["```work_plan", "- key: a", "  title: A", "  owner: someone", "```"].join("\n"), 'unknown field "owner"');
});

test("workplan_format: a field repeated on one step is refused", () => {
  assertRefused(["```work_plan", "- key: a", "  title: A", "  title: B", "```"].join("\n"), 'step "a" already has a title');
});

test("workplan_format: a field before any step is refused", () => {
  assertRefused(["```work_plan", "  title: A", "```"].join("\n"), "a field before any step");
});

test("workplan_format: a step with no title is refused", () => {
  assertRefused(["```work_plan", "- key: a", "  blocked_by: a", "```"].join("\n"), 'step "a" has no title');
});

test("workplan_format: an empty title is refused, not silently dropped", () => {
  const r = parseWorkPlanBlock(["```work_plan", "- key: a", "  title:", "```"].join("\n"));
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ["line 3: title can't be empty"]);
});

test("workplan_format: a title over 200 characters is refused", () => {
  assertRefused(["```work_plan", "- key: a", `  title: ${"x".repeat(201)}`, "```"].join("\n"), "longer than 200 characters");
});

test("workplan_format: an invalid gate value is refused", () => {
  assertRefused(["```work_plan", "- key: a", "  title: A", "  gate: maybe", "```"].join("\n"), 'gate must be "review"');
});

test("workplan_format: a cites entry with no version is refused", () => {
  assertRefused(["```work_plan", "- key: a", "  title: A", "  cites: docs/x.md", "```"].join("\n"), 'cites entry "docs/x.md" isn\'t "path@version"');
});

test("workplan_format: an invalid step key is refused", () => {
  assertRefused(["```work_plan", "- key: Not_Valid", "  title: A", "```"].join("\n"), 'isn\'t a valid step key');
});
