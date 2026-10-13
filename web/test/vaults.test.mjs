// Creating a vault in the browser, and revising your own proposal (parity
// with what an agent can do over MCP; docs/parity.md).
//
// Ana (local sign-in, WEB_URL) sees the New vault action and creates one
// named to sort after her seeded vaults, so other tests' lists and Review
// counts don't move. Eve (00000000-0000-0000-0000-0000000000e1) exists only
// on the AUTH_MODE=supabase instance A (web/test.sh) and has no vaults: she
// sees the first-vault empty state, creates one, proposes into it and
// revises her proposal. The database rules are in
// supabase/tests/create_vault_test.sql and review_test.sql.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { TEAM_VAULT, PROPOSAL, P_SOLO, LOGIN_FILE, WEB_AUTH_A_URL: A, WEB_AUTH_PUBLIC_URL, FAKE_AUTH_URL } = process.env;
const ORIGIN_A = WEB_AUTH_PUBLIC_URL ? new URL(WEB_AUTH_PUBLIC_URL).origin : "";
const EVE = "00000000-0000-0000-0000-0000000000e1";
let cookie = "";

const get = (path, base = BASE, c = cookie) => fetch(base + path, { headers: { cookie: c }, redirect: "manual" });
const page = async (path, base, c) => (await get(path, base, c)).text();
const post = (path, fields, headers = {}, base = BASE, c = cookie, origin = BASE) =>
  fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: c, "content-type": "application/x-www-form-urlencoded", origin, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
const header = (h) => /<div class="page-head">[\s\S]*?<\/div>\s*<\/div>/.exec(h)[0];
// Home's vault cards, the card of the vault named `name`, a card's name,
// and the cards under Your vaults (before Shared with you, if there is one).
const vaultCards = (h) => [...h.matchAll(/<li class="card vault-card">[\s\S]*?<\/li>/g)].map((m) => m[0]);
const cardNamed = (h, name) => vaultCards(h).find((c) => c.includes(`>${name}</a></h3>`)) ?? "";
const cardName = (c) => /class="card-link" href="[^"]+">([^<]+)<\/a>/.exec(c)[1];
const ownCards = (h) => vaultCards(/<h2>Your vaults<\/h2>([\s\S]*?)(?:<h2>Shared with you<\/h2>|<\/main>)/.exec(h)[1]);
// Eve, on the supabase-mode instance A. Her cookies follow Set-Cookie (a
// notice after a form is a cookie there), starting from a minted session.
const eveJar = new Map();
const eveTake = (r) => {
  for (const sc of r.headers.getSetCookie()) {
    const [pair] = sc.split(";");
    const i = pair.indexOf("=");
    if (/Max-Age=0(;|$)/.test(sc)) eveJar.delete(pair.slice(0, i));
    else eveJar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return r;
};
const eveCookieHeader = () => [...eveJar].map(([k, v]) => `${k}=${v}`).join("; ");
const evePage = async (path) => (await eveTake(await get(path, A, eveCookieHeader()))).text();
const evePost = async (path, fields) => eveTake(await post(path, fields, {}, A, eveCookieHeader(), ORIGIN_A));

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
  const minted = await fetch(`${FAKE_AUTH_URL}/_mint`, {
    method: "POST",
    body: JSON.stringify({ sub: EVE, session_id: "eve-vaults" }),
  });
  eveJar.set("__Host-rlq_at", (await minted.json()).token);
});

// New vault (Ana) ----------------------------------------------------------------

test("new vault: Home's header has New vault as its one primary action, after Review", async () => {
  const h = header(await page("/"));
  assert.match(h, /<a class="button primary" href="\/vaults\/new">New vault<\/a>/);
  assert.equal((h.match(/class="button primary"|<button class="primary"/g) ?? []).length, 1, "one primary");
  assert.ok(h.indexOf('href="/inbox"') < h.indexOf('href="/vaults/new"'), "primary last");
});

test("new vault: a name, and open or canon, each explained in a line", async () => {
  const h = await page("/vaults/new");
  assert.match(h, /<h1>New vault<\/h1>/);
  assert.match(h, /<button class="primary" form="new-vault">Create vault<\/button>/);
  assert.match(h, /<form method="post" action="\/vaults\/new" class="panel choice-form new-vault-form" id="new-vault">/);
  assert.match(h, /name="csrf" value="[0-9a-f]+"/);
  assert.match(h, /<input id="vn" type="text" name="name"[^>]* required maxlength="100">/);
  assert.match(h, /<legend>Files without a rule are<\/legend>/);
  assert.match(h, /name="default_policy" value="open" checked>\s*<span class="choice-card-body"><span class="choice-card-title">Open<\/span>\s*<span class="choice-card-text">[^<]+\.<\/span>/);
  assert.match(h, /name="default_policy" value="canon">\s*<span class="choice-card-body"><span class="choice-card-title">Canon<\/span>\s*<span class="choice-card-text">[^<]+\.<\/span>/);
  assert.doesNotMatch(h, /<script/i);
});

test("new vault: creating one lands in it, owned by me, with the default I chose", async () => {
  const token = csrfOf(await page("/vaults/new"));
  const r = await post("/vaults/new", { csrf: token, name: "  Zephyr ledger  ", default_policy: "canon" });
  assert.equal(r.status, 303);
  const loc = r.headers.get("location");
  assert.match(loc, /^\/v\/[0-9a-f-]{36}$/);
  const h = await page(loc);
  assert.match(h, /Created Zephyr ledger\. You’re its owner\./);
  assert.match(h, /<a class="side-title" href="\/v\/[0-9a-f-]{36}">Zephyr ledger<\/a>/);
  assert.match(await page(`${loc}/rules`), /Everything is <span class="badge policy canon"[^>]*>Canon<\/span> unless a rule says otherwise/);
  const card = cardNamed(await page("/"), "Zephyr ledger");
  assert.match(card, new RegExp(`<a class="card-link" href="${loc}">Zephyr ledger</a>`));
  assert.ok(ownCards(await page("/")).includes(card), "under Your vaults");
  assert.match(await page(`${loc}/activity`), /Created the vault/);
});

test("new vault: needs the form token and a same-origin Origin", async () => {
  const token = csrfOf(await page("/vaults/new"));
  assert.equal((await post("/vaults/new", { name: "Zephyr forged" })).status, 403);
  assert.equal((await post("/vaults/new", { csrf: token, name: "Zephyr forged" }, { origin: "https://evil.example" })).status, 403);
  assert.doesNotMatch(await page("/"), /Zephyr forged/);
});

test("new vault: a blank name is refused with a reason, and nothing is created", async () => {
  const before = ownCards(await page("/")).length;
  const token = csrfOf(await page("/vaults/new"));
  const r = await post("/vaults/new", { csrf: token, name: "   ", default_policy: "open" });
  assert.equal(r.status, 400, "the form again, not a redirect to a blank one");
  assert.match(await r.text(), /A vault name is 1 to 100 characters\./);
  assert.equal(ownCards(await page("/")).length, before);
});

test("new vault: a refused create comes back with the name, template and default chosen, the reason and a reference first in the form, and the name marked", async () => {
  const token = csrfOf(await page("/vaults/new"));
  const r = await post("/vaults/new", { csrf: token, name: "  ", template: "client", default_policy: "canon" });
  assert.equal(r.status, 400);
  const h = await r.text();
  assert.match(h, /<h1>New vault<\/h1>/);
  assert.match(h, /<p class="callout danger" role="alert" id="vault-error">A vault name is 1 to 100 characters\. \(ref [0-9a-f]{8}\)<\/p>/);
  assert.match(h, /<input id="vn" type="text" name="name" placeholder="Client work" value="" aria-invalid="true" aria-describedby="vault-error" required maxlength="100">/);
  assert.match(h, /<input type="radio" name="template" value="client" checked>/);
  assert.doesNotMatch(h, /<input type="radio" name="template" value="blank" checked>/);
  assert.match(h, /name="default_policy" value="canon" checked>/);
  assert.doesNotMatch(h, /name="default_policy" value="open" checked>/);
  assert.ok(h.indexOf('id="vault-error"') < h.indexOf('id="vn"'), "the reason is the first thing in the form");
});

test("new vault: a name that was fine is kept when something else is refused", async () => {
  const token = csrfOf(await page("/vaults/new"));
  const r = await post("/vaults/new", { csrf: token, name: "Zephyr kept <b>", template: "no-such-template", default_policy: "canon" });
  assert.equal(r.status, 400);
  const h = await r.text();
  assert.match(h, /id="vault-error">Choose one of the templates on the form\. Nothing was created\. \(ref [0-9a-f]{8}\)<\/p>/);
  assert.match(h, /<input id="vn" type="text" name="name" placeholder="Client work" value="Zephyr kept &lt;b&gt;" required maxlength="100">/);
  assert.match(h, /<input type="radio" name="template" value="blank" checked>/, "an unknown template shows as Blank");
  assert.match(h, /name="default_policy" value="canon" checked>/);
  assert.equal(cardNamed(await page("/"), "Zephyr kept &lt;b&gt;"), "");
});

test("new vault: the notice after creating one is a success, not a plain note", async () => {
  const token = csrfOf(await page("/vaults/new"));
  const r = await post("/vaults/new", { csrf: token, name: "Zephyr notice", default_policy: "open" });
  assert.equal(r.status, 303);
  const h = await page(r.headers.get("location"));
  assert.match(h, /<p class="callout success flash" role="status">Created Zephyr notice\. You’re its owner\. Add files, or connect an agent to it\.<\/p>/);
});

// Home's vault cards (Ana) -----------------------------------------------------------

test("vault cards: Home is titled Home, as in the nav, and shows each of my vaults as a card linking to it, with when it last changed", async () => {
  const h = await page("/");
  assert.match(h, /<title>Home · Reliquary<\/title>/);
  assert.match(h, /<h1>Home<\/h1>/);
  assert.match(h, /<a href="\/" aria-current="page">Home<\/a>/);
  assert.match(h, /<h2>Your vaults<\/h2>\s*<p class="meta plan-line">[\s\S]*?<\/p>\s*<ul class="card-grid">/);
  const card = cardNamed(h, "Zephyr ledger");
  assert.match(card, /<div class="card-head"><span class="vault-mark tint-[0-5]" aria-hidden="true">[^<]<\/span><h3 class="card-title"><a class="card-link" href="\/v\/[0-9a-f-]{36}">Zephyr ledger<\/a><\/h3><span class="badge">Standard \([^)]+\)<\/span><\/div>/);
  assert.match(card, /<p class="card-foot">Updated <time datetime="\d{4}-\d\d-\d\dT[^"]+" title="\d{4}-\d\d-\d\d \d\d:\d\d UTC">[^<]+<\/time><\/p>/);
  assert.doesNotMatch(card, /card-counts/, "no proposals and no ready tasks: nothing said");
  assert.doesNotMatch(card, /card-role/, "my own vault doesn't say my role");
  assert.doesNotMatch(h, /<table class="vault-list/, "no longer a table");
});

test("vault cards: a vault with open proposals links the count to its proposals", async () => {
  const card = vaultCards(await page("/")).find((c) => c.includes(`href="/v/${TEAM_VAULT}"`));
  assert.ok(card, "Team is listed");
  assert.match(card, new RegExp(`<p class="card-counts"><a href="/v/${TEAM_VAULT}/proposals" aria-label="([1-9]\\d* open proposals?) in [^"]+">\\1</a>`));
});

test("vault cards: each card has one link to its vault, the name, so the whole card opens it without nesting links", async () => {
  const cards = vaultCards(await page("/"));
  assert.ok(cards.length >= 2);
  for (const c of cards) {
    const vault = /class="card-link" href="(\/v\/[0-9a-f-]{36})"/.exec(c)[1];
    assert.equal([...c.matchAll(new RegExp(`href="${vault}"`, "g"))].length, 1);
    assert.doesNotMatch(c, /<a [^>]*>[^<]*<a /);
  }
});

// First vault (Eve, who has none) -------------------------------------------------

test("first vault: with no vaults, Home shows three steps: create a vault, connect an agent, write or approve a first file", async () => {
  const h = await evePage("/");
  assert.match(h, /<div class="empty first-vault"><strong>Create your first vault\.<\/strong>/);
  const steps = [.../<ol class="first-steps">([\s\S]*?)<\/ol>/.exec(h)[1].matchAll(/<li><strong>([^<]+)<\/strong>/g)].map((m) => m[1]);
  assert.deepEqual(steps, ["Create a vault", "Connect an agent", "Write or approve a first file."]);
  assert.match(h, /<a class="button" href="\/vaults\/new">Create your first vault<\/a>/);
  assert.match(h, /from <a href="\/connect">Connect<\/a>/);
  assert.match(header(h), /<a class="button primary" href="\/vaults\/new">New vault<\/a>/);
  assert.doesNotMatch(h, /Needs your review/);
  assert.doesNotMatch(h, /dev\.sh/);
});

test("first vault: created from the form on the hosted sign-in, and Home lists it", async () => {
  const token = csrfOf(await evePage("/vaults/new"));
  const r = await evePost("/vaults/new", { csrf: token, name: "Eve studio", default_policy: "canon" });
  assert.equal(r.status, 303);
  assert.match(r.headers.get("location"), /^\/v\/[0-9a-f-]{36}$/);
  const h = await evePage("/");
  assert.ok(ownCards(h).includes(cardNamed(h, "Eve studio")) && cardNamed(h, "Eve studio"), "under Your vaults");
  assert.doesNotMatch(h, /Create your first vault\./);
});

// Revise your own proposal ---------------------------------------------------------

test("revise: the proposer revises their own proposal without approving it", async () => {
  const home = await evePage("/");
  const vault = /href="(\/v\/[0-9a-f-]{36})">Eve studio</.exec(home)[1];
  let token = csrfOf(await evePage(`${vault}/new`));
  const created = await evePost(`${vault}/file`, { csrf: token, action: "create", path: "plan.md", content: "First plan.", reason: "a plan" });
  assert.equal(created.status, 303);
  const proposal = created.headers.get("location");
  assert.match(proposal, /\/proposals\/[0-9a-f-]{36}$/);

  const p = await evePage(proposal);
  assert.match(header(p), new RegExp(`<a class="button" href="${proposal}/revise">Revise</a>`));
  const form = await evePage(`${proposal}/revise`);
  assert.match(form, /<h1 class="path">Revise [^<]+<\/h1>/);
  assert.match(form, /<textarea id="content" name="content">First plan\.<\/textarea>/);
  token = csrfOf(form);
  const r = await evePost(`${proposal}/revise`, { csrf: token, content: "Second plan.", reason: "shorter" });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), proposal);
  const after = await evePage(proposal);
  assert.match(after, /Revised\. This is revision 2, waiting for review again\./);
  assert.match(after, /<span>Revision 2<\/span>/);
  assert.match(after, /<span class="badge state open">Open<\/span>/);
  assert.match(after, /0 of 1 approval for revision 2/);
});

test("revise: needs the form token", async () => {
  const home = await evePage("/");
  const vault = /href="(\/v\/[0-9a-f-]{36})">Eve studio</.exec(home)[1];
  const list = await evePage(`${vault}/proposals`);
  const proposal = new RegExp(`href="(${vault}/proposals/[0-9a-f-]{36})"`).exec(list)[1];
  assert.equal((await evePost(`${proposal}/revise`, { content: "Forged." })).status, 403);
  assert.doesNotMatch(await evePage(proposal), /Forged\./);
});

test("revise: only the proposer gets it; someone else's proposal has no Revise and no revise page", async () => {
  // PROPOSAL is Ben's agent's; P_SOLO is Ana's own agent's, so it is hers.
  assert.doesNotMatch(header(await page(`/v/${TEAM_VAULT}/proposals/${PROPOSAL}`)), />Revise</);
  assert.equal((await get(`/v/${TEAM_VAULT}/proposals/${PROPOSAL}/revise`)).status, 404);
  assert.match(header(await page(`/v/${TEAM_VAULT}/proposals/${P_SOLO}`)), />Revise</);
});

test("revise: a revision by someone else is refused by the database, and says so", async () => {
  const token = csrfOf(await page(`/v/${TEAM_VAULT}/proposals/${PROPOSAL}`));
  const r = await post(`/v/${TEAM_VAULT}/proposals/${PROPOSAL}/revise`, { csrf: token, content: "Hijack." });
  assert.equal(r.status, 303);
  const h = await page(r.headers.get("location"));
  assert.match(h, /No such proposal of yours\./);
  assert.doesNotMatch(h, /Hijack\./);
});

// Home's order (Eve: only she acts in her vaults) ---------------------------------

test("vault cards: the vault where something happened last comes first, whatever its name", async () => {
  const token = csrfOf(await evePage("/vaults/new"));
  const r = await evePost("/vaults/new", { csrf: token, name: "Eve zinc", default_policy: "open" });
  assert.equal(r.status, 303);
  let names = vaultCards(await evePage("/")).map(cardName);
  assert.deepEqual(names.slice(0, 2), ["Eve zinc", "Eve studio"]);
  // Something happens in Eve studio: it moves to the top.
  const vault = /href="(\/v\/[0-9a-f-]{36})">Eve studio</.exec(await evePage("/"))[1];
  const made = await evePost(`${vault}/file`, { csrf: csrfOf(await evePage(`${vault}/new`)), action: "create", path: "order.md", content: "Order.", reason: "order" });
  assert.equal(made.status, 303);
  const h = await evePage("/");
  names = vaultCards(h).map(cardName);
  assert.deepEqual(names.slice(0, 2), ["Eve studio", "Eve zinc"]);
  assert.match(cardNamed(h, "Eve studio"), new RegExp(`<a href="${vault}/proposals" aria-label="2 open proposals in Eve studio">2 open proposals</a>`));
});
