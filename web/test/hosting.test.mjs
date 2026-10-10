// The web server as hosted (docs/research/hosting.md, chunk A): a second
// instance that web/test.sh starts with PUBLIC_URL=https://... and without
// public/ (on Netlify the CDN serves it). It is reached over plain http on
// loopback, so the Origin it expects is PUBLIC_URL, not the address used.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

const { WEB_HOSTED_URL: BASE, WEB_HOSTED_PUBLIC_URL: PUBLIC_URL, HOSTED_LOGIN_FILE } = process.env;
let cookie = "";
let loginSetCookie = "";

const get = (path) => fetch(BASE + path, { headers: { cookie }, redirect: "manual" });
const post = (path, fields, headers = {}) =>
  fetch(BASE + path, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const csrf = async () => /name="csrf" value="([0-9a-f]+)"/.exec(await (await get("/")).text())[1];
const setTheme = async (headers) => post("/theme", { csrf: await csrf(), theme: "dark", back: "/" }, headers);

before(async () => {
  assert.ok(BASE && PUBLIC_URL && HOSTED_LOGIN_FILE, "run through web/test.sh (hosted instance env)");
  assert.match(PUBLIC_URL, /^https:\/\//);
  const r = await fetch(readFileSync(HOSTED_LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  assert.equal(r.status, 303);
  loginSetCookie = r.headers.get("set-cookie");
  cookie = loginSetCookie.split(";")[0];
});

test("hosted: the session cookie is __Host- prefixed, Secure, HttpOnly, Path=/ and has no Domain", () => {
  assert.match(loginSetCookie, /^__Host-rlq_session=[0-9a-f]{64};/);
  assert.match(loginSetCookie, /; Secure(;|$)/);
  assert.match(loginSetCookie, /HttpOnly/);
  assert.match(loginSetCookie, /SameSite=Strict/);
  assert.match(loginSetCookie, /Path=\//);
  assert.doesNotMatch(loginSetCookie, /Domain=/i);
});

test("hosted: the session is read from the __Host- cookie only", async () => {
  const sid = cookie.split("=")[1];
  const plain = await fetch(BASE + "/", { headers: { cookie: `rlq_session=${sid}` }, redirect: "manual" });
  assert.equal(plain.status, 401);
  assert.equal((await get("/")).status, 200);
});

test("hosted: a POST whose Origin is PUBLIC_URL passes", async () => {
  const r = await setTheme({ origin: new URL(PUBLIC_URL).origin });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/");
});

test("hosted: the theme cookie is __Host- prefixed and Secure too", async () => {
  const r = await setTheme({ origin: new URL(PUBLIC_URL).origin });
  const c = r.headers.get("set-cookie");
  assert.match(c, /^__Host-rlq_theme=dark;/);
  assert.match(c, /; Secure(;|$)/);
  assert.match(c, /Path=\//);
  assert.doesNotMatch(c, /Domain=/i);
});

test("hosted: any other Origin gets 403, including the address the server was reached on", async () => {
  const others = [
    new URL(BASE).origin, // http://127.0.0.1:<port>: what the local rule would accept
    new URL(PUBLIC_URL).origin.replace("https://", "http://"),
    `${new URL(PUBLIC_URL).origin}:8443`,
    "https://evil.example",
    "null",
  ];
  for (const origin of others) {
    const r = await setTheme({ origin });
    assert.equal(r.status, 403, `origin ${origin}`);
    assert.equal(r.headers.get("set-cookie"), null, `origin ${origin} set a cookie`);
  }
});

test("hosted: a POST with no Origin gets 403", async () => {
  const r = await setTheme({});
  assert.equal(r.status, 403);
});

test("hosted: starts without public/ and still renders pages with a versioned stylesheet link", async () => {
  assert.equal((await fetch(BASE + "/healthz")).status, 200);
  assert.match(await (await get("/")).text(), /<link rel="stylesheet" href="\/style\.css\?v=[0-9a-f]{10}">/);
  // Static files are the CDN's job here: the function doesn't serve them.
  for (const path of ["/style.css", "/favicon.svg", "/fonts/inter-latin-opsz-normal.woff2"]) {
    const r = await get(path);
    assert.notEqual(r.status, 200, path);
    assert.doesNotMatch(r.headers.get("content-type") ?? "", /css|svg|woff2/, path);
  }
});
