// Connections (/connections) and Connect (/connect), signed in as Ana: the list
// first with a type per connection and the ended ones folded away, New
// token on its own page, revoking through a confirm page, and Connect with
// one client per tab. The database enforces scope and who may revoke
// (supabase/tests/access_tokens_test.sql, hardening_test.sql); these check
// the pages. Seeds its own tokens, named "Conn ...".

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const BASE = WEB.origin;
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const { TEAM_VAULT, DEE, LOGIN_FILE } = process.env;
const ANA = "00000000-0000-0000-0000-00000000000a";
let cookie = "";

const get = (path) => fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
const page = async (path) => (await get(path)).text();
const post = (path, pairs) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams(pairs).toString(),
  });
const csrf = async () => /name="csrf" value="([0-9a-f]+)"/.exec(await page("/connections"))[1];
const at = (h, s) => {
  const i = h.indexOf(s);
  assert.ok(i >= 0, `missing: ${s}`);
  return i;
};

// A token of someone's, made as them in the database; its id.
async function mint(user, name, days = 30, vaults = null) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    await db.query("select public.create_access_token($1, $2, $3::uuid[], 'read')", [name, days, vaults]);
    const { rows } = await db.query("select id from public.access_tokens where name = $1 order by created_at desc limit 1", [name]);
    await db.query("commit");
    return rows[0].id;
  } finally {
    await db.end();
  }
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

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

// Connections -------------------------------------------------------------------

test("connections: the list comes first, with New token as the header's primary link and no form on the page", async () => {
  await mint(ANA, "Conn listed");
  const h = await page("/connections");
  assert.match(h, /<h1>Connections<\/h1>/);
  assert.match(h, /Everything that can act as you: tokens, apps you signed in to, and the Reliquary CLI\./);
  const actions = at(h, '<div class="page-actions">');
  assert.ok(actions < at(h, '<a class="button primary" href="/connections/new">New token</a>'));
  assert.ok(at(h, '<a class="button primary" href="/connections/new">New token</a>') < at(h, "<td>Conn listed</td>"));
  assert.doesNotMatch(h, /action="\/connections\/new"|name="scope"|id="new-token"/);
});

test("connections: each row says its type (token, app or Reliquary CLI) in its own column", async () => {
  const id = await mint(ANA, "Conn typed");
  const h = await page("/connections");
  assert.match(h, /<th>Type<\/th>/);
  const tr = new RegExp(`<tr><td>Conn typed</td>([\\s\\S]*?)</tr>`).exec(h)[1];
  assert.match(tr, /<td data-label="Type" class="small">Token<\/td>/);
  assert.match(tr, /<td data-label="Access" class="small">Read only<\/td>/);
  assert.match(tr, new RegExp(`<a class="button danger" href="/connections/${id}/revoke" aria-label="Revoke Conn typed">Revoke</a>`));
});

test("connections: expired and revoked ones are folded under the live ones, with when they ended and nothing to revoke", async () => {
  await mint(ANA, "Conn live");
  const gone = await mint(ANA, "Conn ended");
  await sql("update public.access_tokens set revoked_at = now() - interval '3 hours' where id = $1", [gone]);
  const h = await page("/connections");
  const fold = at(h, '<details class="connections-ended"><summary>Expired and revoked');
  assert.ok(at(h, "<td>Conn live</td>") < fold, "live first");
  const ended = h.slice(fold, h.indexOf("</details>", fold));
  const tr = /<tr class="inactive"><td>Conn ended<\/td>([\s\S]*?)<\/tr>/.exec(ended)[1];
  assert.match(tr, /Revoked <time datetime="[^"]+" title="[^"]+">3 h ago<\/time>/);
  assert.doesNotMatch(tr, /\/revoke/);
  assert.match(ended, /<tr class="inactive"><td>Seeded expired<\/td>[\s\S]*?Expired <time/);
  assert.doesNotMatch(h.slice(0, fold), /<td>(Conn ended|Seeded expired)<\/td>/);
});

test("connections: tables stack on a phone, each cell labelled", async () => {
  const h = await page("/connections");
  assert.match(h, /<table class="token-list table-stack">/);
  assert.match(h, /<td data-label="Vaults" class="small">/);
  assert.match(h, /<td data-label="Last used" class="small">/);
});

// New token ---------------------------------------------------------------------

test("new token: the form is its own page, and the header's Create token submits it", async () => {
  const h = await page("/connections/new");
  assert.match(h, /<nav class="crumb" aria-label="Breadcrumb"><ol><li><a href="\/connections">Connections<\/a><\/li><li aria-current="page">New token<\/li><\/ol><\/nav>/);
  assert.match(h, /<h1>New token<\/h1>/);
  const submit = at(h, '<button class="primary" form="new-token">Create token</button>');
  assert.ok(at(h, '<div class="page-actions">') < submit && submit < at(h, 'id="new-token"'));
  assert.ok(at(h, 'id="new-token"') < at(h, 'name="name"'), "the required name is the form's first field");
  assert.match(h, /Claude Code, Claude\.ai and ChatGPT don’t need one: they sign in\./);
});

test("new token: once created, the page shows only the token and Done, never a second form", async () => {
  const r = await post("/connections/new", [["csrf", await csrf()], ["name", "Conn fresh"], ["scope", "some"], ["vault", TEAM_VAULT], ["access", "read"], ["days", "7"]]);
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Copy your token<\/h1>/);
  assert.match(h, /<p class="secret">rlq_[0-9a-f]{64}<\/p>/);
  assert.match(h, /<a class="button primary" href="\/connections">Done<\/a>/);
  assert.doesNotMatch(h, /id="new-token"|name="scope"/);
  assert.doesNotMatch(await page("/connections"), /rlq_[0-9a-f]{64}/);
});

test("new token: a refusal goes back to the form as a danger message", async () => {
  const r = await post("/connections/new", [["csrf", await csrf()], ["name", "Conn none"], ["scope", "some"], ["access", "read"], ["days", "7"]]);
  assert.equal(r.status, 400, "the form itself, not a redirect to an empty one");
  const h = await r.text();
  assert.match(h, /<h1>New token<\/h1>/);
  assert.match(h, /<p class="callout danger" role="alert" id="token-error">Tick at least one vault, or choose all your vaults\. Nothing was created\. \(ref [0-9a-f]{8}\)<\/p>/);
  assert.ok(at(h, 'id="new-token"') < at(h, "Tick at least one vault") && at(h, "Tick at least one vault") < at(h, 'name="name"'), "the reason is the first thing in the form");
});

// Revoke ------------------------------------------------------------------------

test("revoke: Revoke opens a confirm page naming the connection, its type, vaults, access and last use; opening it revokes nothing", async () => {
  const id = await mint(ANA, "Conn to revoke", 30, [TEAM_VAULT]);
  await sql("update public.access_tokens set last_used_at = now() - interval '2 hours', client_name = 'Cursor 1.2' where id = $1", [id]);
  const r = await get(`/connections/${id}/revoke`);
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Revoke Conn to revoke\?<\/h1>/);
  assert.match(h, /Conn to revoke stops working on its next request\./);
  assert.match(h, /Token\. Anything using it loses access to Team \(read only\)\./);
  assert.match(h, /Last used: <time[^>]*>2 h ago<\/time><span class="token-client"> · from Cursor 1\.2<\/span>\./);
  assert.match(h, /create a new token/);
  assert.match(h, new RegExp(`<form method="post" action="/connections/${id}/revoke" class="panel confirm">`));
  assert.match(h, /<button class="danger solid">Revoke Conn to revoke<\/button><a class="button quiet" href="\/connections">Cancel<\/a>/);
  const [row] = await sql("select revoked_at from public.access_tokens where id = $1", [id]);
  assert.equal(row.revoked_at, null);
});

test("revoke: confirming revokes it and says so by name, as a success", async () => {
  const id = await mint(ANA, "Conn confirmed");
  const r = await post(`/connections/${id}/revoke`, [["csrf", await csrf()]]);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/connections");
  const h = await page("/connections");
  assert.match(h, /<p class="callout success flash" role="status">Revoked Conn confirmed\. Anything using it is cut off on its next request\.<\/p>/);
  assert.match(h, /<tr class="inactive"><td>Conn confirmed<\/td>/);
});

test("revoke: the confirm page for an app or the CLI says how to connect it again", async () => {
  const app = await mint(ANA, "Conn app page");
  await sql(`update public.access_tokens set kind = 'oauth', token_hash = null,
               client_id = 'https://app.client.test/meta.json', resource = 'http://127.0.0.1:8787/mcp',
               client_name = 'app.client.test' where id = $1`, [app]);
  const a = await page(`/connections/${app}/revoke`);
  assert.match(a, /App\. The app loses access/);
  assert.match(a, /sign in from it again/);
  const cli = await mint(ANA, "Conn cli page");
  await sql(`update public.access_tokens set kind = 'cli', token_hash = null,
               client_id = 'http://127.0.0.1:8791/cli/oauth-client.json', resource = 'http://127.0.0.1:8791/api/env' where id = $1`, [cli]);
  const c = await page(`/connections/${cli}/revoke`);
  assert.match(c, /Reliquary CLI\. The CLI on that computer loses access/);
  assert.match(c, /run reliquary login there/);
  const list = await page("/connections");
  const appRow = new RegExp(`<tr><td>Conn app page</td>([\\s\\S]*?)</tr>`).exec(list)[1];
  assert.match(appRow, /<td data-label="Type" class="small">App<\/td>/);
  assert.match(appRow, /Never<span class="token-client"> · from app\.client\.test<\/span>/, "an app not used yet still says where it is from");
  assert.match(new RegExp(`<tr><td>Conn cli page</td>([\\s\\S]*?)</tr>`).exec(list)[1], /<td data-label="Type" class="small">Reliquary CLI<\/td>/);
});

test("revoke: an ended connection has no confirm page, it says it already ended", async () => {
  const id = await mint(ANA, "Conn gone");
  await sql("update public.access_tokens set revoked_at = now() where id = $1", [id]);
  const r = await get(`/connections/${id}/revoke`);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/connections");
  assert.match(await page("/connections"), /Conn gone was already revoked: it can’t act as you\./);
});

test("revoke: someone else's connection, or a malformed id, is not found", async () => {
  const theirs = await mint(DEE, "Conn of Dee's");
  assert.equal((await get(`/connections/${theirs}/revoke`)).status, 404);
  assert.equal((await get("/connections/not-a-uuid/revoke")).status, 404);
  const r = await post(`/connections/${theirs}/revoke`, [["csrf", await csrf()]]);
  assert.equal(r.status, 303);
  const [row] = await sql("select revoked_at from public.access_tokens where id = $1", [theirs]);
  assert.equal(row.revoked_at, null, "the database refused it");
});

// Connect -----------------------------------------------------------------------

test("connect: one sentence, the MCP URL, and one client per tab, the current one marked", async () => {
  const h = await page("/connect");
  assert.match(h, /<p class="page-desc">Connect any MCP client to your vaults with this URL\.<\/p>/);
  assert.match(h, /<p class="endpoint"><span class="muted small">MCP URL<\/span><code>http:\/\/127\.0\.0\.1:8787\/mcp<\/code><\/p>/);
  assert.match(h, /<nav class="tabs" aria-label="Clients"><a href="\/connect\?client=claude-code" aria-current="page">Claude Code<\/a>/);
  for (const c of ["chat", "cursor", "vscode", "other", "cli"]) assert.match(h, new RegExp(`<a href="/connect\\?client=${c}">`));
  assert.match(h, /<section id="claude-code">/);
  assert.doesNotMatch(h, /<section id="(chat|cursor|vscode|other|cli)">/);
});

test("connect: a tab shows only its client, and an unknown one shows Claude Code", async () => {
  const cursor = await page("/connect?client=cursor");
  assert.match(cursor, /<a href="\/connect\?client=cursor" aria-current="page">Cursor<\/a>/);
  assert.match(cursor, /<section id="cursor">/);
  assert.doesNotMatch(cursor, /<section id="claude-code">/);
  assert.match(cursor, /<a href="\/connections\/new\?client=cursor">use the full form<\/a>/);
  const odd = await page("/connect?client=%3Cscript%3E");
  assert.match(odd, /<section id="claude-code">/);
  assert.doesNotMatch(odd, /<script>/);
});

test("connect: no primary action; the connections list is a secondary link", async () => {
  const h = await page("/connect");
  assert.doesNotMatch(h.slice(0, h.indexOf("<section")), /class="button primary"/);
  assert.match(h, /<a class="button" href="\/connections">Your connections<\/a>/);
});

// Moved from /tokens ------------------------------------------------------------

test("moved: every old /tokens URL is a permanent redirect to its /connections URL, keeping the query", async () => {
  const id = await mint(ANA, "Conn moved");
  for (const [old, now] of [
    ["/tokens", "/connections"],
    ["/tokens?x=1&y=a%20b", "/connections?x=1&y=a%20b"],
    ["/tokens/new", "/connections/new"],
    [`/tokens/${id}/revoke`, `/connections/${id}/revoke`],
  ]) {
    const r = await get(old);
    assert.equal(r.status, 308, old);
    assert.equal(r.headers.get("location"), now, old);
  }
  const followed = await fetch(BASE + "/tokens", { headers: { cookie } });
  assert.equal(followed.status, 200);
  assert.match(await followed.text(), /<h1>Connections<\/h1>/);
});

test("moved: an old URL redirects signed out too, before sign-in", async () => {
  const r = await fetch(BASE + "/tokens/new?from=bookmark", { redirect: "manual" });
  assert.equal(r.status, 308);
  assert.equal(r.headers.get("location"), "/connections/new?from=bookmark");
});

test("moved: a POST to an old URL is a 308 to the new one, where the same POST still works", async () => {
  const form = async () => [["csrf", await csrf()], ["name", "Conn via old URL"], ["scope", "all"], ["access", "read"], ["days", "7"]];
  const r = await post("/tokens/new", await form());
  assert.equal(r.status, 308);
  assert.equal(r.headers.get("location"), "/connections/new");
  const again = await post(r.headers.get("location"), await form());
  assert.equal(again.status, 200);
  assert.match(await again.text(), /rlq_[0-9a-f]{64}/);
  const id = await mint(ANA, "Conn moved revoke");
  const rv = await post(`/tokens/${id}/revoke`, [["csrf", await csrf()]]);
  assert.equal(rv.status, 308);
  assert.equal(rv.headers.get("location"), `/connections/${id}/revoke`);
});
