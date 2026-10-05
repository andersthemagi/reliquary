// A proposal's page while it still waits (src/proposals.ts): what the Revise
// form's reason field does to the proposal's reason, and what the page says
// when its file has moved on since it was proposed. Who may decide or revise
// is the database's (supabase/tests/review_test.sql); this file is about what
// a person reads and is offered.
//
// This file starts its own server and seeds its own vault ("Live Desk"):
// Una owns it and proposes as herself; canon/ needs one approval, pair/ two
// (Vic edits).

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { as, csrfOf, flashOf, get, page, post, sql, start } from "./threads-harness.mjs";

const UNA = "c9000000-0000-0000-0000-0000000000d2";
const VIC = "c9000000-0000-0000-0000-0000000000d3";
const VAULT = "Live Desk";

let V = "";
let una;
const P = {};

const propose = (path, body, reason) => as(UNA, "select public.propose($1, $2, $3, $4) as id", [V, path, body, reason]).then((r) => r[0].id);
const pp = (pid, rest = "") => `/v/${V}/proposals/${pid}${rest}`;
const decide = (user, pid) => as(user, "select public.decide($1, 'approve', null)", [pid]);
const status = async (pid) => (await sql("select status from public.proposals where id = $1", [pid]))[0].status;
const at = (h, x) => {
  const i = h.indexOf(x);
  assert.ok(i >= 0, `missing ${x}`);
  return i;
};
const form = async (path, fields) => post(una, path, { csrf: csrfOf(await page(una, "/settings")), ...fields });
// What the proposal's page gives as its reason.
const reasonOf = async (pid) => /<blockquote class="claim">([^<]*)<\/blockquote>/.exec(await page(una, pp(pid)))?.[1];

before(async () => {
  await sql(`insert into auth.users (id, email) values ($1, 'una@example.test'), ($2, 'vic@example.test') on conflict (id) do nothing`, [UNA, VIC]);
  [{ id: V }] = await as(UNA, "select public.create_vault($1) as id", [VAULT]);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V, VIC, UNA]);
  for (const f of ["canon/replace.md", "canon/keep.md", "canon/moved.md", "canon/fresh.md", "pair/x.md"]) {
    await as(UNA, "select public.write_file($1, $2, 'Base.')", [V, f]);
  }
  await as(UNA, "select public.set_policy($1, 'canon/', 'canon', 1)", [V]);
  await as(UNA, "select public.set_policy($1, 'pair/', 'canon', 2)", [V]);
  P.replace = await propose("canon/replace.md", "Base, proposed.", "Original why.");
  P.keep = await propose("canon/keep.md", "Base, proposed.", "Original why.");
  P.fresh = await propose("canon/fresh.md", "Base, proposed.", "Still current.");

  // Each file moves when its first proposal applies; the later ones, made
  // against the version before, are left open.
  const first = await propose("canon/moved.md", "Base, first.", "Goes first.");
  P.moved = await propose("canon/moved.md", "Base, second.", "Made against the old version.");
  P.crafted = await propose("canon/moved.md", "Base, third.", "Approved anyway.");
  await decide(UNA, first);
  const created = await propose("canon/late.md", "Late, first.", "Creates it.");
  P.late = await propose("canon/late.md", "Late, second.", "Meant to create it.");
  await decide(UNA, created);
  const pair = await propose("pair/x.md", "Pair, first.", "Needs two.");
  P.pair = await propose("pair/x.md", "Pair, second.", "Made against the old version.");
  await decide(UNA, pair);
  await decide(VIC, pair);
  await decide(UNA, P.pair);
  una = await start(UNA, "una");
});

after(async () => {
  una?.child?.kill();
  await as(UNA, "select public.delete_vault($1, $2)", [V, VAULT]).catch(() => {});
  await sql("delete from private.vault_deletion_notices where user_id = any($1)", [[UNA, VIC]]);
});

test("revise reason: the field says it replaces the old reason and how to keep it", async () => {
  const h = await page(una, pp(P.replace, "/revise"));
  assert.match(h, /<label for="reason">New reason \(replaces the old one; leave empty to keep it\)<\/label>\s*<p class="hint" id="reason-hint">/);
  assert.match(h, /<input id="reason" type="text" name="reason" aria-describedby="reason-hint">/);
  assert.doesNotMatch(h, /Optional, for the reviewers/);
});

test("revise reason: a new reason replaces the one the proposal's page shows", async () => {
  const r = await form(pp(P.replace, "/revise"), { content: "Base, revised.", reason: "Because of the audit." });
  assert.equal(r.status, 303);
  assert.equal(await reasonOf(P.replace), "Because of the audit.");
});

test("revise reason: leaving it empty keeps the old reason", async () => {
  const r = await form(pp(P.keep, "/revise"), { content: "Base, revised.", reason: "" });
  assert.equal(r.status, 303);
  assert.equal(await reasonOf(P.keep), "Original why.");
});

const WARNING = /<div class="callout warning"><p>The file changed after this was proposed\. Approving it would mark it stale instead of applying it/;

test("moved file: an open proposal whose file changed after it was proposed says so above the decision, and offers Reject, not Approve", async () => {
  const h = await page(una, pp(P.moved));
  assert.match(h, WARNING);
  assert.ok(at(h, "callout warning") < at(h, "/decide"), "the warning is above the decision");
  const decision = /<form method="post" action="[^"]+\/decide"[\s\S]*?<\/form>/.exec(h)[0];
  assert.match(decision, /value="reject">Reject<\/button>/);
  assert.doesNotMatch(decision, /value="approve"|value="request_changes"/);
});

test("moved file: a proposal to create a file that has since been created is warned the same way", async () => {
  const h = await page(una, pp(P.late));
  assert.match(h, WARNING);
  assert.doesNotMatch(h, /value="approve"/);
});

test("moved file: a proposal whose file is where it was has no warning and still offers Approve", async () => {
  const h = await page(una, pp(P.fresh));
  assert.doesNotMatch(h, /The file changed after this was proposed/);
  assert.match(h, /value="approve">Approve<\/button>/);
});

test("moved file: approving it anyway marks it stale, as the warning says", async () => {
  const r = await form(pp(P.crafted, "/decide"), { decision: "approve" });
  assert.equal(r.status, 303);
  assert.equal(flashOf(await (await get(una, r.headers.get("location"))).text())?.[2], "The file changed after this was proposed, so it was marked stale instead of applied.");
  assert.equal(await status(P.crafted), "stale");
});

test("moved file: a proposal already approved once, waiting for a second approval, shows the warning, not that it needs more approvals", async () => {
  assert.equal(await status(P.pair), "open");
  const h = await page(una, pp(P.pair));
  assert.match(h, WARNING);
  assert.doesNotMatch(h, /needs more approvals/);
});
