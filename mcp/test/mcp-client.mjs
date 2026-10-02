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

export async function call(url, token, name, args = {}) {
  const client = await connect(url, token);
  try {
    const r = await client.callTool({ name, arguments: args });
    return { text: r.content.map((c) => c.text).join("\n"), isError: Boolean(r.isError) };
  } finally {
    await client.close();
  }
}
