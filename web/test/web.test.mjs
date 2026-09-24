// End to end: the web UI against a real database, signed in as Ana (owner).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { TEAM_VAULT, DEE_VAULT, PROPOSAL, LOGIN_FILE } = process.env;
let cookie = "";

const get = (path, headers = {}) => fetch(BASE + path, { headers: { cookie, ...headers }, redirect: "manual" });
const post = (path, fields, headers = {}) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const csrfOf = (html) => /name="csrf" value="([0-9a-f]+)"/.exec(html)[1];
const text = async (r) => r.text();

before(async () => {
  const link = readFileSync(LOGIN_FILE, "utf8").trim();
  const r = await fetch(link, { redirect: "manual" });
  assert.equal(r.status, 303);
  cookie = r.headers.get("set-cookie").split(";")[0];
  assert.match(r.headers.get("set-cookie"), /HttpOnly/);
  assert.match(r.headers.get("set-cookie"), /SameSite=Strict/);
});

test("auth: no session is refused", async () => {
  assert.equal((await fetch(BASE + "/", { redirect: "manual" })).status, 401);
});

test("auth: a login link works once, and a wrong code never", async () => {
  assert.equal((await fetch(BASE + "/login?code=nope", { redirect: "manual" })).status, 401);
  // before() used the first link; the file now holds a fresh one. The old one is dead.
  const fresh = readFileSync(LOGIN_FILE, "utf8").trim();
  const r1 = await fetch(fresh, { redirect: "manual" });
  assert.equal(r1.status, 303);
  const r2 = await fetch(fresh, { redirect: "manual" });
  assert.equal(r2.status, 401);
});

test("headers: scripts are forbidden and pages aren't cached", async () => {
  const r = await get("/");
  // Browsers send Origin: null on form posts under "no-referrer", which broke
  // every form. The policy must keep the real Origin on same-site requests.
  assert.equal(r.headers.get("referrer-policy"), "same-origin");
  assert.match(r.headers.get("content-security-policy"), /default-src 'none'/);
  assert.doesNotMatch(r.headers.get("content-security-policy"), /script-src/);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("home: my vaults, not other people's", async () => {
  const h = await text(await get("/"));
  assert.match(h, /Team/);
  assert.match(h, /1 to review/);
  assert.doesNotMatch(h, /Dee private/);
});

test("isolation: someone else's vault looks like a missing one", async () => {
  const theirs = await get(`/v/${DEE_VAULT}`);
  const missing = await get("/v/00000000-0000-0000-0000-000000000000");
  assert.equal(theirs.status, 404);
  assert.equal(await text(theirs), await text(missing));
});

test("escaping: agent-written HTML is shown as text, never run", async () => {
  const h = await text(await get(`/v/${TEAM_VAULT}/file?path=notes%2Fxss.md`));
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(h, /<script/);
  assert.doesNotMatch(h, /<img/);
});

test("review: the proposal shows a diff, who proposed it, and a warning", async () => {
  const h = await text(await get(`/v/${TEAM_VAULT}/proposals`));
  assert.match(h, /<div class="del">Day rate is 800 EUR\.<\/div>/);
  assert.match(h, /<div class="add">Day rate is 900 EUR\.<\/div>/);
  assert.match(h, /<div class="same">Net 30\.<\/div>/);
  assert.match(h, /via Hermes on Linux/);
  assert.match(h, /Proposed by an agent/);
  assert.match(h, />Approve</);
});

test("csrf: a decision without the form token is refused", async () => {
  const r = await post(`/v/${TEAM_VAULT}/proposals/${PROPOSAL}`, { decision: "approve" });
  assert.equal(r.status, 403);
});

test("csrf: a decision from another origin is refused", async () => {
  const csrf = csrfOf(await text(await get(`/v/${TEAM_VAULT}/proposals`)));
  const r = await post(`/v/${TEAM_VAULT}/proposals/${PROPOSAL}`, { decision: "approve", csrf },
    { origin: "https://evil.example" });
  assert.equal(r.status, 403);
});

test("csrf: an opaque (null) origin is refused", async () => {
  const csrf = csrfOf(await text(await get(`/v/${TEAM_VAULT}/proposals`)));
  const r = await post(`/v/${TEAM_VAULT}/proposals/${PROPOSAL}`, { decision: "approve", csrf }, { origin: "null" });
  assert.equal(r.status, 403);
});

test("approve: a person approves in the browser and the change applies", async () => {
  const csrf = csrfOf(await text(await get(`/v/${TEAM_VAULT}/proposals`)));
  const r = await post(`/v/${TEAM_VAULT}/proposals/${PROPOSAL}`, { decision: "approve", csrf });
  assert.equal(r.status, 303);
  const after = await text(await get(r.headers.get("location")));
  assert.match(after, /Approved and applied/);
  const file = await text(await get(`/v/${TEAM_VAULT}/file?path=canon%2Fpricing.md`));
  assert.match(file, /Day rate is 900 EUR/);
  assert.match(file, /via Hermes on Linux/);
});

test("edit: an open file saves, attributed to me without an agent", async () => {
  const page = await text(await get(`/v/${TEAM_VAULT}/new`));
  const r = await post(`/v/${TEAM_VAULT}/file`, {
    csrf: csrfOf(page), action: "create", path: "notes/web.md", content: "Written in the browser", reason: "x",
  });
  assert.equal(r.status, 303);
  const log = await text(await get(`/v/${TEAM_VAULT}/log`));
  assert.match(log, /notes\/web\.md<\/td><td class="small">you<\/td>/);
});

test("create under canon becomes a proposal, not a write", async () => {
  const page = await text(await get(`/v/${TEAM_VAULT}/new`));
  const r = await post(`/v/${TEAM_VAULT}/file`, {
    csrf: csrfOf(page), action: "create", path: "canon/new.md", content: "x", reason: "new canon file",
  });
  assert.match(r.headers.get("location"), /\/proposals$/);
  assert.equal((await get(`/v/${TEAM_VAULT}/file?path=canon%2Fnew.md`)).status, 404);
});

test("policy: the owner sets a folder rule", async () => {
  const csrf = csrfOf(await text(await get(`/v/${TEAM_VAULT}`)));
  await post(`/v/${TEAM_VAULT}/policy`, { csrf, path: "clients/", policy: "canon", quorum: "2" });
  const h = await text(await get(`/v/${TEAM_VAULT}`));
  assert.match(h, /<code>clients\/<\/code><\/td><td><span class="badge canon">canon<\/span><\/td><td>2<\/td>/);
});

test("tokens: minted in the browser, shown once, then revocable", async () => {
  const csrf = csrfOf(await text(await get("/tokens")));
  const made = await text(await post("/tokens/new", { csrf, name: "Hermes on Linux" }));
  assert.match(made, /<p class="secret">rlq_[0-9a-f]{64}<\/p>/);
  const again = await text(await get("/tokens"));
  assert.doesNotMatch(again, /rlq_[0-9a-f]{64}/);
  const id = /action="\/tokens\/([0-9a-f-]{36})\/revoke"/.exec(again)[1];
  await post(`/tokens/${id}/revoke`, { csrf });
  assert.match(await text(await get("/tokens")), /revoked/);
});
