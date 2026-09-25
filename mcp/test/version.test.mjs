// The release a build is (mcp/stamp-version.mjs at build time,
// mcp/src/version.ts): GET /version and the MCP server's serverInfo.version.
// Production's deploy compares /version with the tag it deployed
// (scripts/deploy-check.sh). Seeds nothing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_ = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8788/mcp");
const { EXPECT_VERSION, ANA_TOKEN } = process.env;

test("version: GET /version answers the release in version.txt and the build's commit, as uncached JSON, without a token", async () => {
  assert.ok(EXPECT_VERSION, "run through mcp/test.sh (EXPECT_VERSION from version.txt)");
  const r = await fetch(new URL("/version", URL_));
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^application\/json/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await r.json();
  assert.deepEqual(Object.keys(body).sort(), ["commit", "version"]);
  assert.equal(body.version, EXPECT_VERSION);
  assert.match(body.commit, /^([0-9a-f]{7,40}|unknown)$/);
});

test("version: /healthz is unchanged (plain ok), since uptime depends on it", async () => {
  const r = await fetch(new URL("/healthz", URL_));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "ok");
});

test("version: initialize names the release as serverInfo.version", async () => {
  const client = new Client({ name: "version-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(URL_, { requestInit: { headers: { Authorization: `Bearer ${ANA_TOKEN}` } } }),
  );
  try {
    const info = client.getServerVersion();
    assert.equal(info.name, "reliquary");
    assert.equal(info.version, EXPECT_VERSION);
  } finally {
    await client.close();
  }
});
