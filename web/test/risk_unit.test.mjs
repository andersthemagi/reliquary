// What a proposal's risk flags say (src/risk.ts): computed from the line
// diff the reviewer sees, with a short label for list rows and a sentence
// for the proposal page. No server needed.

import assert from "node:assert/strict";
import { test } from "node:test";

const { risks, lineChanges } = await import("../dist/risk.js");

const change = (current_body, body, revision = 1) => ({ kind: "write", current_body, body, revision });
const PRICING = "# Pricing\nDay rate: 800 EUR\nNet 30\nTravel billed at cost";

test("risk: editing two lines of a four-line file rewrites them, it doesn't remove them", () => {
  const r = risks(change(PRICING, "# Pricing\nDay rate: 900 EUR\nNet 45\nTravel billed at cost"));
  assert.equal(r.some((x) => /^Removes/.test(x.short)), false);
  assert.deepEqual(r, [
    { short: "Rewrites 2 of 4 lines", long: "Rewrites 2 of the file’s 4 lines: read each change." },
  ]);
  assert.deepEqual(lineChanges(PRICING, "# Pricing\nDay rate: 900 EUR\nNet 45\nTravel billed at cost"), {
    total: 4,
    removed: 0,
    rewritten: 2,
  });
});

test("risk: removing half or more of the lines, with nothing in their place, says so", () => {
  assert.deepEqual(risks(change(PRICING, "# Pricing\nNet 30")), [
    { short: "Removes 2 of 4 lines", long: "Removes 2 of the file’s 4 lines, with nothing in their place." },
  ]);
  // Replaced by fewer lines: only the lines not replaced count as removed.
  const r = risks(change(PRICING, "# Pricing\nAsk us."));
  assert.deepEqual(r.map((x) => x.short), ["Removes 2 of 4 lines"]);
  assert.deepEqual(lineChanges(PRICING, "# Pricing\nAsk us."), { total: 4, removed: 2, rewritten: 1 });
});

test("risk: a rewrite that also removes lines names both", () => {
  const r = risks(change("a\nb\nc\nd\ne\nf", "a\nB\nC\nf"));
  assert.deepEqual(r, [{ short: "Rewrites 4 of 6 lines", long: "Rewrites 4 of the file’s 6 lines (2 removed): read each change." }]);
});

test("risk: small edits, additions and small files raise nothing", () => {
  assert.deepEqual(risks(change(PRICING, `${PRICING}\nPayment by transfer`)), []);
  assert.deepEqual(risks(change(PRICING, PRICING.replace("800", "900"))), []);
  assert.deepEqual(risks(change("one\ntwo\nthree", "")), [], "under four lines, half of it means little");
  // Blank lines don't count either way.
  assert.deepEqual(risks(change("a\n\n\n\nb\n\nc\n\nd", "a\nb\nc\nd")), []);
});

test("risk: creating a file is not a risk; deleting one is", () => {
  assert.deepEqual(risks({ kind: "write", current_body: null, body: "new", revision: 1 }), []);
  assert.deepEqual(risks({ kind: "delete", current_body: PRICING, body: null, revision: 1 }), [
    { short: "Deletes the file", long: "Approving deletes the file. Its history stays in the log." },
  ]);
});

test("risk: a revised proposal says how often, and that earlier approvals don't count", () => {
  assert.deepEqual(risks(change(PRICING, PRICING, 2)), [
    { short: "Revised once", long: "Revised once since it was proposed; approvals of earlier revisions don’t count." },
  ]);
  assert.equal(risks(change(PRICING, PRICING, 4))[0].short, "Revised 3 times");
});

test("risk: extra facts from the page come last, in the same shape", () => {
  const extra = { short: "First proposal from Claude Code", long: "First proposal from Claude Code in this vault." };
  assert.deepEqual(risks({ kind: "delete", current_body: "x", body: null, revision: 2 }, [extra]).map((x) => x.short), [
    "Deletes the file",
    "Revised once",
    "First proposal from Claude Code",
  ]);
});

test("risk: past the diff's size cap, only a net loss of lines counts as removed", () => {
  const big = Array.from({ length: 40_000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const half = big.split("\n").slice(0, 15_000).join("\n");
  assert.deepEqual(lineChanges(big, half), { total: 40_000, removed: 25_000, rewritten: 0 });
  assert.deepEqual(risks(change(big, half)).map((x) => x.short), ["Removes 25000 of 40000 lines"]);
});
