// Limits and caching in the web app, signed in as Ana (owner of Team): text
// over the database's ceilings and paths with control characters come back
// as a message, not an error page, and never echoed; the theme switch only
// returns to a local page; the versioned stylesheet is cached for good.
// Uses its own paths. Seed: test/seed.sql.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { TEAM_VAULT, LOGIN_FILE } = process.env;
const V = `/v/${TEAM_VAULT}`;
let cookie = "";

const get = (path) => fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
const page = async (path) => (await get(path)).text();
const post = (path, fields) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: BASE },
    body: new URLSearchParams(fields).toString(),
  });
const csrf = async (path) => /name="csrf" value="([0-9a-f]+)"/.exec(await page(path))[1];

before(async () => {
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

test("limits: file text over 1 MB is refused with a message, not an error page", async () => {
  const token = await csrf(`${V}/new`);
  const r = await post(`${V}/file`, { csrf: token, action: "write", path: "notes/huge.md", content: "x".repeat(1048577) });
  assert.equal(r.status, 303);
  const next = await page(r.headers.get("location"));
  assert.match(next, /too long \(text up to 1 MB/);
  assert.equal((await get(`${V}/file?path=notes%2Fhuge.md`)).status, 404);
});

test("limits: a path with a newline is refused, and the message doesn't echo it", async () => {
  const token = await csrf(`${V}/new`);
  const r = await post(`${V}/file`, { csrf: token, action: "write", path: "notes/ECHOMARKER\nx.md", content: "x" });
  assert.equal(r.status, 303);
  const next = await page(r.headers.get("location"));
  assert.match(next, /Invalid path/);
  assert.doesNotMatch(next.replace(/value="[^"]*"/g, ""), /ECHOMARKER\s*x\.md/);
});

test("theme: a back link to another site (/\\host) goes home instead", async () => {
  for (const back of ["/\\evil.example", "//evil.example", "https://evil.example/", "/\tevil"]) {
    const r = await post("/theme", { csrf: await csrf("/"), theme: "dark", back });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/", back);
  }
  const r = await post("/theme", { csrf: await csrf("/"), theme: "auto", back: "/review" });
  assert.equal(r.headers.get("location"), "/review");
});

test("assets: the versioned stylesheet is cached for a year; an unversioned one for minutes", async () => {
  const href = /href="(\/style\.css\?v=[0-9a-f]+)"/.exec(await page("/"))[1];
  assert.equal((await fetch(BASE + href)).headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal((await fetch(BASE + "/style.css?v=stale")).headers.get("cache-control"), "public, max-age=300");
  assert.equal(
    (await fetch(BASE + "/fonts/inter-latin-opsz-normal.woff2")).headers.get("cache-control"),
    "public, max-age=31536000, immutable",
  );
});
