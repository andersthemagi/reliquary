// Discovery (docs/design.md, "Links" implementation plan): calling an
// upstream MCP server's tools/list to populate public.link_tools when a
// link is added. Runs server-side, synchronously with the request that
// adds the link (design.md's first open question about links, resolved
// this way for v1: a slow or unreachable upstream fails discovery, not the
// link itself -- linkspage.ts still creates the link and flashes a
// warning naming why; there is no rediscovery yet, so retrying today means
// deleting and re-adding the link. A later change can add it once real use
// shows whether that's needed often enough to justify a new owner-facing
// action and a way to read a link's own stored credential back, which
// nothing needs today).
//
// Fetching an upstream URL an owner chose is a server-side request forgery
// risk, exactly like a Client ID Metadata Document (cimd.ts), and shares its
// address safety (netsafety.ts): https only (loopback allowed only for
// tests, the same escape hatch cimd.ts uses), every resolved address must
// be public, checked at request time so DNS can't rebind after the link was
// added, no redirects (refused outright, simpler than re-checking each hop
// and sufficient for a tool listing), 10 s per call, and the response body
// capped at 256 KB.
//
// The MCP handshake (initialize, the initialized notification, then
// tools/list, paged) runs over the Streamable HTTP transport by hand
// rather than the official SDK's client: that would be a second HTTP
// client library and dependency in the web app for one call, where mcp/'s
// server already needs the SDK for a different reason (serving, not
// calling). The credential is sent once, as `Authorization: Bearer
// <credential>`, matching mcp/src/server.ts's own bearer check for
// Reliquary's remote MCP endpoint -- the shape an upstream MCP server is
// most likely to expect too.
//
// A tool's `annotations.readOnlyHint` decides the starting `is_write` guess
// (design.md: "a tool discovery can't classify defaults to a write tool
// (off), never to read"): only an explicit `true` counts as read-only;
// anything else, including a missing annotation, is treated as a write
// tool until an owner flips it.
//
// LINK_DISCOVERY_ALLOW_LOOPBACK=1 lets tests serve a fixture MCP server from
// loopback, exactly like CIMD_ALLOW_LOOPBACK (cimd.ts); refused when VERCEL
// or SELF_HOSTED is set.

import type http from "node:http";
import { isLoopbackHost, safeFetch, type Resolved } from "./netsafety.js";
import { BUILD } from "./version.js";

export class DiscoveryError extends Error {}

let ALLOW_LOOPBACK = false;

// Called once at server startup (server.ts, alongside configureVariables
// and the rest); throws rather than returns, matching those.
export function configureDiscovery(env: NodeJS.ProcessEnv): void {
  const strict = env.VERCEL ? "VERCEL" : env.SELF_HOSTED === "1" ? "SELF_HOSTED" : "";
  const allow = env.LINK_DISCOVERY_ALLOW_LOOPBACK === "1";
  if (strict && allow) throw new Error(`Refusing to start: LINK_DISCOVERY_ALLOW_LOOPBACK is for tests and must not be set with ${strict}`);
  ALLOW_LOOPBACK = allow;
}
export const discoveryAllowsLoopback = (): boolean => ALLOW_LOOPBACK;

export type DiscoveredTool = { name: string; isWrite: boolean; description: string | null };

export type DiscoveryOptions = {
  allowLoopback?: boolean;
  timeoutMs?: number;
  resolve?: (host: string) => Promise<Resolved[]>;
};

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 256 * 1024;
const MAX_TOOLS = 500;
const MAX_PAGES = 20;
const PROTOCOL_VERSION = "2025-06-18";

type RawResponse = { status: number; headers: http.IncomingHttpHeaders; body: string };

// The request mechanism itself (the DNS-rebinding re-check, redirect
// refusal, timeout and size-cap bookkeeping) is netsafety.ts's safeFetch,
// shared with cimd.ts's get(). What's left here is what's actually specific
// to a link's MCP call: it's a POST with a JSON-RPC body, and its response
// is read in full whatever its status or content type turns out to be
// (200 vs. a notification's 202; JSON vs. SSE) -- call() and parseJsonRpc()
// below decide what that means, not the fetch itself.
function post(
  u: URL,
  body: string,
  headers: Record<string, string>,
  opts: Required<Pick<DiscoveryOptions, "allowLoopback" | "timeoutMs">> & Pick<DiscoveryOptions, "resolve">,
): Promise<RawResponse> {
  // Tests only: a link's url is always https (create_link/update_link's own
  // check, no test bypass there), but a loopback fixture needs no real
  // certificate, so with the same allowLoopback that safeFetch checks the
  // address with, a loopback target is still spoken to over plain HTTP.
  // Refused in anything but a test the same way allowLoopback itself is
  // (LINK_DISCOVERY_ALLOW_LOOPBACK, refused with VERCEL or SELF_HOSTED).
  const plainLoopback = opts.allowLoopback && isLoopbackHost(u.hostname);
  const useHttp = u.protocol === "https:" && plainLoopback;
  // node:http's own request() refuses a URL whose protocol isn't "http:"
  // (ERR_INVALID_PROTOCOL), so the plain-http case needs its own URL with
  // the scheme rewritten; everything else about it (host, port, path) is
  // untouched.
  const reqUrl = useHttp ? new URL(u.href.replace(/^https:/, "http:")) : u;
  return safeFetch(reqUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "content-length": Buffer.byteLength(body), ...headers },
    body,
    allowLoopback: opts.allowLoopback,
    timeoutMs: opts.timeoutMs,
    maxBytes: MAX_BYTES,
    resolve: opts.resolve,
    errorClass: DiscoveryError,
    messages: {
      addressNotFound: "This link’s address can’t be found.",
      addressNotPublic: "This link’s address isn’t public.",
      redirected: "This link’s server redirected; redirects aren’t followed.",
      tooLarge: "This link’s server sent too large a response.",
      timedOut: "This link’s server took too long to respond.",
      requestFailed: "This link’s server couldn’t be reached.",
    },
    // No onHeaders: unlike cimd.ts's get(), a response is read in full
    // whatever its status or content type is -- call() and parseJsonRpc()
    // below need the raw status (200 vs. 202) and either a JSON or an SSE
    // body to interpret it correctly.
  });
}

// A single JSON-RPC response out of a body that's either a plain JSON
// object or a minimal Server-Sent Events stream (Streamable HTTP allows
// either). Picks the event whose id matches, or the only one there is.
function parseJsonRpc(res: RawResponse, id: number): { result?: unknown; error?: { message?: string } } {
  const contentType = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  const candidates: unknown[] = [];
  if (contentType === "application/json") {
    try {
      candidates.push(JSON.parse(res.body));
    } catch {
      throw new DiscoveryError("This link’s server sent a response that isn’t valid JSON.");
    }
  } else if (contentType === "text/event-stream") {
    for (const block of res.body.split(/\r?\n\r?\n/)) {
      const dataLines = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""));
      if (dataLines.length === 0) continue;
      try {
        candidates.push(JSON.parse(dataLines.join("\n")));
      } catch {
        // A non-JSON-RPC event (a comment, a keepalive); not a candidate.
      }
    }
  } else {
    throw new DiscoveryError(`This link’s server answered with an unexpected content type (${contentType || "none"}).`);
  }
  const isRpc = (c: unknown): c is { jsonrpc: string; id?: unknown; result?: unknown; error?: { message?: string } } =>
    !!c && typeof c === "object" && (c as { jsonrpc?: unknown }).jsonrpc === "2.0";
  const rpcs = candidates.filter(isRpc);
  const match = rpcs.find((c) => c.id === id) ?? (rpcs.length === 1 ? rpcs[0] : undefined);
  if (!match) throw new DiscoveryError("This link’s server didn’t send a matching MCP response.");
  return match;
}

export type CallOptions = Required<Pick<DiscoveryOptions, "allowLoopback" | "timeoutMs">> & Pick<DiscoveryOptions, "resolve">;

export async function call(
  u: URL,
  credential: string,
  method: string,
  params: Record<string, unknown>,
  id: number | undefined,
  sessionId: string | undefined,
  protocolVersion: string | undefined,
  opts: CallOptions,
): Promise<{ result: unknown; sessionId?: string; protocolVersion?: string }> {
  const body = JSON.stringify(id === undefined ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params });
  const headers: Record<string, string> = { authorization: `Bearer ${credential}`, "user-agent": "Reliquary (link discovery)" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
  const res = await post(u, body, headers, opts);
  const returnedSession = res.headers["mcp-session-id"];
  if (id === undefined) {
    // A notification: no JSON-RPC response is expected, only 202 (or a
    // lenient 200 for a server that answers anyway).
    if (res.status !== 202 && res.status !== 200) {
      throw new DiscoveryError(`This link’s server refused the MCP handshake (status ${res.status}).`);
    }
    return { result: undefined, sessionId: typeof returnedSession === "string" ? returnedSession : undefined };
  }
  if (res.status !== 200) {
    throw new DiscoveryError(`This link’s server refused the call (status ${res.status}).`);
  }
  const rpc = parseJsonRpc(res, id);
  if (rpc.error) {
    throw new DiscoveryError(`This link’s server refused: ${String(rpc.error.message ?? "unknown error").slice(0, 200)}`);
  }
  return { result: rpc.result, sessionId: typeof returnedSession === "string" ? returnedSession : undefined };
}

function toolOf(raw: unknown): DiscoveredTool | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.name !== "string" || t.name.length === 0 || t.name.length > 200) return null;
  const annotations = t.annotations && typeof t.annotations === "object" ? (t.annotations as Record<string, unknown>) : undefined;
  const isWrite = annotations?.readOnlyHint !== true;
  const description = typeof t.description === "string" ? t.description : null;
  return { name: t.name, isWrite, description };
}

export type Handshake = { u: URL; sessionId: string | undefined; protocolVersion: string; opts: CallOptions };

// Validates a link's url and runs the initialize / initialized handshake
// every call to an upstream MCP server starts with -- shared by
// discoverTools (below) and linkcall.ts's callUpstreamTool, which proxies
// a single tools/call the same way. No session is kept between calls
// (design.md: a link's address is re-validated on every proxied call, not
// just discovery's), so this runs fresh each time, whichever caller needs
// it.
export async function handshake(url: string, credential: string, options: DiscoveryOptions = {}): Promise<Handshake> {
  const opts = { allowLoopback: options.allowLoopback ?? false, timeoutMs: options.timeoutMs ?? TIMEOUT_MS, resolve: options.resolve };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new DiscoveryError("This link’s url isn’t a URL.");
  }
  const plainLoopback = opts.allowLoopback && u.protocol === "http:" && isLoopbackHost(u.hostname);
  if (u.protocol !== "https:" && !plainLoopback) throw new DiscoveryError("This link’s url must be https.");

  const init = await call(
    u,
    credential,
    "initialize",
    { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "Reliquary", version: BUILD.version } },
    1,
    undefined,
    undefined,
    opts,
  );
  const sessionId = init.sessionId;
  const protocolVersion =
    init.result && typeof init.result === "object" && typeof (init.result as Record<string, unknown>).protocolVersion === "string"
      ? ((init.result as Record<string, unknown>).protocolVersion as string)
      : PROTOCOL_VERSION;
  await call(u, credential, "notifications/initialized", {}, undefined, sessionId, protocolVersion, opts);
  return { u, sessionId, protocolVersion, opts };
}

// Calls the upstream MCP server named by a link's own url with its
// credential, and returns every tool it declares (paged, capped at 500).
// Throws DiscoveryError, never the credential, with a reason written for
// people.
export async function discoverTools(url: string, credential: string, options: DiscoveryOptions = {}): Promise<DiscoveredTool[]> {
  const { u, sessionId, protocolVersion, opts } = await handshake(url, credential, options);
  const tools: DiscoveredTool[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES && tools.length < MAX_TOOLS; page++) {
    const params: Record<string, unknown> = cursor ? { cursor } : {};
    const res = await call(u, credential, "tools/list", params, 2 + page, sessionId, protocolVersion, opts);
    const result = res.result && typeof res.result === "object" ? (res.result as Record<string, unknown>) : {};
    const list = Array.isArray(result.tools) ? result.tools : [];
    for (const raw of list) {
      const tool = toolOf(raw);
      if (!tool || seen.has(tool.name) || tools.length >= MAX_TOOLS) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
    cursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  return tools;
}
