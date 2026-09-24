// The Connect page leads with sign-in (OAuth) for the clients that support
// it, so connecting Claude Code on another computer needs only the MCP URL:
// no script, no token file. Tokens stay as the fallback for other clients,
// and the local-development helper is tucked away.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

const BASE = process.env.WEB_URL ?? "http://127.0.0.1:8791";
let cookie = "";

before(async () => {
  const r = await fetch(readFileSync(process.env.LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  cookie = r.headers.get("set-cookie").split(";")[0];
});

const page = async (path) => (await fetch(BASE + path, { headers: { cookie } })).text();

test("connect: Claude Code connects by URL and browser sign-in, before any token setup", async () => {
  const h = await page("/connect");
  const add = h.indexOf("claude mcp add --transport http --scope user reliquary http://127.0.0.1:8787/mcp");
  assert.ok(add > 0, "the claude mcp add command with the MCP URL");
  assert.match(h, /run <code>\/mcp<\/code>, choose <strong>reliquary<\/strong> and <strong>Authenticate<\/strong>/);
  assert.ok(add < h.indexOf("RELIQUARY_TOKEN"), "sign-in comes before token setups");
  assert.ok(add < h.indexOf("headersHelper"), "sign-in comes before the local helper");
});

test("connect: Claude.ai and ChatGPT add the URL as a connector; the dev helper is only under Local development", async () => {
  const h = await page("/connect");
  assert.match(h, /Add custom connector/);
  assert.match(h, /developer mode/);
  assert.match(h, /<details><summary>Local development[^<]*<\/summary>[\s\S]*headersHelper[\s\S]*<\/details>/);
  assert.doesNotMatch(h, /arrive with hosting/);
});
