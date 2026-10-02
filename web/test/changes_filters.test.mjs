// The Changes feed's views (src/changes.ts): Everyone, Mine (made by you or
// your agents) and Watching (changes on the paths you watch). Mine is the
// log's actor; Watching is public.subscriptions under its own RLS joined to
// the log by the rule in src/watchrule.ts. This file proves the rule agrees
// with public.list_flags's own on the same paths, that only the reader's own
// watches count, and that no view moves anyone's flag watermark.
//
// This file starts its own servers from dist/, signed in as Kai (an owner)
// and Max (a viewer), people no other test file uses. Kai owns "Filters
// main" with Lia (an editor) and Max.

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
const KAI = "00000000-0000-0000-0000-0000000050b1";
const LIA = "00000000-0000-0000-0000-0000000050b2";
const MAX = "00000000-0000-0000-0000-0000000050b3";

const V = {};
const servers = [];
let kai;
let max;

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

// As a person in the web UI, or (with an agent name) as their agent.
async function as(user, q, params = [], agent = null) {
  const db = new pg.Client({ connectionString: SUPER });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    const claims = { sub: user, role: "authenticated", ...(agent ? { act: { sub: agent, name: agent } } : {}) };
    await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const { rows } = await db.query(q, params);
    await db.query("commit");
    return rows;
  } finally {
    await db.end();
  }
}

async function start(user, name) {
  const port = await freePort();
  const s = { origin: `http://127.0.0.1:${port}`, cookie: "", child: null };
  const loginFile = `/tmp/changes-filters-${name}-${process.pid}-${port}`;
  s.child = spawn(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: WEB_DB, LOCAL_USER_ID: user, LOGIN_FILE: loginFile, HOST: "127.0.0.1", PORT: String(port), PUBLIC_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(s);
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${s.origin}/healthz`).then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await fetch(readFileSync(loginFile, "utf8").trim(), { redirect: "manual" });
  s.cookie = r.headers.get("set-cookie").split(";")[0];
  return s;
}

const get = (s, path) => fetch(s.origin + path, { headers: { cookie: s.cookie }, redirect: "manual" });
const page = async (s, path) => (await get(s, path)).text();
const url = (v, show) => `/v/${v}/changes${show ? `?show=${show}` : ""}`;
const text = (h) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const lines = (h) => [...h.matchAll(/<li class="change"><span class="change-what">([\s\S]*?)<\/span><span class="change-when">/g)].map((m) => text(m[1]));
const wrote = (h) => lines(h).map((l) => /wrote (\S+)$/.exec(l)?.[1]).filter(Boolean);

before(async () => {
  await sql(
    `insert into auth.users (id, email) values ($1, 'kai@example.test'), ($2, 'lia@example.test'), ($3, 'max@example.test') on conflict (id) do nothing`,
    [KAI, LIA, MAX],
  );
  kai = await start(KAI, "kai");
  max = await start(MAX, "max");

  [{ id: V.main }] = await as(KAI, "select public.create_vault('Filters main', 'open') as id");
  await sql("select test_support.add_member($1, $2, 'editor', $3)", [V.main, LIA, KAI]);
  await sql("select test_support.add_member($1, $2, 'viewer', $3)", [V.main, MAX, KAI]);

  // Another vault Kai watches in, with a path that exists in the first too: it must not carry over.
  [{ id: V.other }] = await as(KAI, "select public.create_vault('Filters other', 'open') as id");
  await as(KAI, "select public.create_subscription($1, 'path', 'x/')", [V.other]);

  // Watches first: flags, and so the rule they apply, count only what happens after.
  await as(KAI, "select public.create_subscription($1, 'path', 'clients/')", [V.main]);
  await as(KAI, "select public.create_subscription($1, 'path', 'notes/plan.md')", [V.main]);
  await as(MAX, "select public.create_subscription($1, 'path', 'notes/')", [V.main]);
  await as(LIA, "select public.create_subscription($1, 'path', 'private/')", [V.main]);

  await as(KAI, "select public.write_file($1, 'canon/rules.md', 'Rules v1')", [V.main]);
  await as(KAI, "select public.set_policy($1, 'canon/rules.md', 'canon', 1)", [V.main]);
  // Lia's writes, on paths a watch on clients/ or notes/plan.md does and does not cover.
  for (const p of ["clients/a.md", "clients/deep/b.md", "clients-old/c.md", "clients", "notes/plan.md", "notes/plan.md.bak", "notes/other.md", "private/x.md", "x/y.md"]) {
    await as(LIA, "select public.write_file($1, $2, 'x')", [V.main, p]);
  }
  await as(KAI, "select public.write_file($1, 'mine/k1.md', 'x')", [V.main]);
  await as(KAI, "select public.write_file($1, 'mine/k2.md', 'x')", [V.main], "Hermes on Linux");
  await as(LIA, "select public.write_file($1, 'mine/l1.md', 'x')", [V.main], "Cursor");
  [{ id: V.proposal }] = await as(LIA, "select public.propose($1, 'canon/rules.md', 'Rules v2', 'tighten') as id", [V.main]);
  await as(KAI, "select public.decide($1, 'approve')", [V.proposal]); // Kai decides; the write that applies it is Lia's

  // A vault Kai watches nothing in, and one he watches something that never changes.
  [{ id: V.nowatch }] = await as(KAI, "select public.create_vault('Filters nowatch', 'open') as id");
  await as(KAI, "select public.write_file($1, 'a.md', 'x')", [V.nowatch]);
  [{ id: V.quiet }] = await as(KAI, "select public.create_vault('Filters quiet', 'open') as id");
  await as(KAI, "select public.write_file($1, 'a.md', 'x')", [V.quiet]);
  await as(KAI, "select public.create_subscription($1, 'path', 'zzz/')", [V.quiet]);

  // A change made before the watch began: the view shows it, flags (which count from the watch) do not.
  [{ id: V.early }] = await as(KAI, "select public.create_vault('Filters early', 'open') as id");
  await as(KAI, "select public.write_file($1, 'hist/h.md', 'x')", [V.early]);
  await as(KAI, "select public.create_subscription($1, 'path', 'hist/')", [V.early]);

  // Paging keeps the view: 33 files, then one written 5 times, all Kai's.
  [{ id: V.long }] = await as(KAI, "select public.create_vault('Filters long', 'open') as id");
  for (let i = 1; i <= 33; i++) await as(KAI, "select public.write_file($1, $2, 'x')", [V.long, `f${String(i).padStart(2, "0")}.md`]);
});

after(async () => {
  for (const s of servers) s.child?.kill();
});

// ---------------------------------------------------------------------------
// The chips

test("changes views: Everyone, Mine and Watching are links, the current one marked, and anything else is Everyone", async () => {
  const chips = (v, show) =>
    `<ul class="chips" aria-label="Show changes by">` +
    [["everyone", "Everyone", url(v)], ["mine", "Mine", url(v, "mine")], ["watching", "Watching", url(v, "watching")]]
      .map(([k, label, href]) => `<li><a class="chip" href="${href}"${k === show ? ' aria-current="true"' : ""}>${label}</a></li>`)
      .join("") +
    `</ul>`;
  assert.ok((await page(kai, url(V.main))).includes(chips(V.main, "everyone")));
  assert.ok((await page(kai, url(V.main, "mine"))).includes(chips(V.main, "mine")));
  assert.ok((await page(kai, url(V.main, "watching"))).includes(chips(V.main, "watching")));
  for (const odd of ["bogus", "MINE", "", "mine,watching"]) {
    assert.ok((await page(kai, url(V.main, encodeURIComponent(odd)))).includes(chips(V.main, "everyone")), odd);
  }
});

// ---------------------------------------------------------------------------
// Mine

test("changes views: Mine is what you did and what your agents did for you, not what others did or what applied your proposal", async () => {
  const mine = lines(await page(kai, url(V.main, "mine")));
  assert.deepEqual(mine, [
    "You approved the proposal on canon/rules.md",
    "Your agent Hermes on Linux wrote mine/k2.md",
    "You wrote mine/k1.md",
    "You wrote canon/rules.md",
  ]);
  // Everyone has Lia's lines as well, and the write that applied her proposal (hers, not Kai's).
  const everyone = lines(await page(kai, url(V.main)));
  assert.ok(everyone.includes("lia@example.test wrote canon/rules.md, from an approved proposal"));
  assert.ok(everyone.includes("lia@example.test’s agent Cursor wrote mine/l1.md"));
  assert.ok(!mine.some((l) => l.includes("lia@example.test")));
  // Max made no change: he is told so.
  const none = await page(max, url(V.main, "mine"));
  assert.equal(lines(none).length, 0);
  assert.match(none, /<strong>You haven’t changed anything here yet<\/strong>/);
});

// ---------------------------------------------------------------------------
// Watching

test("changes views: Watching is the changes on your watches: a folder covers what is under it, a file only itself", async () => {
  // Kai watches clients/ and notes/plan.md. Not clients-old/, not "clients", not notes/plan.md.bak.
  assert.deepEqual(wrote(await page(kai, url(V.main, "watching"))), ["notes/plan.md", "clients/deep/b.md", "clients/a.md"]);
});

test("changes views: only your own watches count, and only in this vault", async () => {
  // Max watches notes/, Lia private/, Kai x/ in another vault: each sees their own.
  assert.deepEqual(wrote(await page(max, url(V.main, "watching"))), ["notes/other.md", "notes/plan.md.bak", "notes/plan.md"]);
  const kaiSees = wrote(await page(kai, url(V.main, "watching")));
  assert.ok(!kaiSees.includes("private/x.md"), "Lia's watch is not Kai's");
  assert.ok(!kaiSees.includes("x/y.md"), "a watch on x/ in another vault does not reach this one");
  assert.ok(!kaiSees.includes("notes/other.md"), "Max's watch is not Kai's");
});

test("changes views: Watching agrees with public.list_flags on which paths a watch covers", async () => {
  const flagged = (await as(KAI, "select public.list_flags($1, 200) as r", [V.main]))[0].r.flags
    .filter((f) => f.category === "subscription")
    .map((f) => f.path)
    .sort();
  assert.deepEqual(flagged, ["clients/a.md", "clients/deep/b.md", "notes/plan.md"], "the rule list_flags applies, on these writes");
  assert.deepEqual(wrote(await page(kai, url(V.main, "watching"))).sort(), flagged);
  const maxFlagged = (await as(MAX, "select public.list_flags($1, 200) as r", [V.main]))[0].r.flags
    .filter((f) => f.category === "subscription")
    .map((f) => f.path)
    .sort();
  assert.deepEqual(wrote(await page(max, url(V.main, "watching"))).sort(), maxFlagged);
});

test("changes views: Watching includes changes from before the watch began, which flags do not", async () => {
  assert.deepEqual(wrote(await page(kai, url(V.early, "watching"))), ["hist/h.md"]);
  const flagged = (await as(KAI, "select public.list_flags($1, 200) as r", [V.early]))[0].r.flags.filter((f) => f.category === "subscription");
  assert.deepEqual(flagged, [], "list_flags counts only what happened after the watch");
});

test("changes views: Watching says when you watch nothing here, and when what you watch has not changed", async () => {
  const none = await page(kai, url(V.nowatch, "watching"));
  assert.match(none, /<strong>You don’t watch anything here<\/strong>/);
  assert.match(none, new RegExp(`<a class="button" href="/v/${V.nowatch}/config/watching">Watch a path</a>`));
  const quiet = await page(kai, url(V.quiet, "watching"));
  assert.match(quiet, /<strong>Nothing has changed on what you watch<\/strong>/);
  assert.equal(lines(quiet).length, 0);
});

// ---------------------------------------------------------------------------
// Paging and reading

test("changes views: Older and Newest keep the view", async () => {
  const first = await page(kai, url(V.long, "mine"));
  assert.equal(lines(first).length, 30);
  const older = /<a class="older" href="([^"]+)">Older<\/a>/.exec(first)[1].replaceAll("&amp;", "&");
  assert.match(older, new RegExp(`^/v/${V.long}/changes\\?show=mine&before=\\d+$`));
  const second = await page(kai, older);
  assert.equal(lines(second).length, 3);
  assert.match(second, new RegExp(`<a href="/v/${V.long}/changes\\?show=mine">Newest</a>`));
  const past = await page(kai, `${url(V.long, "mine")}&before=1`);
  assert.match(past, new RegExp(`<a class="button" href="/v/${V.long}/changes\\?show=mine">Back to the newest</a>`));
});

test("changes views: opening any view marks no flag shown, for the reader or anyone", async () => {
  const waiting = async (user, v) => (await as(user, "select public.list_flags($1, 200) as r", [v]))[0].r.flags.length;
  const before = [await waiting(KAI, V.main), await waiting(MAX, V.main), await waiting(LIA, V.main)];
  assert.ok(before[0] > 0 && before[1] > 0, "Kai and Max have flags waiting");
  for (const show of [undefined, "mine", "watching", "bogus"]) {
    for (const s of [kai, max]) assert.equal((await get(s, url(V.main, show))).status, 200);
  }
  assert.deepEqual([await waiting(KAI, V.main), await waiting(MAX, V.main), await waiting(LIA, V.main)], before);
});

test("changes views: a vault you are not in is 404 in every view", async () => {
  for (const show of [undefined, "mine", "watching"]) assert.equal((await get(max, url(V.other, show))).status, 404);
});
