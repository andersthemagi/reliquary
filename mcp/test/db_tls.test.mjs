// Database TLS and pool settings (docs/research/hosting.md, section 2):
// poolConfig() in src/db.ts, called directly. No connection is made.

import assert from "node:assert/strict";
import { test } from "node:test";
import { poolConfig } from "../dist/db.js";

const PASSWORD = "not-a-real-password-7f3a";
const URL = `postgres://reliquary_mcp.ref:${PASSWORD}@pooler.example:6543/postgres`;

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
  const c = poolConfig({ DATABASE_URL: "postgres://reliquary_mcp:test@127.0.0.1:5432/postgres" });
  assert.equal(c.ssl, undefined);
});

test("db pool: small by default (5 for mcp), DB_POOL_MAX overrides, nonsense refused", () => {
  assert.equal(poolConfig({ DATABASE_URL: URL }).max, 5);
  assert.equal(poolConfig({ DATABASE_URL: URL, DB_POOL_MAX: "2" }).max, 2);
  assert.equal(poolConfig({ DATABASE_URL: URL }).idleTimeoutMillis, 10_000);
  assert.throws(() => poolConfig({ DATABASE_URL: URL, DB_POOL_MAX: "0" }), /DB_POOL_MAX/);
  assert.throws(() => poolConfig({ DATABASE_URL: URL, DB_POOL_MAX: "many" }), /DB_POOL_MAX/);
});
