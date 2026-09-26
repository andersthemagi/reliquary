// Invite-only admission in the web UI (src/plans.ts, src/pages.ts; the rules
// are in supabase/tests/admission_test.sql), driven over HTTP.
//
// This file starts its own servers from dist/ (local sign-in), signed in as
// Ada and as Bea, people no other test file uses. The suite's database is
// open (supabase/tests/support.sql); this file turns invite-only on in
// before() and off again in after(). web/test.sh runs one file at a time,
// so no other file sees it on. Bea is admitted by the operator and owns
// "Admission club"; Ada has an account nobody admitted.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const ADA = "00000000-0000-0000-0000-000000000ad1";
const BEA = "00000000-0000-0000-0000-000000000ad2";
const KEY = randomBytes(32).toString("base64url");

const servers = [];
const S = {}; // person -> { origin, cookie }
const V = {};
let log = "";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
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

async function startAs(user) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/admission-login-${process.pid}-${port}`;
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1",
      PORT: String(port), PUBLIC_URL: "", VARIABLES_KEY: KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  servers.push(child);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  return { origin, cookie: r.headers.get("set-cookie").split(";")[0] };
}

const get = (who, path) => fetch(S[who].origin + path, { headers: { cookie: S[who].cookie }, redirect: "manual" });
const page = async (who, path) => (await get(who, path)).text();
const csrfOf = async (who) => /name="csrf" value="([0-9a-f]+)"/.exec(await page(who, "/"))[1];
const post = async (who, path, fields) => {
  const body = new URLSearchParams(Array.isArray(fields) ? fields : Object.entries(fields));
  body.append("csrf", await csrfOf(who));
  return fetch(S[who].origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: S[who].cookie, "content-type": "application/x-www-form-urlencoded", origin: S[who].origin },
    body: body.toString(),
  });
};
const unescape = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const flashAfter = async (who, r) => {
  assert.equal(r.status, 303);
  const h = await page(who, r.headers.get("location"));
  return unescape(/<p class="callout (?:info|success|warning|danger) flash" role="(?:status|alert)">([^<]*)<\/p>/.exec(h)?.[1] ?? "");
};

let club = "";

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'ada@example.test'), ($2, 'bea@example.test') on conflict (id) do nothing`,
    [ADA, BEA],
  );
  await sql("select private.admit_account($1)", [BEA]);
  await sql("select private.set_invite_only(true)");
  [{ id: club }] = await as({ user: BEA }, "select public.create_vault('Admission club') as id");
  S.ada = await startAs(ADA);
});

after(async () => {
  for (const child of servers) child.kill();
  await sql("select private.set_invite_only(false)");
});

const NOTE = /<p class="callout attention" role="status">Your account can’t create vaults yet: Reliquary is invite-only during the alpha\. To get in, open an invite link someone sent you and join their vault, or ask the operator to admit your account\. <a href="\/docs\/concepts\/plans-and-limits#invite-only">Invite-only<\/a><\/p>/;

test("admission: New vault tells an account nobody admitted that it can't create vaults yet, and how to get in", async () => {
  assert.match(await page("ada", "/vaults/new"), NOTE);
});

test("admission: Plan and usage says the same", async () => {
  assert.match(await page("ada", "/account"), NOTE);
});

test("admission: creating a vault anyway is refused with the database's reason and a reference, and nothing is created", async () => {
  const flash = await flashAfter("ada", await post("ada", "/vaults/new", { name: "Ada's own", default_policy: "open" }));
  assert.match(flash,
    /^Your account can't create vaults yet: Reliquary is invite-only during alpha\. Open an invite link someone sent you and join their vault \(that admits your account\), or ask the operator to admit you\. \(ref ([0-9a-f]{8})\)$/);
  const [{ n }] = await sql("select count(*)::int as n from public.vaults where created_by = $1", [ADA]);
  assert.equal(n, 0);
});

test("admission: once they accept an invite, the note is gone and New vault creates their vault", async () => {
  const [{ t }] = await as({ user: BEA }, "select public.create_invite($1, 'ada@example.test', 'viewer') as t", [club]);
  await as({ user: ADA }, "select public.accept_invite($1)", [t]);
  assert.doesNotMatch(await page("ada", "/vaults/new"), NOTE);
  const r = await post("ada", "/vaults/new", { name: "Ada's own", default_policy: "open" });
  assert.equal(r.status, 303);
  assert.match(r.headers.get("location"), /^\/v\/[0-9a-f-]{36}$/);
  const [{ n }] = await sql("select count(*)::int as n from public.vaults where created_by = $1", [ADA]);
  assert.equal(n, 1);
});
