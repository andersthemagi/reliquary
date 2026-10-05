// A proposal's page after it has been decided (src/proposals.ts): the diff
// and the verb come from what the proposal was made against, because once it
// has applied the file already says what it proposed. Who may decide is the
// database's (supabase/tests); this file is about what a person reads.
//
// This file starts its own server and seeds its own vault ("Decided Desk"):
// Ines owns it, canon/ needs one approval, notes/ is open to direct writes.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { as, page, sql, start } from "./threads-harness.mjs";

const INES = "c9000000-0000-0000-0000-0000000000d1";
const VAULT = "Decided Desk";
const RATES = "# Rates\nDay rate: 800 EUR\nNet 30\nTravel at cost\n";

let V = "";
let ines;
const P = {};

const propose = (path, body, reason, del = false) =>
  as(INES, "select public.propose($1, $2, $3, $4, $5) as id", [V, path, body, reason, del]).then((r) => r[0].id);
const decide = (pid, decision, note = null) => as(INES, "select public.decide($1, $2, $3)", [pid, decision, note]);
const pp = (pid) => `/v/${V}/proposals/${pid}`;
const stat = (h) => /<p class="diff-stat"><span class="plus">\+(\d+)<\/span> <span class="minus">−(\d+)<\/span>/.exec(h)?.slice(1).map(Number);
const lines = (h, kind) => [...h.matchAll(new RegExp(`<div class="${kind}"><span class="ln"[^>]*>[^<]*</span><span class="ln"[^>]*>[^<]*</span><span>(.*?)</span></div>`, "g"))].map((m) =>
  m[1].replace(/<\/?(?:ins|del)>/g, ""),
);

before(async () => {
  await sql(`insert into auth.users (id, email) values ($1, 'ines@example.test') on conflict (id) do nothing`, [INES]);
  [{ id: V }] = await as(INES, "select public.create_vault($1) as id", [VAULT]);
  await as(INES, "select public.write_file($1, 'canon/rates.md', $2)", [V, RATES]);
  await as(INES, "select public.write_file($1, 'canon/old.md', 'Old terms.')", [V]);
  await as(INES, "select public.write_file($1, 'notes/draft.md', 'First draft.')", [V]);
  await as(INES, "select public.write_file($1, 'notes/moved.md', 'Before it moved.')", [V]);
  await as(INES, "select public.set_policy($1, 'canon/', 'canon', 1)", [V]);

  P.change = await propose("canon/rates.md", RATES.replace("800", "900"), "New rates for 2027.");
  await decide(P.change, "approve");
  P.create = await propose("canon/new.md", "A new page.", "Start a page.");
  await decide(P.create, "approve");
  P.delete = await propose("canon/old.md", null, "Retire it.", true);
  await decide(P.delete, "approve");

  P.rejected = await propose("notes/draft.md", "Second draft.", "Rewrite it.");
  await decide(P.rejected, "reject", "Not yet.");
  // The file moves on after the rejection, and after the proposal was made.
  await as(INES, "select public.write_file($1, 'notes/draft.md', 'Third draft, by hand.')", [V]);

  P.stale = await propose("notes/moved.md", "After it moved, proposed.", "Edit.");
  await as(INES, "select public.write_file($1, 'notes/moved.md', 'Moved by hand.')", [V]);
  await decide(P.stale, "approve");

  ines = await start(INES, "ines");
});

after(async () => {
  ines?.child?.kill();
  await as(INES, "select public.delete_vault($1, $2)", [V, VAULT]).catch(() => {});
  await sql("delete from private.vault_deletion_notices where user_id = $1", [INES]);
});

test("decided diff: an applied change shows what it changed, not an empty diff against the file as it is now", async () => {
  const h = await page(ines, pp(P.change));
  assert.match(h, /<h1 class="path">Change canon\/rates\.md<\/h1>/);
  assert.deepEqual(stat(h), [1, 1]);
  assert.deepEqual(lines(h, "del"), ["Day rate: 800 EUR"]);
  assert.deepEqual(lines(h, "add"), ["Day rate: 900 EUR"]);
});

test("decided diff: an applied proposal that created a file says Create, with the New file badge, and shows the whole text as added", async () => {
  const h = await page(ines, pp(P.create));
  assert.match(h, /<h1 class="path">Create canon\/new\.md<\/h1>/);
  assert.match(h, /<span class="badge state applied">Applied<\/span> <span class="badge">New file<\/span>/);
  assert.deepEqual(stat(h), [1, 0]);
});

test("decided diff: the Applied tab calls a proposal that created a file Create, not Change", async () => {
  const h = await page(ines, `/v/${V}/proposals?status=applied`);
  assert.match(h, /Create canon\/new\.md<\/a>/);
  assert.doesNotMatch(h, /Change canon\/new\.md/);
});

test("decided diff: an applied delete shows the lines it removed", async () => {
  const h = await page(ines, pp(P.delete));
  assert.match(h, /<h1 class="path">Delete canon\/old\.md<\/h1>/);
  assert.deepEqual(stat(h), [0, 1]);
  assert.deepEqual(lines(h, "del"), ["Old terms."]);
});

test("decided diff: a rejected proposal keeps the diff it was reviewed with when the file has since changed", async () => {
  const h = await page(ines, pp(P.rejected));
  assert.deepEqual(lines(h, "del"), ["First draft."]);
  assert.deepEqual(lines(h, "add"), ["Second draft."]);
  assert.doesNotMatch(h, /Third draft/);
});

test("decided diff: a stale proposal still compares with the file as it is now, as its page says", async () => {
  const h = await page(ines, pp(P.stale));
  assert.match(h, /the diff will show what it would change now/);
  assert.deepEqual(lines(h, "del"), ["Moved by hand."]);
  assert.deepEqual(lines(h, "add"), ["After it moved, proposed."]);
});
