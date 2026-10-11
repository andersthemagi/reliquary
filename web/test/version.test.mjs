// The release a build is (web/stamp-version.mjs at build time, web/src/version.ts):
// GET /version, the version in both footers, and the build stamp itself.
// Production's deploy compares /version with the tag it deployed
// (scripts/deploy-check.sh), so "live" always names a release. Seeds nothing.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const { LOGIN_FILE, EXPECT_VERSION } = process.env;
const PKG_VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;

let cookie = "";
before(async () => {
  assert.ok(EXPECT_VERSION, "run through web/test.sh (EXPECT_VERSION from version.txt)");
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

// Runs the build stamp with its paths in a scratch directory.
function stamp(env) {
  const dir = mkdtempSync(join(tmpdir(), "stamp-"));
  const out = join(dir, "version.json");
  const r = spawnSync(process.execPath, ["stamp-version.mjs"], {
    env: { PATH: process.env.PATH, VERSION_FILE: join(dir, "none.txt"), VERSION_OUT: out, ...env(dir) },
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr, json: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null };
}

test("version: GET /version answers the release in version.txt and the build's commit, as uncached JSON", async () => {
  const r = await fetch(`${BASE}/version`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^application\/json/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json();
  assert.equal(body.version, EXPECT_VERSION);
  assert.match(body.commit, /^([0-9a-f]{7,40}|unknown)$/);
});

test("version: /version has exactly version and commit, and needs no sign-in", async () => {
  const body = await (await fetch(`${BASE}/version`, { redirect: "manual" })).json();
  assert.deepEqual(Object.keys(body).sort(), ["commit", "version"]);
});

test("version: /healthz is unchanged (plain ok), since uptime depends on it", async () => {
  const r = await fetch(`${BASE}/healthz`);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "ok");
});

test("version: the app footer shows v<version> linking to /docs/changelog", async () => {
  const page = await (await fetch(`${BASE}/`, { headers: { cookie } })).text();
  const footer = /<footer>[\s\S]*<\/footer>/.exec(page)?.[0] ?? "";
  assert.ok(footer.includes(`<a class="footer-version" href="/docs/changelog">v${EXPECT_VERSION}</a>`), footer);
});

test("version: the public site's footer shows it too", async () => {
  const page = await (await fetch(`${BASE}/terms`)).text();
  const footer = /<footer class="site-footer">[\s\S]*<\/footer>/.exec(page)?.[0] ?? "";
  assert.ok(footer.includes(`href="/docs/changelog">v${EXPECT_VERSION}</a>`), footer);
});

test("version: the build stamp fails when version.txt and package.json disagree, and writes nothing", () => {
  const r = stamp((dir) => {
    writeFileSync(join(dir, "v.txt"), "9.9.9\n");
    return { VERSION_FILE: join(dir, "v.txt") };
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /version\.txt says 9\.9\.9 but package\.json says/);
  assert.equal(r.json, null);
});

test("version: without version.txt the build stamp takes package.json's version", () => {
  const r = stamp(() => ({}));
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json, { version: PKG_VERSION, commit: "unknown" });
});

test("version: the build stamp takes the commit from COMMIT_REF, and anything but hex is unknown", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(stamp(() => ({ COMMIT_REF: sha })).json.commit, sha);
  assert.equal(stamp(() => ({ GITHUB_SHA: sha })).json.commit, sha);
  assert.equal(stamp(() => ({ COMMIT_REF: "main; rm -rf /" })).json.commit, "unknown");
  assert.equal(stamp(() => ({ COMMIT_REF: "<script>" })).json.commit, "unknown");
});
