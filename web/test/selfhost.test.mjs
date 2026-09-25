// Self-hosting (SELF_HOSTED=1, deploy/, docs/public/how-to/self-host.md):
// what the web app does differently there, and that nothing changes without
// it. Settings are checked by calling the modules in dist/ and by starting
// dist/server.js with settings it must refuse (it exits before listening).
// The whole stack, end to end, is deploy/test.sh.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { configureAuth } from "../dist/auth.js";
import { poolConfig } from "../dist/db.js";
import { NO_LIMIT_BYTES, NO_LIMIT_COUNT, planLine, usageLine } from "../dist/plans.js";
import { configureRateLimits } from "../dist/ratelimit.js";
import { configureVariables } from "../dist/secrets.js";
import { EMAIL_TEMPLATES, emailTemplate, selfHosted } from "../dist/selfhost.js";

const PASSWORD = "not-a-real-password-5c1e";
const DB_URL = `postgres://reliquary_web:${PASSWORD}@db:5432/postgres`;
const SECRET = "a-session-secret-that-is-long-enough-0123456789";
const KEY = "k1:" + "A".repeat(43);
const site = { secure: false, host: "127.0.0.1", port: 8790 };
const authEnv = { AUTH_MODE: "supabase", AUTH_URL: "http://auth:9999", JWT_ALG: "ES256", SESSION_SECRET: SECRET, SELF_HOSTED: "1" };

// Database TLS ----------------------------------------------------------------

test("self-hosted db: DATABASE_TLS=off connects without TLS, for a database on the same private network", () => {
  const c = poolConfig({ SELF_HOSTED: "1", DATABASE_URL: DB_URL, DATABASE_TLS: "off" });
  assert.equal(c.ssl, false);
  assert.equal(c.connectionString, DB_URL);
});

test("self-hosted db: DATABASE_TLS=system verifies the certificate against the system's CAs", () => {
  const c = poolConfig({ SELF_HOSTED: "1", DATABASE_URL: DB_URL, DATABASE_TLS: "system" });
  assert.deepEqual(c.ssl, { rejectUnauthorized: true });
});

test("self-hosted db: a CA file works as hosted", () => {
  const c = poolConfig({ SELF_HOSTED: "1", DATABASE_URL: DB_URL, DATABASE_CA_FILE: "supabase-ca.crt" });
  assert.equal(c.ssl.rejectUnauthorized, true);
  assert.match(c.ssl.ca, /^-----BEGIN CERTIFICATE-----/);
});

test("self-hosted db: with no TLS choice the server refuses to start, naming the choices", () => {
  assert.throws(() => poolConfig({ SELF_HOSTED: "1", DATABASE_URL: DB_URL }), /SELF_HOSTED is set but neither DATABASE_CA_FILE nor DATABASE_TLS/);
});

test("self-hosted db: an unknown DATABASE_TLS, both settings, or TLS parameters in the URL are refused, never showing the URL", () => {
  for (const [env, message] of [
    [{ DATABASE_TLS: "on" }, /DATABASE_TLS must be off or system/],
    [{ DATABASE_TLS: "off", DATABASE_CA_FILE: "supabase-ca.crt" }, /not both/],
    [{ DATABASE_TLS: "system", DATABASE_URL: `${DB_URL}?sslmode=require` }, /must not carry sslmode/],
    [{ DATABASE_TLS: "off", VERCEL: "1" }, /never on Vercel/],
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

test("self-hosted db: without SELF_HOSTED or DATABASE_TLS, nothing changes (local: no TLS object; Vercel: CA required)", () => {
  assert.equal(poolConfig({ DATABASE_URL: DB_URL }).ssl, undefined);
  assert.throws(() => poolConfig({ VERCEL: "1", DATABASE_URL: DB_URL }), /VERCEL is set but DATABASE_CA_FILE is not/);
});

// Auth ------------------------------------------------------------------------

test("self-hosted auth: AUTH_URL points sign-in at a self-hosted Supabase Auth, plain http allowed on the private network", () => {
  assert.equal(configureAuth(authEnv, site), "supabase");
  assert.equal(configureAuth({ ...authEnv, SELF_HOSTED: undefined, AUTH_URL: "http://127.0.0.1:9999" }, site), "supabase");
  assert.equal(configureAuth({ ...authEnv, AUTH_URL: "https://auth.example.test" }, site), "supabase");
});

test("self-hosted auth: bad AUTH_URL settings are refused, naming the variable and never a value", () => {
  for (const [env, message] of [
    [{ SELF_HOSTED: undefined }, /AUTH_URL must be https/],
    [{ VERCEL: "1" }, /AUTH_URL must be https/],
    [{ AUTH_URL: "not a url" }, /AUTH_URL must be the Auth server's URL/],
    [{ AUTH_URL: "http://auth:9999/?x=1" }, /no query, fragment or credentials/],
    [{ AUTH_URL: "http://user:pw@auth:9999" }, /no query, fragment or credentials/],
    [{ SUPABASE_URL: "https://ref.supabase.co" }, /not both/],
    [{ JWT_ALG: "HS256" }, /JWT_ALG must be ES256 or RS256/],
    [{ SESSION_SECRET: "short" }, /SESSION_SECRET must be at least 32/],
  ]) {
    try {
      configureAuth({ ...authEnv, ...env }, site);
      assert.fail(`expected a refusal for ${JSON.stringify(env)}`);
    } catch (err) {
      assert.match(err.message, message, JSON.stringify(env));
      assert.doesNotMatch(err.message, new RegExp(SECRET));
    }
  }
});

// Variables key ---------------------------------------------------------------

test("self-hosted variables: the server refuses to start without a variables key", () => {
  assert.throws(() => configureVariables({ SELF_HOSTED: "1" }), /SELF_HOSTED is set but neither VARIABLES_KEYS nor VARIABLES_KEY is/);
  assert.equal(configureVariables({ SELF_HOSTED: "1", VARIABLES_KEYS: KEY }), true);
  assert.equal(configureVariables({}), false, "locally, still optional");
});

// Rate limits: TRUST_PROXY_IP=0 ---------------------------------------------------

test("self-hosted rate limits: TRUST_PROXY_IP may be 0 (off), as compose passes it; anything but 1, 0 or unset is refused", () => {
  assert.doesNotThrow(() => configureRateLimits({ TRUST_PROXY_IP: "0" }));
  assert.doesNotThrow(() => configureRateLimits({ TRUST_PROXY_IP: "1" }));
  assert.doesNotThrow(() => configureRateLimits({}));
  assert.throws(() => configureRateLimits({ TRUST_PROXY_IP: "yes" }), /TRUST_PROXY_IP must be 1, 0 or unset/);
});

// Plans: no limits --------------------------------------------------------------

test("self-hosted plan: limits this large read as no limit", () => {
  const plan = { plan: "self_hosted", planName: "Self-hosted", vaultsOwned: 3, maxVaults: 2147483647 };
  assert.equal(planLine(plan), "Self-hosted plan · 3 vaults (no limit)");
  assert.equal(planLine({ ...plan, vaultsOwned: 1 }), "Self-hosted plan · 1 vault (no limit)");
  const u = { tier: "standard", tierName: "Standard", plan: "self_hosted", planName: "Self-hosted", members: 4, invites: 0, maxMembers: 2147483647, bytes: 12e6, maxBytes: 9223372036854775807 };
  assert.equal(usageLine(u), "Standard (Self-hosted) · 4 people · 12 MB");
  assert.ok(NO_LIMIT_COUNT > 25 && NO_LIMIT_BYTES > 5e9, "far above every hosted plan and tier");
});

test("self-hosted plan: hosted plans read as before", () => {
  assert.equal(planLine({ plan: "free", planName: "Free", vaultsOwned: 3, maxVaults: 5 }), "Free plan · 3 of 5 vaults");
  const u = { tier: "standard", tierName: "Standard", plan: "free", planName: "Free", members: 4, invites: 0, maxMembers: 10, bytes: 12e6, maxBytes: 100e6 };
  assert.equal(usageLine(u), "Standard (Free) · 4 of 10 people · 12 MB of 100 MB");
});

// Email templates -----------------------------------------------------------------

test("self-hosted email templates: the code and a link to this site's /auth/confirm, served only when SELF_HOSTED=1", () => {
  assert.equal(selfHosted({ SELF_HOSTED: "1" }), true);
  assert.equal(selfHosted({}), false);
  for (const path of ["/_selfhost/email/sign-in.html", "/_selfhost/email/confirm.html"]) {
    const t = emailTemplate(path, { SELF_HOSTED: "1" });
    assert.ok(t, path);
    assert.match(t, /\{\{ \.Token \}\}/);
    assert.match(t, /\{\{ \.SiteURL \}\}\/auth\/confirm\?token_hash=\{\{ \.TokenHash \}\}&type=email/);
    assert.doesNotMatch(t, /ConfirmationURL/, "never Auth's own link (tokens in a fragment)");
    assert.equal(emailTemplate(path, {}), undefined);
  }
  assert.equal(emailTemplate("/_selfhost/email/other.html", { SELF_HOSTED: "1" }), undefined);
  assert.equal(EMAIL_TEMPLATES.size, 2);
});

// Starting the server -------------------------------------------------------------

function start(env) {
  const base = {
    PATH: process.env.PATH,
    PORT: "1", // never reached: every case here must exit before listening
    SELF_HOSTED: "1",
    DATABASE_URL: DB_URL,
    DATABASE_TLS: "off",
    ...authEnv,
    VARIABLES_KEYS: KEY,
    PUBLIC_URL: "https://app.example.test",
    MCP_RESOURCE: "https://mcp.example.test/mcp",
  };
  const merged = { ...base, ...env };
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
  return spawnSync(process.execPath, ["dist/server.js"], { env: merged, encoding: "utf8", timeout: 15_000 });
}

test("self-hosted server: refuses to start without the settings a real deployment needs, never printing a value", () => {
  for (const [env, message] of [
    [{ AUTH_MODE: "local", LOCAL_USER_ID: "00000000-0000-0000-0000-00000000000a" }, /AUTH_MODE is local .* SELF_HOSTED is set/],
    [{ DATABASE_TLS: undefined }, /neither DATABASE_CA_FILE nor DATABASE_TLS/],
    [{ VARIABLES_KEYS: undefined }, /neither VARIABLES_KEYS nor VARIABLES_KEY/],
    [{ CIMD_ALLOW_LOOPBACK: "1" }, /CIMD_ALLOW_LOOPBACK is for tests and must not be set with SELF_HOSTED/],
    [{ PUBLIC_URL: undefined }, /SELF_HOSTED is set but PUBLIC_URL/],
    [{ MCP_RESOURCE: undefined }, /SELF_HOSTED is set but MCP_RESOURCE/],
  ]) {
    const r = start(env);
    assert.notEqual(r.status, 0, `${JSON.stringify(env)} started: ${r.stderr}`);
    assert.match(r.stderr, message, JSON.stringify(env));
    assert.doesNotMatch(r.stderr + r.stdout, new RegExp(`${PASSWORD}|${SECRET}|A{43}`));
  }
});
