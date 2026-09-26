// `reliquary env push` end to end (docs/variables.md, "Imports"): a .env's
// values go to the server as a pending import, a person applies or rejects
// it in the web UI, and `--wait` reports what they decided. The CLI never
// sets a value, and never prints one.
//
// cli/test.sh starts Postgres, the web app (signed in as Cara, with a
// VARIABLES_KEY for this run) and the MCP server. This file seeds its own
// vaults. Every value holds PUSHVAL-, goes to SECRETS_FILE so test.sh can
// check the server logs, and may be in no CLI output.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

const WEB = process.env.WEB_URL ?? "http://127.0.0.1:8796";
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
  const v = `PUSHVAL-${label}-${randomBytes(6).toString("hex")}`;
  record(v);
  return v;
};
const tmp = (prefix) => mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));

let vars;
let cookie = "";
let team = "";
let dans = "";
let pusher = ""; // a config dir signed in with pushing allowed
let reader = ""; // one signed in without it
const outputs = [];

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

function start(args, { config, cwd } = {}) {
  const env = { ...process.env, RELIQUARY_CONFIG_DIR: config ?? tmp("cfg"), RELIQUARY_NO_BROWSER: "1", RELIQUARY_URL: WEB };
  for (const k of ["VARIABLES_KEY", "PG_URL", "WEB_DB_URL", "DATABASE_URL"]) delete env[k];
  const child = spawn(process.execPath, [CLI, ...args], { cwd: cwd ?? tmp("cwd"), env, stdio: ["ignore", "pipe", "pipe"] });
  const r = { child, stdout: "", stderr: "" };
  child.stdout.on("data", (d) => (r.stdout += d));
  child.stderr.on("data", (d) => (r.stderr += d));
  r.done = new Promise((resolve) =>
    child.on("close", (code) => {
      outputs.push(r.stdout, r.stderr);
      resolve({ code, stdout: r.stdout, stderr: r.stderr });
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

function assertClean(...texts) {
  for (const t of texts) {
    assert.doesNotMatch(t, /PUSHVAL|SEKRIT|rl[ecrq]_[0-9a-f]{8}/, "a value or token in CLI output");
    for (const s of secrets) assert.ok(!t.includes(s), "a recorded secret in CLI output");
  }
}

const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
const page = (p) => fetch(new URL(p, WEB), { headers: { cookie }, redirect: "manual" });

// `reliquary login`, with the browser's part (Cara's consent) done here.
// `push` is the consent page's "also let it send .env files" box.
async function login(config, { push }) {
  const r = start(["login", "--no-browser"], { config });
  const [, url] = await waitFor(r, "stderr", /^\s+(http:\/\/\S+\/oauth\/authorize\?\S+)$/m);
  const consent = await (await page(new URL(url).pathname + new URL(url).search)).text();
  const fields = [...new URL(url).searchParams, ["csrf", csrfOf(consent)], ["decision", "approve"], ...(push ? [["push", "yes"]] : [])];
  const answer = await fetch(`${WEB}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: WEB },
    body: new URLSearchParams(fields).toString(),
  });
  assert.equal(answer.status, 303);
  const location = answer.headers.get("location");
  record(new URL(location).searchParams.get("code"));
  await fetch(location);
  const result = await r.done;
  const f = path.join(config, "credentials.json");
  if (existsSync(f)) {
    const c = JSON.parse(readFileSync(f, "utf8")).servers[WEB];
    record(c.accessToken, c.refreshToken);
  }
  return result;
}

// Apply or reject in the web UI, as Cara.
async function decide(url, what) {
  const h = await (await page(new URL(url).pathname)).text();
  const r = await fetch(`${url}/${what}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: WEB },
    body: new URLSearchParams({ csrf: csrfOf(h) }).toString(),
  });
  assert.equal(r.status, 303);
}

function envFile(lines) {
  const dir = tmp("push");
  const file = path.join(dir, ".env");
  writeFileSync(file, lines.join("\n"));
  return { dir, file };
}

const urlOf = (stdout) => {
  const m = /^(http:\/\/\S+\/v\/[0-9a-f-]{36}\/variables\/imports\/([0-9a-f-]{36}))$/m.exec(stdout);
  assert.ok(m, `no approval link in: ${stdout}`);
  return { url: m[1], id: m[2] };
};

before(async () => {
  process.env.DATABASE_URL = process.env.WEB_DB_URL;
  const secretsMod = await import(pathToFileURL(path.join(WEB_BUILD, "dist/secrets.js")).href);
  secretsMod.configureVariables({ VARIABLES_KEY: process.env.VARIABLES_KEY });
  vars = await import(pathToFileURL(path.join(WEB_BUILD, "dist/variables.js")).href);

  const r = await fetch(readFileSync(process.env.LOGIN_FILE ?? "/work/state/login", "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];

  [{ id: team }] = await as(CARA, "select public.create_vault('Push Team') as id");
  [{ id: dans }] = await as(DAN, "select public.create_vault('Push Dan') as id");
  await as(null, "select test_support.add_member($1, $2, 'editor', $3)", [dans, CARA, DAN]);
  await vars.setVariable(CARA, team, "OLD_KEY", "development", value("old"));

  pusher = tmp("pusher");
  assert.equal((await login(pusher, { push: true })).code, 0);
  reader = tmp("reader");
  assert.equal((await login(reader, { push: false })).code, 0);
});

after(async () => {
  const { pool } = await import(pathToFileURL(path.join(WEB_BUILD, "dist/db.js")).href);
  await pool.end();
  assertClean(...outputs);
});

// ---------------------------------------------------------------------------

const sent = {};

test("push: sends a .env for approval, printing the names and the approval link, never a value; nothing is set yet", async () => {
  sent.api = value("api");
  sent.old = value("old-new");
  sent.pem = `-----BEGIN-----\n${value("pem")}\n-----END-----`;
  const { file } = envFile([
    "# from an agent's project",
    `export API_KEY=${sent.api}`,
    `OLD_KEY="${sent.old}" # rotated`,
    `PEM="${sent.pem.replaceAll("\n", "\\n")}"`,
  ]);
  const r = await cli(["env", "push", "--vault", "Push Team", "--file", file], { config: pusher });
  assert.equal(r.code, 0, r.stderr);
  assertClean(r.stdout, r.stderr);
  const { url, id } = urlOf(r.stdout);
  assert.equal(url, `${WEB}/v/${team}/variables/imports/${id}`);
  assert.equal(r.stdout, `${url}\n`);
  assert.match(r.stderr, /sent 3 variables for Push Team \(development\) for approval; new: API_KEY, PEM; replacing: OLD_KEY\./);
  assert.match(r.stderr, /nothing is set until a person applies it in the web UI/);
  const [imp] = await as(null, "select status, source, names from public.env_imports where id = $1", [id]);
  assert.deepEqual(imp, { status: "pending", source: "cli", names: ["API_KEY", "OLD_KEY", "PEM"] });
  assert.equal((await vars.revealVariable(CARA, team, "API_KEY", "development")).error, "not_found");
  sent.url = url;
});

test("push: the CLI's own token can't apply it; a person does, in the web UI, and the values are exactly the file's", async () => {
  const { accessToken } = JSON.parse(readFileSync(path.join(pusher, "credentials.json"), "utf8")).servers[WEB];
  const tried = await fetch(`${sent.url}/apply`, { method: "POST", redirect: "manual", headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal(tried.status, 401);
  assert.equal((await as(null, "select status from public.env_imports where id = $1", [urlOf(sent.url).id]))[0].status, "pending");
  await decide(sent.url, "apply");
  assert.equal((await vars.revealVariable(CARA, team, "API_KEY", "development")).value, sent.api);
  assert.equal((await vars.revealVariable(CARA, team, "OLD_KEY", "development")).value, sent.old);
  assert.equal((await vars.revealVariable(CARA, team, "PEM", "development")).value, sent.pem);
});

test("push: --wait returns 0 once a person applies it", async () => {
  const { file } = envFile([`WAITED=${value("waited")}`]);
  const r = start(["env", "push", "--vault", team, "--env", "preview", "--file", file, "--wait"], { config: pusher });
  await waitFor(r, "stderr", /waiting for approval/);
  await waitFor(r, "stdout", /imports\/[0-9a-f-]{36}\n/);
  await decide(urlOf(r.stdout).url, "apply");
  const done = await r.done;
  assert.equal(done.code, 0, done.stderr);
  assert.match(done.stderr, /applied\. Push Team \(preview\) now has WAITED\./);
  assertClean(done.stdout, done.stderr);
});

test("push: --wait fails (exit 1) when a person rejects it, and nothing is set", async () => {
  const { file } = envFile([`REJECTED_KEY=${value("rejected")}`]);
  const r = start(["env", "push", "--vault", team, "--file", file, "--wait"], { config: pusher });
  await waitFor(r, "stderr", /waiting for approval/);
  await waitFor(r, "stdout", /imports\/[0-9a-f-]{36}\n/);
  await decide(urlOf(r.stdout).url, "reject");
  const done = await r.done;
  assert.equal(done.code, 1);
  assert.match(done.stderr, /The push was rejected; nothing was set\./);
  assert.equal((await vars.revealVariable(CARA, team, "REJECTED_KEY", "development")).error, "not_found");
});

test("push: --wait gives up after --timeout with exit 3, and the push stays pending", async () => {
  const { file } = envFile([`SLOW_KEY=${value("slow")}`]);
  const r = await cli(["env", "push", "--vault", team, "--file", file, "--wait", "--timeout", "3s"], { config: pusher });
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /still waiting for approval/);
  const [imp] = await as(null, "select status from public.env_imports where id = $1", [urlOf(r.stdout).id]);
  assert.equal(imp.status, "pending");
});

test("push: a sign-in that wasn't allowed to send values is refused, with how to fix it", async () => {
  const { file } = envFile([`NOPE=${value("nope")}`]);
  const r = await cli(["env", "push", "--vault", team, "--file", file], { config: reader });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /This connection wasn't allowed to send values\. Run `reliquary login` again/);
  assert.equal(r.stdout, "");
});

test("push: an editor can't send production values; the CLI says so and sends nothing", async () => {
  const before = (await as(null, "select count(*)::int as n from public.env_imports where vault_id = $1", [dans]))[0].n;
  const { file } = envFile([`PROD=${value("prod")}`]);
  const r = await cli(["env", "push", "--vault", "Push Dan", "--env", "production", "--file", file], { config: pusher });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /Your role can't set values in production of Push Dan \(you can in development, preview\)\./);
  assert.equal((await as(null, "select count(*)::int as n from public.env_imports where vault_id = $1", [dans]))[0].n, before);
});

test("push: lines it can't take are named with their reasons and not sent; a file with nothing to send sends nothing", async () => {
  const { file } = envFile([`PATH=${value("path")}`, "just words", `GOOD=${value("good")}`, `B="never closed ${value("unclosed")}`]);
  const r = await cli(["env", "push", "--vault", team, "--file", file], { config: pusher });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /line 1 \(PATH\): changes how programs start, so it can't be a shared variable; not sent\./);
  assert.match(r.stderr, /line 2: not NAME=value \(no = sign\); not sent\./);
  assert.match(r.stderr, /line 4 \(B\): the double quote opened here is never closed/);
  assert.match(r.stderr, /sent 1 variable for Push Team \(development\) for approval; new: GOOD\./);
  const [imp] = await as(null, "select names, refused from public.env_imports where id = $1", [urlOf(r.stdout).id]);
  assert.deepEqual(imp.names, ["GOOD"]);
  assert.deepEqual(imp.refused.map((x) => x.line), [1, 2, 4]);
  assertClean(r.stdout, r.stderr);

  const none = envFile([`PATH=${value("path2")}`, "# only this"]);
  const n = await cli(["env", "push", "--vault", team, "--file", none.file], { config: pusher });
  assert.equal(n.code, 1);
  assert.match(n.stderr, /Nothing in .* can be sent\./);
  assert.equal(n.stdout, "");
});

test("push: a missing file or a directory is refused before anything is sent", async () => {
  const dir = tmp("nofile");
  const missing = await cli(["env", "push", "--vault", team], { config: pusher, cwd: dir });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /There's no \.env\. Name the file with --file\./);
  mkdirSync(path.join(dir, "adir"));
  const d = await cli(["env", "push", "--vault", team, "--file", "adir"], { config: pusher, cwd: dir });
  assert.equal(d.code, 1);
  assert.match(d.stderr, /adir isn't a regular file\./);
  const t = await cli(["env", "push", "--vault", team, "--timeout", "5m"], { config: pusher, cwd: dir });
  assert.equal(t.code, 2);
  assert.match(t.stderr, /--timeout goes with --wait/);
});
