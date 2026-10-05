// Proposals and review in the web UI (proposals.ts, thread.ts, the Inbox in
// pages.ts): breadcrumbs, the header's Snooze menu, risk sentences, a
// refused decision shown again with its reason, decided proposals' outcome,
// the list's tabs with counts and closed rows, and the tones of decisions.
//
// This file starts its own servers from dist/ (local sign-in), one per
// person, none of whom any other test file uses: Rhea owns "Proposal Desk"
// (canon/ is canon, one approval); Sol edits there and proposes through his
// agent, "Desk agent".

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const RHEA = "c9000000-0000-0000-0000-0000000000c1";
const SOL = "c9000000-0000-0000-0000-0000000000c2";
const VAULT = "Proposal Desk";
const RATES = "# Rates\nDay rate: 800 EUR\nNet 30\nTravel at cost\n";

const servers = [];
const S = {};
const P = {}; // proposals by what they're for
let V = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function sql(q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
}

// As a person in the web UI, or (with an agent name) as their agent.
async function as(user, q, params = [], agent = null) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    const claims = { sub: user, role: "authenticated", ...(agent ? { act: { sub: agent, name: agent } } : {}) };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

async function startAs(user) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/proposals-login-${process.pid}-${port}`;
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const s = { origin, cookie: "" };
  servers.push(child);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];
  return s;
}

const get = (who, path) => fetch(S[who].origin + path, { headers: { cookie: S[who].cookie }, redirect: "manual" });
const page = async (who, path) => (await get(who, path)).text();
const csrfOf = async (who) => /name="csrf" value="([0-9a-f]+)"/.exec(await page(who, "/settings"))[1];
const post = async (who, path, fields) =>
  fetch(S[who].origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: S[who].origin },
    body: new URLSearchParams({ csrf: await csrfOf(who), ...fields }).toString(),
  });
const at = (h, s) => {
  const i = h.indexOf(s);
  assert.ok(i >= 0, `missing ${s}`);
  return i;
};
// A proposal page's header: from the page head to the controls under it.
const header = (h) => h.slice(at(h, '<div class="page-head'), at(h, '<div class="review-top">'));
const pp = (pid, rest = "") => `/v/${V}/proposals/${pid}${rest}`;
const propose = (path, body, reason) =>
  as(SOL, "select public.propose($1, $2, $3, $4) as id", [V, path, body, reason], "Desk agent").then((r) => r[0].id);
const status = async (pid) => (await sql("select status from public.proposals where id = $1", [pid]))[0].status;

before(async () => {
  await sql(`insert into auth.users (id, email) values ($1, 'rhea@example.test'), ($2, 'sol@example.test') on conflict (id) do nothing`, [
    RHEA,
    SOL,
  ]);
  [{ id: V }] = await as(RHEA, "select public.create_vault($1) as id", [VAULT]);
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V, SOL, RHEA]);
  await as(RHEA, "select public.write_file($1, 'canon/rates.md', $2)", [V, RATES]);
  await as(RHEA, "select public.write_file($1, 'canon/old.md', 'Old terms.')", [V]);
  await as(RHEA, "select public.write_file($1, 'canon/done.md', 'Draft.')", [V]);
  await as(RHEA, "select public.set_policy($1, 'canon/', 'canon', 1)", [V]);
  P.edit = await propose("canon/rates.md", RATES.replace("800", "900").replace("Net 30", "Net 45"), "New rates for 2027.");
  P.create = await propose("canon/new.md", "A new page.", "Start a page.");
  P.reject = await propose("canon/old.md", "Old terms, rewritten.", "Tidy.");
  P.apply = await propose("canon/done.md", "Final.", "Finish it.");
  P.refuse = await propose("canon/refuse.md", "To be refused.", "For the refusal tests.");
  await as(RHEA, "select public.decide($1, 'reject', 'Keep the old terms.')", [P.reject]);
  await as(RHEA, "select public.decide($1, 'approve', null)", [P.apply]);
  S.rhea = await startAs(RHEA);
  S.sol = await startAs(SOL);
});

after(async () => {
  for (const child of servers) child.kill();
  await as(RHEA, "select public.delete_vault($1, $2)", [V, VAULT]).catch(() => {});
  await sql("delete from private.vault_deletion_notices where user_id = any($1)", [[RHEA, SOL]]);
});

// ---------------------------------------------------------------------------
// The proposal page

test("proposal page: the breadcrumb starts at the vault, then Proposals, and ends at this proposal", async () => {
  const h = await page("rhea", pp(P.edit));
  assert.match(
    h,
    new RegExp(
      `<nav class="crumb" aria-label="Breadcrumb"><ol><li><a href="/v/${V}">Proposal Desk</a></li><li><a href="/v/${V}/proposals">Proposals</a></li><li aria-current="page">Change canon/rates\\.md</li></ol></nav>`,
    ),
  );
});

test("proposal page: the meta names the agent first, then whose it is, and a relative time; no revision until there's a second", async () => {
  const h = header(await page("rhea", pp(P.edit)));
  assert.match(h, /<p class="meta"><span>By Desk agent for sol@example\.test<\/span><span><time datetime="[^"]+" title="[^"]+ UTC">just now<\/time><\/span><\/p>/);
  assert.doesNotMatch(h, /Revision 1/);
});

test("proposal page: two edited lines are a rewrite, with the short label and the sentence", async () => {
  const h = await page("rhea", pp(P.edit));
  assert.match(
    h,
    /<ul class="risks" aria-label="Worth a closer look"><li><span class="badge attention">Rewrites 2 of 4 lines<\/span> <span class="risk-long">Rewrites 2 of the file’s 4 lines: read each change\.<\/span><\/li>/,
  );
  assert.doesNotMatch(h, /Removes 2 of 4 lines/);
  assert.ok(at(h, 'class="risks"') < at(h, "/decide"), "flags before the decision");
});

test("proposal page: a new file is a neutral badge beside the status, not a risk", async () => {
  const h = await page("rhea", pp(P.create));
  assert.match(header(h), /<span class="badge state open">Open<\/span> <span class="badge">New file<\/span>/);
  assert.doesNotMatch(h, /Creates a new file|badge attention">New file/);
});

test("proposal page: Snooze is a menu in the header's actions, three choices posting to snooze, before Edit, then approve", async () => {
  const h = header(await page("rhea", pp(P.edit)));
  const actions = /<div class="page-actions">([\s\S]*)<\/div>/.exec(h)[1];
  assert.match(actions, /<details class="menu-wrap action-menu snooze-menu">\s*<summary class="button">Snooze<\/summary>/);
  assert.match(actions, /<p class="menu-label">Hide it from your inbox<\/p>/);
  for (const [value, label] of [["day", "For a day"], ["week", "For a week"], ["change", "Until it changes"]]) {
    assert.match(
      actions,
      new RegExp(
        `<form method="post" action="${pp(P.edit, "/snooze")}"><input type="hidden" name="csrf" value="[0-9a-f]+"><input type="hidden" name="for" value="${value}"><button class="menu-item"><span class="menu-item-title">${label}</span>`,
      ),
    );
  }
  assert.ok(at(actions, "Snooze</summary>") < at(actions, ">Edit, then approve</a>"));
  const body = await page("rhea", pp(P.edit));
  assert.doesNotMatch(body.slice(at(body, '<div class="review-top">')), /\/snooze"/, "no second snooze control under the header");
});

test("proposal page: a snoozed proposal says so above the decision, with Unsnooze, and has no Snooze menu", async () => {
  await as(RHEA, "select public.snooze_proposal($1)", [P.create]);
  try {
    const h = await page("rhea", pp(P.create));
    assert.match(h, /<span>Snoozed in your inbox until it changes\.<\/span>/);
    assert.doesNotMatch(header(h), /Snooze<\/summary>/);
    assert.ok(at(h, 'class="snoozed-note"') < at(h, "/decide"));
  } finally {
    await as(RHEA, "select public.unsnooze_proposal($1)", [P.create]);
  }
});

test("proposal page: the note's hint is described by, not inside, its label", async () => {
  const h = await page("rhea", pp(P.edit));
  assert.match(h, /<label for="note">Note<\/label>\s*<p class="hint" id="note-hint">Required to request changes or reject\. The proposer sees it\.<\/p>/);
  assert.match(h, /<textarea id="note" name="note" class="note-field" rows="2" aria-describedby="note-hint"><\/textarea>/);
});

// ---------------------------------------------------------------------------
// Decisions

test("decision refused: rejecting without a note answers the page again (400) with the reason in the decision box and the note marked", async () => {
  const r = await post("rhea", pp(P.refuse, "/decide"), { decision: "reject", note: "  " });
  assert.equal(r.status, 400);
  const h = await r.text();
  const form = /<form method="post" action="[^"]+\/decide" class="panel decide"[\s\S]*?<\/form>/.exec(h)[0];
  assert.match(form, /<div class="callout danger" role="alert" id="decide-error"><p>Say why, so the proposer can act on it\. \(ref [0-9a-f]{8}\)<\/p><\/div>/);
  assert.match(form, /<textarea id="note" name="note" class="note-field" rows="2" aria-describedby="decide-error note-hint" aria-invalid="true">  <\/textarea>/);
  assert.doesNotMatch(h, /class="callout [a-z]+ flash"/, "not a flash as well");
  assert.equal(await status(P.refuse), "open");
});

test("decision refused: on a proposal already decided, the reason is shown at the top without a form", async () => {
  const r = await post("rhea", pp(P.reject, "/decide"), { decision: "reject", note: "Again." });
  assert.equal(r.status, 400);
  const h = await r.text();
  assert.match(h, /<div class="callout danger" role="alert" id="decide-error"><p>[^<]*proposal is rejected[^<]*\(ref [0-9a-f]{8}\)<\/p><\/div>/i);
  assert.doesNotMatch(h, /class="panel decide"/);
});

test("decisions: a decision done is a success message", async () => {
  const r = await post("rhea", pp(P.refuse, "/decide"), { decision: "request_changes", note: "Say more." });
  assert.equal(r.status, 303);
  const h = await page("rhea", r.headers.get("location"));
  assert.match(h, /<p class="callout success flash" role="status">Changes requested\. The proposer can see your note and revise\.<\/p>/);
});

test("decision refused: the note as typed comes back, escaped, in the form the page offers now", async () => {
  // Changes are already requested (the test above), so requesting them again is refused.
  const r = await post("rhea", pp(P.refuse, "/decide"), { decision: "request_changes", note: "<b>Even</b> more." });
  assert.equal(r.status, 400);
  const h = await r.text();
  const form = /<form method="post" action="[^"]+\/decide" class="panel decide"[\s\S]*?<\/form>/.exec(h)[0];
  assert.match(form, /<div class="callout danger" role="alert" id="decide-error"><p>[^<]+\(ref [0-9a-f]{8}\)<\/p><\/div>/);
  assert.match(form, /<textarea id="note" name="note" class="note-field" rows="2" aria-describedby="note-hint">&lt;b&gt;Even&lt;\/b&gt; more\.<\/textarea>/);
  assert.match(form, /value="reject">Reject<\/button>/);
  assert.equal(await status(P.refuse), "changes_requested");
});

// ---------------------------------------------------------------------------
// Decided proposals

test("decided: an applied proposal says who approved it and when, in place of Approvals", async () => {
  const h = await page("rhea", pp(P.apply));
  assert.match(h, /<p class="callout success outcome-line">Applied, approved by you · <time datetime="[^"]+" title="[^"]+ UTC">just now<\/time>\.<\/p>/);
  assert.doesNotMatch(h, /<h2>Approvals<\/h2>|approvals? for revision/);
  assert.ok(at(h, "outcome-line") < at(h, 'class="diff'), "the outcome is at the top");
});

test("decided: a rejected proposal says who rejected it, and its discussion is closed", async () => {
  const rejected = await page("sol", pp(P.reject));
  assert.match(rejected, /<p class="callout neutral outcome-line">Rejected by rhea@example\.test · <time /);
  assert.match(rejected, /<p>Keep the old terms\.<\/p>/, "the reject note is in the discussion");
  assert.match(rejected, /This proposal is decided, so its discussion is closed\./);
  assert.doesNotMatch(rejected, /No comments yet/);
});

test("decided: open proposals keep Approvals, counted as n of m approvals", async () => {
  assert.match(await page("rhea", pp(P.edit)), /<h2>Approvals<\/h2>\s*<p>0 of 1 approval\.<\/p>/);
});

// ---------------------------------------------------------------------------
// The vault's Proposals list

test("proposals list: the breadcrumb starts at the vault; tabs carry counts, Closed holding rejected and stale", async () => {
  const h = await page("rhea", `/v/${V}/proposals`);
  assert.match(h, new RegExp(`<nav class="crumb" aria-label="Breadcrumb"><ol><li><a href="/v/${V}">Proposal Desk</a></li><li aria-current="page">Proposals</li></ol></nav>`));
  const tabs = /<nav class="tabs" aria-label="Proposal status">([\s\S]*?)<\/nav>/.exec(h)[1];
  const seen = [...tabs.matchAll(/<a href="[^"]+\?status=([a-z_]+)"( aria-current="page")?>([^<]+)<span class="count">(\d+)<\/span><\/a>/g)].map(
    (m) => [m[1], m[3], Number(m[4]), !!m[2]],
  );
  assert.deepEqual(seen, [
    ["open", "Open", 2, true],
    ["changes_requested", "Changes requested", 1, false],
    ["applied", "Applied", 1, false],
    ["closed", "Closed", 1, false],
  ]);
});

test("proposals list: older links to Rejected or Stale open Closed", async () => {
  for (const s of ["rejected", "stale"]) {
    const h = await page("rhea", `/v/${V}/proposals?status=${s}`);
    assert.match(h, /aria-current="page">Closed<span class="count">1<\/span>/, s);
    assert.match(h, /Change canon\/old\.md/, s);
  }
});

test("proposals list: decided rows say how they ended, not approvals or risks", async () => {
  const closed = await page("rhea", `/v/${V}/proposals?status=closed`);
  assert.match(
    closed,
    /<span class="row-end small"><span class="muted outcome">Rejected by you · <time [^>]+>just now<\/time><\/span> <span class="badge state rejected">Rejected<\/span><\/span>/,
  );
  const applied = await page("rhea", `/v/${V}/proposals?status=applied`);
  assert.match(applied, /<span class="muted outcome">Applied, approved by you · <time /);
  for (const h of [closed, applied]) assert.doesNotMatch(h, /\d of \d approval|risk-count/);
});

test("proposals list: live rows lead with the agent, and count approvals", async () => {
  const h = await page("rhea", `/v/${V}/proposals`);
  assert.match(h, /Change canon\/rates\.md<\/a>\s*<span class="muted small"> · Desk agent for sol@example\.test · <time /);
  assert.match(h, /<span class="badge attention risk-count" title="Rewrites 2 of the file’s 4 lines: read each change\.">Rewrites 2 of 4 lines<\/span> <span class="muted">0 of 1 approval<\/span>/);
});

test("proposals list: an empty tab says what's missing and when it fills", async () => {
  await as(SOL, "select public.revise_proposal($1, 'Revised.', 'as asked')", [P.refuse], "Desk agent");
  const h = await page("rhea", `/v/${V}/proposals?status=changes_requested`);
  assert.match(h, /<div class="empty"><strong>Nothing sent back<\/strong><p>When a reviewer asks for changes, the proposal waits here until its proposer revises it\.<\/p><\/div>/);
});

// ---------------------------------------------------------------------------
// Edit, then approve and Revise

test("edit, then approve: the crumb ends at this step under the proposal, the title names the file, the file as it is now is folded above", async () => {
  const h = await page("rhea", pp(P.edit, "/edit"));
  assert.match(h, new RegExp(`<li><a href="${pp(P.edit)}">Change canon/rates\\.md</a></li><li aria-current="page">Edit, then approve</li></ol></nav>`));
  assert.match(h, /<h1 class="path">Edit, then approve rates\.md<\/h1>/);
  assert.match(h, /<details class="current-file"><summary>The file as it is now<\/summary><pre class="current-text"># Rates\nDay rate: 800 EUR/);
  assert.ok(at(h, "current-file") < at(h, 'id="edit-approve"'));
});

test("revise: the proposer's page is named for the file, under the proposal", async () => {
  // Sol proposed through his agent, so he is the proposer.
  const h = await page("sol", pp(P.edit, "/revise"));
  assert.match(h, /<h1 class="path">Revise rates\.md<\/h1>/);
  assert.match(h, /<li aria-current="page">Revise<\/li>/);
  assert.match(h, /<details class="current-file">/);
});

// What a proposal editor's box holds once a browser has read it: the HTML
// parser drops one newline right after <textarea>.
const boxOf = (h) => /<textarea id="content" name="content">([\s\S]*?)<\/textarea>/.exec(h)[1].replace(/^\n/, "");

test("revise: a text that starts with a newline comes back from the box, and saves as a revision, unchanged", async () => {
  const body = "\nOn its own line.\n";
  const pid = await propose("canon/lead-revise.md", body, "Starts with a newline.");
  const h = await page("sol", pp(pid, "/revise"));
  assert.equal(boxOf(h), body);
  const r = await post("sol", pp(pid, "/revise"), { content: boxOf(h) });
  assert.equal(r.status, 303);
  assert.equal((await sql("select body from public.proposals where id = $1", [pid]))[0].body, body);
  // Not left waiting: the Inbox tests below count what waits for Rhea.
  await as(RHEA, "select public.decide($1, 'reject', 'Test over.')", [pid]);
});

test("edit, then approve: a text that starts with a newline comes back from the box, and applies, unchanged", async () => {
  const body = "\nOn its own line.\n";
  const pid = await propose("canon/lead-approve.md", body, "Starts with a newline.");
  const h = await page("rhea", pp(pid, "/edit"));
  assert.equal(boxOf(h), body);
  const r = await post("rhea", pp(pid, "/edit"), { content: boxOf(h) });
  assert.equal(r.status, 303);
  const [{ body: written }] = await sql(
    "select fv.body from public.files f join public.file_versions fv on fv.id = f.current_version_id where f.vault_id = $1 and f.path = 'canon/lead-approve.md'",
    [V],
  );
  assert.equal(written, body);
});

// ---------------------------------------------------------------------------
// The Inbox

test("inbox: one sentence under the title, and a count of what's waiting to review", async () => {
  const h = await page("rhea", "/inbox");
  assert.match(h, /<h1>Inbox<\/h1><span class="badge count-badge">3 to review<\/span>/);
  assert.match(h, /<p class="page-desc">What needs you across your vaults: changes to review, proposals sent back, \.env imports and invites\.<\/p>/);
  assert.doesNotMatch(h, /<p class="lede">/);
  assert.match(h, /Change canon\/rates\.md<\/a>\s*<span class="muted small"> · Desk agent for sol@example\.test · <time /);
});
