// The content key set (F1000): CONTENT_KEYS, the sealed body envelope and
// what the web app refuses at startup. Pure module tests plus one server
// start; no database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { before, test } from "node:test";

const KEY = randomBytes(32).toString("base64url");
const KEY2 = randomBytes(32).toString("base64url");
const VAULT = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";
let content; // dist/content.js
let secrets; // dist/secrets.js

before(async () => {
  content = await import("../dist/content.js");
  secrets = await import("../dist/secrets.js");
  content.configureContent({ CONTENT_KEYS: `c2:${KEY2},c1:${KEY}` });
});

test("content: a body round-trips, sealed under the current key with a fresh nonce each time", () => {
  const a = content.sealBody("héllo\nworld", VAULT);
  const b = content.sealBody("héllo\nworld", VAULT);
  assert.equal(a[0], 0);
  assert.equal(a.subarray(2, 2 + a[1]).toString(), "c2");
  assert.notDeepEqual(a, b);
  assert.equal(content.isSealed(a), true);
  assert.equal(content.openBody(a, VAULT), "héllo\nworld");
  assert.equal(content.openBody(content.sealBody("", VAULT), VAULT), "");
  assert.equal(a.toString("latin1").includes("héllo"), false);
});

test("content: a body sealed for one vault fails to open under another, naming nothing", () => {
  const sealed = content.sealBody("secret-text-MARK", VAULT);
  try {
    content.openBody(sealed, OTHER);
    assert.fail("expected a refusal");
  } catch (err) {
    assert.ok(err instanceof content.ContentError);
    assert.equal(String(err.stack).includes("MARK"), false);
    assert.equal(String(err.stack).includes(KEY2), false);
  }
});

test("content: an altered body, an unknown key id or a truncated envelope fails to open", () => {
  const sealed = content.sealBody("text", VAULT);
  const flipped = Buffer.from(sealed);
  flipped[flipped.length - 1] ^= 1;
  const unknown = Buffer.concat([Buffer.from([0, 2]), Buffer.from("zz"), sealed.subarray(4)]);
  for (const bad of [flipped, unknown, sealed.subarray(0, 10)]) {
    assert.throws(() => content.openBody(bad, VAULT), content.ContentError);
  }
});

test("content: a plaintext body (no NUL marker) opens as it is, until the backfill is done", () => {
  assert.equal(content.openBody(Buffer.from("# Plain\n", "utf8"), VAULT), "# Plain\n");
  assert.equal(content.isSealed(Buffer.from("# Plain\n", "utf8")), false);
});

test("content: a body over 1 MiB is refused", () => {
  assert.throws(() => content.sealBody("x".repeat(1024 * 1024 + 1), VAULT), /1 MiB/);
});

test("content: CONTENT_KEYS is id:key pairs; a malformed one is refused without printing it", () => {
  for (const bad of ["short", `c1:${randomBytes(31).toString("base64url")}`, `c1:${KEY},c1:${KEY2}`, `c1:${KEY},c2:${KEY}`, `bad id:${KEY}`]) {
    try {
      content.configureContent({ CONTENT_KEYS: bad });
      assert.fail("expected a refusal");
    } catch (err) {
      assert.match(err.message, /CONTENT_KEYS/);
      assert.equal(String(err.stack).includes(KEY), false);
      assert.equal(String(err.stack).includes(KEY2), false);
    }
  }
  content.configureContent({ CONTENT_KEYS: `c2:${KEY2},c1:${KEY}` });
  assert.deepEqual(content.contentKeyIds(), ["c2", "c1"]);
});

test("content: on Netlify or self-hosted, no CONTENT_KEYS refuses to start; locally, sealing is just off", () => {
  assert.throws(() => content.configureContent({ NETLIFY: "1" }), /Refusing to start: NETLIFY is set but CONTENT_KEYS is not/);
  assert.throws(() => content.configureContent({ SELF_HOSTED: "1" }), /Refusing to start: SELF_HOSTED is set but CONTENT_KEYS is not/);
  assert.equal(content.configureContent({}), false);
  assert.equal(content.contentConfigured(), false);
  assert.throws(() => content.sealBody("x", VAULT), content.ContentError);
  assert.equal(content.openBody(Buffer.from("plain"), VAULT), "plain");
  assert.equal(content.configureContent({ CONTENT_KEYS: `c1:${KEY}` }), true);
});

test("content: a content key that is also a variables key is refused, without printing it", () => {
  secrets.configureVariables({ VARIABLES_KEYS: `k1:${KEY}` });
  try {
    content.configureContent({ CONTENT_KEYS: `c1:${KEY}` }, secrets.isVariablesKey);
    assert.fail("expected a refusal");
  } catch (err) {
    assert.match(err.message, /CONTENT_KEYS key c1 is also a variables key/);
    assert.equal(String(err.stack).includes(KEY), false);
  }
  assert.equal(content.configureContent({ CONTENT_KEYS: `c1:${KEY2}` }, secrets.isVariablesKey), true);
});

test("content: the web server refuses to start with a content key that is a variables key, and prints neither", () => {
  const r = spawnSync(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: "postgres://reliquary_web:test@127.0.0.1:1/postgres", LOCAL_USER_ID: "00000000-0000-0000-0000-00000000000a", LOGIN_FILE: `/tmp/content-bad-${process.pid}`, PORT: "1", VARIABLES_KEY: KEY, CONTENT_KEYS: `c1:${KEY}` },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /CONTENT_KEYS key c1 is also a variables key/);
  assert.equal((r.stdout + r.stderr).includes(KEY), false);
});
