// A proposal's page while it still waits (src/proposals.ts): what the Revise
// form's reason field does to the proposal's reason, and what the page says
// when its file has moved on since it was proposed. Who may decide or revise
// is the database's (supabase/tests/review_test.sql); this file is about what
// a person reads and is offered.
//
// This file starts its own server and seeds its own vault ("Live Desk"):
// Una owns it and proposes as herself; canon/ needs one approval.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { as, csrfOf, page, post, sql, start } from "./threads-harness.mjs";

const UNA = "c9000000-0000-0000-0000-0000000000d2";
const VAULT = "Live Desk";

let V = "";
let una;
const P = {};

const propose = (path, body, reason) => as(UNA, "select public.propose($1, $2, $3, $4) as id", [V, path, body, reason]).then((r) => r[0].id);
const pp = (pid, rest = "") => `/v/${V}/proposals/${pid}${rest}`;
const form = async (path, fields) => post(una, path, { csrf: csrfOf(await page(una, "/settings")), ...fields });
// What the proposal's page gives as its reason.
const reasonOf = async (pid) => /<blockquote class="claim">([^<]*)<\/blockquote>/.exec(await page(una, pp(pid)))?.[1];

before(async () => {
  await sql(`insert into auth.users (id, email) values ($1, 'una@example.test') on conflict (id) do nothing`, [UNA]);
  [{ id: V }] = await as(UNA, "select public.create_vault($1) as id", [VAULT]);
  for (const f of ["replace", "keep"]) await as(UNA, "select public.write_file($1, $2, 'Base.')", [V, `canon/${f}.md`]);
  await as(UNA, "select public.set_policy($1, 'canon/', 'canon', 1)", [V]);
  P.replace = await propose("canon/replace.md", "Base, proposed.", "Original why.");
  P.keep = await propose("canon/keep.md", "Base, proposed.", "Original why.");
  una = await start(UNA, "una");
});

after(async () => {
  una?.child?.kill();
  await as(UNA, "select public.delete_vault($1, $2)", [V, VAULT]).catch(() => {});
  await sql("delete from private.vault_deletion_notices where user_id = $1", [UNA]);
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
