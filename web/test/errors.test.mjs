// Errors end to end (docs/public/reference/errors.md): real failures from a
// real database show what was being done, where it broke, why, and a
// reference that finds the full record in the server's log, and never a
// value from the failing row.
//
// This file makes its own database (errors_test), with faults a test-only
// trigger raises on chosen paths, and runs its own server on it, so it can
// read that server's log. The database gives the web app's role a 1.5 s
// statement timeout, so a slow call is a real 57014. Every value the faults
// put in a failing row holds SEKRIT-; none may reach a page or the log.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";

const REPO = process.env.REPO_DIR ?? new URL("../..", import.meta.url).pathname;
const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
// web/test.sh puts Postgres at 54332 + 10 * slot and the server at 8791 + 10 * slot.
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const DB = "errors_test";
const SUPER = (db) => `postgres://postgres:test@127.0.0.1:${PG_PORT}/${db}`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/${DB}`;
const ERIN = "00000000-0000-0000-0000-0000000000e7"; // the server's person
const FRED = "00000000-0000-0000-0000-0000000000e8"; // owns the vaults Erin can't see or can't govern
const MARK = `SEKRIT-${randomBytes(6).toString("hex")}`;
const SLOW_MS = 1500;

let server; // { child, origin, out() }
let cookie = "";
const V = {}; // vault ids
const refs = []; // every reference a test saw

const sha = (s) => createHash("sha256").update(s).digest("hex");
const REF = /ref ([0-9a-f]{8})/;

async function sql(q, params = [], db = DB) {
  const c = new pg.Client({ connectionString: SUPER(db) });
  await c.connect();
  try {
    return (await c.query(q, params)).rows;
  } finally {
    await c.end();
  }
}

async function as(user, q, params = []) {
  const c = new pg.Client({ connectionString: SUPER(DB) });
  await c.connect();
  try {
    await c.query("begin");
    if (user === "reliquary_web") await c.query("set local role reliquary_web");
    else {
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated" })]);
    }
    const { rows } = await c.query(q, params);
    await c.query("commit");
    return rows;
  } finally {
    await c.end();
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const get = (path, headers = {}) => fetch(server.origin + path, { headers: { cookie, ...headers }, redirect: "manual" });
const post = (path, fields) =>
  fetch(server.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: server.origin },
    body: new URLSearchParams(fields).toString(),
  });
const csrf = async (path = "/") => /name="csrf" value="([0-9a-f]+)"/.exec(await (await get(path)).text())[1];
const flashOf = (h) => /<p class="callout (?:info|success|warning|danger) flash" role="(?:status|alert)">([^<]*)<\/p>/.exec(h)?.[1] ?? "";

// The four fields of an error page, and its copyable text.
function fields(h) {
  const dd = (label) => new RegExp(`<dt>${label}</dt><dd>(.*?)</dd>`).exec(h)?.[1];
  const ref = /<dt>Reference<\/dt><dd><code>ref ([0-9a-f]{8})<\/code><\/dd>/.exec(h)?.[1];
  const copy = /<pre class="code failure-copy">([\s\S]*?)<\/pre>/.exec(h)?.[1] ?? "";
  if (ref) refs.push(ref);
  return { what: dd("What"), where: dd("Where"), why: dd("Why"), ref, copy };
}

// The log line for a reference, parsed.
async function logged(ref) {
  for (let i = 0; i < 20; i++) {
    const line = server.out().split("\n").find((l) => l.startsWith(`failure ref=${ref} `));
    if (line) return JSON.parse(line.slice(line.indexOf("{")));
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`no log line for ref ${ref}`);
}

const write = async (path) => post(`/v/${V.own}/file`, { csrf: await csrf(), action: "write", path, content: "x" });

before(async () => {
  // A database of our own: every migration, then the faults.
  await sql(`drop database if exists ${DB} with (force)`, [], "postgres");
  await sql(`create database ${DB}`, [], "postgres");
  const files = [
    join(REPO, "supabase/tests/stub.sql"),
    ...readdirSync(join(REPO, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => join(REPO, "supabase/migrations", f)),
    join(REPO, "supabase/tests/support.sql"),
  ];
  const c = new pg.Client({ connectionString: SUPER(DB) });
  await c.connect();
  try {
    for (const f of files) await c.query(readFileSync(f, "utf8"));
    await c.query(`
      create schema test_faults;
      create table test_faults.uniq (v text unique);
      create table test_faults.parent (v text primary key);
      create table test_faults.child (v text references test_faults.parent);
      create table test_faults.slow_vaults (id uuid primary key);
      create function test_faults.fire() returns trigger language plpgsql security definer set search_path = '' as $f$
      declare p text;
      begin
        select f.path into p from public.files f where f.id = new.file_id;
        if p = 'errors-test/unique.md' then
          insert into test_faults.uniq values ('${MARK}-unique');
          insert into test_faults.uniq values ('${MARK}-unique');
        elsif p = 'errors-test/fk.md' then
          insert into test_faults.child values ('${MARK}-fk');
        elsif p = 'errors-test/slow.md' then
          perform pg_sleep(${(SLOW_MS * 3) / 1000});
        end if;
        return new;
      end $f$;
      create trigger test_fault before insert on public.file_versions for each row execute function test_faults.fire();
      create function test_faults.slow_read() returns trigger language plpgsql security definer set search_path = '' as $f$
      begin
        if exists (select 1 from test_faults.slow_vaults s where s.id = new.vault_id) then perform pg_sleep(${(SLOW_MS * 3) / 1000}); end if;
        return new;
      end $f$;
      create trigger test_slow_read before insert on public.env_access_log for each row execute function test_faults.slow_read();
      alter role reliquary_web in database ${DB} set statement_timeout = '${SLOW_MS}ms';
    `);
  } finally {
    await c.end();
  }
  [{ id: V.own }] = await as(ERIN, "select public.create_vault('Errors Vault') as id");
  [{ id: V.fred }] = await as(FRED, "select public.create_vault('Fred Shared') as id");
  [{ id: V.hidden }] = await as(FRED, "select public.create_vault('Fred Hidden') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.fred, ERIN, FRED]);

  const port = await freePort();
  const loginFile = `/tmp/errors-login-${process.pid}-${port}`;
  let out = "";
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env,
      DATABASE_URL: WEB_DB,
      LOCAL_USER_ID: ERIN,
      LOGIN_FILE: loginFile,
      HOST: "127.0.0.1",
      PORT: String(port),
      PUBLIC_URL: "",
      MCP_RESOURCE: "https://mcp.reliquary.test/mcp",
      VARIABLES_KEY: randomBytes(32).toString("base64url"),
      VARIABLES_KEYS: "",
      RATE_LIMIT_SCALE: "1",
      RATE_LIMITS: "web_write_minute=12/60",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  server = { child, origin: `http://127.0.0.1:${port}`, out: () => out };
  for (let i = 0; i < 100 && !(await fetch(`${server.origin}/healthz`).then((r) => r.ok, () => false)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

after(async () => {
  server?.child.kill();
  await sql(`drop database if exists ${DB} with (force)`, [], "postgres").catch(() => {});
});

test("errors: a database error shows what was being done, where, why and a reference on a page with the right status", async () => {
  const r = await write("errors-test/fk.md");
  assert.equal(r.status, 409);
  const h = await r.text();
  const e = fields(h);
  assert.equal(e.what, `Saving errors-test/fk.md in vault ${V.own.slice(0, 8)}`);
  assert.equal(e.where, "database (function test_faults.fire)");
  assert.equal(e.why, "23503 foreign key violation: insert or update on table &quot;child&quot; violates foreign key constraint &quot;child_v_fkey&quot;.");
  assert.match(h, /<h1>Saving errors-test\/fk\.md in vault [0-9a-f]{8} failed<\/h1>/);
  // "Copy details": the same fields as plain text, no script needed.
  assert.match(e.copy, new RegExp(`^Reliquary error\nwhat:  Saving errors-test/fk\\.md in vault [0-9a-f]{8}\nwhere: database \\(function test_faults\\.fire\\)\nwhy:   23503 foreign key violation`));
  assert.match(e.copy, new RegExp(`\nref:   ${e.ref}\nstatus: 409\ntime: `));
  assert.doesNotMatch(h, /<script|went wrong/i);
  assert.equal(h.includes("SEKRIT"), false);
  // The log has the detail, found by the reference, with the row's values redacted.
  const l = await logged(e.ref);
  assert.equal(l.sqlstate, "23503");
  assert.equal(l.constraint, "child_v_fkey");
  assert.equal(l.detail, 'Key (…)=(…) is not present in table "parent".');
  assert.match(l.functions, /^test_faults\.fire line \d+ < private\.apply_write line \d+/);
  assert.equal(l.what, `POST /v/:id/file ${V.own} action=write`);
});

test("errors: the lines to copy are folded away under Details to send if you report this, closed until opened", async () => {
  const r = await get("/no/such/page");
  assert.equal(r.status, 404);
  const h = await r.text();
  assert.ok(fields(h).ref, "a reference");
  assert.match(h, /<details class="failure-details">\s*<summary>Details to send if you report this<\/summary>[\s\S]*?<pre class="code failure-copy">Reliquary error\n[\s\S]*?<\/pre>\s*<\/details>/);
  assert.doesNotMatch(h, /<details class="failure-details" open/);
  assert.doesNotMatch(h, /<h2>Copy details<\/h2>/);
});

test("errors: a unique violation's row values never reach the page or the log", async () => {
  const r = await write("errors-test/unique.md");
  assert.equal(r.status, 303);
  const flash = flashOf(await (await get(r.headers.get("location"))).text());
  assert.match(flash, /^23505 unique violation: duplicate key value violates unique constraint &quot;uniq_v_key&quot;\. \(ref [0-9a-f]{8}\)$/);
  const ref = REF.exec(flash)[1];
  refs.push(ref);
  const l = await logged(ref);
  assert.equal(l.sqlstate, "23505");
  assert.equal(l.detail, "Key (…)=(…) already exists.");
  assert.equal(server.out().includes("SEKRIT"), false);
});

test("errors: a statement timeout is a 504 that names the call that ran out of time", async () => {
  const started = Date.now();
  const r = await write("errors-test/slow.md");
  assert.ok(Date.now() - started < SLOW_MS * 3, "the database stopped it, not the sleep's end");
  assert.equal(r.status, 504);
  const e = fields(await r.text());
  assert.equal(e.what, `Saving errors-test/slow.md in vault ${V.own.slice(0, 8)}`);
  assert.equal(e.where, "database (function test_faults.fire)");
  assert.equal(e.why, "57014 statement timeout: test_faults.fire ran past the database’s time limit and was stopped.");
  const l = await logged(e.ref);
  assert.equal(l.sqlstate, "57014");
  assert.equal(l.status, 504);
});

test("errors: a permission refusal from the database carries its reason and a reference", async () => {
  const r = await post(`/v/${V.fred}/rules`, { csrf: await csrf(), path: "notes/", policy: "canon", quorum: "1" });
  assert.equal(r.status, 303);
  const flash = flashOf(await (await get(r.headers.get("location"))).text());
  assert.match(flash, /^[A-Z].+\. \(ref [0-9a-f]{8}\)$/);
  const ref = REF.exec(flash)[1];
  refs.push(ref);
  const l = await logged(ref);
  assert.equal(l.sqlstate, "42501");
  assert.equal(l.status, 403);
  assert.equal(l.routine, "exec_stmt_raise");
});

test("errors: not found says what was looked for, the same for a vault that isn't shared as for one that doesn't exist", async () => {
  const hidden = await get(`/v/${V.hidden}/file?path=notes%2Fplan.md`);
  assert.equal(hidden.status, 404);
  const h = await hidden.text();
  const e = fields(h);
  assert.equal(e.what, `Opening notes/plan.md in vault ${V.hidden.slice(0, 8)}`);
  assert.equal(e.why, "There’s no such vault, file or proposal, or it isn’t shared with you.");
  const none = "ffffffff-0000-4000-8000-000000000000";
  const missing = await (await get(`/v/${none}/file?path=notes%2Fplan.md`)).text();
  const plain = (s, id) => s.replaceAll(id.slice(0, 8), "ID").replace(/ref:? +[0-9a-f]{8}/g, "ref").replace(/time: \S+/g, "time");
  assert.equal(plain(h, V.hidden), plain(missing, none));
  assert.doesNotMatch(h, /Fred Hidden/);
  // A page that doesn't exist names its path.
  const nopage = fields(await (await get("/no/such/page")).text());
  assert.equal(nopage.why, "There’s no page at /no/such/page.");
});

test("errors: the env API answers a failure with its code, what, where, why and a reference", async () => {
  // A CLI sign-in made in the database, as consent and the token endpoint would.
  const resource = `${server.origin}/api/env`;
  const client = `${server.origin}/cli/oauth-client.json`;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirect = "http://127.0.0.1:53682/callback";
  const [{ code }] = await as(ERIN, "select public.create_cli_grant($1, $2, $3, $4, null::uuid[]) as code", [client, redirect, resource, challenge]);
  const access = `rle_${randomBytes(32).toString("hex")}`;
  const [{ r: redeemed }] = await as("reliquary_web", "select private.oauth_redeem_code($1, $2, $3, $4, $5, $6, $7) as r", [
    sha(code), client, redirect, resource, verifier, sha(access), sha(`rlr_${randomBytes(32).toString("hex")}`),
  ]);
  assert.equal(redeemed, "ok");
  await sql("insert into test_faults.slow_vaults values ($1)", [V.own]);
  try {
    const r = await fetch(`${server.origin}/api/env/${V.own}/development`, { headers: { authorization: `Bearer ${access}` } });
    assert.equal(r.status, 504);
    const body = await r.json();
    assert.equal(body.error, "server_error");
    assert.equal(body.message, `Reading development in vault ${V.own.slice(0, 8)} failed: 57014 statement timeout: test_faults.slow_read ran past the database’s time limit and was stopped.`);
    assert.equal(body.where, "env API: database (function test_faults.slow_read)");
    assert.match(body.ref, /^[0-9a-f]{8}$/);
    refs.push(body.ref);
    const l = await logged(body.ref);
    assert.equal(l.sqlstate, "57014");
    // The route's shape only: no vault id or environment in the log.
    assert.equal(l.what, "env api GET /api/env/:vault/:environment");
    assert.equal(server.out().includes(access), false);
  } finally {
    await sql("delete from test_faults.slow_vaults");
  }
  const none = await (await fetch(`${server.origin}/api/env/vaults`)).json();
  assert.equal(none.error, "invalid_token");
  assert.equal(none.where, "env API (sign-in)");
  assert.match(none.message, /^Listing your vaults and environments failed: No live sign-in/);
  assert.match(none.ref, /^[0-9a-f]{8}$/);
});

test("errors: a rate limit says what was limited, when to retry, and a reference", async () => {
  const token = await csrf();
  let r;
  for (let i = 0; i < 20; i++) {
    r = await post("/theme", { csrf: token, theme: "auto", back: "/" });
    if (r.status === 429) break;
  }
  assert.equal(r.status, 429);
  assert.match(r.headers.get("retry-after"), /^\d+$/);
  const e = fields(await r.text());
  assert.equal(e.what, "Changing the theme");
  assert.equal(e.where, "rate limit");
  assert.match(e.why, /^That was too many changes in a short time, so Reliquary is pausing them\. Try again in \d+ \w+, after .+ UTC\. Nothing was changed\.$/);
  assert.equal((await logged(e.ref)).status, 429);
});

test("errors: every reference shown is in the server log, and no row value or token is", async () => {
  assert.ok(refs.length >= 7, `refs seen: ${refs.length}`);
  for (const ref of refs) await logged(ref);
  const out = server.out();
  assert.equal(out.includes("SEKRIT"), false);
  assert.doesNotMatch(out, /rl[eqor]_[0-9a-f]{8}|went wrong/i);
});
