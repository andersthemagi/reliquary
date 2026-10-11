// Database TLS and pool settings (docs/research/hosting.md, section 2):
// poolConfig() in src/db.ts, called directly. No connection is made.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { poolConfig } from "../dist/db.js";

const REPO = process.env.REPO_DIR ?? new URL("../..", import.meta.url).pathname;
const PASSWORD = "not-a-real-password-7f3a";
const URL = `postgres://reliquary_web.ref:${PASSWORD}@pooler.example:6543/postgres`;

test("db tls: DATABASE_URL without TLS config is refused when NETLIFY is set", () => {
  assert.throws(() => poolConfig({ NETLIFY: "1", DATABASE_URL: URL }), /DATABASE_CA_FILE/);
  assert.throws(() => poolConfig({ NETLIFY: "1", DATABASE_URL: `${URL}?sslmode=require` }), /DATABASE_CA_FILE/);
});

test("db tls: the refusal never contains the connection string or its password", () => {
  for (const env of [
    { NETLIFY: "1", DATABASE_URL: URL },
    { NETLIFY: "1", DATABASE_URL: `${URL}?sslmode=require`, DATABASE_CA_FILE: "supabase-ca.crt" },
    { NETLIFY: "1", DATABASE_URL: URL, DATABASE_CA_FILE: "no-such.crt" },
  ]) {
    try {
      poolConfig(env);
      assert.fail("expected a refusal");
    } catch (err) {
      assert.doesNotMatch(String(err.message), new RegExp(PASSWORD));
      assert.doesNotMatch(String(err.stack), new RegExp(PASSWORD));
    }
  }
});

test("db tls: with the bundled Supabase CA, TLS is verified against it", () => {
  const c = poolConfig({ NETLIFY: "1", DATABASE_URL: URL, DATABASE_CA_FILE: "supabase-ca.crt" });
  assert.equal(c.ssl.rejectUnauthorized, true);
  assert.match(c.ssl.ca, /^-----BEGIN CERTIFICATE-----/);
  assert.equal(c.connectionString, URL);
});

test("db tls: sslmode in DATABASE_URL is refused next to a CA (it would override it)", () => {
  assert.throws(
    () => poolConfig({ DATABASE_URL: `${URL}?sslmode=require`, DATABASE_CA_FILE: "supabase-ca.crt" }),
    /sslmode/,
  );
});

test("db tls: a missing or non-PEM CA file is refused", () => {
  assert.throws(() => poolConfig({ DATABASE_URL: URL, DATABASE_CA_FILE: "no-such.crt" }), /can't be read/);
  assert.throws(() => poolConfig({ DATABASE_URL: URL, DATABASE_CA_FILE: "package.json" }), /no PEM/);
});

test("db tls: local runs (no NETLIFY, no CA) are unchanged: no TLS", () => {
  const c = poolConfig({ DATABASE_URL: "postgres://reliquary_web:test@127.0.0.1:5432/postgres" });
  assert.equal(c.ssl, undefined);
});

test("db pool: small by default (3 for web), DB_POOL_MAX overrides, nonsense refused", () => {
  assert.equal(poolConfig({ DATABASE_URL: URL }).max, 3);
  assert.equal(poolConfig({ DATABASE_URL: URL, DB_POOL_MAX: "2" }).max, 2);
  assert.equal(poolConfig({ DATABASE_URL: URL }).idleTimeoutMillis, 10_000);
  assert.throws(() => poolConfig({ DATABASE_URL: URL, DB_POOL_MAX: "0" }), /DB_POOL_MAX/);
  assert.throws(() => poolConfig({ DATABASE_URL: URL, DB_POOL_MAX: "many" }), /DB_POOL_MAX/);
});

// mcp/src/db.ts and web/src/db.ts each define poolConfig(); they're meant to
// be identical (same TLS verification, same DATABASE_TLS/DATABASE_CA_FILE
// handling) except DEFAULT_POOL_MAX, which differs on purpose (5 for mcp, 3
// for web — see the comment above DEFAULT_POOL_MAX in either file for why).
// This pins everything from the "Pool settings from the environment."
// comment through poolConfig()'s end as byte-identical between the two
// files, the same spirit as errors_unit.test.mjs's check that
// mcp/src/failure.ts and web/src/failure.ts are the same file, so a TLS fix
// landing in one copy and forgotten in the other fails a test instead of
// silently drifting.
test("db config: mcp/src/db.ts and web/src/db.ts share identical pool/TLS logic, except DEFAULT_POOL_MAX", () => {
  const START = "// Pool settings from the environment.";
  const END = "export const pool = new pg.Pool(poolConfig());";
  const sharedRegion = (src) => {
    const s = src.indexOf(START);
    const e = src.indexOf(END, s);
    assert.notEqual(s, -1, `"${START}" not found`);
    assert.notEqual(e, -1, `"${END}" not found`);
    return src.slice(s, e);
  };
  const mcp = readFileSync(join(REPO, "mcp/src/db.ts"), "utf8");
  const web = readFileSync(join(REPO, "web/src/db.ts"), "utf8");
  assert.equal(sharedRegion(mcp), sharedRegion(web));
});
