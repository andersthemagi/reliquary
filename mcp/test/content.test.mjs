// The MCP server and the content key set (F1000): it holds CONTENT_KEYS,
// since it serves files, and still refuses the variables key. Startup
// checks only; no database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

const start = (env) =>
  spawnSync(process.execPath, ["dist/server.js"], {
    env: { ...process.env, DATABASE_URL: "postgres://reliquary_mcp:test@127.0.0.1:1/postgres", PORT: "1", ...env },
    encoding: "utf8",
    timeout: 15_000,
  });

test("mcp content: self-hosted, no CONTENT_KEYS refuses to start", () => {
  const r = start({ SELF_HOSTED: "1", DATABASE_TLS: "off", MCP_RESOURCE: "https://mcp.example.com/mcp", AUTH_ISSUER: "https://app.example.com", LINK_PROXY_SECRET: randomBytes(24).toString("base64url") });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to start: SELF_HOSTED is set but CONTENT_KEYS is not/);
});

test("mcp content: a malformed CONTENT_KEYS is refused without printing it", () => {
  const bad = `c1:${randomBytes(24).toString("base64url")}KEYMARK`;
  const r = start({ CONTENT_KEYS: bad });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /CONTENT_KEYS \(key c1\) must be 32 random bytes/);
  assert.equal((r.stdout + r.stderr).includes("KEYMARK"), false);
});

test("mcp content: with CONTENT_KEYS set, VARIABLES_KEYS is still refused, without printing either", () => {
  const key = randomBytes(32).toString("base64url");
  const r = start({ CONTENT_KEYS: `c1:${key}`, VARIABLES_KEYS: `k1:${randomBytes(32).toString("base64url")}` });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Refusing to start: VARIABLES_KEYS is set, and only the web app may hold it/);
  assert.equal((r.stdout + r.stderr).includes(key), false);
});
