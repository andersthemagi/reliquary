// Environment variables in the web app (docs/variables.md): encryption
// (src/secrets.ts), the person-facing module (src/variables.ts), the CLI's
// OAuth sign-in (src/oauth.ts) and the env API (src/envapi.ts). The
// database's rules are in supabase/tests/variables_test.sql.
//
// This file starts its own servers from dist/, signed in as Olive, a person
// no other test file uses, with her own vaults, so nothing here moves
// another file's counts. Every value it sets holds SEKRIT-; none may reach a
// server log, and neither may the key.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const MCP_RESOURCE = "https://mcp.reliquary.test/mcp";
const OLIVE = "00000000-0000-0000-0000-0000000000f1";
const ED = "00000000-0000-0000-0000-0000000000f2";
const KEY = randomBytes(32).toString("base64url");
const REDIRECT = "https://app.client.test/callback";

const b64url = (buf) => buf.toString("base64url");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const secrets = []; // every value and token this file sees: none may reach a log
const value = (label) => {
  const v = `SEKRIT-${label}-${randomBytes(6).toString("hex")}`;
  secrets.push(v);
  return v;
};

let crypto; // dist/secrets.js
let vars; // dist/variables.js
let base = "";
let bare = ""; // a second server, without VARIABLES_KEY
let cookie = "";
let log = "";
let fixture;
let fixtureClient = "";
const servers = [];
let team = "";
let side = "";
const values = {};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function startServer(extra) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env,
      DATABASE_URL: WEB_DB,
      LOCAL_USER_ID: OLIVE,
      LOGIN_FILE: `/tmp/variables-login-${process.pid}-${port}`,
      HOST: "127.0.0.1",
      PORT: String(port),
      MCP_RESOURCE,
      CIMD_ALLOW_LOOPBACK: "1",
      PUBLIC_URL: "",
      ...extra,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  servers.push(child);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) return { origin, loginFile: `/tmp/variables-login-${process.pid}-${port}` };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
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

// As a person (no act claim), or as a database role with no claims.
async function as(who, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    if (who.role) {
      await db.query(`set local role ${who.role}`);
    } else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who.user, role: "authenticated" })]);
    }
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

// A CLI sign-in made straight in the database, as consent and the token
// endpoint would: for users other than the server's signed-in person, and
// for the second server.
async function cliToken(user, origin, vaults = null) {
  const resource = `${origin}/api/env`;
  const client = `${origin}/cli/oauth-client.json`;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const redirect = "http://127.0.0.1:53682/callback";
  const [{ code }] = await as({ user }, "select public.create_cli_grant($1, $2, $3, $4, $5::uuid[]) as code", [
    client, redirect, resource, challenge, vaults,
  ]);
  const access = `rle_${randomBytes(32).toString("hex")}`;
  const refresh = `rlr_${randomBytes(32).toString("hex")}`;
  secrets.push(access, refresh, code);
  const [{ r }] = await as({ role: "reliquary_web" }, "select private.oauth_redeem_code($1, $2, $3, $4, $5, $6, $7) as r", [
    sha(code), client, redirect, resource, verifier, sha(access), sha(refresh),
  ]);
  assert.equal(r, "ok");
  return access;
}

before(async () => {
  process.env.DATABASE_URL = WEB_DB;
  crypto = await import("../dist/secrets.js");
  vars = await import("../dist/variables.js");
  crypto.configureVariables({ VARIABLES_KEY: KEY });

  fixture = http.createServer((req, res) => {
    if (req.url !== "/client.json") return res.writeHead(404).end();
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ client_id: fixtureClient, client_name: "Fixture Chat", redirect_uris: [REDIRECT, "http://127.0.0.1/callback"] }));
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  fixtureClient = `http://127.0.0.1:${fixture.address().port}/client.json`;

  const main = await startServer({ VARIABLES_KEY: KEY });
  base = main.origin;
  bare = (await startServer({ VARIABLES_KEY: "" })).origin;
  const r = await fetch(readFileSync(main.loginFile, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];

  [{ id: team }] = await as({ user: OLIVE }, "select public.create_vault('Env Team') as id");
  [{ id: side }] = await as({ user: OLIVE }, "select public.create_vault('Env Side') as id");
  await as({ user: OLIVE }, "select public.set_member($1, $2, 'editor')", [team, ED]);
  values.devKey = value("dev-api");
  values.prodKey = value("prod-api");
  values.dbUrl = value("db-url");
  values.side = value("side");
  await vars.setVariable(OLIVE, team, "API_KEY", "production", values.prodKey);
  await vars.setVariable(ED, team, "API_KEY", "development", values.devKey);
  await vars.setVariable(ED, team, "DATABASE_URL", "development", `postgres://u:${values.dbUrl}@db/x?a="b"\n`);
  await vars.setVariable(OLIVE, side, "SIDE_KEY", "development", values.side);
});

after(async () => {
  for (const s of servers) s.kill();
  fixture?.closeAllConnections();
  fixture?.close();
  const { pool } = await import("../dist/db.js");
  await pool.end();
});

// ---------------------------------------------------------------------------
// Encryption

test("crypto: a value round-trips, with a fresh nonce each time", () => {
  const slot = { vaultId: team, environment: "development", name: "X" };
  const a = crypto.seal("héllo", slot);
  const b = crypto.seal("héllo", slot);
  assert.equal(a.keyId, "k1");
  assert.equal(a.nonce.length, 12);
  assert.notDeepEqual(a.nonce, b.nonce);
  assert.notDeepEqual(a.ciphertext, b.ciphertext);
  assert.equal(crypto.open(a, slot), "héllo");
  assert.equal(crypto.open(crypto.seal("", slot), slot), "");
});

test("crypto: a ciphertext sealed for one slot fails for another vault, environment or name", () => {
  const slot = { vaultId: team, environment: "development", name: "X" };
  const s = crypto.seal("v", slot);
  for (const other of [{ ...slot, vaultId: side }, { ...slot, environment: "production" }, { ...slot, name: "Y" }]) {
    assert.throws(() => crypto.open(s, other), crypto.SecretsError);
  }
});

test("crypto: an altered ciphertext, nonce or key id fails, naming the variable and never the value", () => {
  const slot = { vaultId: team, environment: "preview", name: "ALTERED" };
  const secret = value("altered");
  const s = crypto.seal(secret, slot);
  const flip = (buf) => Buffer.from(buf.map((x, i) => (i === 0 ? x ^ 1 : x)));
  for (const bad of [{ ...s, ciphertext: flip(s.ciphertext) }, { ...s, nonce: flip(s.nonce) }, { ...s, keyId: "k2" }]) {
    try {
      crypto.open(bad, slot);
      assert.fail("expected a refusal");
    } catch (err) {
      assert.ok(err instanceof crypto.SecretsError);
      assert.match(err.message, /ALTERED in preview could not be decrypted/);
      assert.equal(String(err.stack).includes(secret), false);
    }
  }
});

test("crypto: VARIABLES_KEY must be 32 bytes of base64url, and errors never contain it", () => {
  for (const bad of ["short", randomBytes(31).toString("base64url"), randomBytes(32).toString("base64"), `${KEY}=`]) {
    try {
      crypto.configureVariables({ VARIABLES_KEY: bad });
      assert.fail("expected a refusal");
    } catch (err) {
      assert.match(err.message, /VARIABLES_KEY must be 32 random bytes/);
      assert.equal(String(err.stack).includes(bad), false);
    }
  }
  assert.throws(() => crypto.configureVariables({ VARIABLES_KEY: KEY, VARIABLES_KEY_ID: "bad id" }), /VARIABLES_KEY_ID/);
  crypto.configureVariables({ VARIABLES_KEY: KEY });
});

test("crypto: on Vercel, no VARIABLES_KEY refuses to start; locally, values are just off", () => {
  assert.throws(() => crypto.configureVariables({ VERCEL: "1" }), /Refusing to start: VERCEL is set but VARIABLES_KEY is not/);
  assert.equal(crypto.configureVariables({}), false);
  assert.throws(() => crypto.seal("x", { vaultId: team, environment: "development", name: "X" }), crypto.SecretsError);
  assert.equal(crypto.configureVariables({ VARIABLES_KEY: KEY }), true);
});

test("crypto: a value over 64 KiB is refused", () => {
  assert.throws(() => crypto.seal("x".repeat(64 * 1024 + 1), { vaultId: team, environment: "development", name: "X" }), /64 KiB/);
});

test("crypto: the server refuses to start with a malformed key, without printing it", () => {
  const bad = "not-a-key-SEKRIT-startup";
  const r = spawnSync(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: OLIVE, LOGIN_FILE: `/tmp/variables-bad-${process.pid}`, PORT: "1", VARIABLES_KEY: bad },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /VARIABLES_KEY must be 32 random bytes/);
  assert.equal((r.stdout + r.stderr).includes(bad), false);
});

// ---------------------------------------------------------------------------
// The web module (what phase 2's Variables page calls)

test("web module: the database holds ciphertext, never the value", async () => {
  const rows = await sql("select s.ciphertext, s.key_id from private.variable_secrets s join public.variables v on v.id = s.variable_id where v.vault_id = $1", [team]);
  assert.equal(rows.length, 3);
  for (const r of rows) {
    assert.equal(r.key_id, "k1");
    for (const v of Object.values(values)) assert.equal(r.ciphertext.includes(Buffer.from(v)), false);
  }
});

test("web module: listVariables shows names, environments and who set them, never values", async () => {
  const l = await vars.listVariables(ED, team);
  assert.equal(l.role, "editor");
  assert.deepEqual(l.environments, [
    { name: "development", ownersOnly: false },
    { name: "preview", ownersOnly: false },
    { name: "production", ownersOnly: true },
  ]);
  assert.deepEqual(l.variables.map((v) => [v.name, v.values.map((x) => x.environment)]), [
    ["API_KEY", ["development", "production"]],
    ["DATABASE_URL", ["development"]],
  ]);
  assert.equal(l.variables[0].values[1].updatedBy, OLIVE);
  assert.equal(JSON.stringify(l).includes("SEKRIT"), false);
});

test("web module: the owner reveals a value, and it is logged as reveal", async () => {
  const r = await vars.revealVariable(OLIVE, team, "API_KEY", "production");
  assert.equal(r.ok, true);
  assert.equal(r.value, values.prodKey);
  const log = await vars.accessLog(OLIVE, team);
  assert.equal(log[0].action, "reveal");
  assert.deepEqual(log[0].names, ["API_KEY"]);
  assert.equal(log[0].environment, "production");
  assert.equal(log[0].agent, null);
});

test("web module: an editor can't reveal or set production, and the refusal is logged", async () => {
  assert.deepEqual(await vars.revealVariable(ED, team, "API_KEY", "production"), { ok: false, error: "forbidden" });
  await assert.rejects(vars.setVariable(ED, team, "API_KEY", "production", value("editor-prod")), (err) => {
    assert.equal(err.code, "42501");
    assert.equal(String(err.message).includes("SEKRIT"), false);
    return true;
  });
  const log = await vars.accessLog(OLIVE, team);
  assert.equal(log[0].action, "refused");
  assert.equal(log[0].actor, ED);
});

test("web module: setting again rotates", async () => {
  const v = value("rotated");
  assert.equal(await vars.setVariable(OLIVE, side, "ROTATE_ME", "preview", value("first")), "set");
  assert.equal(await vars.setVariable(OLIVE, side, "ROTATE_ME", "preview", v), "rotate");
  assert.equal((await vars.revealVariable(OLIVE, side, "ROTATE_ME", "preview")).value, v);
  await vars.deleteVariable(OLIVE, side, "ROTATE_ME", "preview");
  assert.deepEqual((await vars.accessLog(OLIVE, side, { limit: 3 })).map((r) => r.action), ["delete", "reveal", "rotate"]);
});

// ---------------------------------------------------------------------------
// The CLI's sign-in

function pkce() {
  const verifier = b64url(randomBytes(32));
  secrets.push(verifier);
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

const cliParams = (over = {}) => {
  const k = over.pkce ?? pkce();
  const p = {
    response_type: "code",
    client_id: `${base}/cli/oauth-client.json`,
    redirect_uri: "http://127.0.0.1:53682/callback",
    code_challenge: k.challenge,
    code_challenge_method: "S256",
    state: "st-" + randomBytes(6).toString("hex"),
    resource: `${base}/api/env`,
    ...over,
  };
  delete p.pkce;
  return p;
};

const get = (path, headers = {}) => fetch(base + path, { headers: { cookie, ...headers }, redirect: "manual" });
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];

async function consent(params, choice = [["decision", "approve"]]) {
  const page = await (await get(`/oauth/authorize?${new URLSearchParams(params)}`)).text();
  return fetch(`${base}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams([...Object.entries(params), ["csrf", csrfOf(page)], ...choice]).toString(),
  });
}

const tokenPost = (fields) =>
  fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

// The whole CLI login: consent (as Olive), code, tokens.
async function cliLogin(choice = [["decision", "approve"]]) {
  const k = pkce();
  const params = cliParams({ pkce: k });
  const r = await consent(params, choice);
  assert.equal(r.status, 303, await r.text());
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  secrets.push(code);
  const t = await tokenPost({
    grant_type: "authorization_code",
    code,
    client_id: params.client_id,
    redirect_uri: params.redirect_uri,
    code_verifier: k.verifier,
    resource: params.resource,
  });
  const body = await t.json();
  if (body.access_token) secrets.push(body.access_token, body.refresh_token);
  return { status: t.status, body };
}

test("cli oauth: the CLI's client metadata document is served at /cli/oauth-client.json", async () => {
  const r = await fetch(`${base}/cli/oauth-client.json`);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.client_id, `${base}/cli/oauth-client.json`);
  assert.equal(d.client_name, "Reliquary CLI");
  assert.deepEqual(d.redirect_uris, ["http://127.0.0.1/callback", "http://[::1]/callback"]);
  assert.equal(d.token_endpoint_auth_method, "none");
  assert.deepEqual(d.grant_types, ["authorization_code", "refresh_token"]);
});

test("cli oauth: the consent page is the CLI's: environment variables only, a loopback warning, no access choice", async () => {
  const r = await get(`/oauth/authorize?${new URLSearchParams(cliParams())}`);
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /Sign in the Reliquary CLI\?/);
  assert.match(h, /reliquary login/);
  assert.match(h, /class="callout attention loopback-warning"/);
  assert.match(h, /name="vault" value="[0-9a-f-]{36}"> Env Team/);
  assert.doesNotMatch(h, /name="access"/);
  assert.match(r.headers.get("content-security-policy"), /form-action 'self' http:\/\/127\.0\.0\.1:53682/);
});

test("cli oauth: allow gives a code, and the token endpoint an rle_ access token and a refresh token", async () => {
  const t = await cliLogin();
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.match(t.body.access_token, /^rle_[0-9a-f]{64}$/);
  assert.match(t.body.refresh_token, /^rlr_[0-9a-f]{64}$/);
  assert.equal(t.body.expires_in, 3600);
  const [row] = await sql("select kind, access, all_vaults, resource, client_id from public.access_tokens where user_id = $1 and kind = 'cli' order by created_at desc limit 1", [OLIVE]);
  assert.deepEqual(row, { kind: "cli", access: "read", all_vaults: true, resource: `${base}/api/env`, client_id: `${base}/cli/oauth-client.json` });
});

test("cli oauth: the CLI can't ask for the MCP resource", async () => {
  const r = await get(`/oauth/authorize?${new URLSearchParams(cliParams({ resource: MCP_RESOURCE }))}`);
  assert.equal(r.status, 303);
  assert.equal(new URL(r.headers.get("location")).searchParams.get("error"), "invalid_target");
});

test("cli oauth: another client can't ask for the env API", async () => {
  const r = await get(`/oauth/authorize?${new URLSearchParams(cliParams({ client_id: fixtureClient, redirect_uri: REDIRECT }))}`);
  assert.equal(r.status, 303);
  assert.equal(new URL(r.headers.get("location")).searchParams.get("error"), "invalid_target");
});

test("cli oauth: a redirect off this computer gets an error page, never a redirect", async () => {
  const r = await get(`/oauth/authorize?${new URLSearchParams(cliParams({ redirect_uri: "https://evil.example/callback" }))}`);
  assert.equal(r.status, 400);
  assert.match(await r.text(), /hasn’t registered/);
});

test("cli oauth: the token endpoint refuses the env API for another client", async () => {
  const r = await tokenPost({
    grant_type: "authorization_code", code: `rlc_${"0".repeat(64)}`, client_id: fixtureClient,
    redirect_uri: REDIRECT, code_verifier: "v".repeat(43), resource: `${base}/api/env`,
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "invalid_target");
});

// ---------------------------------------------------------------------------
// The env API

const api = (path, token, origin = base, init = {}) =>
  fetch(`${origin}/api/env${path}`, { ...init, headers: token ? { authorization: `Bearer ${token}` } : {} });

test("env api: without a token, 401 names the resource metadata, which names the env API", async () => {
  const r = await api("/vaults");
  assert.equal(r.status, 401);
  const challenge = r.headers.get("www-authenticate");
  assert.match(challenge, /resource_metadata="([^"]+)"/);
  assert.doesNotMatch(challenge, /error=/);
  const prm = await (await fetch(/resource_metadata="([^"]+)"/.exec(challenge)[1])).json();
  assert.equal(prm.resource, `${base}/api/env`);
  assert.deepEqual(prm.authorization_servers, [base]);
});

test("env api: lists the vaults the sign-in reaches, with the environments it may read", async () => {
  const { body } = await cliLogin([["decision", "approve"], ["reach", "all"]]);
  const r = await api("/vaults", body.access_token);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).vaults, [
    { id: side, name: "Env Side", role: "owner", environments: ["development", "preview", "production"] },
    { id: team, name: "Env Team", role: "owner", environments: ["development", "preview", "production"] },
  ]);
});

test("env api: returns an environment's values, decrypted, never cached", async () => {
  const { body } = await cliLogin();
  const r = await api(`/${team}/development`, body.access_token);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store, private");
  assert.equal(r.headers.get("pragma"), "no-cache");
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await r.json(), {
    vault: team,
    environment: "development",
    variables: { API_KEY: values.devKey, DATABASE_URL: `postgres://u:${values.dbUrl}@db/x?a="b"\n` },
  });
  const prod = await (await api(`/${team}/production`, body.access_token)).json();
  assert.deepEqual(prod.variables, { API_KEY: values.prodKey });
  const [row] = await sql("select action, names, agent, client_id from public.env_access_log where vault_id = $1 order by seq desc limit 1", [team]);
  assert.deepEqual(row, { action: "read", names: ["API_KEY"], agent: "Reliquary CLI", client_id: `${base}/cli/oauth-client.json` });
});

test("env api: an editor's CLI gets development and preview, not production", async () => {
  const token = await cliToken(ED, base);
  assert.equal((await api(`/${team}/development`, token)).status, 200);
  assert.equal((await api(`/${team}/preview`, token)).status, 200);
  const r = await api(`/${team}/production`, token);
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: "forbidden" });
  assert.deepEqual((await (await api("/vaults", token)).json()).vaults.map((v) => [v.name, v.environments]), [["Env Team", ["development", "preview"]]]);
});

test("env api: a sign-in scoped to one vault gets 404 for another", async () => {
  const page = await (await get(`/oauth/authorize?${new URLSearchParams(cliParams())}`)).text();
  const sideId = /name="vault" value="([0-9a-f-]{36})"> Env Side/.exec(page)[1];
  const { body } = await cliLogin([["decision", "approve"], ["reach", "some"], ["vault", sideId]]);
  assert.equal((await api(`/${side}/development`, body.access_token)).status, 200);
  assert.equal((await api(`/${team}/development`, body.access_token)).status, 404);
  assert.deepEqual((await (await api("/vaults", body.access_token)).json()).vaults.map((v) => v.name), ["Env Side"]);
});

test("env api: an MCP access token is refused", async () => {
  const k = pkce();
  const params = { ...cliParams({ pkce: k }), client_id: fixtureClient, redirect_uri: REDIRECT, resource: MCP_RESOURCE };
  const r = await consent(params, [["decision", "approve"]]);
  const code = new URL(r.headers.get("location")).searchParams.get("code");
  const t = await (await tokenPost({ grant_type: "authorization_code", code, client_id: fixtureClient, redirect_uri: REDIRECT, code_verifier: k.verifier, resource: MCP_RESOURCE })).json();
  secrets.push(code, t.access_token, t.refresh_token);
  assert.match(t.access_token, /^rlo_/);
  const a = await api("/vaults", t.access_token);
  assert.equal(a.status, 401);
  assert.match(a.headers.get("www-authenticate"), /error="invalid_token"/);
  // Even dressed as a CLI token, the database doesn't know it for the env API.
  assert.equal((await api("/vaults", t.access_token.replace(/^rlo_/, "rle_"))).status, 401);
});

test("env api: a personal token is refused", async () => {
  const [{ t }] = await as({ user: OLIVE }, "select public.create_access_token('env-test-pat', 7) as t");
  secrets.push(t);
  assert.equal((await api("/vaults", t)).status, 401);
});

test("env api: a CLI token is useless at the MCP endpoint (it resolves only for the env API)", async () => {
  const token = await cliToken(OLIVE, base);
  const count = async (fn, resource) =>
    (await as({ role: fn === "cli" ? "reliquary_web" : "reliquary_mcp" },
      `select count(*)::int as n from private.${fn === "cli" ? "resolve_cli_token" : "resolve_oauth_token"}($1, $2)`, [sha(token), resource]))[0].n;
  assert.equal(await count("mcp", MCP_RESOURCE), 0);
  assert.equal(await count("mcp", `${base}/api/env`), 0);
  assert.equal(await count("cli", `${base}/api/env`), 1);
});

test("env api: the grant is on the Tokens page, and revoking it there cuts the CLI off on its next request", async () => {
  const { body } = await cliLogin();
  assert.equal((await api("/vaults", body.access_token)).status, 200);
  const h = await (await get("/tokens")).text();
  const rows = [...h.matchAll(/<tr><td>Reliquary CLI<\/td>([\s\S]*?)<\/tr>/g)];
  assert.ok(rows.length > 0);
  assert.match(rows[0][1], /Environment variables/);
  const [grant] = await sql("select id from public.access_tokens where user_id = $1 and kind = 'cli' and revoked_at is null order by last_used_at desc nulls last limit 1", [OLIVE]);
  const r = await fetch(`${base}/tokens/${grant.id}/revoke`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ csrf: csrfOf(h) }).toString(),
  });
  assert.equal(r.status, 303);
  assert.equal((await api("/vaults", body.access_token)).status, 401);
  const again = await tokenPost({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: `${base}/cli/oauth-client.json`, resource: `${base}/api/env` });
  assert.equal((await again.json()).error, "invalid_grant");
});

test("env api: refresh rotates for the CLI too; the refresh can't be moved to the MCP resource", async () => {
  const { body } = await cliLogin();
  const client = `${base}/cli/oauth-client.json`;
  const wrong = await tokenPost({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: client, resource: MCP_RESOURCE });
  assert.equal((await wrong.json()).error, "invalid_target");
  const r = await (await tokenPost({ grant_type: "refresh_token", refresh_token: body.refresh_token, client_id: client, resource: `${base}/api/env` })).json();
  secrets.push(r.access_token, r.refresh_token);
  assert.match(r.access_token, /^rle_/);
  assert.equal((await api("/vaults", r.access_token)).status, 200);
});

test("env api: an expired sign-in is refused on its next request", async () => {
  const token = await cliToken(OLIVE, base);
  assert.equal((await api("/vaults", token)).status, 200);
  await sql("update private.oauth_tokens set expires_at = now() - interval '1 second' where token_hash = $1", [sha(token)]);
  assert.equal((await api("/vaults", token)).status, 401);
});

test("env api: a ciphertext swapped between rows fails to decrypt, and nothing is delivered", async () => {
  const a = value("swap-a");
  const b = value("swap-b");
  await vars.setVariable(OLIVE, side, "SWAP_A", "preview", a);
  await vars.setVariable(OLIVE, side, "SWAP_B", "preview", b);
  // An operator (or an attacker with database access) swaps the two rows' ciphertexts.
  await sql(
    `with s as (select s.variable_id, v.name, s.nonce, s.ciphertext from private.variable_secrets s
                  join public.variables v on v.id = s.variable_id where v.vault_id = $1 and s.environment = 'preview')
     update private.variable_secrets t set nonce = o.nonce, ciphertext = o.ciphertext
       from s me, s o
      where t.variable_id = me.variable_id and t.environment = 'preview' and me.name <> o.name`,
    [side],
  );
  const token = await cliToken(OLIVE, base);
  const r = await api(`/${side}/preview`, token);
  assert.equal(r.status, 500);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { error: "decrypt_failed" });
  assert.equal(text.includes("SEKRIT"), false);
  assert.deepEqual(await vars.revealVariable(OLIVE, side, "SWAP_A", "preview"), { ok: false, error: "decrypt_failed" });
  await vars.deleteVariable(OLIVE, side, "SWAP_A", "preview");
  await vars.deleteVariable(OLIVE, side, "SWAP_B", "preview");
});

test("env api: only GET, and unknown paths are 404", async () => {
  const token = await cliToken(OLIVE, base);
  assert.equal((await api("/vaults", token, base, { method: "POST" })).status, 405);
  assert.equal((await api("/nope/x/y", token)).status, 404);
  assert.equal((await api(`/${team}/NOT_AN_ENV`, token)).status, 404);
  assert.equal((await api(`/${team}/staging`, token)).status, 404);
});

test("env api: without VARIABLES_KEY, values are 503 and the vault list still works", async () => {
  const token = await cliToken(OLIVE, bare);
  assert.equal((await api("/vaults", token, bare)).status, 200);
  const r = await api(`/${team}/development`, token, bare);
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: "not_configured" });
});

// ---------------------------------------------------------------------------

test("log: no value, key, token, vault id or code in the server log", async () => {
  await new Promise((r) => setTimeout(r, 200));
  assert.match(log, /GET \/api\/env\/:vault\/:environment 200 ok/);
  assert.match(log, /GET \/api\/env\/:vault\/:environment 403 forbidden/);
  for (const s of secrets) assert.equal(log.includes(s), false, "a secret reached the log");
  assert.equal(log.includes(KEY), false, "the key reached the log");
  assert.doesNotMatch(log, /SEKRIT|rl[ecor]_[0-9a-f]{8}/);
  assert.equal(log.includes(team), false);
  assert.equal(log.includes(side), false);
});
