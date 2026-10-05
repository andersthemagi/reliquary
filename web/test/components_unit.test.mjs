// The shared page components (src/html.ts, src/flash.ts): time, breadcrumbs,
// tabs, the page header, flash messages and their storage format, callouts,
// the policy badge, action menus, empty states and confirm pages, and the
// stylesheet rules that go with them. No server needed.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const h = await import("../dist/html.js");
const fl = await import("../dist/flash.js");
const CSS = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

const NOW = Date.parse("2026-09-26T12:00:00Z");
const ago = (s) => new Date(NOW - s * 1000);

// ---------------------------------------------------------------------------
// Time

test("time: recent times are relative, with the exact UTC time in the title and datetime", () => {
  assert.equal(
    h.time(ago(6 * 60), { now: NOW }).html,
    '<time datetime="2026-09-26T11:54:00.000Z" title="2026-09-26 11:54 UTC">6 min ago</time>',
  );
  assert.equal(h.relativeTime(ago(30), NOW), "just now");
  assert.equal(h.relativeTime(ago(3 * 3600), NOW), "3 h ago");
  assert.equal(h.relativeTime(ago(4 * 86400), NOW), "4 days ago");
});

test("time: a time ahead says in how long", () => {
  assert.equal(h.relativeTime(new Date(NOW + 2 * 86400 * 1000), NOW), "in 2 days");
  assert.equal(h.relativeTime(new Date(NOW + 10 * 60 * 1000), NOW), "in 10 min");
});

test("time: older than 30 days shows the date", () => {
  assert.equal(h.relativeTime(ago(45 * 86400), NOW), "2026-08-12");
});

test("time: absolute shows the UTC time itself", () => {
  assert.equal(h.time(new Date("2026-09-26T06:49:10Z"), { absolute: true }).html, '<time datetime="2026-09-26T06:49:10.000Z">2026-09-26 06:49 UTC</time>');
  assert.equal(h.when(new Date("2026-09-26T06:49:10Z")), "2026-09-26 06:49 UTC");
});

test("time: accepts a Date, an ISO string or milliseconds, and shows nothing for none or garbage", () => {
  const iso = "2026-09-26T11:54:00.000Z";
  assert.equal(h.time(iso, { now: NOW }).html, h.time(new Date(iso), { now: NOW }).html);
  assert.equal(h.time(Date.parse(iso), { now: NOW }).html, h.time(new Date(iso), { now: NOW }).html);
  for (const x of [null, undefined, "", "not a date"]) assert.equal(h.time(x).html, "");
});

test("time: a time never wraps, so UTC doesn't end up alone on a line", () => {
  assert.match(CSS, /\ntime \{ white-space: nowrap; \}/);
});

// ---------------------------------------------------------------------------
// Breadcrumbs and tabs

test("crumb: a breadcrumb nav with an ordered list, links for the way up, the current page last and not a link", () => {
  assert.equal(
    h.crumb([{ label: "Acme <consulting>", href: "/v/1" }, { label: "canon", href: "/v/1/tree?path=canon%2F" }, { label: "pricing.md", href: "/ignored" }]).html,
    '<nav class="crumb" aria-label="Breadcrumb"><ol><li><a href="/v/1">Acme &lt;consulting&gt;</a></li><li><a href="/v/1/tree?path=canon%2F">canon</a></li><li aria-current="page">pricing.md</li></ol></nav>',
  );
  assert.equal(h.crumb([]).html, "");
});

test("tabs: links with the current one marked and optional counts", () => {
  assert.equal(
    h.tabs([{ href: "/a", label: "Open", count: 3, current: true }, { href: "/b", label: "Closed" }], "Proposals").html,
    '<nav class="tabs" aria-label="Proposals"><a href="/a" aria-current="page">Open<span class="count">3</span></a><a href="/b">Closed</a></nav>',
  );
});

// ---------------------------------------------------------------------------
// Page header

test("pageHeader: crumb, title, badge, actions with the primary last, a description, meta and tabs, in that order", () => {
  const out = h.pageHeader({
    crumb: [{ label: "Acme", href: "/v/1" }, { label: "Proposals" }],
    title: "Change canon/pricing.md",
    badge: h.raw('<span class="badge info">Open</span>'),
    primary: h.raw('<button class="primary">Approve</button>'),
    secondary: h.raw('<a class="button" href="/e">Edit, then approve</a>'),
    description: "Read the change before its reason.",
    meta: h.raw('<p class="meta">By Ben</p>'),
    tabs: [{ href: "/x", label: "Conversation", current: true }],
  }).html;
  const order = ['aria-label="Breadcrumb"', "<h1>Change canon/pricing.md</h1>", 'class="badge info"', "Edit, then approve", "Approve</button>", 'class="page-desc"', 'class="meta"', 'class="tabs"'];
  const at = order.map((s) => out.indexOf(s));
  assert.ok(at.every((i) => i >= 0), `all present: ${at}`);
  assert.deepEqual([...at].sort((a, b) => a - b), at, "in order");
  assert.match(out, /<div class="page-head has-tabs">/);
  assert.match(out, /<div class="page-actions"><a class="button" href="\/e">Edit, then approve<\/a><button class="primary">Approve<\/button><\/div>/);
});

test("pageHeader: no actions, description or tabs render nothing for them; the older actions slot still works", () => {
  const bare = h.pageHeader({ title: "Vaults" }).html;
  assert.doesNotMatch(bare, /page-actions|page-desc|tabs|has-tabs/);
  assert.match(h.pageHeader({ title: "T", actions: h.raw("<a>x</a>"), primary: h.raw("<b>p</b>") }).html, /<div class="page-actions"><a>x<\/a><b>p<\/b><\/div>/);
  assert.match(h.pageHeader({ title: "T", crumb: h.raw('<p class="crumb">old</p>') }).html, /<p class="crumb">old<\/p>/);
});

test("pageHeader: text is escaped", () => {
  const out = h.pageHeader({ title: "<b>x</b>", description: "a & b" }).html;
  assert.match(out, /<h1>&lt;b&gt;x&lt;\/b&gt;<\/h1>/);
  assert.match(out, /<p class="page-desc">a &amp; b<\/p>/);
});

// ---------------------------------------------------------------------------
// Flash

const vaultLike = (header) => h.html`<div class="vault"><aside class="side">sidebar</aside><div class="content">${header}<p>body</p></div></div>`;

test("flash: shown after the page header, inside the content column, not above the layout", () => {
  const out = h.page("Settings", vaultLike(h.pageHeader({ title: "Settings" })), { flash: { text: "Saved.", tone: "success" } });
  assert.match(out, /<div class="content"><div class="page-head">[\s\S]*?<h1>Settings<\/h1>[\s\S]*?<\/div>\s*<\/div><p class="callout success flash" role="status">Saved\.<\/p><p>body<\/p>/);
  assert.ok(out.indexOf("flash") > out.indexOf('<aside class="side">'));
  assert.doesNotMatch(out, /<!--flash-/, "the placeholder never reaches the page");
});

test("flash: a page without a page header shows it at the top of the main column", () => {
  const out = h.page("Error", h.html`<h1>Not found</h1>`, { flash: "Heads up." });
  assert.match(out, /<main id="main">\s*<p class="callout info flash" role="status">Heads up\.<\/p><h1>Not found<\/h1>/);
});

test("flash: no message, no callout, and no placeholder left behind", () => {
  const out = h.page("Settings", vaultLike(h.pageHeader({ title: "Settings" })), {});
  assert.doesNotMatch(out, /callout|<!--flash-/);
});

test("flash: only the first page header takes it; text can't choose where it goes", () => {
  const two = h.html`${h.pageHeader({ title: "One" })}${h.pageHeader({ title: "Two" })}`;
  const out = h.page("P", two, { flash: "Once." });
  assert.equal(out.split("Once.").length - 1, 1);
  assert.ok(out.indexOf("Once.") < out.indexOf("<h1>Two</h1>"));
  // A comment in raw content (rendered markdown, say) isn't the placeholder.
  const fake = h.page("P", h.raw('<div class="prose"><!--flash-0000000000000000--></div>'), { flash: "Top." });
  assert.match(fake, /<main id="main">\s*<p class="callout info flash" role="status">Top\.<\/p><div class="prose">/);
});

test("flash: each tone has its class; danger is an alert, the others a status", () => {
  for (const [tone, role] of [["info", "status"], ["success", "status"], ["warning", "status"], ["danger", "alert"]]) {
    assert.equal(h.flashMessage({ text: "M <x>", tone }).html, `<p class="callout ${tone} flash" role="${role}">M &lt;x&gt;</p>`);
  }
});

test("flash: a message ending in a reference is a refusal (danger) unless a tone is given; anything else is info", () => {
  assert.equal(fl.flashTone("Only owners rename a vault. (ref 1a2b3c4d)"), "danger");
  assert.equal(fl.flashTone("That’s too long: x (ref 1a2b3c4d)."), "danger");
  assert.equal(fl.flashTone("Nothing changed."), "info");
  assert.equal(fl.flashTone("Saved notes/a.md.", "success"), "success");
  assert.equal(fl.flashTone("Refused. (ref 1a2b3c4d)", "warning"), "warning");
  assert.equal(fl.flashTone("x", "loud"), "info", "an unknown tone isn't used");
  assert.deepEqual(fl.toFlash("Refused (ref 00ff00ff)"), { text: "Refused (ref 00ff00ff)", tone: "danger" });
});

test("flash: stored as text and tone, read back the same; a message from before tones reads as its text", () => {
  for (const f of [{ text: "Saved canon/ä.md.", tone: "success" }, { text: "{not json", tone: "info" }, { text: "Refused. (ref 1a2b3c4d)", tone: "danger" }]) {
    assert.deepEqual(fl.decodeFlash(fl.encodeFlash(f)), f);
  }
  const old = Buffer.from("Invite revoked. Its link no longer works.").toString("base64url");
  assert.deepEqual(fl.decodeFlash(old), { text: "Invite revoked. Its link no longer works.", tone: "info" });
  const oldRefusal = Buffer.from("Nope. (ref 1a2b3c4d)").toString("base64url");
  assert.equal(fl.decodeFlash(oldRefusal).tone, "danger");
  const badTone = Buffer.from(JSON.stringify({ t: "<script>", m: "Hi" })).toString("base64url");
  assert.deepEqual(fl.decodeFlash(badTone), { text: "Hi", tone: "info" });
  assert.equal(fl.decodeFlash(""), undefined);
});

// ---------------------------------------------------------------------------
// Callouts, badges, empty states

test("callout: a tone class; danger is an alert; a string is one paragraph; a title leads", () => {
  assert.equal(h.callout("info", "Heads <up>").html, '<div class="callout info"><p>Heads &lt;up&gt;</p></div>');
  assert.equal(h.callout("danger", "No.").html, '<div class="callout danger" role="alert"><p>No.</p></div>');
  assert.equal(h.callout("success", h.raw("<ul><li>a</li></ul>"), { title: "Done", id: "done" }).html,
    '<div class="callout success" id="done"><p class="callout-title"><strong>Done</strong></p><ul><li>a</li></ul></div>');
  assert.equal(h.callout("warning", "Check.").html, '<div class="callout warning"><p>Check.</p></div>');
});

test("callout: the warning tone has its colours, and every tone but info a mark, in the stylesheet", () => {
  assert.match(CSS, /\.callout\.warning \{ background: var\(--attention-bg\);/);
  assert.match(CSS, /\.callout\.success::before, \.callout\.warning::before, \.callout\.attention::before, \.callout\.danger::before \{/);
});

test("policyBadge: canon and open with a diamond class and a title that explains the term", () => {
  assert.equal(h.policyBadge("canon").html, '<span class="badge policy canon" title="Canon: changes are proposals that people approve">Canon</span>');
  assert.equal(h.policyBadge("open").html, '<span class="badge policy open" title="Open: members and agents write directly">Open</span>');
  assert.equal(h.policyBadge("<odd>").html, '<span class="badge">&lt;odd&gt;</span>');
});

test("emptyState: what's missing, when it appears, and the action", () => {
  assert.equal(h.emptyState({ title: "No files yet.", body: "Files you or your agents add show up here.", action: h.raw('<a class="button" href="/n">New file</a>') }).html,
    '<div class="empty"><strong>No files yet.</strong><p>Files you or your agents add show up here.</p><p class="empty-action"><a class="button" href="/n">New file</a></p></div>');
  assert.equal(h.emptyState({ title: "Nothing here." }).html, '<div class="empty"><strong>Nothing here.</strong></div>');
});

// ---------------------------------------------------------------------------
// Menus

test("menu: a details menu whose button opens a list of links and one-button forms with the form token", () => {
  const out = h.menu({
    label: "More",
    heading: "This file",
    items: [
      { href: "/h", label: "History" },
      { href: "/d", label: "Delete file…", description: "Moves it out of the vault; history stays.", danger: true },
      { action: "/snooze", csrf: "c0ffee", fields: { for: "day" }, label: "For a day" },
    ],
  }).html;
  assert.match(out, /^<details class="menu-wrap action-menu">\s*<summary class="button">More<\/summary>/);
  assert.match(out, /<div class="menu action-list">\s*<p class="menu-label">This file<\/p>/);
  assert.match(out, /<li><a class="menu-item" href="\/h"><span class="menu-item-title">History<\/span><\/a><\/li>/);
  assert.match(out, /<li><a class="menu-item danger" href="\/d"><span class="menu-item-title">Delete file…<\/span><span class="menu-item-meta">Moves it out of the vault; history stays\.<\/span><\/a><\/li>/);
  assert.match(out, /<li><form method="post" action="\/snooze"><input type="hidden" name="csrf" value="c0ffee"><input type="hidden" name="for" value="day"><button class="menu-item"><span class="menu-item-title">For a day<\/span><\/button><\/form><\/li>/);
});

test("menu: no script and no role=menu; keyboard use is the summary (Enter, Space) and Tab through the items", () => {
  const out = h.menu({ label: "More", items: [{ href: "/h", label: "History" }] }).html;
  assert.doesNotMatch(out, /<script|role="menu|onclick|tabindex="-1"/);
});

test("menu: a ⋯ button has its label as its accessible name; ghost and left-aligned variants", () => {
  const out = h.menu({ label: "Actions for DATABASE_URL", icon: "more", align: "left", items: [{ href: "/r", label: "Reveal" }] }).html;
  assert.match(out, /<details class="menu-wrap action-menu var-menu">/);
  assert.match(out, /<summary class="button quiet icon-button" aria-label="Actions for DATABASE_URL" title="Actions for DATABASE_URL"><svg class="icon"[^>]*aria-hidden="true"/);
  assert.match(out, /<div class="menu action-list menu-left">/);
  assert.match(h.menu({ label: "Snooze", ghost: true, items: [] }).html, /<summary class="button quiet">Snooze<\/summary>/);
});

test("menu: a ⋯ menu opens from its button, not its table cell, so a table or scrolling box never clips it", () => {
  assert.match(h.menu({ label: "Actions for the rule on canon/", icon: "more", items: [] }).html, /^<details class="menu-wrap action-menu var-menu">/);
  assert.doesNotMatch(h.menu({ label: "More", items: [] }).html, /var-menu/);
  assert.match(CSS, /\.var-menu\.menu-wrap \{ position: static;/);
  assert.match(CSS, /\.var-menu > \.menu \{[^}]*transform: translateX\(calc\(-100% \+ 32px\)\)/);
});

// ---------------------------------------------------------------------------
// Confirm pages

test("confirmPage: header, what will happen, the consequences, and a form with the danger button and Cancel", () => {
  const out = h.confirmPage({
    crumb: [{ label: "Acme", href: "/v/1" }, { label: "Tokens" }],
    title: "Revoke Claude Code on laptop?",
    lede: "Any agent using it is cut off on its next request.",
    consequences: ["It can't be turned back on.", h.raw("<strong>Make a new one</strong> to reconnect.")],
    action: "/tokens/t1/revoke",
    csrf: "c0ffee",
    fields: { back: "/tokens" },
    button: "Revoke Claude Code on laptop",
    cancel: "/tokens",
  }).html;
  assert.match(out, /<h1>Revoke Claude Code on laptop\?<\/h1>/);
  assert.match(out, /<p class="lede confirm-lede">Any agent using it is cut off on its next request\.<\/p>/);
  assert.match(out, /<ul class="consequences"><li>It can&#39;t be turned back on\.<\/li><li><strong>Make a new one<\/strong> to reconnect\.<\/li><\/ul>/);
  assert.match(out, /<form method="post" action="\/tokens\/t1\/revoke" class="panel confirm">\s*<input type="hidden" name="csrf" value="c0ffee"><input type="hidden" name="back" value="\/tokens">/);
  assert.match(out, /<div class="actions"><button class="danger solid">Revoke Claude Code on laptop<\/button><a class="button quiet" href="\/tokens">Cancel<\/a><\/div>/);
  assert.doesNotMatch(out, /confirm-typed|role="alert"/);
});

test("confirmPage: a typed-name step asks for the exact value; an error comes back as an alert", () => {
  const out = h.confirmPage({
    title: "Delete Acme",
    lede: "This deletes the vault now.",
    action: "/v/1/config/delete",
    csrf: "c",
    typed: { value: "Acme <co>" },
    button: "Delete this vault",
    cancel: "/v/1/config",
    error: "That isn’t the vault’s name. Nothing was deleted.",
  }).html;
  assert.match(out, /<div class="callout danger" role="alert"><p>That isn’t the vault’s name\. Nothing was deleted\.<\/p><\/div>/);
  assert.match(out, /<label for="confirm-typed">Type <strong>Acme &lt;co&gt;<\/strong> to confirm<\/label>/);
  assert.match(out, /<input id="confirm-typed" type="text" name="confirm_name" required autocomplete="off" spellcheck="false" autocapitalize="off">/);
  const named = h.confirmPage({ title: "Erase", lede: "x", action: "/e", csrf: "c", typed: { value: "a.md", name: "confirm_path", label: "Type the path" }, button: "Erase", cancel: "/" }).html;
  assert.match(named, /<label for="confirm-typed">Type the path<\/label>\s*<input id="confirm-typed" type="text" name="confirm_path"/);
});

// ---------------------------------------------------------------------------
// Stylesheet

test("stylesheet: tabular figures only where numbers line up, not on body text", () => {
  const body = /\nbody \{([^}]*)\}/.exec(CSS)[1];
  assert.doesNotMatch(body, /tabular-nums/);
  assert.match(CSS, /\ntd, th, \.num, time, \.count, \.diff-stat, \.meter \{ font-variant-numeric: tabular-nums; \}/);
});

test("stylesheet: stacked tables on phones label each cell from data-label", () => {
  const phone = CSS.slice(CSS.indexOf("/* Tables that stack on a phone"));
  assert.match(phone, /@media \(max-width: 640px\) \{/);
  assert.match(phone, /\.table-stack td::before, \.table-stack tbody th::before \{ content: attr\(data-label\);/);
  assert.match(phone, /table\.table-stack \{ min-width: 0; \}/);
});

test("stylesheet: button variants for the hierarchy (secondary, ghost, danger, filled danger)", () => {
  for (const sel of [/\n\.secondary \{/, /\n\.ghost \{/, /\n\.ghost:hover \{/, /\n\.danger \{/, /\n\.danger\.solid \{/, /\n\.primary, a\.button\.primary \{/]) assert.match(CSS, sel);
});

test("stylesheet: every rule and @media block closes, so a missing brace can't swallow the rest of the file", () => {
  const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  let line = 1;
  for (const ch of stripped) {
    if (ch === "\n") line++;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      assert.ok(depth >= 0, `unmatched closing brace at line ${line}`);
    }
  }
  assert.equal(depth, 0, "unclosed rule or @media block (brace count doesn't return to 0)");
});
