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

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { addressAllowed, isLoopbackHost } from "./netsafety.js";

export type ClientMetadata = {
  clientId: string;
  clientName: string; // as the client calls itself: shown, never trusted
  redirectUris: string[];
};

export class CimdError extends Error {}

type Resolved = { address: string; family: number };
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

const systemResolve = async (host: string): Promise<Resolved[]> =>
  (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

function get(u: URL, opts: Required<Omit<Options, "resolve" | "beforeFetch">> & Pick<Options, "resolve">): Promise<string> {
  const resolve = opts.resolve ?? systemResolve;
  const bare = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bare) && !addressAllowed(bare, opts.allowLoopback)) {
    return Promise.reject(new CimdError("The client’s address isn’t public."));
  }
  // Node calls this for every connection it makes to a name (not for IP
  // literals, checked above), so the addresses checked are the ones used.
  const lookup = (
    hostname: string,
    options: dns.LookupOptions,
    cb: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void,
  ) => {
    resolve(hostname).then(
      (addrs) => {
        if (addrs.length === 0) return cb(new CimdError("The client’s address can’t be found."), "");
        if (!addrs.every((a) => addressAllowed(a.address, opts.allowLoopback))) {
          return cb(new CimdError("The client’s address isn’t public."), "");
        }
        const wanted = options.family === 6 || options.family === 4 ? addrs.filter((a) => a.family === options.family) : addrs;
        if (wanted.length === 0) return cb(new CimdError("The client’s address can’t be found."), "");
        if (options.all) cb(null, wanted.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, wanted[0].address, wanted[0].family);
      },
      () => cb(new CimdError("The client’s address can’t be found."), ""),
    );
  };

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const done = (err: Error | null, body?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err instanceof CimdError ? err : new CimdError("The client’s metadata couldn’t be fetched."));
      else resolvePromise(body!);
    };
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "GET",
        agent: false, // a fresh connection: never reuse a socket to another address
        lookup: lookup as unknown as net.LookupFunction,
        headers: { accept: "application/json", "user-agent": "Reliquary (client metadata)" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return done(
            new CimdError(
              res.statusCode && res.statusCode >= 300 && res.statusCode < 400
                ? "The client’s metadata redirects elsewhere; redirects aren’t followed."
                : "The client’s metadata couldn’t be fetched.",
            ),
          );
        }
        if (!/^application\/json\s*(;|$)/i.test(res.headers["content-type"] ?? "")) {
          res.resume();
          return done(new CimdError("The client’s metadata isn’t JSON."));
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          return done(new CimdError("The client’s metadata is too large."));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            res.destroy();
            done(new CimdError("The client’s metadata is too large."));
          } else chunks.push(c);
        });
        res.on("end", () => done(null, Buffer.concat(chunks).toString("utf8")));
        res.on("error", (e) => done(e));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(new CimdError("The client’s metadata took too long."));
    }, opts.timeoutMs);
    req.on("error", (e) => done(e));
    req.end();
  });
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
