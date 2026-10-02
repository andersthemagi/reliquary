// Shared MCP test client: connect over StreamableHTTPClientTransport with a
// Bearer token, call a tool, read back {text, isError}. Extracted from 19
// test files that each hand-rolled this (ponytail-audit, 2026-10).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function connect(url, token, name = "mcp-test") {
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

// A successful call can end with the flags hint, a block of its own
// (src/tools-shared.ts, test/flags_hint.test.mjs): `text` is the tool's own
// answer without it, as it was before the hint existed, and `hint` the
// hint's line when there was one.
export async function call(url, token, name, args = {}) {
  const client = await connect(url, token);
  try {
    const r = await client.callTool({ name, arguments: args });
    const blocks = r.content.map((c) => c.text);
    const hint = blocks.length > 1 && blocks.at(-1).startsWith("Reliquary: ") ? blocks.pop() : undefined;
    return { text: blocks.join("\n"), isError: Boolean(r.isError), hint };
  } finally {
    await client.close();
  }
}
