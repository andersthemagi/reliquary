// Controls at the top of the page, signed in as Ana. Seed: the "Controls at
// the top" block at the end of test/seed.sql. Ana owns Controls, where two of
// Ben's agent's proposals wait on her: C_REVISED (she asked for changes, the
// agent revised) and C_ROW. Both are rejected when this file is done, so the
// Review counts other tests expect still hold.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { CONTROL_VAULT, C_REVISED, C_ROW, TEAM_VAULT, THREAD_VAULT, TW_CLOSED, SHOP_VAULT, TW_VIEW, LOGIN_FILE } = process.env;
const C = `/v/${CONTROL_VAULT}`;
const V = `/v/${TEAM_VAULT}`;
let cookie = "";

const get = (path) => fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
const post = (path, fields, headers = {}) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const page = async (path) => (await get(path)).text();
const csrf = async (path = "/review") => /name="csrf" value="([0-9a-f]+)"/.exec(await page(path))[1];
const follow = async (r) => page(r.headers.get("location"));
const waiting = async () => Number(/aria-label="(\d+) waiting"/.exec(await page("/review"))?.[1] ?? 0);
const at = (h, s) => {
  const i = h.indexOf(s);
  assert.ok(i >= 0, `missing ${s}`);
  return i;
};

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  const token = await csrf();
  for (const pid of [C_REVISED, C_ROW]) {
    await post(`${C}/proposals/${pid}/decide`, { csrf: token, decision: "reject", note: "Cleanup after the controls tests." });
  }
});

// Proposal page ----------------------------------------------------------------

test("proposal: title and status, then the decision, then the diff, reason, approvals, discussion", async () => {
  const h = await page(`${C}/proposals/${C_REVISED}`);
  const head = at(h, '<div class="page-head">');
  const title = at(h, "Create canon/figures.md</h1>");
  const status = at(h, '<span class="badge state open">Open</span>');
  const form = at(h, `action="${C}/proposals/${C_REVISED}/decide"`);
  const diff = at(h, 'class="diff');
  const reason = at(h, "Agent’s stated reason (unverified)");
  const approvals = at(h, "<h2>Approvals</h2>");
  const discussion = at(h, '<h2 id="discussion">Discussion</h2>');
  assert.ok(head < title && title < status && status < form, "header, then the controls");
  assert.ok(form < diff && diff < reason && reason < approvals && approvals < discussion, "diff follows the controls");
  for (const b of ['value="approve"', 'value="request_changes"', 'value="reject"', ">Edit, then approve</a>", 'name="note"']) {
    assert.ok(at(h, b) < diff, `${b} before the diff`);
  }
});

test("proposal: the verdict buttons are never inside a disclosure", async () => {
  const h = await page(`${C}/proposals/${C_REVISED}`);
  const form = /<form method="post" action="[^"]+\/decide"[\s\S]*?<\/form>/.exec(h)[0];
  assert.doesNotMatch(form, /<details/);
  assert.match(form, /<button class="primary" name="decision" value="approve">Approve<\/button>/);
});

test("proposal: the latest requested changes are shown at the top, escaped, and marked as revised since", async () => {
  const h = await page(`${C}/proposals/${C_REVISED}`);
  const feedback = at(h, '<h2 id="feedback">Latest requested changes</h2>');
  assert.ok(feedback < at(h, "/decide"), "feedback before the controls");
  assert.ok(feedback < at(h, 'class="diff'), "feedback before the diff");
  assert.match(h, /<blockquote class="claim">Add the &lt;b&gt;March&lt;\/b&gt; figures\.<\/blockquote>/);
  assert.doesNotMatch(h, /<b>March<\/b>/);
  assert.match(h, /you · revision 1 · [^<]+ · <strong>revised since: this is revision 2<\/strong>/);
});

test("proposal: no feedback block when nobody asked for changes", async () => {
  assert.doesNotMatch(await page(`${C}/proposals/${C_ROW}`), /Latest requested changes/);
});

test("proposal: snooze is a secondary control at the top, before the diff", async () => {
  const h = await page(`${C}/proposals/${C_REVISED}`);
  const snooze = at(h, `action="${C}/proposals/${C_REVISED}/snooze"`);
  assert.ok(at(h, "/decide") < snooze && snooze < at(h, 'class="diff'));
});

test("proposal: closed or viewer pages show status at the top and no controls", async () => {
  const closed = await page(`/v/${THREAD_VAULT}/proposals/${TW_CLOSED}`);
  assert.ok(at(closed, '<span class="badge state rejected">Rejected</span>') < at(closed, 'class="diff'));
  assert.doesNotMatch(closed, /\/decide"|\/snooze"|Latest requested changes/);
  const viewer = await page(`/v/${SHOP_VAULT}/proposals/${TW_VIEW}`);
  assert.match(viewer, /<span class="badge state open">Open<\/span>/);
  assert.doesNotMatch(viewer, /\/decide"|\/snooze"/);
});

// Other pages: the main action is in the page header ----------------------------

test("pages: the main action sits in the header, before the form it submits", async () => {
  const cases = [
    ["/tokens", '<button class="primary" form="new-token">Create token</button>', 'id="new-token"'],
    [`${V}/edit?path=notes%2Fmd.md`, '<button class="primary" form="edit-file">Save</button>', 'id="edit-file"'],
    [`${V}/new`, '<button class="primary" form="new-file">Create file</button>', 'id="new-file"'],
    [`${C}/proposals/${C_REVISED}/edit`, '<button class="primary" form="edit-approve">Save edit and approve</button>', 'id="edit-approve"'],
  ];
  for (const [path, button, form] of cases) {
    const h = await page(path);
    const actions = at(h, '<div class="page-actions">');
    assert.ok(actions < at(h, button) && at(h, button) < at(h, form), path);
  }
});

test("pages: file and folder actions are in the header; the rule form comes before the rules list", async () => {
  const folder = await page(V);
  assert.ok(at(folder, '<div class="page-actions">') < at(folder, ">New file</a>"));
  const file = await page(`${V}/file?path=canon%2Fpricing.md`);
  assert.ok(at(file, '<div class="page-actions">') < at(file, ">Propose a change</a>"));
  assert.ok(at(file, ">Propose a change</a>") < at(file, 'aria-label="File view"'));
  const rules = await page(`${V}/rules`);
  assert.ok(at(rules, 'id="add-rule"') < at(rules, "What applies to a path?"));
  assert.ok(at(rules, 'id="add-rule"') < at(rules, "<table>"));
});

// Review list: per-row snooze ----------------------------------------------------

test("review: every waiting row carries one Snooze menu with three choices", async () => {
  const h = await page("/review");
  const row = new RegExp(
    `<details class="menu-wrap row-snooze-menu">\\s*<summary class="button small quiet" aria-label="Snooze Create canon/row\\.md">Snooze</summary>\\s*` +
      `<form method="post" action="${C}/proposals/${C_ROW}/snooze" class="menu row-snooze" aria-label="Snooze Create canon/row\\.md">\\s*` +
      `<input type="hidden" name="csrf" value="[0-9a-f]+"><span class="menu-label">Hide from your Review</span><button name="for" value="day">For a day</button>\\s*` +
      `<button name="for" value="week">For a week</button>\\s*<button name="for" value="change">Until it changes</button>`,
  );
  assert.match(h, row);
  assert.match(h, new RegExp(`action="${C}/proposals/${C_REVISED}/snooze" class="menu row-snooze"`));
});

test("review: a row's risk badge names the first reason, not a bare count", async () => {
  const h = await page("/review");
  assert.doesNotMatch(h, /\d+ to check/);
  assert.match(h, /<span class="badge attention risk-count" title="[^"]+">(Deletes the file|Removes \d+ of \d+ lines|Revised [^<]+|First proposal [^<]+)( \+\d+ more)?<\/span>/);
  // Creating a file is not a risk: a neutral label, never the amber badge.
  assert.match(h, /<span class="badge">New file<\/span>/);
  assert.doesNotMatch(h, /risk-count"[^>]*>Creates a new file/);
});

test("review: snoozing a row needs the form token and a same-origin post", async () => {
  const before = await waiting();
  const token = await csrf();
  const url = `${C}/proposals/${C_ROW}/snooze`;
  assert.equal((await post(url, { for: "week" })).status, 403);
  assert.equal((await post(url, { csrf: "0".repeat(token.length), for: "week" })).status, 403);
  assert.equal((await post(url, { csrf: token, for: "week" }, { origin: "https://evil.example" })).status, 403);
  assert.equal(await waiting(), before);
  assert.match(await page("/review"), new RegExp(`${C_ROW}/snooze`));
});

test("review: snoozing a row hides it and returns to Review; unsnooze brings it back", async () => {
  const before = await waiting();
  const token = await csrf();
  const r = await post(`${C}/proposals/${C_ROW}/snooze`, { csrf: token, for: "week" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/review");
  const h = await follow(r);
  assert.match(h, /Snoozed for a week, or until it changes\./);
  assert.doesNotMatch(h, new RegExp(`${C_ROW}/snooze`));
  assert.equal(await waiting(), before - 1);
  assert.match(await page("/review?snoozed=1"), /Create canon\/row\.md<\/a>\s*<span class="muted small"> · Controls · [^<]*until \d{4}-/);
  const un = await post(`${C}/proposals/${C_ROW}/unsnooze`, { csrf: token, back: "review" });
  assert.equal(un.headers.get("location"), "/review?snoozed=1");
  assert.equal(await waiting(), before);
});

// Changes requested: status and what's left, still at the top --------------------

test("changes requested: waiting note, feedback and Reject at the top; no Approve", async () => {
  const token = await csrf(`${C}/proposals/${C_ROW}`);
  const r = await post(`${C}/proposals/${C_ROW}/decide`, { csrf: token, decision: "request_changes", note: "Say which row." });
  const h = await follow(r);
  const diff = at(h, 'class="diff');
  assert.ok(at(h, "Waiting for the proposer to revise.") < diff);
  assert.ok(at(h, "Latest requested changes") < diff);
  assert.ok(at(h, 'value="reject"') < diff);
  assert.doesNotMatch(h, /value="approve"/);
  assert.doesNotMatch(h, /\/snooze"/);
});
