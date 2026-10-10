// Self-hosting (SELF_HOSTED=1, deploy/, docs/public/how-to/self-host.md):
// the MCP server's settings there. poolConfig() and configureRateLimits()
// are called directly; dist/server.js is started with settings it must
// refuse (it exits before listening). The whole stack is deploy/test.sh.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { poolConfig } from "../dist/db.js";
import { configureRateLimits } from "../dist/ratelimit.js";

const PASSWORD = "not-a-real-password-9b2d";
const DB_URL = `postgres://reliquary_mcp:${PASSWORD}@db:5432/postgres`;

test("self-hosted db: DATABASE_TLS=off or system, or a CA file; none of them and the server refuses to start", () => {
  assert.equal(poolConfig({ SELF_HOSTED: "1", DATABASE_URL: DB_URL, DATABASE_TLS: "off" }).ssl, false);
  assert.deepEqual(poolConfig({ SELF_HOSTED: "1", DATABASE_URL: DB_URL, DATABASE_TLS: "system" }).ssl, { rejectUnauthorized: true });
  assert.equal(poolConfig({ SELF_HOSTED: "1", DATABASE_URL: DB_URL, DATABASE_CA_FILE: "supabase-ca.crt" }).ssl.rejectUnauthorized, true);
  assert.throws(() => poolConfig({ SELF_HOSTED: "1", DATABASE_URL: DB_URL }), /SELF_HOSTED is set but neither DATABASE_CA_FILE nor DATABASE_TLS/);
});

test("self-hosted db: bad TLS settings are refused, never showing the URL", () => {
  for (const [env, message] of [
    [{ DATABASE_TLS: "yes" }, /DATABASE_TLS must be off or system/],
    [{ DATABASE_TLS: "off", DATABASE_CA_FILE: "supabase-ca.crt" }, /not both/],
    [{ DATABASE_TLS: "off", DATABASE_URL: `${DB_URL}?sslmode=disable` }, /must not carry sslmode/],
    [{ DATABASE_TLS: "off", NETLIFY: "1" }, /never on Netlify/],
  ]) {
    try {
      poolConfig({ SELF_HOSTED: "1", DATABASE_URL: DB_URL, ...env });
      assert.fail(`expected a refusal for ${JSON.stringify(env)}`);
    } catch (err) {
      assert.match(err.message, message);
      assert.doesNotMatch(String(err.stack), new RegExp(PASSWORD));
    }
  }
});

test("self-hosted db: without SELF_HOSTED or DATABASE_TLS, nothing changes", () => {
  assert.equal(poolConfig({ DATABASE_URL: DB_URL }).ssl, undefined);
  assert.throws(() => poolConfig({ NETLIFY: "1", DATABASE_URL: DB_URL }), /NETLIFY is set but DATABASE_CA_FILE is not/);
});

test("self-hosted rate limits: TRUST_PROXY_IP may be 0 (off), as compose passes it; anything but 1, 0 or unset is refused", () => {
  assert.doesNotThrow(() => configureRateLimits({ TRUST_PROXY_IP: "0" }));
  assert.doesNotThrow(() => configureRateLimits({}));
  assert.throws(() => configureRateLimits({ TRUST_PROXY_IP: "true" }), /TRUST_PROXY_IP must be 1, 0 or unset/);
});

function start(env) {
  const merged = {
    PATH: process.env.PATH,
    PORT: "1", // never reached: every case here must exit before listening
    SELF_HOSTED: "1",
    DATABASE_URL: DB_URL,
    DATABASE_TLS: "off",
    MCP_RESOURCE: "https://mcp.example.test/mcp",
    AUTH_ISSUER: "https://app.example.test",
    ...env,
  };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return spawnSync(process.execPath, ["dist/server.js"], { env: merged, encoding: "utf8", timeout: 15_000 });
}

test("self-hosted server: refuses to start without MCP_RESOURCE, AUTH_ISSUER or a database TLS choice, never printing a value", () => {
  for (const [env, message] of [
    [{ MCP_RESOURCE: undefined }, /SELF_HOSTED is set but MCP_RESOURCE or AUTH_ISSUER is not/],
    [{ AUTH_ISSUER: undefined }, /SELF_HOSTED is set but MCP_RESOURCE or AUTH_ISSUER is not/],
    [{ DATABASE_TLS: undefined }, /neither DATABASE_CA_FILE nor DATABASE_TLS/],
  ]) {
    const r = start(env);
    assert.notEqual(r.status, 0, `${JSON.stringify(env)} started: ${r.stderr}`);
    assert.match(r.stderr, message, JSON.stringify(env));
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(PASSWORD));
  }
});
