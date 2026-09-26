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
  const tabs = [...h.matchAll(/<nav class="tabs" aria-label="Clients">([\s\S]*?)<\/nav>/g)][0][1];
  const order = [...tabs.matchAll(/href="\/connect\?client=([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["claude-code", "chat", "cursor", "vscode", "other", "cli"], "sign-in clients come before token setups");
  assert.doesNotMatch(h, /RELIQUARY_TOKEN|headersHelper/, "the default tab is sign-in only");
  assert.match(await page("/connect?client=cursor"), /RELIQUARY_TOKEN/);
});

test("connect: Claude.ai and ChatGPT add the URL as a connector; the dev helper is only under Local development", async () => {
  const chat = await page("/connect?client=chat");
  assert.match(chat, /Add custom connector/);
  assert.match(chat, /developer mode/);
  const other = await page("/connect?client=other");
  assert.match(other, /<details><summary>Local development[^<]*<\/summary>[\s\S]*headersHelper[\s\S]*<\/details>/);
  for (const c of ["", "?client=chat", "?client=cursor", "?client=vscode", "?client=cli"]) {
    assert.doesNotMatch(await page(`/connect${c}`), /headersHelper/, c);
  }
  assert.doesNotMatch(other, /arrive with hosting/);
});
