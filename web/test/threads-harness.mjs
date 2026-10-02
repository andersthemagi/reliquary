// Shared set-up for the vault Threads page tests (threads_list.test.mjs,
// threads_page.test.mjs): the same four synthetic people, a server from dist/
// signed in as any of them, and the form and database helpers each file would
// otherwise copy. Not a test file (the runner takes only *.test.mjs).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;

// Noa owns the vaults, Edda edits, Rex only views, Ola is in none of them.
export const NOA = "00000000-0000-0000-0000-0000000065a1";
export const EDDA = "00000000-0000-0000-0000-0000000065a2";
export const REX = "00000000-0000-0000-0000-0000000065a3";
export const OLA = "00000000-0000-0000-0000-0000000065a4";

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function sql(q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    return (await db.query(q, params)).rows;
  } finally {
    await db.end();
  }
}

// A statement as `user` (an agent of theirs when `agent` names one), through
// the same role the web app uses, so row level security applies.
export async function as(user, q, params = [], agent = null) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    const claims = { sub: user, role: "authenticated", ...(agent ? { act: { name: agent } } : {}) };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

export async function addPeople() {
  await sql(
    `insert into auth.users (id, email) values ($1, 'noa@example.test'), ($2, 'edda@example.test'), ($3, 'rex@example.test'), ($4, 'ola@example.test')
       on conflict (id) do nothing`,
    [NOA, EDDA, REX, OLA],
  );
}

// A server from dist/, signed in as `user`.
export async function start(user, name) {
  const port = await freePort();
  const s = { origin: `http://127.0.0.1:${port}`, cookie: "", child: null };
  const loginFile = `/tmp/threads-${name}-${process.pid}-${port}`;
  s.child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${s.origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];
  return s;
}

export const get = (s, path) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
export const page = async (s, path) => (await get(s, path)).text();
// A form post. `fields` may hold arrays: each value is sent under the same name.
export const post = (s, path, fields, headers = {}) => {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin, ...headers },
    body: body.toString(),
  });
};
export const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
// Where a redirect landed, as a page.
export const landed = async (s, r) => {
  assert.equal(r.status, 303);
  return page(s, r.headers.get("location"));
};
export const flashOf = (h) => /<p class="callout (\w+) flash" role="(\w+)">([\s\S]*?)<\/p>/.exec(h)?.slice(1);
export const visibleText = (h) => h.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&#39;/g, "'");
