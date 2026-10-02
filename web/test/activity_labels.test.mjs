// Activity names every logged event in plain words (src/activity.ts).
// The events come from the database two ways: every event a migration can
// write to public.log, read from the SQL itself, and every event already in
// this suite's log. Either one without a label, or without a filter choice,
// or without a place in EVENT_KIND (content for the Changes feed, or
// diagnostic), fails here. Read-only: nothing here changes the database.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, test } from "node:test";
import pg from "pg";
import { activityTable, EVENT_GROUPS, EVENT_LABELS, parseFilters } from "../dist/activity.js";
import { CONTENT_EVENTS, EVENT_KIND } from "../dist/activity.js";
import { describe as describeEvent } from "../dist/activity.js";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const WEB = new URL(BASE);
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const { TEAM_VAULT, LOGIN_FILE } = process.env;
const MIGRATIONS = join(process.env.REPO_DIR ?? "..", "supabase", "migrations");
const LABEL = new Map(EVENT_LABELS);
let cookie = "";

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  assert.equal(r.status, 303);
  cookie = r.headers.get("set-cookie").split(";")[0];
});

// ---------------------------------------------------------------------------
// Reading the migrations

// Splits an argument list at top-level commas, minding parentheses and
// quoted strings ('' inside a string is a quote).
function splitArgs(s) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      let j = end;
      while (s[j + 1] === "'") j = s.indexOf("'", j + 2);
      cur += s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      if (depth === 0) break;
      depth--;
    }
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// Event expressions that aren't a plain literal, and every value each can
// take (the values are checked in the functions that build them). A new
// computed event fails the test until it's listed here.
const COMPUTED = {
  "'proposal.' || p_decision": ["proposal.approve", "proposal.reject", "proposal.request_changes"],
  "'variable.' || v_action": ["variable.set", "variable.rotate"],
  // log_event's own insert passes its argument through.
  p_event: [],
};

function eventsInMigrations() {
  const events = new Set();
  const unread = [];
  const take = (expr, where) => {
    const lit = /^'([a-z_]+\.[a-z_]+)'$/.exec(expr);
    if (lit) events.add(lit[1]);
    else if (expr in COMPUTED) for (const e of COMPUTED[expr]) events.add(e);
    else unread.push(`${where}: ${expr}`);
  };
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/(function\s+)?(?:private\.)?log_event\s*\(/g)) {
      // Defining, altering or granting the function names types, not events.
      if (m[1]) continue;
      take(splitArgs(sql.slice(m.index + m[0].length))[1], file);
    }
    for (const m of sql.matchAll(/insert\s+into\s+public\.log\s*\(([^)]*)\)\s*(values\s*\()?/gi)) {
      const cols = m[1].split(",").map((c) => c.trim());
      const at = cols.indexOf("event");
      if (at < 0) continue;
      if (!m[2]) {
        unread.push(`${file}: an insert into public.log without VALUES`);
        continue;
      }
      take(splitArgs(sql.slice(m.index + m[0].length))[at], file);
    }
  }
  return { events, unread };
}

// ---------------------------------------------------------------------------

test("activity labels: every event a migration can log has a plain label", () => {
  const { events, unread } = eventsInMigrations();
  assert.deepEqual(unread, [], "an event expression this test can't read: add it to COMPUTED");
  // The reader must find the events it is known to: an empty set proves nothing.
  for (const e of ["file.write", "file.delete", "proposal.approve", "proposal.comment", "variable.rotate", "environment.create", "vault.export"]) {
    assert.ok(events.has(e), `the migrations reader missed ${e}`);
  }
  const missing = [...events].filter((e) => !LABEL.has(e)).sort();
  assert.deepEqual(missing, [], "events with no label in EVENT_LABELS (web/src/activity.ts)");
});

test("activity labels: every labelled event is classified as content or diagnostic, so a new event has to be sorted", () => {
  const labelled = EVENT_LABELS.map(([e]) => e);
  assert.deepEqual(
    labelled.filter((e) => !(e in EVENT_KIND)),
    [],
    "events with no entry in EVENT_KIND (src/activity.ts): 'content' if a person reading the vault wants it in Changes, else 'diagnostic'",
  );
  assert.deepEqual(Object.keys(EVENT_KIND).filter((e) => !LABEL.has(e)), [], "EVENT_KIND names an event that has no label");
  for (const [e, kind] of Object.entries(EVENT_KIND)) assert.ok(kind === "content" || kind === "diagnostic", `${e}: ${kind}`);
});

test("activity labels: the Changes feed asks for exactly the content events, and files and proposals are among them", () => {
  assert.deepEqual([...CONTENT_EVENTS].sort(), Object.keys(EVENT_KIND).filter((e) => EVENT_KIND[e] === "content").sort());
  for (const e of ["file.write", "file.delete", "file.erase", "proposal.open", "proposal.approve", "proposal.comment"]) {
    assert.ok(CONTENT_EVENTS.includes(e), `${e} is content`);
  }
  for (const e of ["member.set", "variable.set", "claim.grant", "policy.set", "vault.export"]) {
    assert.ok(!CONTENT_EVENTS.includes(e), `${e} is not content`);
  }
});

test("activity labels: every event in the log has a plain label", async () => {
  const c = new pg.Client({ connectionString: SUPER });
  await c.connect();
  try {
    const { rows } = await c.query("select distinct event from public.log order by 1");
    assert.ok(rows.length > 5, "the suite's log has events");
    assert.deepEqual(rows.map((r) => r.event).filter((e) => !LABEL.has(e)), []);
  } finally {
    await c.end();
  }
});

test("activity labels: labels are plain words, one per event", () => {
  const labels = EVENT_LABELS.map(([, l]) => l);
  assert.equal(new Set(labels).size, labels.length, "two events share a label");
  for (const [e, l] of EVENT_LABELS) {
    assert.match(l, /^[A-Z][a-z’ ]+[a-z]$/, `${e}: ${l}`);
    assert.doesNotMatch(l, /[._]/, `${e}: ${l}`);
  }
});

test("activity labels: every event and group is a filter choice the filter keeps", async () => {
  const r = await fetch(`${BASE}/v/${TEAM_VAULT}/activity`, { headers: { cookie }, redirect: "manual" });
  assert.equal(r.status, 200);
  const h = await r.text();
  const select = /<select id="f-action" name="action">([\s\S]*?)<\/select>/.exec(h)[1];
  for (const [value, label] of [...EVENT_GROUPS, ...EVENT_LABELS]) {
    assert.ok(select.includes(`<option value="${value}">${label}</option>`), `${value} is a choice`);
    assert.equal(parseFilters(new URLSearchParams({ action: value })).action, value, `${value} is kept`);
  }
  assert.deepEqual(EVENT_GROUPS.find(([g]) => g === "variable."), ["variable.", "Any variable change"]);
});

test("activity labels: a row shows the label, never the stored code", () => {
  const rows = EVENT_LABELS.map(([event], i) => ({
    seq: String(i + 1),
    vault_id: "00000000-0000-0000-0000-000000000001",
    vault: "V",
    at: new Date(),
    actor: null,
    agent: null,
    event,
    path: null,
    proposal_id: null,
  }));
  const h = activityTable({ me: "x", url: new URL("http://x/"), base: "/activity", scope: {} }, rows).html;
  for (const [event, label] of EVENT_LABELS) {
    assert.ok(h.includes(`>${label}</td>`), label);
    assert.ok(!h.includes(event), `${event} shown as stored`);
  }
});

// Member and invite events in plain words (describe() in src/activity.ts).
const ME = "00000000-0000-0000-0000-00000000000a";
const CY = "00000000-0000-0000-0000-0000000000c1";
const marker = (id) => new RegExp(`\\[\\[person:[0-9a-f]+:${id}\\]\\]`);

test("activity members: a role change names the member and the role", () => {
  const w = describeEvent(ME, { event: "member.set", subject: CY, role: "editor", has_role: true });
  assert.match(w, /^Made \[\[person:[0-9a-f]+:[0-9a-f-]+\]\] an editor$/);
  assert.match(w, marker(CY));
  assert.equal(describeEvent(ME, { event: "member.set", subject: ME, role: "owner", has_role: true }), "Made you an owner");
  assert.match(describeEvent(ME, { event: "member.set", subject: CY, role: "viewer", has_role: true }), / a viewer$/);
});

test("activity members: a removal says who was removed", () => {
  const w = describeEvent(ME, { event: "member.set", subject: CY, role: null, has_role: true });
  assert.match(w, /^Removed \[\[person:[0-9a-f]+:[0-9a-f-]+\]\] from the vault$/);
});

test("activity members: invites and cut-off connections say the role or the member", () => {
  assert.equal(describeEvent(ME, { event: "invite.create", subject: null, role: "viewer", has_role: true }), "Invited someone as a viewer");
  assert.equal(describeEvent(ME, { event: "invite.accept", subject: null, role: "editor", has_role: true }), "Joined by invite as an editor");
  assert.match(describeEvent(ME, { event: "member.connection_revoke", subject: CY, role: null, has_role: false }), /^Cut off \[\[person:[^\]]+\]\]’s connection$/);
  assert.equal(describeEvent(ME, { event: "member.connection_revoke", subject: ME, role: null, has_role: false }), "Cut off your connection");
});

test("activity members: missing or malformed detail falls back to the label, never to what the detail holds", () => {
  const label = (e) => LABEL.get(e);
  for (const r of [
    { event: "member.set" },
    { event: "member.set", subject: null, role: null, has_role: false },
    { event: "member.set", subject: CY, role: null, has_role: false },
    { event: "member.set", subject: "<b>x</b>", role: "editor", has_role: true },
    { event: "member.set", subject: CY, role: "admin<script>", has_role: true },
    { event: "invite.create", subject: null, role: "superuser", has_role: true },
    { event: "member.connection_revoke", subject: "not-a-uuid", role: null, has_role: false },
  ]) {
    assert.equal(describeEvent(ME, r), label(r.event), JSON.stringify(r));
  }
  // Other events ignore subject and role even if a row carried them.
  assert.equal(describeEvent(ME, { event: "file.write", subject: CY, role: "owner", has_role: true }), "Wrote");
  assert.equal(describeEvent(ME, { event: "member.leave", subject: CY, role: "editor", has_role: true }), "Left the vault");
});
