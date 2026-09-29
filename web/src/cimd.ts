// Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document):
// an OAuth client's id is an https URL, and the document at that URL names
// the client and its redirect URIs. Claude, Claude Code and ChatGPT register
// this way, so there is no client table to manage.
//
// Fetching a URL someone else chose is a server-side request forgery risk,
// so the fetch is fenced (docs/research/hosting.md, section 4):
// - https only, and the id must be exactly the URL we fetch (no fragments,
//   credentials or dot segments, a real path);
// - every address the name resolves to must be public: private, loopback,
//   link-local, CGNAT, multicast, documentation, IPv4-mapped and NAT64 ranges
//   are refused. The check runs inside the socket's own DNS lookup, so the
//   address checked is the address connected to (no rebinding window);
// - no redirects, 5 s in all, at most 5 KB, JSON only;
// - the document's client_id must equal the URL.
// Tests need a fixture on loopback: CIMD_ALLOW_LOOPBACK=1 allows loopback
// addresses and plain http to them, nothing else, and the web server refuses
// to start with it when VERCEL is set.
//
// Errors carry our own fixed messages, never the document's content.

import { addressAllowed, isLoopbackHost, safeFetch, type Resolved } from "./netsafety.js";

export type ClientMetadata = {
  clientId: string;
  clientName: string; // as the client calls itself: shown, never trusted
  redirectUris: string[];
};

export class CimdError extends Error {}

export type Options = {
  allowLoopback?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  // For tests: resolve a name to addresses (default: the system resolver).
  resolve?: (host: string) => Promise<Resolved[]>;
  // Called with the id's host before each fetch (a cache miss), to rate
  // limit fetches per host; may throw to refuse (oauth.ts).
  beforeFetch?: (host: string) => Promise<void>;
};

export const MAX_BYTES = 5 * 1024;
const TIMEOUT_MS = 5_000;

// Address safety (blocklists, addressAllowed, isLoopbackHost) lives in
// netsafety.ts, shared with discovery.ts; re-exported here so existing
// imports of these two names from this file keep working.
export { addressAllowed, isLoopbackHost };

// ---------------------------------------------------------------------------
// The client_id URL

function clientUrl(clientId: string, allowLoopback: boolean): URL {
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 2048) {
    throw new CimdError("The client id isn’t a URL.");
  }
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    throw new CimdError("The client id isn’t a URL.");
  }
  const plainLoopback = allowLoopback && u.protocol === "http:" && isLoopbackHost(u.hostname);
  if (u.protocol !== "https:" && !plainLoopback) throw new CimdError("The client id must be an https URL.");
  // Exactly as written: no normalisation (dot segments, case, default
  // ports), no fragment, no credentials, and a path to a document.
  if (u.href !== clientId || u.hash || clientId.includes("#") || u.username || u.password || u.pathname === "/") {
    throw new CimdError("The client id must be a plain https URL with a path.");
  }
  return u;
}

// ---------------------------------------------------------------------------
// Fetching

// The request mechanism itself (the DNS-rebinding re-check, redirect
// refusal, timeout and size-cap bookkeeping) is netsafety.ts's safeFetch,
// shared with discovery.ts's post(). What's left here is what's actually
// specific to a client metadata GET: it must be exactly one 200 response,
// and it must be application/json -- checked before any body is buffered,
// via onHeaders, so a wrong status or content type never reads a body at
// all (discovery.ts can't do the same: it has to accept a 202 for a
// notification and either JSON or SSE for a call, and tells those apart
// downstream of the fetch itself).
function get(u: URL, opts: Required<Omit<Options, "resolve" | "beforeFetch">> & Pick<Options, "resolve">): Promise<string> {
  return safeFetch(u, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": "Reliquary (client metadata)" },
    allowLoopback: opts.allowLoopback,
    timeoutMs: opts.timeoutMs,
    maxBytes: opts.maxBytes,
    resolve: opts.resolve,
    errorClass: CimdError,
    messages: {
      addressNotFound: "The client’s address can’t be found.",
      addressNotPublic: "The client’s address isn’t public.",
      redirected: "The client’s metadata redirects elsewhere; redirects aren’t followed.",
      tooLarge: "The client’s metadata is too large.",
      timedOut: "The client’s metadata took too long.",
      requestFailed: "The client’s metadata couldn’t be fetched.",
    },
    onHeaders: (res) => {
      if (res.statusCode !== 200) return new CimdError("The client’s metadata couldn’t be fetched.");
      if (!/^application\/json\s*(;|$)/i.test(res.headers["content-type"] ?? "")) {
        return new CimdError("The client’s metadata isn’t JSON.");
      }
      return undefined;
    },
  }).then((r) => r.body);
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g;

function redirectUriOk(r: unknown): r is string {
  if (typeof r !== "string" || r.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(r);
  } catch {
    return false;
  }
  if (u.hash || r.includes("#") || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  // Native apps (Claude Code) come back to a port on this machine.
  return u.protocol === "http:" && isLoopbackHost(u.hostname);
}

function parse(body: string, clientId: string, host: string): ClientMetadata {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new CimdError("The client’s metadata isn’t JSON.");
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new CimdError("The client’s metadata isn’t a JSON object.");
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) throw new CimdError("The client’s metadata names a different client id.");
  const uris = d.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 20 || !uris.every(redirectUriOk)) {
    throw new CimdError("The client’s metadata has no usable redirect URIs.");
  }
  if (d.token_endpoint_auth_method !== undefined && d.token_endpoint_auth_method !== "none") {
    throw new CimdError("Only public clients (no client secret) can connect.");
  }
  if (d.grant_types !== undefined && !(Array.isArray(d.grant_types) && d.grant_types.includes("authorization_code"))) {
    throw new CimdError("The client doesn’t use the authorization code flow.");
  }
  if (d.response_types !== undefined && !(Array.isArray(d.response_types) && d.response_types.includes("code"))) {
    throw new CimdError("The client doesn’t use the authorization code flow.");
  }
  const name = typeof d.client_name === "string" ? d.client_name.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  return { clientId, clientName: name || host, redirectUris: uris as string[] };
}

export async function fetchClientMetadata(clientId: string, options: Options = {}): Promise<ClientMetadata> {
  const opts = {
    allowLoopback: options.allowLoopback ?? false,
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    maxBytes: options.maxBytes ?? MAX_BYTES,
    resolve: options.resolve,
  };
  const u = clientUrl(clientId, opts.allowLoopback);
  return parse(await get(u, opts), clientId, u.hostname);
}

// A small per-instance cache: an hour per client, at most 256 clients.
// Failures aren't cached.
const cache = new Map<string, { meta: ClientMetadata; until: number }>();
const TTL_MS = 3600_000;

export async function clientMetadata(clientId: string, options: Options = {}): Promise<ClientMetadata> {
  const hit = cache.get(clientId);
  if (hit && hit.until > Date.now()) return hit.meta;
  if (options.beforeFetch) {
    let host: string;
    try {
      host = new URL(clientId).hostname;
    } catch {
      throw new CimdError("The app’s client id isn’t a URL.");
    }
    await options.beforeFetch(host);
  }
  const meta = await fetchClientMetadata(clientId, options);
  cache.delete(clientId);
  if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  cache.set(clientId, { meta, until: Date.now() + TTL_MS });
  return meta;
}

// Is `requested` one of the client's redirect URIs? Exact string match,
// except that a loopback redirect (http://127.0.0.1/..., http://localhost/...,
// http://[::1]/...) matches on any port, as native apps pick a free port at
// run time (RFC 8252, 7.3).
export function redirectAllowed(meta: ClientMetadata, requested: string): boolean {
  if (typeof requested !== "string" || requested.length === 0) return false;
  if (meta.redirectUris.includes(requested)) return true;
  let q: URL;
  try {
    q = new URL(requested);
  } catch {
    return false;
  }
  if (q.protocol !== "http:" || !isLoopbackHost(q.hostname) || q.hash || requested.includes("#") || q.username || q.password) {
    return false;
  }
  return meta.redirectUris.some((r) => {
    const u = new URL(r);
    return (
      u.protocol === "http:" &&
      u.hostname.toLowerCase() === q.hostname.toLowerCase() &&
      u.pathname === q.pathname &&
      u.search === q.search
    );
  });
}
