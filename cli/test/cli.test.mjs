// The CLI end to end (docs/variables.md, "CLI"), as a person uses it:
// `reliquary login` against the web app's authorization server (the
// browser's part, consent, is done over HTTP with Cara's signed-in session),
// then `vaults`, `run`, `env pull` and `logout` against the env API.
//
// cli/test.sh starts Postgres, the web app (signed in as Cara, with a
// VARIABLES_KEY for this run) and the MCP server. This file seeds its own
// people and vaults straight in the database, and sets values through the
// web app's own module (sealed with the same key). Every value holds
// SEKRIT-; every value, token and code seen here goes to SECRETS_FILE so
// test.sh can check the server logs, and no CLI output may hold any of them.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

const WEB = process.env.WEB_URL ?? "http://127.0.0.1:8796";
const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:8797/mcp";
const WEB_BUILD = process.env.WEB_BUILD ?? "/work/web";
const CARA = process.env.CARA ?? "00000000-0000-0000-0000-0000000000c1";
const DAN = "00000000-0000-0000-0000-0000000000d1";
const CLI = path.resolve("dist/cli.js");
const pg = createRequire(path.join(WEB_BUILD, "package.json"))("pg");

const secrets = new Set();
function record(...xs) {
  for (const x of xs) {
    if (typeof x !== "string" || x.length < 8 || secrets.has(x)) continue;
    secrets.add(x);
    appendFileSync(process.env.SECRETS_FILE ?? "/tmp/cli-test-secrets", `${x}\n`);
  }
}
const value = (label) => {
  const v = `SEKRIT-${label}-${randomBytes(6).toString("hex")}`;
  record(v);
  return v;
};
const sha = (s) => createHash("sha256").update(s).digest("hex");
const tmp = (prefix) => mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));

let vars; // the web app's variables module
let cookie = "";
let team = "";
let twinA = "";
let twinB = "";
let shared = "";
const v = {};
let main = ""; // a config dir signed in once, for the tests that just need a sign-in
const outputs = []; // every CLI stdout and stderr

async function as(user, q, params = []) {
  const db = new pg.Client({ connectionString: process.env.PG_URL });
  await db.connect();
  try {
    await db.query("begin");
    if (user) {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    }
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------------------
// Driving the CLI

function start(args, { config, cwd, env = {}, server = true } = {}) {
  const childEnv = { ...process.env, RELIQUARY_CONFIG_DIR: config ?? tmp("cfg"), RELIQUARY_NO_BROWSER: "1", ...env };
  delete childEnv.RELIQUARY_URL;
  if (server) childEnv.RELIQUARY_URL = WEB;
  for (const k of ["VARIABLES_KEY", "PG_URL", "WEB_DB_URL", "DATABASE_URL"]) delete childEnv[k];
  const child = spawn(process.execPath, [CLI, ...args], { cwd: cwd ?? tmp("cwd"), env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  const r = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (d) => (r.stdout += d));
  child.stderr.on("data", (d) => (r.stderr += d));
  r.done = new Promise((resolve) =>
    child.on("close", (code, signal) => {
      outputs.push(r.stdout, r.stderr);
      resolve({ code, signal, stdout: r.stdout, stderr: r.stderr });
    }),
  );
  return r;
}
const cli = (args, opts) => start(args, opts).done;

async function waitFor(r, stream, re, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const m = re.exec(r[stream]);
    if (m) return m;
    if (Date.now() > until) throw new Error(`timed out waiting for ${re} in ${stream}: ${r[stream]}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

// No value, token or code in anything the CLI printed.
function assertClean(...texts) {
  for (const t of texts) {
    assert.doesNotMatch(t, /SEKRIT|rl[ecrq]_[0-9a-f]{8}/, "a value or token in CLI output");
    for (const s of secrets) assert.ok(!t.includes(s), "a recorded secret in CLI output");
  }
}

const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
const page = (p) => fetch(new URL(p, WEB), { headers: { cookie }, redirect: "manual" });

// `reliquary login` with the browser's part done here: the consent page as
// Cara, then Allow (or Deny), then following the redirect to the CLI.
async function login(config, { decision = "approve", choice = [], cwd } = {}) {
  const r = start(["login", "--no-browser"], { config, cwd });
  const [, url] = await waitFor(r, "stderr", /^\s+(http:\/\/\S+\/oauth\/authorize\?\S+)$/m);
  const params = [...new URL(url).searchParams];
  const consent = await (await page(new URL(url).pathname + new URL(url).search)).text();
  const answer = await fetch(`${WEB}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: WEB },
    body: new URLSearchParams([...params, ["csrf", csrfOf(consent)], ["decision", decision], ...choice]).toString(),
  });
  assert.equal(answer.status, 303);
  const location = answer.headers.get("location");
  record(new URL(location).searchParams.get("code"));
  const back = await fetch(location);
  const result = await r.done;
  recordTokens(config);
  return { ...result, url, callback: back.status, location };
}

const credentials = (config) => {
  const f = path.join(config, "credentials.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")).servers[WEB] ?? null : null;
};
function recordTokens(config) {
  const c = credentials(config);
  if (c) record(c.accessToken, c.refreshToken);
}

// A child that reports, without printing any value, what it was given.
const REPORT = `const e = process.env, h = (s) => require("crypto").createHash("sha256").update(s).digest("hex");
console.log(JSON.stringify({ names: Object.keys(e).filter((k) => /^(API_KEY|DATABASE_URL|MULTI|PREVIEW_ONLY|DEV_KEY|PROD_ONLY)$/.test(k)).sort(),
  hashes: Object.fromEntries(["API_KEY", "DATABASE_URL", "MULTI", "PREVIEW_ONLY"].filter((k) => k in e).map((k) => [k, h(e[k])])) }));`;
const report = (r) => JSON.parse(r.stdout.trim().split("\n").pop());

// ---------------------------------------------------------------------------

before(async () => {
  process.env.DATABASE_URL = process.env.WEB_DB_URL;
  const secretsMod = await import(pathToFileURL(path.join(WEB_BUILD, "dist/secrets.js")).href);
  secretsMod.configureVariables({ VARIABLES_KEY: process.env.VARIABLES_KEY });
  vars = await import(pathToFileURL(path.join(WEB_BUILD, "dist/variables.js")).href);

  const r = await fetch(readFileSync(process.env.LOGIN_FILE ?? "/work/state/login", "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];

  [{ id: team }] = await as(CARA, "select public.create_vault('CLI Team') as id");
  [{ id: twinA }] = await as(CARA, "select public.create_vault('Twin') as id");
  [{ id: shared }] = await as(DAN, "select public.create_vault('Dan Shared') as id");
  [{ id: twinB }] = await as(DAN, "select public.create_vault('Twin') as id");
  await as(DAN, "select public.set_member($1, $2, 'editor')", [shared, CARA]);
  await as(DAN, "select public.set_member($1, $2, 'viewer')", [twinB, CARA]);

  v.api = value("api");
  v.db = `postgres://u:${value("db")}@db/x?a="b"\\c`;
  v.multi = `line one\r\nline "two" ${value("multi")}\n`;
  v.prod = value("prod");
  v.preview = value("preview");
  v.dev = value("dev");
  v.danProd = value("dan-prod");
  await vars.setVariable(CARA, team, "API_KEY", "development", v.api);
  await vars.setVariable(CARA, team, "DATABASE_URL", "development", v.db);
  await vars.setVariable(CARA, team, "MULTI", "development", v.multi);
  await vars.setVariable(CARA, team, "API_KEY", "production", v.prod);
  await vars.setVariable(CARA, team, "PREVIEW_ONLY", "preview", v.preview);
  await vars.setVariable(DAN, shared, "DEV_KEY", "development", v.dev);
  await vars.setVariable(DAN, shared, "PROD_ONLY", "production", v.danProd);

  main = tmp("main");
  const l = await login(main);
  assert.equal(l.code, 0, l.stderr);
});

after(async () => {
  const { pool } = await import(pathToFileURL(path.join(WEB_BUILD, "dist/db.js")).href);
  await pool.end();
  // Everything the CLI printed, in every test.
  assertClean(...outputs);
});

// ---------------------------------------------------------------------------
// login

test("login: signs in through the browser's consent (PKCE S256, loopback redirect, resource /api/env) and lists what it can read", async () => {
  const config = tmp("login");
  const r = await login(config);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.callback, 200);
  const u = new URL(r.url);
  assert.equal(u.origin + u.pathname, `${WEB}/oauth/authorize`);
  assert.equal(u.searchParams.get("client_id"), `${WEB}/cli/oauth-client.json`);
  assert.equal(u.searchParams.get("resource"), `${WEB}/api/env`);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.match(u.searchParams.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.match(u.searchParams.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.match(r.stderr, /Signed in to http:\/\/127\.0\.0\.1:\d+/);
  assert.match(r.stderr, /CLI Team \(owner\): development, preview, production/);
  assert.match(r.stderr, /Dan Shared \(editor\): development, preview\n/);
  assert.match(r.stderr, /Twin \(viewer\): no environments your role may read/);
  const c = credentials(config);
  assert.match(c.accessToken, /^rle_[0-9a-f]{64}$/);
  assert.match(c.refreshToken, /^rlr_[0-9a-f]{64}$/);
  assertClean(r.stdout, r.stderr);
});

test("login: credentials go to the config directory with mode 600 (directory 700), never the project directory", async () => {
  const config = path.join(tmp("login-mode"), "nested", "reliquary");
  const cwd = tmp("project");
  const l = await login(config, { cwd });
  assert.equal(l.code, 0, l.stderr);
  assert.equal(statSync(path.join(config, "credentials.json")).mode & 0o777, 0o600);
  assert.equal(statSync(config).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(cwd), []);
  assert.deepEqual(readdirSync(config).sort(), ["credentials.json"]);
});

test("login: an answer with the wrong state is refused, and nothing is stored", async () => {
  const config = tmp("login-state");
  const r = start(["login", "--no-browser"], { config });
  const [, url] = await waitFor(r, "stderr", /^\s+(http:\/\/\S+\/oauth\/authorize\?\S+)$/m);
  const redirect = new URL(url).searchParams.get("redirect_uri");
  const back = await fetch(`${redirect}?${new URLSearchParams({ code: `rlc_${"0".repeat(64)}`, state: "not-the-state", iss: WEB })}`);
  assert.equal(back.status, 400);
  const done = await r.done;
  assert.equal(done.code, 1);
  assert.match(done.stderr, /wrong state/);
  assert.equal(credentials(config), null);
});

test("login: an answer from another issuer is refused", async () => {
  const config = tmp("login-iss");
  const r = start(["login", "--no-browser"], { config });
  const [, url] = await waitFor(r, "stderr", /^\s+(http:\/\/\S+\/oauth\/authorize\?\S+)$/m);
  const u = new URL(url);
  const back = await fetch(`${u.searchParams.get("redirect_uri")}?${new URLSearchParams({ code: `rlc_${"0".repeat(64)}`, state: u.searchParams.get("state"), iss: "https://evil.example" })}`);
  assert.equal(back.status, 400);
  const done = await r.done;
  assert.equal(done.code, 1);
  assert.match(done.stderr, /wrong iss/);
  assert.equal(credentials(config), null);
});

test("login: denying consent fails with a plain message and stores nothing", async () => {
  const config = tmp("login-deny");
  const r = await login(config, { decision: "deny" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /denied/);
  assert.equal(credentials(config), null);
});

test("login: a sign-in scoped to one vault reaches only that vault", async () => {
  const config = tmp("login-scope");
  const r = await login(config, { choice: [["reach", "some"], ["vault", team]] });
  assert.equal(r.code, 0, r.stderr);
  const vaults = await cli(["vaults"], { config });
  assert.equal(vaults.code, 0);
  assert.equal(vaults.stdout, `${team}  CLI Team (owner): development, preview, production\n`);
  const run = await cli(["run", "--vault", shared, "--", "true"], { config });
  assert.equal(run.code, 1);
  assert.match(run.stderr, /No vault .* for this sign-in/);
});

test("login: signing in again revokes the previous sign-in on this computer", async () => {
  const config = tmp("login-again");
  assert.equal((await login(config)).code, 0);
  const first = credentials(config);
  assert.equal((await login(config)).code, 0);
  const again = await fetch(`${WEB}/api/env/vaults`, { headers: { authorization: `Bearer ${first.accessToken}` } });
  assert.equal(again.status, 401);
  assert.equal((await cli(["vaults"], { config })).code, 0);
});

test("login: the server must be https, or plain http on this computer only", async () => {
  const r = await cli(["vaults", "--server", "http://reliquary.example"], { server: false });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /must use https/);
});

// ---------------------------------------------------------------------------
// tokens: refresh, revocation, logout

test("tokens: an expired access token is refreshed by itself, and the refresh token rotates", async () => {
  const config = tmp("refresh");
  assert.equal((await login(config)).code, 0);
  const before = credentials(config);
  const f = path.join(config, "credentials.json");
  const store = JSON.parse(readFileSync(f, "utf8"));
  store.servers[WEB].expiresAt = 0;
  writeFileSync(f, JSON.stringify(store));
  const r = await cli(["vaults"], { config });
  assert.equal(r.code, 0, r.stderr);
  recordTokens(config);
  const now = credentials(config);
  assert.notEqual(now.refreshToken, before.refreshToken);
  assert.notEqual(now.accessToken, before.accessToken);
  assert.ok(now.expiresAt > Date.now() + 30 * 60_000);
});

test("tokens: two commands refreshing at once take turns, so the grant survives (a reused refresh token would revoke it)", async () => {
  const config = tmp("refresh-race");
  assert.equal((await login(config)).code, 0);
  const f = path.join(config, "credentials.json");
  const store = JSON.parse(readFileSync(f, "utf8"));
  store.servers[WEB].expiresAt = 0;
  writeFileSync(f, JSON.stringify(store));
  const [a, b, c] = await Promise.all([cli(["vaults"], { config }), cli(["vaults"], { config }), cli(["vaults"], { config })]);
  recordTokens(config);
  assert.deepEqual([a.code, b.code, c.code], [0, 0, 0], a.stderr + b.stderr + c.stderr);
  assert.equal((await cli(["vaults"], { config })).code, 0);
});

test("tokens: a sign-in revoked on the Tokens page fails with 'run reliquary login', and is forgotten", async () => {
  const config = tmp("revoked");
  assert.equal((await login(config)).code, 0);
  const h = await (await page("/tokens")).text();
  const [grant] = await as(null, "select id from public.access_tokens where user_id = $1 and kind = 'cli' and revoked_at is null order by created_at desc limit 1", [CARA]);
  const rv = await fetch(`${WEB}/tokens/${grant.id}/revoke`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: WEB },
    body: new URLSearchParams({ csrf: csrfOf(h) }).toString(),
  });
  assert.equal(rv.status, 303);
  const r = await cli(["run", "--vault", "CLI Team", "--", process.execPath, "-e", REPORT], { config });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /revoked or has expired.*Run `reliquary login/);
  assert.equal(r.stdout, "", "the command never ran");
  assert.equal(credentials(config), null);
});

test("tokens: logout revokes the grant on the server and forgets it", async () => {
  const config = tmp("logout");
  assert.equal((await login(config)).code, 0);
  const c = credentials(config);
  const r = await cli(["logout"], { config });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /revoked and forgotten/);
  assert.equal(credentials(config), null);
  assert.equal((await fetch(`${WEB}/api/env/vaults`, { headers: { authorization: `Bearer ${c.accessToken}` } })).status, 401);
  const refresh = await fetch(`${WEB}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: c.refreshToken, client_id: `${WEB}/cli/oauth-client.json`, resource: `${WEB}/api/env` }).toString(),
  });
  assert.equal((await refresh.json()).error, "invalid_grant");
  const again = await cli(["vaults"], { config });
  assert.equal(again.code, 1);
  assert.match(again.stderr, /not signed in.*reliquary login/);
});

test("tokens: the CLI's token is refused at the MCP endpoint", async () => {
  const { accessToken } = credentials(main);
  const r = await fetch(MCP_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });
  assert.equal(r.status, 401);
});

// ---------------------------------------------------------------------------
// run

test("run: the command gets the environment's variables (checked by hash), and no value reaches the CLI's output", async () => {
  const r = await cli(["run", "--vault", "CLI Team", "--", process.execPath, "-e", REPORT], { config: main });
  assert.equal(r.code, 0, r.stderr);
  const got = report(r);
  assert.deepEqual(got.names, ["API_KEY", "DATABASE_URL", "MULTI"]);
  assert.deepEqual(got.hashes, { API_KEY: sha(v.api), DATABASE_URL: sha(v.db), MULTI: sha(v.multi) });
  assert.match(r.stderr, /3 variables from CLI Team \(development\)/);
  assertClean(r.stdout, r.stderr);
});

test("run: --env picks the environment; production is there for an owner", async () => {
  const r = await cli(["run", "--vault", "CLI Team", "--env", "production", "--", process.execPath, "-e", REPORT], { config: main });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(report(r).hashes, { API_KEY: sha(v.prod) });
});

test("run: an editor can't read production, and the command doesn't run", async () => {
  const r = await cli(["run", "--vault", "Dan Shared", "--env", "production", "--", process.execPath, "-e", REPORT], { config: main });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Your role can't read production in Dan Shared/);
  assert.equal(r.stdout, "");
});

test("run: a viewer reads no environment", async () => {
  const r = await cli(["run", "--vault", twinB, "--", process.execPath, "-e", REPORT], { config: main });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Your role can't read development in Twin/);
});

test("run: vaults by id or name; an ambiguous name lists the ids, an unknown one is refused", async () => {
  const byId = await cli(["run", "--vault", team, "--", process.execPath, "-e", REPORT], { config: main });
  assert.equal(byId.code, 0);
  const twin = await cli(["run", "--vault", "Twin", "--", "true"], { config: main });
  assert.equal(twin.code, 2);
  assert.match(twin.stderr, /More than one vault is named "Twin"/);
  assert.ok(twin.stderr.includes(twinA) && twin.stderr.includes(twinB));
  const none = await cli(["run", "--vault", "Nope", "--", "true"], { config: main });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /No vault named "Nope"/);
  const unset = await cli(["run", "--", "true"], { config: main });
  assert.equal(unset.code, 2);
  assert.match(unset.stderr, /Choose a vault with --vault/);
});

test("run: .reliquary.json gives the server, vault and environment", async () => {
  const cwd = tmp("project");
  writeFileSync(path.join(cwd, ".reliquary.json"), JSON.stringify({ server: WEB, vault: team, environment: "preview" }));
  const r = await cli(["run", "--", process.execPath, "-e", REPORT], { config: main, cwd, server: false });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(report(r).hashes, { PREVIEW_ONLY: sha(v.preview) });
});

test("run: says by name which inherited variables it overrides", async () => {
  const r = await cli(["run", "--vault", "CLI Team", "--", process.execPath, "-e", REPORT], { config: main, env: { API_KEY: "inherited" } });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /overriding API_KEY from your environment/);
  assert.equal(report(r).hashes.API_KEY, sha(v.api));
});

test("run: exits with the command's exit code", async () => {
  const r = await cli(["run", "--vault", "CLI Team", "--", process.execPath, "-e", "process.exit(7)"], { config: main });
  assert.equal(r.code, 7);
});

test("run: forwards SIGTERM to the command and exits 128 + 15", async () => {
  const r = start(["run", "--vault", "CLI Team", "--", process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"], { config: main });
  await waitFor(r, "stdout", /ready/);
  r.child.kill("SIGTERM");
  const done = await r.done;
  assert.equal(done.signal, null, "the CLI itself wasn't killed");
  assert.equal(done.code, 143);
});

test("run: an unknown command exits 127", async () => {
  const r = await cli(["run", "--vault", "CLI Team", "--", "no-such-command-reliquary"], { config: main });
  assert.equal(r.code, 127);
  assert.match(r.stderr, /Command not found: no-such-command-reliquary/);
});

test("run: writes nothing to disk", async () => {
  const cwd = tmp("run-disk");
  const before = { cwd: readdirSync(cwd), config: readdirSync(main).sort() };
  const r = await cli(["run", "--vault", "CLI Team", "--", process.execPath, "-e", REPORT], { config: main, cwd });
  assert.equal(r.code, 0);
  assert.deepEqual(readdirSync(cwd), before.cwd);
  assert.deepEqual(readdirSync(main).sort(), before.config);
});

// ---------------------------------------------------------------------------
// env pull

const gitIn = (dir, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
};
function repo(gitignore) {
  const dir = tmp("repo");
  gitIn(dir, "init", "-q");
  if (gitignore !== null) writeFileSync(path.join(dir, ".gitignore"), gitignore);
  return dir;
}
// Reads back what env pull wrote (the format in docs/variables.md).
function parseDotenv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"$/.exec(line);
    assert.ok(m, `a line env pull wrote isn't NAME="value"`);
    out[m[1]] = m[2].replace(/\\(.)/g, (_, c) => ({ n: "\n", r: "\r" })[c] ?? c);
  }
  return out;
}

test("env pull: writes an ignored .env with mode 600, values escaped, and prints only names", async () => {
  const dir = repo(".env\n.env.*\n");
  const r = await cli(["env", "pull", "--vault", "CLI Team"], { config: main, cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  const file = path.join(dir, ".env");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const text = readFileSync(file, "utf8");
  assert.match(text, /^# Environment variables from Reliquary: vault "CLI Team"/);
  assert.deepEqual(parseDotenv(text), { API_KEY: v.api, DATABASE_URL: v.db, MULTI: v.multi });
  assert.deepEqual(text.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("=")[0]), ["API_KEY", "DATABASE_URL", "MULTI"]);
  assert.match(r.stderr, /Wrote 3 variables from CLI Team \(development\) to \.env \(mode 600\): API_KEY, DATABASE_URL, MULTI/);
  assert.deepEqual(readdirSync(dir).sort(), [".env", ".git", ".gitignore"], "no temporary file left");
  assertClean(r.stdout, r.stderr);
});

test("env pull: replaces an existing file atomically when its temporary name is ignored too, and tightens the mode", async () => {
  const dir = repo(".env*\n");
  const file = path.join(dir, ".env");
  writeFileSync(file, "OLD=1\n");
  chmodSync(file, 0o644);
  const ino = statSync(file).ino;
  const r = await cli(["env", "pull", "--vault", "CLI Team", "--env", "preview"], { config: main, cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.notEqual(statSync(file).ino, ino, "renamed into place");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(parseDotenv(readFileSync(file, "utf8")), { PREVIEW_ONLY: v.preview });
});

test("env pull: when only the file itself is ignored, it is rewritten in place with mode 600 and no temporary file", async () => {
  const dir = repo("/.env\n");
  const file = path.join(dir, ".env");
  writeFileSync(file, "OLD=1\n");
  chmodSync(file, 0o644);
  const ino = statSync(file).ino;
  const r = await cli(["env", "pull", "--vault", "CLI Team"], { config: main, cwd: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(statSync(file).ino, ino);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(parseDotenv(readFileSync(file, "utf8")), { API_KEY: v.api, DATABASE_URL: v.db, MULTI: v.multi });
  assert.deepEqual(readdirSync(dir).sort(), [".env", ".git", ".gitignore"]);
});

test("env pull: refuses a file git doesn't ignore, before fetching anything, and writes nothing", async () => {
  const dir = repo("node_modules/\n");
  const r = await cli(["env", "pull", "--vault", "CLI Team"], { config: main, cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\.env isn't ignored by git/);
  assert.equal(existsSync(path.join(dir, ".env")), false);
  const other = await cli(["env", "pull", "--vault", "CLI Team", "--file", "config.env"], { config: main, cwd: repo(".env\n") });
  assert.equal(other.code, 1);
  assert.match(other.stderr, /config\.env isn't ignored by git/);
});

test("env pull: refuses a tracked .env even when .gitignore matches it, and leaves it as it was", async () => {
  const dir = repo(null);
  writeFileSync(path.join(dir, ".env"), "TRACKED=1\n");
  gitIn(dir, "add", ".env");
  gitIn(dir, "commit", "-q", "-m", "oops");
  writeFileSync(path.join(dir, ".gitignore"), ".env\n");
  const r = await cli(["env", "pull", "--vault", "CLI Team"], { config: main, cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /isn't ignored by git \(or it's tracked\).*git rm --cached \.env/);
  assert.equal(readFileSync(path.join(dir, ".env"), "utf8"), "TRACKED=1\n");
});

test("env pull: refuses outside a git repository unless --outside-repo is given", async () => {
  const dir = tmp("norepo");
  const r = await cli(["env", "pull", "--vault", "CLI Team"], { config: main, cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /isn't in a git repository/);
  assert.deepEqual(readdirSync(dir), []);
  const ok = await cli(["env", "pull", "--vault", "CLI Team", "--outside-repo"], { config: main, cwd: dir });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(statSync(path.join(dir, ".env")).mode & 0o777, 0o600);
  assert.deepEqual(parseDotenv(readFileSync(path.join(dir, ".env"), "utf8")), { API_KEY: v.api, DATABASE_URL: v.db, MULTI: v.multi });
});

test("env pull: refuses to write through a symbolic link", async () => {
  const dir = repo(".env\n");
  spawnSync("ln", ["-s", "/tmp/elsewhere", path.join(dir, ".env")]);
  const r = await cli(["env", "pull", "--vault", "CLI Team"], { config: main, cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /symbolic link/);
  assert.equal(existsSync("/tmp/elsewhere"), false);
});

test("env pull: a forbidden environment writes nothing", async () => {
  const dir = repo(".env\n");
  const r = await cli(["env", "pull", "--vault", "Dan Shared", "--env", "production"], { config: main, cwd: dir });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Your role can't read production/);
  assert.equal(existsSync(path.join(dir, ".env")), false);
});
