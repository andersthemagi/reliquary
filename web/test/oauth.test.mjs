// The OAuth 2.1 authorization server in the web app (web/src/oauth.ts): AS
// metadata, the consent page, the authorization code flow with PKCE, refresh
// rotation and revocation. The database rules behind it are in
// supabase/tests/oauth_test.sql; the MCP side is mcp/test/oauth.test.mjs.
//
// This file starts its own web server from dist/ (signed in as Ben, so Ana's
// Tokens page in the other files doesn't change), with MCP_RESOURCE set and
// CIMD_ALLOW_LOOPBACK=1 so the client metadata can come from a fixture on
// loopback served here.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";
import { startAs } from "./start-as.mjs";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const RESOURCE = "https://mcp.reliquary.test/mcp";
const BEN = "00000000-0000-0000-0000-00000000000b";
const DEE = "00000000-0000-0000-0000-00000000000d"; // the seed's one person with a single vault
const LOGIN_FILE = `/tmp/oauth-login-${process.pid}`;

let base = "";
let issuer = "";
let log = "";
let cookie = "";
let server;
let fixture;
let fx = "";
let clientId = "";
let nativeId = "";
const REDIRECT = "https://app.client.test/callback";
const secrets = []; // every code, token and verifier this file sees: none may reach the log

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha = (s) => createHash("sha256").update(s).digest("hex");

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

before(async () => {
  // Client metadata documents, as a client's website would serve them.
  fixture = http.createServer((req, res) => {
    const docs = {
      "/client.json": { client_id: clientId, client_name: "Fixture Chat", redirect_uris: [REDIRECT] },
      "/native.json": { client_id: nativeId, client_name: "Fixture CLI", redirect_uris: ["http://127.0.0.1/callback"] },
      "/liar.json": { client_id: "https://claude.ai/oauth/claude-code-client-metadata", redirect_uris: [REDIRECT] },
    };
    if (req.url === "/moved.json") return res.writeHead(302, { location: `${fx}/client.json` }).end();
    const d = docs[req.url];
    if (!d) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(d));
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  fx = `http://127.0.0.1:${fixture.address().port}`;
  clientId = `${fx}/client.json`;
  nativeId = `${fx}/native.json`;

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  issuer = base;
  server = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env,
      DATABASE_URL: `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`,
      LOCAL_USER_ID: BEN,
      LOGIN_FILE,
      HOST: "127.0.0.1",
      PORT: String(port),
      MCP_RESOURCE: RESOURCE,
      CIMD_ALLOW_LOOPBACK: "1",
      PUBLIC_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${base}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

after(() => {
  server?.kill();
  fixture?.closeAllConnections();
  fixture?.close();
});

// ---------------------------------------------------------------------------
// Helpers: a client's side of the flow.

function pkce() {
  const verifier = b64url(randomBytes(32));
  secrets.push(verifier);
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

function authParams(over = {}) {
  const { challenge } = over.pkce ?? pkce();
  const p = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st-" + randomBytes(6).toString("hex"),
    resource: RESOURCE,
    ...over,
  };
  delete p.pkce;
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return p;
}

const get = (path, headers = {}) => fetch(base + path, { headers: { cookie, ...headers }, redirect: "manual" });
const authorizeGet = (params, headers) => get(`/oauth/authorize?${new URLSearchParams(params)}`, headers);
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];

async function consent(params, choice = [], headers = {}) {
  const page = await (await authorizeGet(params)).text();
  const fields = [...new URLSearchParams(params), ["csrf", csrfOf(page)], ...choice];
  return fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

// Consent, then the code from the redirect. Returns everything the client knows.
async function codeFor(over = {}, choice = [["decision", "approve"], ["reach", "all"]]) {
  const k = pkce();
  const params = authParams({ ...over, pkce: k });
  const r = await consent(params, choice);
  assert.equal(r.status, 303, await r.text());
  const loc = new URL(r.headers.get("location"));
  const code = loc.searchParams.get("code");
  if (code) secrets.push(code);
  return { ...k, params, loc, code };
}

const tokenPost = (fields, headers = {}) =>
  fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });

async function exchange(c, over = {}) {
  const fields = {
    grant_type: "authorization_code",
    code: c.code,
    client_id: c.params.client_id,
    redirect_uri: c.params.redirect_uri,
    code_verifier: c.verifier,
    resource: RESOURCE,
    ...over,
  };
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
  const r = await tokenPost(fields);
  const body = await r.json();
  if (body.access_token) secrets.push(body.access_token, body.refresh_token);
  return { status: r.status, body, headers: r.headers };
}

const refresh = async (rt, over = {}) => {
  const fields = { grant_type: "refresh_token", refresh_token: rt, client_id: clientId, resource: RESOURCE, ...over };
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
  const r = await tokenPost(fields);
  const body = await r.json();
  if (body.access_token) secrets.push(body.access_token, body.refresh_token);
  return { status: r.status, body };
};

// What the MCP server would get for an access token: its role, its function.
async function resolves(accessToken, resource = RESOURCE) {
  const db = new pg.Client({ connectionString: `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres` });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role reliquary_mcp");
    const { rows } = await db.query("select user_id from private.resolve_oauth_token($1, $2)", [sha(accessToken), resource]);
    await db.query("commit");
    return rows[0]?.user_id ?? null;
  } finally {
    await db.end();
  }
}

async function grantRow(name) {
  const db = new pg.Client({ connectionString: `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres` });
  await db.connect();
  try {
    return (await db.query("select * from public.access_tokens where user_id = $1 and name = $2 order by created_at desc limit 1", [BEN, name])).rows[0];
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------------------
// Metadata

test("metadata: advertises S256, public clients, client metadata documents and iss", async () => {
  const r = await fetch(`${base}/.well-known/oauth-authorization-server`);
  assert.equal(r.status, 200);
  const m = await r.json();
  assert.equal(m.issuer, issuer);
  assert.equal(m.authorization_endpoint, `${issuer}/oauth/authorize`);
  assert.equal(m.token_endpoint, `${issuer}/oauth/token`);
  assert.equal(m.revocation_endpoint, `${issuer}/oauth/revoke`);
  assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(m.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(m.client_id_metadata_document_supported, true);
  assert.equal(m.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(m.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(m.response_types_supported, ["code"]);
});

test("metadata: needs no session", async () => {
  const r = await fetch(`${base}/.well-known/oauth-authorization-server`, { redirect: "manual" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
});

// ---------------------------------------------------------------------------
// Authorize: the consent page

test("authorize: the consent page names the client, the redirect host and the resource", async () => {
  const r = await authorizeGet(authParams());
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1>Connect Fixture Chat\?<\/h1>/);
  assert.match(h, /calls itself <strong>Fixture Chat<\/strong>/);
  assert.match(h, /<strong class="redirect-host">app\.client\.test<\/strong>/);
  assert.match(h, /<code>127\.0\.0\.1<\/code>/);
  assert.match(h, new RegExp(`<code>${RESOURCE.replace(/\./g, "\\.")}</code>`));
  assert.match(h, /name="access" value="read" checked/);
  assert.match(h, /can never approve, change rules or manage members/);
  assert.doesNotMatch(h, /loopback-warning/);
});

test("authorize: a person in several vaults has no vault choice preselected, and is told why", async () => {
  const h = await (await authorizeGet(authParams())).text();
  assert.ok((h.match(/name="vault"/g) ?? []).length > 1, "the seeded person is in several vaults");
  assert.doesNotMatch(h, /name="reach" value="(all|some)" checked/);
  assert.match(h, /You belong to \d+ vaults, so nothing is chosen for you\./);
});

test("authorize: a person in one vault keeps All my vaults chosen", async () => {
  const dee = await startAs(DEE, { MCP_RESOURCE: RESOURCE, CIMD_ALLOW_LOOPBACK: "1" });
  try {
    const params = new URLSearchParams(authParams());
    const h = await (await fetch(`${dee.url}/oauth/authorize?${params}`, { headers: { cookie: dee.cookie }, redirect: "manual" })).text();
    assert.equal((h.match(/name="vault"/g) ?? []).length, 1, "the seeded person is in exactly one vault");
    assert.match(h, /name="reach" value="all" checked/);
    assert.doesNotMatch(h, /so nothing is chosen for you/);
  } finally {
    dee.stop();
  }
});

test("authorize: the consent page says the app shows on Connections, where it is revoked", async () => {
  const h = await (await authorizeGet(authParams())).text();
  assert.match(h, /It shows on your <a href="\/connections">Connections<\/a> page as an app, where you can revoke it any time\./);
  assert.doesNotMatch(h, /Tokens<\/a> page|href="\/tokens/);
});

test("authorize: the page may send its form to the client's origin, and nowhere else", async () => {
  const csp = (await authorizeGet(authParams())).headers.get("content-security-policy");
  assert.match(csp, /form-action 'self' https:\/\/app\.client\.test;/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'none'/);
});

test("authorize: a loopback-only client gets a warning", async () => {
  const h = await (await authorizeGet(authParams({ client_id: nativeId, redirect_uri: "http://127.0.0.1:49152/callback" }))).text();
  assert.match(h, /loopback-warning/);
  assert.match(h, /runs on a computer, not a website/);
  assert.match(h, /127\.0\.0\.1:49152/);
});

test("authorize: not signed in, there is no consent", async () => {
  const r = await fetch(`${base}/oauth/authorize?${new URLSearchParams(authParams())}`, { redirect: "manual" });
  assert.equal(r.status, 401);
  assert.equal(r.headers.get("location"), null);
});

test("authorize: a wrong resource is refused back to the client with invalid_target", async () => {
  const params = authParams({ resource: "https://evil.example/mcp" });
  const r = await authorizeGet(params);
  assert.equal(r.status, 303);
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get("error"), "invalid_target");
  assert.equal(loc.searchParams.get("state"), params.state);
  assert.equal(loc.searchParams.get("iss"), issuer);
  assert.equal(loc.searchParams.get("code"), null);
});

test("authorize: a resource differing by a trailing slash is refused", async () => {
  const loc = new URL((await authorizeGet(authParams({ resource: `${RESOURCE}/` }))).headers.get("location"));
  assert.equal(loc.searchParams.get("error"), "invalid_target");
});

test("authorize: a missing resource is refused", async () => {
  const loc = new URL((await authorizeGet(authParams({ resource: undefined }))).headers.get("location"));
  assert.equal(loc.searchParams.get("error"), "invalid_request");
});

test("authorize: plain PKCE, no method, or no challenge is refused", async () => {
  for (const over of [{ code_challenge_method: "plain" }, { code_challenge_method: undefined }, { code_challenge: undefined }, { code_challenge: "short" }]) {
    const loc = new URL((await authorizeGet(authParams(over))).headers.get("location"));
    assert.equal(loc.searchParams.get("error"), "invalid_request", JSON.stringify(over));
  }
});

test("authorize: another response type is refused", async () => {
  const loc = new URL((await authorizeGet(authParams({ response_type: "token" }))).headers.get("location"));
  assert.equal(loc.searchParams.get("error"), "unsupported_response_type");
});

test("authorize: an unregistered redirect_uri gets an error page, never a redirect", async () => {
  for (const redirect_uri of ["https://evil.example/callback", `${REDIRECT}/x`, "https://app.client.test:8443/callback", undefined]) {
    const r = await authorizeGet(authParams({ redirect_uri }));
    assert.equal(r.status, 400, String(redirect_uri));
    assert.equal(r.headers.get("location"), null);
    assert.match(await r.text(), /somewhere it hasn’t registered/);
  }
});

test("authorize: a loopback redirect matches on any port, but not another path", async () => {
  assert.equal((await authorizeGet(authParams({ client_id: nativeId, redirect_uri: "http://127.0.0.1:61000/callback" }))).status, 200);
  const r = await authorizeGet(authParams({ client_id: nativeId, redirect_uri: "http://127.0.0.1:61000/other" }));
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("location"), null);
});

test("authorize: a client whose metadata can't be trusted gets an error page", async () => {
  const cases = [
    [`${fx}/liar.json`, /different client id/],
    [`${fx}/moved.json`, /redirects/],
    [`${fx}/missing.json`, /couldn’t be fetched/],
    ["https://10.0.0.1/meta.json", /isn’t public/],
    ["https://169.254.169.254/latest/meta-data", /isn’t public/],
    ["http://client.example/meta.json", /https/],
    [undefined, /didn’t say who it is/],
  ];
  for (const [client_id, why] of cases) {
    const r = await authorizeGet(authParams({ client_id }));
    assert.equal(r.status, 400, String(client_id));
    assert.equal(r.headers.get("location"), null);
    assert.match(await r.text(), why, String(client_id));
  }
});

test("authorize: repeated parameters are refused", async () => {
  const params = new URLSearchParams(authParams());
  params.append("resource", "https://evil.example/mcp");
  const r = await get(`/oauth/authorize?${params}`);
  assert.equal(r.status, 400);
});

// ---------------------------------------------------------------------------
// Consent: a human action

test("consent: needs the form token", async () => {
  const params = authParams();
  const r = await fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ ...params, decision: "approve" }).toString(),
  });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("location"), null);
});

test("consent: refused from another origin", async () => {
  const r = await consent(authParams(), [["decision", "approve"]], { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get("location"), null);
});

test("consent: deny sends access_denied back, with state and iss", async () => {
  const c = await codeFor({}, [["decision", "deny"]]);
  assert.equal(c.loc.searchParams.get("error"), "access_denied");
  assert.equal(c.loc.searchParams.get("state"), c.params.state);
  assert.equal(c.loc.searchParams.get("iss"), issuer);
  assert.equal(c.code, null);
});

test("consent: allow sends a code back, with state and iss", async () => {
  const c = await codeFor();
  assert.equal(c.loc.origin + c.loc.pathname, REDIRECT);
  assert.match(c.code, /^rlc_[0-9a-f]{64}$/);
  assert.equal(c.loc.searchParams.get("state"), c.params.state);
  assert.equal(c.loc.searchParams.get("iss"), issuer);
});

test("consent: approving without choosing vaults is refused for a person in several vaults, and no code is sent", async () => {
  const r = await consent(authParams(), [["decision", "approve"]]);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("location"), null);
  assert.match(await r.text(), /Choose all your vaults, or tick the vaults it may reach\./);
});

test("consent: a vault the person isn't in can't be chosen", async () => {
  const r = await consent(authParams(), [["decision", "approve"], ["reach", "some"], ["vault", "00000000-0000-0000-0000-0000000000ff"]]);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /A connection can only reach vaults you belong to\./);
});

// ---------------------------------------------------------------------------
// Token endpoint

test("token: a code, its verifier and the same redirect and resource give a 1 h access token and a refresh token", async () => {
  const c = await codeFor();
  const t = await exchange(c);
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.match(t.body.access_token, /^rlo_[0-9a-f]{64}$/);
  assert.match(t.body.refresh_token, /^rlr_[0-9a-f]{64}$/);
  assert.equal(t.body.token_type, "Bearer");
  assert.equal(t.body.expires_in, 3600);
  assert.equal(t.headers.get("cache-control"), "no-store");
  assert.equal(await resolves(t.body.access_token), BEN);
});

test("token: the token only resolves for the resource it was issued for", async () => {
  const t = await exchange(await codeFor());
  assert.equal(await resolves(t.body.access_token, "https://other.example/mcp"), null);
});

test("token: a code used twice is refused, and the grant it made is revoked", async () => {
  const c = await codeFor();
  const first = await exchange(c);
  assert.equal(first.status, 200);
  const again = await exchange(c);
  assert.equal(again.status, 400);
  assert.equal(again.body.error, "invalid_grant");
  assert.equal(await resolves(first.body.access_token), null);
});

test("token: a wrong verifier is refused", async () => {
  const c = await codeFor();
  const t = await exchange(c, { code_verifier: b64url(randomBytes(32)) });
  assert.equal(t.status, 400);
  assert.equal(t.body.error, "invalid_grant");
  assert.equal((await exchange(c)).body.error, "invalid_grant", "the code is burned");
});

test("token: the challenge itself as verifier (plain PKCE) is refused", async () => {
  const c = await codeFor();
  const t = await exchange(c, { code_verifier: c.challenge });
  assert.equal(t.body.error, "invalid_grant");
});

test("token: a missing verifier is refused", async () => {
  const t = await exchange(await codeFor(), { code_verifier: undefined });
  assert.equal(t.status, 400);
  assert.equal(t.body.error, "invalid_request");
});

test("token: a different redirect_uri is refused", async () => {
  const c = await codeFor({ client_id: nativeId, redirect_uri: "http://127.0.0.1:50000/callback" });
  const t = await exchange(c, { redirect_uri: "http://127.0.0.1:50001/callback" });
  assert.equal(t.body.error, "invalid_grant");
});

test("token: a wrong or missing resource is refused", async () => {
  const c = await codeFor();
  assert.equal((await exchange(c, { resource: "https://evil.example/mcp" })).body.error, "invalid_target");
  assert.equal((await exchange(c, { resource: undefined })).body.error, "invalid_request");
  // Neither burned the code: the endpoint refused before the database saw it.
  assert.equal((await exchange(c)).status, 200);
});

test("token: another client presenting the code is refused", async () => {
  const c = await codeFor();
  assert.equal((await exchange(c, { client_id: nativeId })).body.error, "invalid_grant");
});

test("token: only form-encoded requests from public clients", async () => {
  const c = await codeFor();
  const asJson = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code: c.code }),
  });
  assert.equal(asJson.status, 400);
  assert.equal((await asJson.json()).error, "invalid_request");
  const withSecret = await exchange(c, { client_secret: "s" });
  assert.equal(withSecret.status, 401);
  assert.equal(withSecret.body.error, "invalid_client");
  const unknown = await tokenPost({ grant_type: "password", client_id: clientId, resource: RESOURCE });
  assert.equal((await unknown.json()).error, "unsupported_grant_type");
});

test("token: errors never echo what was sent", async () => {
  const c = await codeFor();
  const r = await tokenPost({ grant_type: "authorization_code", code: c.code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "x".repeat(43), resource: RESOURCE });
  const text = await r.text();
  // The spec's code, a fixed reason and the error model's fields
  // (failure.ts); nothing that was sent.
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ["error", "error_description", "ref", "where"]);
  assert.equal(body.error, "invalid_grant");
  assert.equal(body.where, "OAuth");
  assert.match(body.ref, /^[0-9a-f]{8}$/);
  assert.match(body.error_description, /^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/, "RFC 6749 5.2: printable ASCII, no quote or backslash");
  for (const sent of [c.code, clientId, REDIRECT, RESOURCE, "x".repeat(43)]) assert.equal(text.includes(sent), false, sent);
});

// ---------------------------------------------------------------------------
// Refresh

test("refresh: rotates, and the new access token works", async () => {
  const t = await exchange(await codeFor());
  const r = await refresh(t.body.refresh_token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.notEqual(r.body.refresh_token, t.body.refresh_token);
  assert.equal(await resolves(r.body.access_token), BEN);
});

test("refresh: a reused refresh token is refused and revokes the grant", async () => {
  const t = await exchange(await codeFor());
  const next = await refresh(t.body.refresh_token);
  assert.equal(next.status, 200);
  const replay = await refresh(t.body.refresh_token);
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "invalid_grant");
  assert.equal(await resolves(next.body.access_token), null);
  assert.equal((await refresh(next.body.refresh_token)).body.error, "invalid_grant");
});

test("refresh: a wrong or missing resource is refused", async () => {
  const t = await exchange(await codeFor());
  assert.equal((await refresh(t.body.refresh_token, { resource: "https://evil.example/mcp" })).body.error, "invalid_target");
  assert.equal((await refresh(t.body.refresh_token, { resource: undefined })).body.error, "invalid_request");
  assert.equal((await refresh(t.body.refresh_token)).status, 200, "not burned by the refusals");
});

// ---------------------------------------------------------------------------
// Revocation

test("revoke: the revocation endpoint revokes the whole grant", async () => {
  const t = await exchange(await codeFor());
  const r = await fetch(`${base}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: t.body.refresh_token, client_id: clientId }).toString(),
  });
  assert.equal(r.status, 200);
  assert.equal(await resolves(t.body.access_token), null);
  assert.equal((await refresh(t.body.refresh_token)).body.error, "invalid_grant");
});

test("revoke: an unknown token is not an error", async () => {
  const r = await fetch(`${base}/oauth/revoke`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: `rlo_${"0".repeat(64)}`, client_id: clientId }).toString(),
  });
  assert.equal(r.status, 200);
});

test("revoke: the grant is on the Tokens page with its scope, and revoking it there cuts the client off", async () => {
  const page0 = await (await get("/oauth/authorize?" + new URLSearchParams(authParams()))).text();
  const team = /name="vault" value="([0-9a-f-]{36})"> Team/.exec(page0)[1];
  const t = await exchange(await codeFor({}, [["decision", "approve"], ["reach", "some"], ["vault", team], ["access", "write"]]));
  const row = await grantRow("Fixture Chat (127.0.0.1)");
  assert.equal(row.kind, "oauth");
  assert.deepEqual(row.vault_ids, [team]);
  assert.equal(row.access, "write");
  assert.equal(row.client_id, clientId);
  assert.equal(row.resource, RESOURCE);
  assert.equal(row.token_hash, null);

  const h = await (await get("/connections")).text();
  const tr = new RegExp(`<tr><td>Fixture Chat \\(127\\.0\\.0\\.1\\)</td>([\\s\\S]*?)</tr>`).exec(h)[1];
  assert.match(tr, /<td data-label="Vaults" class="small">Team<\/td>/);
  assert.match(tr, /Read and write/);
  assert.match(tr, /from app\.client\.test/);
  const r = await fetch(`${base}/connections/${row.id}/revoke`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ csrf: csrfOf(h) }).toString(),
  });
  assert.equal(r.status, 303);
  assert.equal(await resolves(t.body.access_token), null);
  assert.equal((await refresh(t.body.refresh_token)).body.error, "invalid_grant");
});

// ---------------------------------------------------------------------------

test("log: no code, token, verifier, client id or state in the server log", async () => {
  await new Promise((r) => setTimeout(r, 200));
  assert.match(log, /POST \/oauth\/token 200 ok/);
  for (const s of secrets) assert.equal(log.includes(s), false, "a secret reached the log");
  assert.doesNotMatch(log, /rl[ocr]_[0-9a-f]{8}/);
  assert.doesNotMatch(log, /st-[0-9a-f]{12}/);
  assert.equal(log.includes(clientId), false);
  assert.equal(log.includes("app.client.test"), false);
});
