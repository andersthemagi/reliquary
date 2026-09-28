// Calling one granted tool on a link's upstream MCP server (docs/design.md,
// "Links"): the same safe-HTTP and MCP-handshake machinery discovery.ts's
// tools/list already uses and web/test/discovery.test.mjs already tests
// (handshake(), call()), reused here for a single tools/call instead of a
// paged tools/list. The address is re-resolved and re-checked here, at
// call time, not trusted from when the link was added or last discovered.
//
// mcp/ never holds this: it only holds the sealed credential
// (begin_link_call's output) and sends it to linkproxy.ts's endpoint,
// which opens it and calls this. The decryption key (VARIABLES_KEYS)
// stays web-app-only, same as every environment variable.

import { call, DiscoveryError, handshake, type DiscoveryOptions } from "./discovery.js";

export { DiscoveryError as UpstreamError } from "./discovery.js";

// A little tighter than discovery's 10 s: this path always makes three
// round trips (initialize, initialized, tools/call -- no session is kept
// between calls, so there's no cheaper path), and mcp/'s own request
// timeout to the agent is 30 s including its own hop to this server.
const TIMEOUT_MS = 8_000;

export type UpstreamResult = { content: unknown; isError: boolean };

// Throws DiscoveryError (exported here as UpstreamError), never the
// credential, with a reason written for people -- mcp/ relays it to the
// agent as the tool call's own failure.
export async function callUpstreamTool(
  url: string,
  credential: string,
  toolName: string,
  args: unknown,
  options: DiscoveryOptions = {},
): Promise<UpstreamResult> {
  const { u, sessionId, protocolVersion, opts } = await handshake(url, credential, { timeoutMs: TIMEOUT_MS, ...options });
  const res = await call(u, credential, "tools/call", { name: toolName, arguments: args ?? {} }, 2, sessionId, protocolVersion, opts);
  if (!res.result || typeof res.result !== "object") {
    throw new DiscoveryError("This link’s server answered tools/call without a result.");
  }
  const result = res.result as Record<string, unknown>;
  return { content: result.content ?? [], isError: result.isError === true };
}
