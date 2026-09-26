// The public site and the app on two hosts (web/src/hosts.ts): web/test.sh
// starts one AUTH_MODE=supabase instance with PUBLIC_URL (the app) and
// SITE_URL (the site). Both names reach the same loopback port; the server
// tells them apart by the Host header, as on Vercel (where Host is the domain
// the client asked for). Signs Ana in against the fake Supabase Auth.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import http from "node:http";
import { before, test } from "node:test";

const { WEB_SPLIT_URL: BASE, WEB_SPLIT_APP_URL: APP, WEB_SPLIT_SITE_URL: SITE, FAKE_AUTH_URL: FAKE, AUTH_SECRETS_FILE } = process.env;
const APP_HOST = APP ? new URL(APP).host : "";
const SITE_HOST = SITE ? new URL(SITE).host : "";
const remember = (...s) => appendFileSync(AUTH_SECRETS_FILE, s.filter(Boolean).map((x) => `${x}\n`).join(""));

// One request with a chosen Host header (fetch can't set Host). `path` is
// sent as written, so crafted paths reach the server unchanged.
function request(host, path, { method = "GET", headers = {}, body } = {}) {
  const u = new URL(BASE);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: u.port, path, method, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
const site = (path, o) => request(SITE_HOST, path, o);
const app = (path, o) => request(APP_HOST, path, o);
const setCookies = (r) => r.headers["set-cookie"] ?? [];

// A browser's cookies for the app host.
class Jar {
  c = new Map();
  take(r) {
    for (const sc of setCookies(r)) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      const [k, v] = [pair.slice(0, i), pair.slice(i + 1)];
      if (/Max-Age=0(;|$)/.test(sc)) this.c.delete(k);
      else this.c.set(k, v);
      if (k.endsWith("rlq_rt") && v) remember(v);
    }
    return r;
  }
  get header() {
    return [...this.c].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)?.[1];
const form = (fields) => new URLSearchParams(fields).toString();
const FORM = "application/x-www-form-urlencoded";

let ana; // Ana's jar, signed in on the app host
let signinCookies = [];

async function signIn(email) {
  const jar = new Jar();
  const page = jar.take(await app("/signin", { headers: { cookie: jar.header } }));
  const asked = jar.take(
    await app("/signin", {
      method: "POST",
      headers: { cookie: jar.header, origin: new URL(APP).origin, "content-type": FORM },
      body: form({ csrf: csrfOf(page.body), email, next: "/" }),
    }),
  );
  assert.equal(asked.status, 200);
  const m = await (await fetch(`${FAKE}/_last_email?email=${encodeURIComponent(email)}`)).json();
  remember(m.code, m.token_hash);
  const done = jar.take(
    await app("/signin/code", {
      method: "POST",
      headers: { cookie: jar.header, origin: new URL(APP).origin, "content-type": FORM },
      body: form({ csrf: csrfOf(asked.body), email, code: m.code, next: "/" }),
    }),
  );
  assert.equal(done.status, 303);
  return { jar, cookies: setCookies(done) };
}

before(async () => {
  assert.ok(BASE && APP && SITE && FAKE && AUTH_SECRETS_FILE, "run through web/test.sh (the split instance)");
  appendFileSync(AUTH_SECRETS_FILE, "");
  const s = await signIn("ana@example.test");
  ana = s.jar;
  signinCookies = s.cookies;
});

// The site host ---------------------------------------------------------------

test("split site: / on the site host is the landing page, signed out or not", async () => {
  for (const cookie of [undefined, "__Host-rlq_at=x; __Host-rlq_rt=y"]) {
    const r = await site("/", { headers: cookie ? { cookie } : {} });
    assert.equal(r.status, 200);
    assert.match(r.body, /id="hero-title"/);
    assert.doesNotMatch(r.body, /<nav class="app-nav" aria-label="Main">/);
  }
});

test("split site: the site host sets no cookie, on any path", async () => {
  const paths = ["/", "/docs", "/docs/index.md", "/terms", "/roadmap", "/robots.txt", "/sitemap.xml", "/llms.txt",
    "/.well-known/security.txt", "/style.css", "/review", "/signin", "/nope"];
  for (const p of paths) {
    for (const cookie of [undefined, ana.header]) {
      const r = await site(p, { headers: cookie ? { cookie } : {} });
      assert.deepEqual(setCookies(r), [], `${p} set a cookie`);
    }
  }
  const post = await site("/signin", { method: "POST", headers: { "content-type": FORM, origin: SITE }, body: "email=a" });
  assert.deepEqual(setCookies(post), []);
});

test("split site: app paths on the site host are a 308 to the app host, path and query kept", async () => {
  const paths = ["/review?x=1&y=a%20b", "/signin?next=%2Freview", "/v/abc/file?path=notes%2Fa.md",
    "/.well-known/oauth-authorization-server", "/oauth/authorize?client_id=https%3A%2F%2Fc.example%2Fm.json&state=s",
    "/cli/oauth-client.json", "/api/env/vaults", "/version", "/healthz", "/tokens"];
  for (const p of paths) {
    const r = await site(p);
    assert.equal(r.status, 308, p);
    assert.equal(r.headers.location, APP + p, p);
  }
  const post = await site("/oauth/token", { method: "POST", headers: { "content-type": FORM }, body: "grant_type=x" });
  assert.equal(post.status, 308);
  assert.equal(post.headers.location, `${APP}/oauth/token`);
});

test("split site: a POST to a public path on the site host is refused, not served", async () => {
  const r = await site("/terms", { method: "POST", headers: { "content-type": FORM }, body: "a=b" });
  assert.equal(r.status, 405);
  assert.doesNotMatch(r.body, /<html/);
});

// The app host ----------------------------------------------------------------

test("split app: public paths on the app host are a 308 to the site host, path and query kept", async () => {
  const paths = ["/docs", "/docs/concepts/agents?x=1&y=a%20b", "/docs/concepts/agents.md", "/terms", "/privacy", "/dpa",
    "/subprocessors", "/security", "/roadmap", "/roadmap.md", "/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt",
    "/.well-known/security.txt"];
  for (const p of paths) {
    const r = await app(p, { headers: { cookie: ana.header } });
    assert.equal(r.status, 308, p);
    assert.equal(r.headers.location, SITE + p, p);
  }
});

test("split app: / on the app host is sign-in signed out, and Home signed in", async () => {
  const out = await app("/");
  assert.equal(out.status, 303);
  assert.equal(out.headers.location, "/signin");
  assert.doesNotMatch(out.body, /hero-title/);
  const home = await app("/", { headers: { cookie: ana.header } });
  assert.equal(home.status, 200);
  assert.match(home.body, /<nav class="app-nav" aria-label="Main">/);
});

test("split app: the OAuth metadata's issuer and endpoints, and the CLI's client, are the app origin", async () => {
  const r = await app("/.well-known/oauth-authorization-server");
  assert.equal(r.status, 200);
  const m = JSON.parse(r.body);
  assert.equal(m.issuer, APP);
  for (const k of ["authorization_endpoint", "token_endpoint", "revocation_endpoint"]) assert.ok(m[k].startsWith(`${APP}/`), k);
  const c = JSON.parse((await app("/cli/oauth-client.json")).body);
  assert.equal(c.client_id, `${APP}/cli/oauth-client.json`);
});

test("split app: sign-in cookies are __Host-, Secure, host-only on the app host", () => {
  const auth = signinCookies.filter((c) => /rlq_(at|rt)=/.test(c));
  assert.equal(auth.length, 2);
  for (const c of auth) {
    assert.match(c, /^__Host-rlq_(at|rt)=/);
    assert.match(c, /; Secure(;|$)/);
    assert.doesNotMatch(c, /Domain=/i);
  }
});

test("split app: a POST on the app host needs the app's Origin; the site's is refused", async () => {
  const csrf = csrfOf((await app("/", { headers: { cookie: ana.header } })).body);
  const post = (origin) =>
    app("/theme", { method: "POST", headers: { cookie: ana.header, origin, "content-type": FORM }, body: form({ csrf, theme: "dark", back: "/" }) });
  assert.equal((await post(SITE)).status, 403);
  assert.equal((await post(APP)).status, 303);
});

test("split app: every app-host answer says noindex; the site host's pages don't", async () => {
  for (const p of ["/", "/signin", "/docs", "/.well-known/oauth-authorization-server", "/version", "/style.css"]) {
    const r = await app(p);
    assert.equal(r.headers["x-robots-tag"], "noindex", p);
  }
  const home = await app("/", { headers: { cookie: ana.header } });
  assert.match(home.body, /<meta name="robots" content="noindex">/);
  for (const p of ["/", "/docs", "/terms", "/robots.txt"]) {
    const r = await site(p);
    assert.equal(r.headers["x-robots-tag"], undefined, p);
    assert.doesNotMatch(r.body, /noindex/, p);
  }
});

// Both ------------------------------------------------------------------------

test("split both: static files are served on both hosts", async () => {
  for (const p of ["/style.css", "/favicon.svg", "/og.png"]) {
    for (const [name, go] of [["site", site], ["app", app]]) {
      const r = await go(p);
      assert.equal(r.status, 200, `${name} ${p}`);
      assert.equal(r.headers.location, undefined);
    }
  }
});

test("split both: docs, the roadmap and llms.txt answer only on the site host", async () => {
  const d = await site("/docs");
  assert.equal(d.status, 200);
  assert.match(d.headers["content-type"], /text\/html/);
  const md = await site("/docs/concepts/agents.md");
  assert.equal(md.status, 200);
  assert.match(md.headers["content-type"], /text\/markdown/);
  assert.equal((await site("/roadmap")).status, 200);
  const llms = await site("/llms.txt");
  assert.equal(llms.status, 200);
  assert.match(llms.body, new RegExp(`\\(${SITE.replaceAll(".", "\\.")}/docs/`));
  for (const p of ["/docs", "/docs/concepts/agents.md", "/roadmap", "/llms.txt"]) assert.equal((await app(p)).status, 308, p);
});

test("split both: canonical, Open Graph, sitemap, robots and security.txt use SITE_URL", async () => {
  const landing = (await site("/")).body;
  assert.match(landing, new RegExp(`<link rel="canonical" href="${SITE}/">`));
  assert.match(landing, new RegExp(`<meta property="og:url" content="${SITE}/">`));
  assert.match(landing, new RegExp(`<meta property="og:image" content="${SITE}/og.png">`));
  const doc = (await site("/docs/concepts/agents")).body;
  assert.match(doc, new RegExp(`<link rel="canonical" href="${SITE}/docs/concepts/agents">`));
  const map = (await site("/sitemap.xml")).body;
  assert.match(map, new RegExp(`<loc>${SITE}/</loc>`));
  assert.match(map, new RegExp(`<loc>${SITE}/docs</loc>`));
  assert.doesNotMatch(map, new RegExp(APP));
  assert.match((await site("/robots.txt")).body, new RegExp(`^Sitemap: ${SITE}/sitemap\\.xml$`, "m"));
  assert.match((await site("/.well-known/security.txt")).body, new RegExp(`^Canonical: ${SITE}/\\.well-known/security\\.txt$`, "m"));
});

test("split both: the site's Sign in goes to the app host; the app's docs, roadmap and legal links go to the site host", async () => {
  const landing = (await site("/")).body;
  assert.match(landing, new RegExp(`<a class="button site-signin" href="${APP}/signin">`));
  assert.match(landing, new RegExp(`<a class="button" href="${APP}/signin">Sign in</a>`));
  assert.match(landing, /<a href="\/docs">Docs<\/a>/);
  const home = (await app("/", { headers: { cookie: ana.header } })).body;
  assert.match(home, new RegExp(`<p class="menu-links"><a href="${SITE}/docs">Docs</a><a href="${SITE}/roadmap">Roadmap</a></p>`));
  assert.match(home, new RegExp(`<a class="stage" href="${SITE}/roadmap"`));
  const signin = (await app("/signin")).body;
  for (const p of ["/terms", "/privacy", "/dpa", "/subprocessors", "/security"]) {
    assert.match(signin, new RegExp(`<a href="${SITE}${p}">`), p);
    assert.match(home, new RegExp(`<a href="${SITE}${p}">`), p);
  }
});

test("split both: a redirect never leaves the two configured origins", async () => {
  const crafted = ["//evil.example/x", "///evil.example/x", "/\\evil.example/x", "/%2F%2Fevil.example/x", "//evil.example",
    "/..//evil.example", "/x?next=https://evil.example"];
  for (const p of crafted) {
    for (const [go, to] of [[site, APP], [app, SITE]]) {
      const r = await go(p);
      if (r.status !== 308) continue;
      const loc = new URL(r.headers.location);
      assert.equal(loc.origin, to, `${p} -> ${r.headers.location}`);
      assert.ok(!loc.pathname.startsWith("//"), `${p} -> ${r.headers.location}`);
    }
  }
  // A Host that is neither is served as the app: its redirects still go to SITE_URL.
  const other = await request("evil.example", "/docs");
  assert.equal(other.status, 308);
  assert.equal(other.headers.location, `${SITE}/docs`);
});

// Configuration ---------------------------------------------------------------

test("split config: a bad SITE_URL refuses to start, naming the variable and never the value", () => {
  const base = {
    PATH: process.env.PATH,
    PORT: "1",
    DATABASE_URL: "postgres://nobody:x@127.0.0.1:9/none",
    LOCAL_USER_ID: "00000000-0000-0000-0000-00000000000a",
    LOGIN_FILE: "/tmp/.login-split-refuse-test",
    PUBLIC_URL: "https://app.example.test",
  };
  const cases = [
    [{ SITE_URL: "ftp://secret-site.example" }, /SITE_URL must be an http\(s\) origin/],
    [{ SITE_URL: "not a url secret-site" }, /SITE_URL must be an http\(s\) origin/],
    [{ SITE_URL: "https://secret-site.example/docs" }, /SITE_URL must be a bare origin/],
    [{ SITE_URL: "https://secret-site.example/?a=1" }, /SITE_URL must be a bare origin/],
    [{ SITE_URL: "https://secret-site.example", PUBLIC_URL: undefined }, /PUBLIC_URL/],
    [{ SITE_URL: "http://secret-site.example", VERCEL: "1", DATABASE_CA_FILE: "supabase-ca.crt" }, /on Vercel, SITE_URL must be https/],
  ];
  for (const [env, msg] of cases) {
    const e = { ...base, ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    const r = spawnSync(process.execPath, ["dist/server.js"], { env: e, encoding: "utf8", timeout: 15_000 });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, msg);
    assert.doesNotMatch(r.stderr, /secret-site/);
  }
});
