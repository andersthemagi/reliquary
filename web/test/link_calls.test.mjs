// A link's Calls page and the Links list's call columns (src/linkcalls.ts,
// src/linkspage.ts; issue #440). Who may read link_calls is proved once, in
// supabase/tests/links_test.sql ("calls:"); this file is about what a person
// sees: the calls newest first with who, agent, tool, outcome and size,
// never a hash; the pager; a viewer told why there is nothing; another
// vault's link never showing; and each link's last call and 7-day count.
//
// Cy owns "Calls main" (Dot edits, Eli views); Fay owns only "Calls Fay".

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { as, page, get, sql, start, visibleText } from "./threads-harness.mjs";

const CY = "00000000-0000-0000-0000-0000000044c1";
const DOT = "00000000-0000-0000-0000-0000000044c2";
const ELI = "00000000-0000-0000-0000-0000000044c3";
const FAY = "00000000-0000-0000-0000-0000000044c4";

const V = {};
const L = {};
let cy;
let dot;
let eli;
let fay;

const addLink = async (vault, name, by) =>
  (await sql(`insert into public.links (vault_id, name, url, created_by) values ($1, $2, 'https://mcp.example.test/mcp', $3) returning id`, [vault, name, by]))[0].id;
const addCall = (link, vault, o) =>
  sql(
    `insert into public.link_calls (link_id, vault_id, actor, agent, tool_name, outcome, arg_hash, result_hash, result_bytes, at)
     values ($1, $2, $3, $4, $5, $6, 'ARGHASH-NEVER-SHOWN', 'RESHASH-NEVER-SHOWN', $7, now() - $8::interval)`,
    [link, vault, o.actor ?? null, o.agent ?? null, o.tool ?? "list_issues", o.outcome ?? "ok", o.bytes ?? null, o.ago ?? "0 seconds"],
  );
const calls = (l) => `/v/${V.main}/links/${l}/calls`;
const rowsOf = (h) => [...h.matchAll(/<tr><td class="small" data-label="When">[\s\S]*?<\/tr>/g)].map((m) => visibleText(m[0]).trim());

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'cy@example.test'), ($2, 'dot@example.test'), ($3, 'eli@example.test'), ($4, 'fay@example.test')
       on conflict (id) do nothing`,
    [CY, DOT, ELI, FAY],
  );
  [{ id: V.main }] = await as(CY, "select public.create_vault('Calls main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3), test_support.add_member($1, $4, 'viewer', $3)", [V.main, DOT, CY, ELI]);
  [{ id: V.fay }] = await as(FAY, "select public.create_vault('Calls Fay', 'open') as id");

  L.linear = await addLink(V.main, "linear", CY);
  L.quiet = await addLink(V.main, "quiet", CY);
  L.busy = await addLink(V.main, "busy", CY);
  L.fay = await addLink(V.fay, "fays", FAY);

  // Oldest first.
  await addCall(L.linear, V.main, { actor: DOT, tool: "old_tool", ago: "10 days" });
  await addCall(L.linear, V.main, { actor: DOT, tool: "create_issue", outcome: "refused", ago: "3 hours" });
  await addCall(L.linear, V.main, { actor: DOT, tool: "list_teams", outcome: "error", bytes: 12, ago: "2 hours" });
  await addCall(L.linear, V.main, { actor: CY, agent: "Claude Code", tool: "list_issues", bytes: 2048, ago: "1 hour" });
  await sql(
    `insert into public.link_calls (link_id, vault_id, actor, tool_name, outcome, at)
     select $1, $2, $3, 'call_' || g, 'ok', now() - interval '1 day' + g * interval '1 second' from generate_series(1, 101) g`,
    [L.busy, V.main, CY],
  );
  await addCall(L.fay, V.fay, { actor: FAY, tool: "fay_secret_tool" });

  cy = await start(CY, "calls-cy");
  dot = await start(DOT, "calls-dot");
  eli = await start(ELI, "calls-eli");
  fay = await start(FAY, "calls-fay");
});

after(async () => {
  for (const s of [cy, dot, eli, fay]) s?.child?.kill();
});

test("link calls: a link's menu has Calls, which opens its Calls page", async () => {
  const h = await page(cy, `/v/${V.main}/links`);
  assert.match(h, new RegExp(`href="${calls(L.linear)}"><span class="menu-item-title">Calls</span>`));
  const c = await page(cy, calls(L.linear));
  assert.match(c, /<h1>Calls to linear<\/h1>/);
});

test("link calls: newest first, each with when, the person and their agent, the tool, the outcome and the size", async () => {
  const rows = rowsOf(await page(cy, calls(L.linear)));
  assert.equal(rows.length, 4);
  assert.match(rows[0], / you via Claude Code linear\.list_issues OK 2 KB$/);
  assert.match(rows[1], / dot@example\.test linear\.list_teams Error 12 bytes$/);
  assert.match(rows[2], / dot@example\.test linear\.create_issue Refused —$/);
  assert.match(rows[3], /linear\.old_tool OK —$/);
});

test("link calls: never the arguments, the result or their hashes", async () => {
  const h = await page(cy, calls(L.linear));
  assert.doesNotMatch(h, /HASH-NEVER-SHOWN/);
  assert.match(h, /Arguments and answers are never stored\./);
});

test("link calls: 100 a page, then Older; past the last page says No older calls", async () => {
  const h = await page(cy, calls(L.busy));
  const rows = rowsOf(h);
  assert.equal(rows.length, 100);
  assert.match(rows[0], /busy\.call_101 /);
  const older = /<a class="older" href="([^"]+)">Older<\/a>/.exec(h)[1].replaceAll("&amp;", "&");
  const h2 = await page(cy, older);
  assert.deepEqual(rowsOf(h2).map((r) => /busy\.(\w+)/.exec(r)[1]), ["call_1"]);
  assert.doesNotMatch(h2, /class="older"/);
  assert.match(h2, new RegExp(`<a href="${calls(L.busy)}">Newest</a>`));
  const past = await page(cy, `${calls(L.busy)}?before=1`);
  assert.match(past, /<strong>No older calls<\/strong>/);
  assert.doesNotMatch(past, /class="pager"/);
});

test("link calls: a link no agent has called says so", async () => {
  const h = await page(cy, calls(L.quiet));
  assert.match(h, /<strong>No calls yet<\/strong><p>No agent has called <code>quiet<\/code> yet\./);
  assert.equal(rowsOf(h).length, 0);
});

test("link calls: an editor reads them; a viewer is told only owners and editors can", async () => {
  assert.equal(rowsOf(await page(dot, calls(L.linear))).length, 4);
  const v = await page(eli, calls(L.linear));
  assert.match(v, /<strong>Only owners and editors can see a link’s calls\.<\/strong>/);
  assert.equal(rowsOf(v).length, 0);
});

test("link calls: another vault's calls never show", async () => {
  assert.equal((await get(fay, calls(L.linear))).status, 404, "a vault she isn't in is Not found");
  const r = await get(fay, `/v/${V.fay}/links/${L.linear}/calls`);
  assert.equal(r.status, 303, "another vault's link under her own vault is gone");
  assert.equal(r.headers.get("location"), `/v/${V.fay}/links`);
  assert.doesNotMatch(await page(cy, calls(L.fay)), /fay_secret_tool/);
});

test("links list calls: each link shows its last call, linking to its Calls page, and its count over the last 7 days", async () => {
  const h = await page(cy, `/v/${V.main}/links`);
  const row = (name) => new RegExp(`<tr>\\s*<td data-label="Name"><code>${name}</code>[\\s\\S]*?</tr>`).exec(h)[0];
  assert.match(row("linear"), new RegExp(`<td data-label="Last call" class="small"><a href="${calls(L.linear)}"><time [^>]+>[^<]+</time></a></td>`));
  assert.match(row("linear"), /<td data-label="Last 7 days" class="small num">3<\/td>/, "the call 10 days ago isn't counted");
  assert.match(row("quiet"), new RegExp(`<a href="${calls(L.quiet)}">Never</a>`));
  assert.match(row("quiet"), /<td data-label="Last 7 days" class="small num">0<\/td>/);
  assert.match(row("busy"), /<td data-label="Last 7 days" class="small num">101<\/td>/);
  const e = await page(dot, `/v/${V.main}/links`);
  assert.match(e, /<th scope="col">Last call<\/th>/, "an editor sees them too");
});

test("links list calls: a viewer sees no call columns", async () => {
  const h = await page(eli, `/v/${V.main}/links`);
  assert.match(h, /<code>linear<\/code>/);
  assert.doesNotMatch(h, /Last call|Last 7 days/);
});
