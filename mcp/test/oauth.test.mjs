// OAuth for the MCP endpoint, end to end: this server as the protected
// resource, the web app (started by test.sh from web/, signed in as Ben) as
// the authorization server, and a client identified by a Client ID Metadata
// Document served here on loopback (the web app runs with
// CIMD_ALLOW_LOOPBACK=1). The authorization server's own rules are in
// web/test/oauth.test.mjs; the database's in supabase/tests/oauth_test.sql.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, before, test } from "node:test";
import pg from "pg";
import { connect as mcpConnect } from "./mcp-client.mjs";

const env = process.env;
const MCP = new URL(env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const RESOURCE = env.MCP_RESOURCE ?? MCP.href;
const WEB = env.WEB_AS_URL ?? "http://127.0.0.1:8789";
// test.sh puts Postgres at 54330 + 10 * slot and this server at 8788 + 10 * slot.
const PG_URL = `postgres://postgres:test@127.0.0.1:${54330 + (Number(MCP.port) - 8788)}/postgres`;
const BEN = "00000000-0000-0000-0000-00000000000b";
const REDIRECT = "https://app.client.test/callback";

let fixture;
let clientId = "";
let cookie = "";

before(async () => {
  assert.ok(env.WEB_AS_LOGIN_FILE, "run through mcp/test.sh (it starts the web app as the authorization server)");
  fixture = http.createServer((req, res) => {
    if (req.url !== "/client.json") return res.writeHead(404).end();
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ client_id: clientId, client_name: "Fixture Chat", redirect_uris: [REDIRECT] }));
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  clientId = `http://127.0.0.1:${fixture.address().port}/client.json`;
  const r = await fetch(readFileSync(env.WEB_AS_LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  assert.equal(r.status, 303);
  cookie = r.headers.get("set-cookie").split(";")[0];
});

after(() => {
  fixture?.closeAllConnections();
  fixture?.close();
});

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha = (s) => createHash("sha256").update(s).digest("hex");

const mcpPost = (headers = {}, body = { jsonrpc: "2.0", id: 1, method: "tools/list" }) =>
  fetch(MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });

const connect = (token) => mcpConnect(MCP, token, "oauth-test");

async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
}

// What a client does, from a 401 to tokens: discovery, consent (as Ben, in
// his browser session), code, token. `choice` is what Ben ticks.
async function connectWithOAuth(choice = []) {
  const challenge401 = (await mcpPost()).headers.get("www-authenticate");
  const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge401)[1];
  const prm = await (await fetch(prmUrl)).json();
  const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();

  const verifier = b64url(randomBytes(32));
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    state: b64url(randomBytes(8)),
    resource: prm.resource,
  };
  const page = await fetch(`${as.authorization_endpoint}?${new URLSearchParams(params)}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(html)[1];
  const answer = await fetch(as.authorization_endpoint, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: new URL(as.authorization_endpoint).origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams([...Object.entries(params), ["csrf", csrf], ["decision", "approve"], ...choice]).toString(),
  });
  assert.equal(answer.status, 303);
  const back = new URL(answer.headers.get("location"));
  assert.equal(back.searchParams.get("state"), params.state);
  assert.equal(back.searchParams.get("iss"), as.issuer);

  const tokens = await fetch(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code"),
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
      resource: prm.resource,
    }).toString(),
  });
  assert.equal(tokens.status, 200);
  return { ...(await tokens.json()), html, as };
}

async function teamId(html) {
  return /name="vault" value="([0-9a-f-]{36})"> Team/.exec(html)[1];
}

async function superuser(fn) {
  const db = new pg.Client({ connectionString: PG_URL });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------------------

test("resource metadata: a 401 names it in WWW-Authenticate", async () => {
  const none = await mcpPost();
  assert.equal(none.status, 401);
  const h = none.headers.get("www-authenticate");
  const url = new URL(RESOURCE);
  assert.match(h, /^Bearer /);
  assert.ok(h.includes(`resource_metadata="${url.origin}/.well-known/oauth-protected-resource${url.pathname}"`), h);
  assert.doesNotMatch(h, /error=/, "no error code when no token was sent");
  const bad = (await mcpPost({ Authorization: `Bearer rlo_${"0".repeat(64)}` })).headers.get("www-authenticate");
  assert.match(bad, /resource_metadata="/);
  assert.match(bad, /error="invalid_token"/);
});

test("resource metadata: both well-known paths serve MCP_RESOURCE byte for byte", async () => {
  const url = new URL(RESOURCE);
  for (const path of [`/.well-known/oauth-protected-resource${url.pathname}`, "/.well-known/oauth-protected-resource"]) {
    const r = await fetch(`${MCP.origin}${path}`);
    assert.equal(r.status, 200, path);
    const text = await r.text();
    assert.ok(text.includes(`"resource":${JSON.stringify(RESOURCE)}`), text);
    const m = JSON.parse(text);
    assert.equal(m.resource, RESOURCE);
    assert.deepEqual(m.authorization_servers, [WEB]);
    assert.deepEqual(m.bearer_methods_supported, ["header"]);
  }
});

test("flow: a client with a metadata document goes from a 401 to tools/list", async () => {
  const t = await connectWithOAuth();
  assert.match(t.access_token, /^rlo_[0-9a-f]{64}$/);
  const c = await connect(t.access_token);
  const names = (await c.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(names, [
    "advance_flags", "changes_since", "checkin_step", "claim_path", "claim_step", "comment_on_proposal", "complete_step",
    "create_vault", "delete_file", "list_claims", "list_files", "list_flags", "list_links", "list_my_feedback",
    "list_proposals", "list_subscriptions", "list_threads", "list_variables", "list_vaults", "open_thread", "post_message",
    "propose", "read_file", "read_proposal", "read_thread", "register_work_plan", "release_claim", "release_step",
    "renew_claim", "revise_proposal", "search", "send_feedback", "work_plan_status", "write_file",
  ]);
  await c.close();
});

test("flow: the refreshed access token works too", async () => {
  const t = await connectWithOAuth();
  const r = await fetch(t.as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId, resource: RESOURCE }).toString(),
  });
  const next = await r.json();
  assert.equal(r.status, 200);
  assert.equal((await mcpPost({ Authorization: `Bearer ${next.access_token}` })).status, 200);
});

test("scope: an all-vaults read-write grant creates a vault; a grant for chosen vaults can't", async () => {
  const all = await connectWithOAuth([["reach", "all"], ["access", "write"]]);
  const c = await connect(all.access_token);
  const made = await call(c, "create_vault", { name: "Ben via OAuth" });
  assert.equal(made.isError, false, made.text);
  assert.match((await call(c, "list_vaults")).text, /^Ben via OAuth \(owner\) id=/m);
  await c.close();

  const probe = await connectWithOAuth();
  const team = await teamId(probe.html);
  const scoped = await connectWithOAuth([["reach", "some"], ["vault", team], ["access", "write"]]);
  const s = await connect(scoped.access_token);
  const refused = await call(s, "create_vault", { name: "Ben scoped via OAuth" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /^Not allowed: creating a vault needs/);
  await s.close();
});

test("scope: a read-only grant for Team sees Team only, as a viewer, and writes nothing", async () => {
  const probe = await connectWithOAuth();
  const team = await teamId(probe.html);
  const t = await connectWithOAuth([["reach", "some"], ["vault", team], ["access", "read"]]);
  const c = await connect(t.access_token);
  const vaults = await call(c, "list_vaults");
  assert.match(vaults.text, /^Team \(viewer\) id=/);
  assert.doesNotMatch(vaults.text, /Threads|Tidings/);
  const w = await call(c, "write_file", { vault: "Team", path: "notes/oauth-ro.md", content: "x" });
  assert.equal(w.isError, true);
  assert.match(w.text, /Not allowed/);
  await c.close();
});

test("scope: a read-write grant writes as Ben's agent, named after the client", async () => {
  const probe = await connectWithOAuth();
  const team = await teamId(probe.html);
  const t = await connectWithOAuth([["reach", "some"], ["vault", team], ["access", "write"]]);
  const c = await connect(t.access_token);
  assert.match((await call(c, "list_vaults")).text, /^Team \(editor\) id=/);
  const w = await call(c, "write_file", { vault: "Team", path: "notes/oauth-rw.md", content: "Written over OAuth." });
  assert.equal(w.isError, false, w.text);
  const log = await call(c, "changes_since", { vault: "Team" });
  assert.match(log.text, /file\.write notes\/oauth-rw\.md\s+by \S+ via Fixture Chat \(127\.0\.0\.1\)/);
  await c.close();
});

test("audience: a token issued for another resource is refused here", async () => {
  // A grant made exactly as the web app makes one, but bound to another
  // resource (the web app itself refuses to issue that; the database doesn't
  // know our URL, so the MCP server's check is what stops it).
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const access = `rlo_${randomBytes(32).toString("hex")}`;
  const refresh = `rlr_${randomBytes(32).toString("hex")}`;
  await superuser(async (db) => {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: BEN, role: "authenticated" })]);
    const { rows } = await db.query("select public.create_oauth_grant('Elsewhere', $1, $2, $3, $4, null, 'read') as code", [
      clientId, REDIRECT, "https://elsewhere.example/mcp", challenge,
    ]);
    await db.query("reset role");
    await db.query("set local role reliquary_web");
    const out = await db.query("select private.oauth_redeem_code($1, $2, $3, $4, $5, $6, $7) as r", [
      sha(rows[0].code), clientId, REDIRECT, "https://elsewhere.example/mcp", verifier, sha(access), sha(refresh),
    ]);
    assert.equal(out.rows[0].r, "ok");
    await db.query("commit");
  });
  const r = await mcpPost({ Authorization: `Bearer ${access}` });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /error="invalid_token"/);
});

test("audience: a refresh token or a code is not an access token", async () => {
  const t = await connectWithOAuth();
  assert.equal((await mcpPost({ Authorization: `Bearer ${t.refresh_token}` })).status, 401);
  assert.equal((await mcpPost({ Authorization: `Bearer rlc_${"1".repeat(64)}` })).status, 401);
});

test("revoke: revoking the grant on the Tokens page cuts the client off on its next request", async () => {
  const t = await connectWithOAuth();
  const c = await connect(t.access_token);
  assert.equal((await call(c, "list_vaults")).isError, false);

  const [{ id }] = await superuser(async (db) =>
    (await db.query(
      "select g.id from public.access_tokens g where g.user_id = $1 and g.kind = 'oauth' and g.revoked_at is null order by g.last_used_at desc nulls last limit 1",
      [BEN],
    )).rows,
  );
  const tokensPage = await (await fetch(`${WEB}/connections`, { headers: { cookie } })).text();
  assert.ok(tokensPage.includes(`/connections/${id}/revoke`), "the grant is listed with a Revoke button");
  const csrf = /name="csrf" value="([0-9a-f]+)"/.exec(tokensPage)[1];
  const r = await fetch(`${WEB}/connections/${id}/revoke`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, origin: WEB, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf }).toString(),
  });
  assert.equal(r.status, 303);

  assert.equal((await mcpPost({ Authorization: `Bearer ${t.access_token}` })).status, 401);
  await assert.rejects(call(c, "list_vaults"));
  await c.close().catch(() => {});
});
