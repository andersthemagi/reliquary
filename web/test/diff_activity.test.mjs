// Diffs (word highlights, split, rendered) and Activity (filters, pages,
// isolation). Unit tests import the compiled modules from dist/; the rest
// drive the server signed in as Ana. Seed: the "Diffs and activity" block at
// the end of test/seed.sql. Read-only: nothing here changes the database.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { diffLines, splitRows, wordDiff } from "../dist/diff.js";
import { diffSection, split, unified } from "../dist/diffview.js";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { TEAM_VAULT, DEE_VAULT, SIDE_VAULT, PROPOSAL, P_HTML, BEN, DEE, LOGIN_FILE } = process.env;
const T = `/v/${TEAM_VAULT}`;
const S = `/v/${SIDE_VAULT}`;
let cookie = "";

const get = (path) => fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
const page = async (path) => {
  const r = await get(path);
  assert.equal(r.status, 200, path);
  return r.text();
};
const events = (h) => [...h.matchAll(/<tr class="ev">([\s\S]*?)<\/tr>/g)].map((m) => m[1]);
const seqOf = (row) => Number(/<td class="num small muted hide-sm">(\d+)<\/td>/.exec(row)[1]);
const older = (h) => /<a class="older" href="([^"]+)">Older<\/a>/.exec(h)?.[1].replaceAll("&amp;", "&");
const cells = (row) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  assert.equal(r.status, 303);
  cookie = r.headers.get("set-cookie").split(";")[0];
});

// Diff algorithm (unit) ---------------------------------------------------------

test("diff: a changed word is highlighted inside its paired lines", () => {
  const lines = diffLines("Day rate is 800 EUR.\nNet 30.", "Day rate is 900 EUR.\nNet 30.");
  assert.deepEqual(lines.map((l) => l.kind), ["del", "add", "same"]);
  assert.deepEqual(lines[0].segs, [{ text: "Day rate is ", changed: false }, { text: "800", changed: true }, { text: " EUR.", changed: false }]);
  assert.deepEqual(lines[1].segs.filter((s) => s.changed).map((s) => s.text), ["900"]);
  assert.deepEqual([lines[0].a, lines[1].b, lines[2].a, lines[2].b], [1, 1, 2, 2]);
});

test("diff: unrelated lines are marked whole, not word by word", () => {
  const lines = diffLines("Completely different sentence here.", "Nothing alike at all, friend.");
  assert.equal(lines[0].segs, undefined);
  assert.equal(wordDiff("abc def", "xyz uvw"), null);
});

test("diff: adjacent changed words merge across a single space", () => {
  const w = wordDiff("the quick brown fox jumps", "the slow red fox jumps");
  assert.deepEqual(w.del.filter((s) => s.changed).map((s) => s.text), ["quick brown"]);
});

test("diff: removed lines come before added ones, and split pairs them", () => {
  const lines = diffLines("a\nb\nc", "a\nB\nx\nc");
  assert.deepEqual(lines.map((l) => `${l.kind}:${l.text}`), ["same:a", "del:b", "add:B", "add:x", "same:c"]);
  const rows = splitRows(lines);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].left.text, "b");
  assert.equal(rows[1].right.text, "B");
  assert.equal(rows[2].left, undefined);
  assert.equal(rows[2].right.text, "x");
});

test("diff: an inserted line before an edited one doesn't hide the edit", () => {
  const lines = diffLines("A line about the weather.", "<script>x</script>\n\nA line about the sunny weather.");
  const del = lines.find((l) => l.kind === "del");
  assert.equal(del.mate.text, "A line about the sunny weather.");
  assert.deepEqual(del.mate.segs.filter((s) => s.changed).map((s) => s.text.trim()), ["sunny"]);
  const rows = splitRows(lines);
  assert.deepEqual(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null]), [
    [null, "<script>x</script>"],
    [null, ""],
    ["A line about the weather.", "A line about the sunny weather."],
  ]);
});

test("diff: huge inputs give up quickly, and the page says it's a whole-file replace", () => {
  const a = Array.from({ length: 3000 }, (_, i) => `old line ${i}`).join("\n");
  const b = Array.from({ length: 3000 }, (_, i) => `new line ${i}`).join("\n");
  const t0 = Date.now();
  assert.equal(diffLines(a, b), null);
  assert.equal(diffLines("x".repeat(1_000_001), "y"), null);
  const section = diffSection({ before: a, after: b, mode: "split", href: (m) => `?diff=${m}` }).html;
  assert.match(section, /Too large to compare line by line\. Read it as a whole-file replacement/);
  assert.ok(Date.now() - t0 < 2000, "fast");
});

test("diff: a small edit in a long file stays cheap and folds the unchanged middle", () => {
  const base = Array.from({ length: 20000 }, (_, i) => `line ${i}`);
  const changed = [...base];
  changed[10000] = "line ten thousand";
  const t0 = Date.now();
  const lines = diffLines(base.join("\n"), changed.join("\n"));
  assert.ok(Date.now() - t0 < 2000, "fast");
  assert.equal(lines.filter((l) => l.kind !== "same").length, 2);
  const h = unified(lines).html;
  assert.match(h, /<details class="fold"><summary>9997 unchanged lines<\/summary>/);
  assert.match(split(lines).html, /<details class="fold"><summary>9997 unchanged lines<\/summary>/);
});

test("diff: text is escaped in every view", () => {
  const lines = diffLines("<b>one</b> two", "<b>one</b> <i>three</i>");
  for (const h of [unified(lines).html, split(lines).html]) {
    assert.doesNotMatch(h, /<b>|<i>/);
    assert.match(h, /&lt;i&gt;three&lt;\/i&gt;/);
  }
});

// Proposal page ---------------------------------------------------------------------

test("proposal: unified is the default view, with word highlights, before the reason", async () => {
  const h = await page(`${T}/proposals/${PROPOSAL}`);
  assert.match(h, /<a href="[^"]+\?diff=unified#changes" aria-current="page">Unified<\/a>/);
  assert.match(h, /<del>800<\/del>/);
  assert.match(h, /<ins>900<\/ins>/);
  assert.ok(h.indexOf('class="diff') < h.indexOf("Agent’s stated reason"));
  assert.ok(h.indexOf('class="diff') < h.indexOf('name="decision"'));
});

test("proposal: split view shows current and proposed side by side, in its own scroll box", async () => {
  const h = await page(`${T}/proposals/${PROPOSAL}?diff=split`);
  assert.match(h, /aria-current="page">Split<\/a>/);
  assert.match(h, /<div class="split-scroll"><div class="diff split facet"/);
  assert.match(h, /<span>Current<\/span><span><\/span><span>Proposed<\/span>/);
  assert.match(h, /<span class="del">Day rate is <del>800<\/del> EUR\.<\/span>/);
  assert.match(h, /<span class="add">Day rate is <ins>900<\/ins> EUR\.<\/span>/);
  assert.ok(h.indexOf('class="diff split') < h.indexOf("Agent’s stated reason"));
});

test("proposal: rendered view shows both versions and escapes raw HTML", async () => {
  const h = await page(`${S}/proposals/${P_HTML}?diff=rendered`);
  assert.match(h, /aria-current="page">Rendered<\/a>/);
  assert.match(h, /<section class="proposed" aria-label="Proposed">[\s\S]*<h1>New heading<\/h1>/);
  assert.match(h, /<section class="current" aria-label="Current">[\s\S]*<h1>Old heading<\/h1>/);
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(h, /<script|<img/i);
  for (const mode of ["unified", "split"]) assert.doesNotMatch(await page(`${S}/proposals/${P_HTML}?diff=${mode}`), /<script|<img/i);
});

test("proposal: an unknown view falls back to unified", async () => {
  assert.match(await page(`${T}/proposals/${PROPOSAL}?diff=bogus`), /aria-current="page">Unified<\/a>/);
});

// Activity ------------------------------------------------------------------------------

test("nav: Vaults, Review, Activity, Connect, Tokens, with Activity current on /activity", async () => {
  const h = await page("/activity");
  const nav = /<nav aria-label="Main">([\s\S]*?)<\/nav>/.exec(h)[1];
  const order = [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["/", "/review", "/activity", "/connect", "/tokens"]);
  assert.match(nav, /<a href="\/activity" aria-current="page">Activity<\/a>/);
});

test("activity: the account page spans my vaults and names each one", async () => {
  const h = await page("/activity");
  const rows = events(h);
  assert.equal(rows.length, 50);
  assert.ok(rows.some((r) => r.includes(">Side</a>")));
  assert.match(h, /<option value="[^"]+">Team<\/option>/);
  const team = events(await page(`/activity?vault=${TEAM_VAULT}`));
  assert.ok(team.length > 0 && team.every((r) => r.includes(">Team</a>")));
});

test("activity: never another vault's events, whatever the filters say", async () => {
  // Every page of my activity, and every way of asking for Dee's.
  let path = "/activity";
  const seen = [];
  while (path) {
    const h = await page(path);
    seen.push(h);
    path = older(h);
  }
  for (const p of [`/activity?vault=${DEE_VAULT}`, `/activity?who=${DEE}`, `/activity?path=dee-only`]) {
    const h = await page(p);
    assert.equal(events(h).length, 0, p);
    seen.push(h);
  }
  for (const h of seen) {
    assert.doesNotMatch(h, /dee-only-plan|Dee private/);
    assert.ok(!h.includes(`/v/${DEE_VAULT}`));
  }
  for (const p of [`/v/${DEE_VAULT}/activity`, `/v/${DEE_VAULT}/file?path=dee-only-plan.md&tab=history`]) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test("activity: shows who did what where, never file text", async () => {
  const h = await page(`${T}/activity`);
  assert.doesNotMatch(h, /Acme wants the booking|Day rate is|Net 30|alert\(/);
});

test("activity: filter by agent, people only, or agents only", async () => {
  const agents = events(await page(`${T}/activity?agent=agents`));
  assert.ok(agents.length > 0 && agents.every((r) => / via /.test(r)));
  const people = events(await page(`${T}/activity?agent=people`));
  assert.ok(people.length > 0 && people.every((r) => !/ via /.test(r)));
  const hermes = events(await page(`${T}/activity?agent=${encodeURIComponent("name:Hermes on Linux")}`));
  assert.ok(hermes.length > 0 && hermes.every((r) => r.includes("via Hermes on Linux")));
  assert.match(await page(`${T}/activity?agent=agents`), /<option value="agents" selected>Agents only<\/option>/);
});

test("activity: filter by person, action, path and date", async () => {
  const ben = events(await page(`${T}/activity?who=${BEN}`));
  assert.ok(ben.length > 0 && ben.every((r) => !r.includes(">you<")));
  const opened = events(await page(`${T}/activity?action=proposal.open`));
  assert.ok(opened.length >= 4 && opened.every((r) => cells(r)[2] === "Proposed"));
  const files = events(await page(`${T}/activity?action=file.`));
  assert.ok(files.length > 0 && files.every((r) => ["Wrote", "Deleted", "Erased"].includes(cells(r)[2])));
  const clients = events(await page(`${T}/activity?path=clients%2F`));
  assert.ok(clients.length > 0 && clients.every((r) => cells(r)[3].startsWith("clients/")));
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(events(await page(`${T}/activity?from=${today}&to=${today}`)).length > 0);
  const old = await page(`${T}/activity?from=2000-01-01&to=2000-01-02`);
  assert.equal(events(old).length, 0);
  assert.match(old, /Nothing matches these filters\./);
  assert.match(old, /Clear filters/);
});

test("activity: malformed filters are ignored, not errors", async () => {
  const h = await page(`${T}/activity?who=bogus&before=abc&from=2026-99-99&action=drop+table&agent=x`);
  assert.ok(events(h).length > 0);
  assert.doesNotMatch(h, /Clear filters/);
});

test("activity: pages go back in time without gaps or repeats, keeping filters", async () => {
  const first = await page(`${S}/activity`);
  const one = events(first).map(seqOf);
  assert.equal(one.length, 50);
  const next = older(first);
  assert.match(next, /before=\d+/);
  const second = await page(next);
  const two = events(second).map(seqOf);
  const all = [...one, ...two];
  assert.equal(all.length, 65); // create, member, write, rule, 60 writes, proposal
  assert.deepEqual(all, [...all].sort((a, b) => b - a));
  assert.equal(new Set(all).size, all.length);
  assert.equal(older(second), undefined);
  assert.match(second, />Newest<\/a>/);

  const filtered = await page(`${S}/activity?agent=agents`);
  assert.equal(events(filtered).length, 50);
  assert.match(older(filtered), /agent=agents/);
  assert.equal(events(await page(older(filtered))).length, 11);
});

test("history: a file's History tab is the same log, filtered to the file", async () => {
  const h = await page(`${T}/file?path=canon%2Fpricing.md&tab=history`);
  assert.match(h, /<input type="hidden" name="path" value="canon\/pricing\.md"><input type="hidden" name="tab" value="history">/);
  assert.doesNotMatch(h, /id="f-path"/);
  const rows = events(h);
  assert.ok(rows.length >= 3);
  assert.ok(rows.some((r) => r.includes(">Proposed<")) && rows.some((r) => r.includes(">Wrote<")));
  const agents = events(await page(`${T}/file?path=canon%2Fpricing.md&tab=history&agent=agents`));
  assert.ok(agents.length > 0 && agents.every((r) => r.includes("via Hermes on Linux")));
});

test("copy: no em dashes or straight apostrophes on the new views", async () => {
  const paths = ["/activity", `${S}/activity`, `/activity?from=2000-01-01&to=2000-01-01`, `${T}/proposals/${PROPOSAL}?diff=split`,
    `${S}/proposals/${P_HTML}?diff=rendered`, `${T}/file?path=canon%2Fpricing.md&tab=history`];
  for (const path of paths) {
    const visible = (await page(path)).replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'");
    assert.doesNotMatch(visible, /—/, `em dash on ${path}`);
    assert.doesNotMatch(visible, /[a-z]'[a-z]/i, `straight apostrophe on ${path}`);
  }
});
