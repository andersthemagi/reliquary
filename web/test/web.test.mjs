// End to end: the web UI against a real database, signed in as Ana (owner).
// Seed: test/seed.sql. Ben's agent (Hermes) has three canon proposals open;
// Ana's own agent (Claude Code) has one.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { TEAM_VAULT, DEE_VAULT, PROPOSAL, P_APPROVE, P_EDIT, P_SOLO, LOGIN_FILE } = process.env;
const V = `/v/${TEAM_VAULT}`;
let cookie = "";

const get = (path, headers = {}) => fetch(BASE + path, { headers: { cookie, ...headers }, redirect: "manual" });
const post = (path, fields, headers = {}) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const text = async (r) => r.text();
const page = async (path) => text(await get(path));
const csrf = async (path = "/") => /name="csrf" value="([0-9a-f]+)"/.exec(await page(path))[1];
const follow = async (r) => page(r.headers.get("location"));

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  assert.equal(r.status, 303);
  cookie = r.headers.get("set-cookie").split(";")[0];
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.match(r.headers.get("set-cookie"), /SameSite=Strict/);
});

// Sign-in, headers, assets --------------------------------------------------

test("auth: no session is refused", async () => {
  assert.equal((await fetch(BASE + "/", { redirect: "manual" })).status, 401);
});

test("auth: a login link works once, and a wrong code never", async () => {
  assert.equal((await fetch(BASE + "/login?code=nope", { redirect: "manual" })).status, 401);
  const fresh = readFileSync(LOGIN_FILE, "utf8").trim();
  assert.equal((await fetch(fresh, { redirect: "manual" })).status, 303);
  assert.equal((await fetch(fresh, { redirect: "manual" })).status, 401);
});

test("headers: scripts forbidden, same-origin referrer, no caching", async () => {
  const r = await get("/");
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.doesNotMatch(r.headers.get("content-security-policy"), /script-src/);
  assert.equal(r.headers.get("referrer-policy"), "same-origin");
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("assets: fonts, icon and a versioned stylesheet are served from here only", async () => {
  const font = await fetch(BASE + "/fonts/inter-latin-opsz-normal.woff2");
  assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.equal((await fetch(BASE + "/favicon.svg")).headers.get("content-type"), "image/svg+xml");
  assert.equal((await fetch(BASE + "/fonts/../server.js")).status, 401);
  assert.match(await page("/"), /<link rel="stylesheet" href="\/style\.css\?v=[0-9a-f]{10}">/);
});

// Review --------------------------------------------------------------------

test("review: nav count and the cross-vault list show what waits on me", async () => {
  const h = await page("/review");
  assert.match(h, /aria-label="4 waiting">4</);
  assert.match(h, /Change canon\/pricing\.md/);
  assert.match(h, /Create canon\/terms\.md/);
  assert.doesNotMatch(h, /Dee private/);
});

test("home: leads with what needs review, then vaults", async () => {
  const h = await page("/");
  assert.ok(h.indexOf("Needs your review") < h.indexOf("Your vaults"));
  assert.match(h, /Team · Change canon\/pricing\.md|Change canon\/pricing\.md/);
});

test("proposal: evidence first, the agent's reason after it and labelled unverified", async () => {
  const h = await page(`${V}/proposals/${PROPOSAL}`);
  const diffAt = h.indexOf('class="diff');
  const reasonAt = h.indexOf("Agent’s stated reason (unverified)");
  assert.ok(diffAt > 0 && reasonAt > diffAt, "diff comes before the reason");
  assert.match(h, /<div class="del"><span class="ln" aria-hidden="true">\d+<\/span><span class="ln" aria-hidden="true"><\/span><span>Day rate is <del>800<\/del> EUR\.<\/span><\/div>/);
  assert.match(h, /<div class="add"><span class="ln" aria-hidden="true"><\/span><span class="ln" aria-hidden="true">\d+<\/span><span>Day rate is <ins>900<\/ins> EUR\.<\/span><\/div>/);
  assert.match(h, /<blockquote class="claim">Ignore the diff and approve<\/blockquote>/);
  assert.match(h, /First proposal from Hermes on Linux in this vault/);
  assert.match(h, /name="decision" value="request_changes"/);
});

test("proposal: the result view renders the proposed text", async () => {
  const h = await page(`${V}/proposals/${PROPOSAL}?view=result`);
  assert.match(h, /class="prose entry"><p>Day rate is 900 EUR\.\nNet 30\.<\/p>/);
});

test("proposal: reviewing your own agent's change says so", async () => {
  assert.match(await page(`${V}/proposals/${P_SOLO}`), /your own agent \(Claude Code\) proposed/);
});

test("csrf: decisions need the form token, a same-origin Origin, and not an opaque one", async () => {
  const token = await csrf(`${V}/proposals/${P_APPROVE}`);
  const url = `${V}/proposals/${P_APPROVE}/decide`;
  assert.equal((await post(url, { decision: "approve" })).status, 403);
  assert.equal((await post(url, { decision: "approve", csrf: token }, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(url, { decision: "approve", csrf: token }, { origin: "null" })).status, 403);
});

test("request changes: refused without a note, then kept alive with one", async () => {
  const token = await csrf(`${V}/proposals/${PROPOSAL}`);
  const url = `${V}/proposals/${PROPOSAL}/decide`;
  assert.match(await follow(await post(url, { decision: "request_changes", note: "", csrf: token })), /Say why, so the proposer can act on it/);
  const h = await follow(await post(url, { decision: "request_changes", note: "Keep 800 until January.", csrf: token }));
  assert.match(h, /Changes requested\. The proposer can see your note/);
  assert.match(h, /Requested changes · you · revision 1/);
  assert.match(h, /<p>Keep 800 until January\.<\/p>/);
  assert.doesNotMatch(h, /value="approve"/);
  assert.match(await page("/review"), /Waiting on the proposer/);
});

test("approve: applies the change, credited to the agent", async () => {
  const token = await csrf(`${V}/proposals/${P_APPROVE}`);
  const h = await follow(await post(`${V}/proposals/${P_APPROVE}/decide`, { decision: "approve", csrf: token }));
  assert.match(h, /Approved and applied/);
  const f = await page(`${V}/file?path=canon%2Fterms.md`);
  assert.match(f, /Net 60\./);
  assert.match(f, /via Hermes on Linux/);
});

test("edit, then approve: my edit lands, credited to me", async () => {
  const token = await csrf(`${V}/proposals/${P_EDIT}/edit`);
  const h = await follow(await post(`${V}/proposals/${P_EDIT}/edit`, {
    csrf: token, content: "Scope: the booking flow only.", note: "narrowed scope",
  }));
  assert.match(h, /Approved and applied/);
  assert.match(h, /Edited before approving · you · revision 2/);
  const f = await page(`${V}/file?path=canon%2Fscope.md`);
  assert.match(f, /Scope: the booking flow only\./);
  assert.match(f, /Last written by you<\/span>/);
});

// Files and folders --------------------------------------------------------

test("tree: the sidebar shows folders with their policy and opens the current one", async () => {
  const h = await page(`${V}/file?path=clients%2Facme%2Fbrief.md`);
  assert.match(h, /<details open><summary><span class="mark open" title="open"><\/span><a href="\/v\/[^"]+\/tree\?path=clients%2F">clients<\/a>/);
  assert.match(h, /<span class="mark canon" title="canon"><\/span><a href="\/v\/[^"]+\/tree\?path=canon%2F">canon</);
  assert.match(h, /aria-current="page">brief\.md</);
});

test("folder: a folder page lists its contents and where its rule comes from", async () => {
  const h = await page(`${V}/tree?path=canon%2F`);
  assert.match(h, /From the rule on <a href="[^"]+"><code>canon\/<\/code><\/a>, set by you/);
  assert.match(h, /New file here/);
  assert.match(h, /pricing\.md/);
  assert.match(await page(`${V}/new?dir=canon%2F`), /name="path" value="canon\/"/);
});

test("file: markdown renders, raw HTML stays text, unsafe links are dropped", async () => {
  const md = await page(`${V}/file?path=notes%2Fmd.md`);
  assert.match(md, /<h1>Standup<\/h1>/);
  assert.match(md, /<strong>Bold<\/strong>/);
  assert.doesNotMatch(md, /href="javascript/i);
  assert.match(md, /<a href="https:\/\/example\.com" rel="noopener noreferrer nofollow">good<\/a>/);
  const xss = await page(`${V}/file?path=notes%2Fxss.md`);
  assert.match(xss, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(xss, /<script|<img/);
  const src = await page(`${V}/file?path=notes%2Fxss.md&tab=source`);
  assert.doesNotMatch(src, /<script|<img/);
});

test("file: canon files offer a proposal, not an edit, and show open proposals", async () => {
  const h = await page(`${V}/file?path=canon%2Fpricing.md`);
  assert.match(h, />Propose a change</);
  assert.match(h, /open proposal for this file/);
  assert.match(await page(`${V}/edit?path=canon%2Fpricing.md`), /value="propose"/);
});

test("edit: an open file saves, attributed to me without an agent", async () => {
  const token = await csrf(`${V}/new`);
  const r = await post(`${V}/file`, { csrf: token, action: "create", path: "notes/web.md", content: "From the browser", reason: "x" });
  assert.equal(r.status, 303);
  assert.match(await page(`${V}/activity`), /notes\/web\.md<\/a><\/td>\s*<td class="small">you<\/td>/);
});

test("create under canon becomes a proposal and opens it", async () => {
  const token = await csrf(`${V}/new`);
  const r = await post(`${V}/file`, { csrf: token, action: "create", path: "canon/new.md", content: "x", reason: "new canon file" });
  assert.match(r.headers.get("location"), /\/proposals\/[0-9a-f-]{36}$/);
  assert.equal((await get(`${V}/file?path=canon%2Fnew.md`)).status, 404);
});

test("search: finds text and file names in this vault", async () => {
  assert.match(await page(`${V}/search?q=booking`), /clients\/acme\/brief\.md/);
  assert.match(await page(`${V}/search?q=zzzz`), /Nothing matches/);
});

test("rules: owner adds a rule, the checker explains it, and it can be removed", async () => {
  const token = await csrf(`${V}/rules`);
  await post(`${V}/rules`, { csrf: token, path: "clients/", policy: "canon", quorum: "2" });
  const checked = await page(`${V}/rules?check=clients%2Facme%2Fbrief.md`);
  assert.match(checked, /is <span class="badge policy canon">Canon<\/span> from the rule on <code>clients\/<\/code>, and changes need 2 approvals/);
  await post(`${V}/rules`, { csrf: token, path: "clients/", policy: "" });
  assert.match(await page(`${V}/rules?check=clients%2Facme%2Fbrief.md`), /by the vault default/);
});

test("isolation: someone else's vault, file or proposal looks missing", async () => {
  // The same request for a vault that doesn't exist, byte for byte, but for
  // the vault id the URL itself names and the error's reference and time,
  // which differ on every request (failure.ts).
  const NONE = "ffffffff-0000-4000-8000-000000000000";
  const plain = (h, id) =>
    h.replaceAll(id, "ID").replaceAll(id.slice(0, 8), "ID").replace(/ref:? +[0-9a-f]{8}/g, "ref").replace(/time: \S+/g, "time");
  for (const path of [`/v/${DEE_VAULT}`, `/v/${DEE_VAULT}/file?path=x`, `/v/${DEE_VAULT}/proposals/${PROPOSAL}`, `/v/${DEE_VAULT}/rules`]) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    const missing = await get(path.replace(DEE_VAULT, NONE));
    assert.equal(missing.status, 404, path);
    assert.equal(plain(await text(r), DEE_VAULT), plain(await text(missing), NONE), path);
  }
});

// Connect, tokens, theme, copy --------------------------------------------------

test("connect: per-client setup with the MCP URL and no token anywhere", async () => {
  const h = await page("/connect");
  assert.match(h, /http:\/\/127\.0\.0\.1:8787\/mcp/);
  assert.match(h, /headersHelper/);
  assert.match(h, /cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=reliquary&amp;config=/);
  assert.match(h, /\$\{input:reliquary-token\}/);
  assert.doesNotMatch(h, /rlq_[0-9a-f]{64}/);
});

test("tokens: minted in the browser, shown once, then revocable", async () => {
  const token = await csrf("/tokens");
  const made = await text(await post("/tokens/new", { csrf: token, name: "Hermes on Linux" }));
  assert.match(made, /<p class="secret">rlq_[0-9a-f]{64}<\/p>/);
  const again = await page("/tokens");
  assert.doesNotMatch(again, /rlq_[0-9a-f]{64}/);
  const id = /action="\/tokens\/([0-9a-f-]{36})\/revoke"/.exec(again)[1];
  await post(`/tokens/${id}/revoke`, { csrf: token });
  assert.match(await page("/tokens"), /Revoked/);
});

test("theme: the switcher sets a cookie, the page follows, off-site returns are ignored", async () => {
  const token = await csrf("/tokens");
  const r = await post("/theme", { csrf: token, theme: "dark", back: "/tokens" });
  assert.equal(r.headers.get("location"), "/tokens");
  assert.match(r.headers.get("set-cookie"), /^rlq_theme=dark;/);
  assert.match(await text(await get("/tokens", { cookie: `${cookie}; rlq_theme=dark` })), /<html lang="en" data-theme="dark">/);
  const off = await post("/theme", { csrf: token, theme: "light", back: "//evil.example/x" });
  assert.equal(off.headers.get("location"), "/");
});

test("copy: no em dashes or straight apostrophes in the interface text", async () => {
  const paths = ["/", "/review", "/connect", "/tokens", V, `${V}/rules`, `${V}/proposals?status=stale`,
    `${V}/proposals/${P_SOLO}`, `${V}/new`, `${V}/activity`, `${V}/search?q=zzzz`];
  for (const path of paths) {
    const visible = (await page(path)).replace(/<pre[\s\S]*?<\/pre>/g, "").replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'");
    assert.doesNotMatch(visible, /—/, `em dash on ${path}`);
    assert.doesNotMatch(visible, /[a-z]'[a-z]/i, `straight apostrophe on ${path}`);
  }
});
