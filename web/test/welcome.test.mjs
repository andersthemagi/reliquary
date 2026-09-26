// The Welcome tour (src/welcome.ts): six server-rendered slides, the
// first-sign-in redirect (once), and the "seen" flag. The database's rules
// are in supabase/tests/welcome_test.sql. Starts its own local-sign-in web
// servers from dist/, as Wren (a new account, no vault) and Olga (an account
// that had the tour marked seen, as the migration does for existing ones).
// The fresh-sign-in cookie a real sign-in leaves is sent by hand here
// (rlq_fresh); auth.test.mjs checks that sign-in sets it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import { after, before, test } from "node:test";
import pg from "pg";

const WEB = new URL(process.env.WEB_URL ?? "http://127.0.0.1:8791");
const PG_PORT = 54332 + (Number(WEB.port) - 8791);
const SUPER = `postgres://postgres:test@127.0.0.1:${PG_PORT}/postgres`;
const WEB_DB = `postgres://reliquary_web:test@127.0.0.1:${PG_PORT}/postgres`;
const WREN = "00000000-0000-0000-0000-0000000000c1";
const OLGA = "00000000-0000-0000-0000-0000000000c2";
const WYN = "00000000-0000-0000-0000-0000000000c3";
const servers = [];
const S = {};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
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
// q as the person, in person.
async function asUser(who, q, params = []) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: who, role: "authenticated" })]);
    const rows = (await db.query(q, params)).rows;
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}
async function start(user) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const loginFile = `/tmp/welcome-login-${process.pid}-${port}`;
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  return { origin, cookie: r.headers.get("set-cookie").split(";")[0] };
}

// fresh: the cookie a sign-in leaves for its first landing.
const get = (s, path, fresh = false) =>
  fetch(s.origin + path, { headers: { cookie: fresh ? `${s.cookie}; rlq_fresh=1` : s.cookie }, redirect: "manual" });
const page = async (s, path) => (await get(s, path)).text();
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
const post = async (s, path, fields, headers = {}) =>
  fetch(s.origin + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: s.cookie, "content-type": "application/x-www-form-urlencoded", origin: s.origin, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const seen = async (who) => (await sql("select count(*)::int as n from public.welcome_seen where user_id = $1", [who]))[0].n === 1;

before(async () => {
  await sql(`insert into auth.users (id, email) values ($1, 'wren@example.test'), ($2, 'olga@example.test'), ($3, 'wyn@example.test') on conflict (id) do nothing`, [WREN, OLGA, WYN]);
  // As the migration marks every account that exists when it runs.
  await sql(`insert into public.welcome_seen (user_id) values ($1) on conflict do nothing`, [OLGA]);
  S.wren = await start(WREN);
  S.olga = await start(OLGA);
  S.wyn = await start(WYN);
});
after(() => {
  for (const c of servers) c.kill();
});

test("welcome slides: /welcome is slide 1 of 6, with Next, Skip, no Back, and the first dot current", async () => {
  const h = await page(S.olga, "/welcome");
  assert.match(h, /<h1 id="welcome-title">Welcome to Reliquary<\/h1>/);
  assert.match(h, /Step 1 of 6/);
  assert.match(h, /shared vault for you, your team and your AI agents/);
  assert.match(h, /<a class="button primary" href="\/welcome\/2" rel="next">Next<\/a>/);
  assert.doesNotMatch(h, />Back</);
  assert.match(h, /<form method="post" action="\/welcome\/done" class="welcome-skip"><input type="hidden" name="csrf" value="[0-9a-f]+"><button class="quiet">Skip<\/button><\/form>/);
  const dots = [...h.matchAll(/<a href="([^"]+)" class="welcome-dot" aria-label="([^"]+)"( aria-current="step")?>/g)];
  assert.deepEqual(dots.map((d) => d[1]), ["/welcome", "/welcome/2", "/welcome/3", "/welcome/4", "/welcome/5", "/welcome/6"]);
  assert.deepEqual(dots.map((d) => Boolean(d[3])), [true, false, false, false, false, false]);
  assert.match(dots[1][2], /^Step 2 of 6: /);
});

test("welcome slides: each slide has its topic, Back to the one before and Next to the one after", async () => {
  const words = [/./, /canon/i, /proposal/i, /<strong>connection<\/strong>/, /reliquary run/, /Feedback/];
  for (let n = 2; n <= 6; n++) {
    const h = await page(S.olga, `/welcome/${n}`);
    assert.match(h, new RegExp(`Step ${n} of 6`));
    assert.match(h, words[n - 1], `slide ${n}`);
    assert.match(h, new RegExp(`<a class="button" href="${n === 2 ? "/welcome" : `/welcome/${n - 1}`}" rel="prev">Back</a>`));
    if (n < 6) assert.match(h, new RegExp(`href="/welcome/${n + 1}" rel="next">Next</a>`));
    assert.equal((h.match(/aria-current="step"/g) ?? []).length, 1);
    assert.match(h, new RegExp(`class="welcome-dot" aria-label="Step ${n} of 6: [^"]+" aria-current="step"`));
  }
  const last = await page(S.olga, "/welcome/6");
  assert.match(last, /<button class="primary">Get started<\/button>/);
  assert.doesNotMatch(last, />Next</);
  assert.doesNotMatch(last, />Skip</);
  assert.match(last, /Feedback<\/strong> button in the top bar/);
  assert.match(last, /href="\/docs"/);
});

test("welcome slides: a slide that doesn't exist is not found, and the pages carry no script, no em dash and the account menu link", async () => {
  for (const p of ["/welcome/0", "/welcome/7", "/welcome/x", "/welcome/1/2"]) assert.equal((await get(S.olga, p)).status, 404, p);
  for (let n = 1; n <= 6; n++) {
    const h = await page(S.olga, n === 1 ? "/welcome" : `/welcome/${n}`);
    assert.doesNotMatch(h, /<script/i);
    const card = h.slice(h.indexOf('<section class="welcome"'), h.indexOf("</section>"));
    assert.doesNotMatch(card, /—/);
  }
  assert.match(await page(S.olga, "/"), /<li><a href="\/welcome">Welcome tour<\/a><\/li>/);
  assert.match(await page(S.olga, "/welcome"), /<li><a href="\/welcome" aria-current="page">Welcome tour<\/a><\/li>/);
});

test("welcome first visit: a new account arriving from a sign-in is sent to /welcome, once", async () => {
  assert.equal(await seen(WREN), false);
  const r = await get(S.wren, "/", true);
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/welcome");
  assert.match(r.headers.get("set-cookie") ?? "", /rlq_fresh=; .*Max-Age=0/, "the cookie is used up by that landing");
  // Without the cookie (as after that landing), Home is Home.
  const again = await get(S.wren, "/");
  assert.equal(again.status, 200);
  assert.match(await again.text(), /<h1>Home<\/h1>/);
});

test("welcome first visit: without a fresh sign-in there is no redirect, and only Home and a vault's front page redirect", async () => {
  const other = await get(S.wren, "/inbox", true);
  assert.equal(other.status, 200, "/inbox is not a landing");
  assert.equal(other.headers.get("set-cookie"), null);
  assert.equal((await get(S.wren, "/welcome", true)).status, 200, "/welcome itself is never redirected");
  // A vault's front page is a landing too (where accepting an invite ends).
  const id = (await asUser(WYN, "select public.create_vault('Wyn notes') as id"))[0].id;
  const v = await get(S.wyn, `/v/${id}`, true);
  assert.equal(v.status, 303);
  assert.equal(v.headers.get("location"), "/welcome");
  assert.equal((await get(S.wyn, `/v/${id}/proposals`, true)).status, 200, "a page inside it is not");
});

test("welcome first visit: an account that has seen it (as existing accounts are marked) is not redirected even when fresh", async () => {
  const r = await get(S.olga, "/", true);
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<h1>Home<\/h1>/);
});

test("welcome seen: Skip marks it seen, goes Home, and a fresh sign-in never shows it again", async () => {
  assert.equal(await seen(WYN), false);
  const h = await page(S.wyn, "/welcome/3");
  const r = await post(S.wyn, "/welcome/done", { csrf: csrfOf(h) });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/");
  assert.equal(await seen(WYN), true);
  assert.equal((await get(S.wyn, "/", true)).status, 200);
});

test("welcome seen: Get started marks it seen and goes to New vault when there is no vault yet, and Home otherwise", async () => {
  await sql("delete from public.welcome_seen where user_id = $1", [WREN]);
  assert.equal(await seen(WREN), false);
  const h = await page(S.wren, "/welcome/6");
  const r = await post(S.wren, "/welcome/done", { csrf: csrfOf(h), to: "start" });
  assert.equal(r.headers.get("location"), "/vaults/new");
  assert.equal(await seen(WREN), true);
  // Once in a vault, Get started goes Home.
  await asUser(OLGA, "select public.create_vault('Olga notes') as id");
  const h2 = await page(S.olga, "/welcome/6");
  const r2 = await post(S.olga, "/welcome/done", { csrf: csrfOf(h2), to: "start" });
  assert.equal(r2.status, 303);
  assert.equal(r2.headers.get("location"), "/");
});

test("welcome seen: /welcome stays open to someone who has seen it, and marking it again is harmless", async () => {
  assert.equal((await get(S.olga, "/welcome")).status, 200);
  const h = await page(S.olga, "/welcome/2");
  assert.equal((await post(S.olga, "/welcome/done", { csrf: csrfOf(h) })).status, 303);
  assert.equal(await seen(OLGA), true);
});

test("welcome form: Skip needs this session's form token and this origin", async () => {
  const noToken = await post(S.wyn, "/welcome/done", {});
  assert.equal(noToken.status, 403);
  const bad = await post(S.wyn, "/welcome/done", { csrf: "0".repeat(64) });
  assert.equal(bad.status, 403);
  const h = await page(S.wyn, "/welcome");
  const foreign = await post(S.wyn, "/welcome/done", { csrf: csrfOf(h) }, { origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  await sql("delete from public.welcome_seen where user_id = $1", [WYN]);
  assert.equal((await post(S.wyn, "/welcome/done", {})).status, 403);
  assert.equal(await seen(WYN), false, "nothing was marked by a refused form");
  const get405 = await fetch(`${S.wyn.origin}/welcome/done`, { headers: { cookie: S.wyn.cookie }, redirect: "manual" });
  assert.equal(get405.status, 404, "GET /welcome/done is not a page");
  assert.equal(await seen(WYN), false);
});
