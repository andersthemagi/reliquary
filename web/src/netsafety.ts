// Address safety for the two places this server fetches a URL someone else
// chose (server-side request forgery risk): a Client ID Metadata Document
// (cimd.ts, an OAuth client's own id) and a link's discovery call
// (discovery.ts, an upstream MCP server's tools/list). Extracted from
// cimd.ts on 2026-09-28 so both share one blocklist instead of two that
// could quietly drift apart; cimd.ts re-exports these same names, so
// nothing importing from it changes.
//
// Every address a name resolves to must be public: private, loopback,
// link-local, CGNAT, multicast, documentation, IPv4-mapped and NAT64 ranges
// are refused. safeFetch (below) checks with a custom DNS `lookup` at
// request time (not once when a URL is stored), so the address checked is
// the address connected to and DNS can't rebind after the check.
//
// That request mechanism was extracted here too, on 2026-09-29: cimd.ts's
// get() and discovery.ts's post() had each grown their own copy of the
// DNS-rebinding re-check, the timeout/size-cap bookkeeping and the redirect
// refusal around this address check -- exactly the kind of drift this file
// exists to prevent one layer up. What genuinely differs between the two
// (GET vs. POST, a body or none, headers, the byte cap, and how a response
// is validated before its body is read) are parameters to safeFetch, not
// separate copies of it.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const refused = new net.BlockList();
for (const [net4, bits] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, broadcast
] as const) refused.addSubnet(net4, bits, "ipv4");
for (const [net6, bits] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 could reach private IPv4
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23], // IETF protocol assignments, Teredo
  ["2001:db8::", 32],
  ["2002::", 16], // 6to4 embeds IPv4
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10],
  ["ff00::", 8], // multicast
] as const) refused.addSubnet(net6, bits, "ipv6");

const loopback = new net.BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

// IPv4-mapped and -translated IPv6 never come from public DNS. Kept apart:
// BlockList also checks IPv4 addresses against mapped IPv6 rules, so in the
// list above these would refuse every IPv4 address.
const mapped = new net.BlockList();
mapped.addSubnet("::ffff:0:0", 96, "ipv6");
mapped.addSubnet("::ffff:0:0:0", 96, "ipv6");

const familyOf = (ip: string) => (net.isIP(ip) === 6 ? "ipv6" : "ipv4");

export function isLoopbackAddress(ip: string): boolean {
  return net.isIP(ip) !== 0 && loopback.check(ip, familyOf(ip));
}

// May we connect to this address?
export function addressAllowed(ip: string, allowLoopback = false): boolean {
  if (net.isIP(ip) === 0) return false;
  if (net.isIP(ip) === 6 && mapped.check(ip, "ipv6")) return false;
  if (allowLoopback && isLoopbackAddress(ip)) return true;
  return !refused.check(ip, familyOf(ip));
}

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const isLoopbackHost = (hostname: string) => LOOPBACK_NAMES.has(hostname.toLowerCase());

// ---------------------------------------------------------------------------
// safeFetch: one request to a URL someone else chose, safe against SSRF and
// DNS rebinding. Shared by cimd.ts's get() (a GET, exactly one JSON
// document) and discovery.ts's post() (a POST, JSON-RPC over either a plain
// JSON or an SSE response) -- see the file header above.

export type Resolved = { address: string; family: number };

const systemResolve = async (host: string): Promise<Resolved[]> =>
  (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

// The wording each caller supplies, so both keep their own voice ("the
// client's metadata" vs. "this link's server") for the same underlying
// failure instead of a shared, vaguer message.
export type SafeFetchMessages = {
  addressNotFound: string;
  addressNotPublic: string;
  redirected: string;
  tooLarge: string;
  timedOut: string;
  requestFailed: string;
};

export type SafeFetchOptions = {
  method: "GET" | "POST";
  headers: Record<string, string | number>;
  body?: string;
  allowLoopback: boolean;
  timeoutMs: number;
  maxBytes: number;
  // For tests: resolve a name to addresses (default: the system resolver).
  resolve?: (host: string) => Promise<Resolved[]>;
  // Called once a non-redirect status arrives, before any body is read.
  // Return an Error to abort right there -- the body is drained, never
  // buffered -- or undefined to continue. cimd.ts uses this so a wrong
  // status or a non-JSON content type never buffers a body at all. Omit it
  // to accept any non-redirect status and always read the body:
  // discovery.ts needs the raw status (200 vs. the 202 a notification
  // gets) and a body that's either JSON or SSE, and decides what either
  // means itself, downstream of this function.
  onHeaders?: (res: http.IncomingMessage) => Error | undefined;
  // The specific error type to throw (CimdError, DiscoveryError, ...). An
  // error already of this type -- from onHeaders or the DNS lookup below --
  // passes through unchanged; anything else (a raw socket/network error) is
  // wrapped as `messages.requestFailed`.
  errorClass: new (message: string) => Error;
  messages: SafeFetchMessages;
};

export type SafeFetchResult = { status: number; headers: http.IncomingHttpHeaders; body: string };

export function safeFetch(url: URL, opts: SafeFetchOptions): Promise<SafeFetchResult> {
  const resolve = opts.resolve ?? systemResolve;
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(bare) && !addressAllowed(bare, opts.allowLoopback)) {
    return Promise.reject(new opts.errorClass(opts.messages.addressNotPublic));
  }
  // Node calls this for every connection it makes to a name (not for IP
  // literals, checked above), so the addresses checked are the ones used.
  const lookup = (
    hostname: string,
    lookupOpts: dns.LookupOptions,
    cb: (err: Error | null, address: string | dns.LookupAddress[], family?: number) => void,
  ) => {
    resolve(hostname).then(
      (addrs) => {
        if (addrs.length === 0) return cb(new opts.errorClass(opts.messages.addressNotFound), "");
        if (!addrs.every((a) => addressAllowed(a.address, opts.allowLoopback))) {
          return cb(new opts.errorClass(opts.messages.addressNotPublic), "");
        }
        const wanted = lookupOpts.family === 6 || lookupOpts.family === 4 ? addrs.filter((a) => a.family === lookupOpts.family) : addrs;
        if (wanted.length === 0) return cb(new opts.errorClass(opts.messages.addressNotFound), "");
        if (lookupOpts.all) cb(null, wanted.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, wanted[0].address, wanted[0].family);
      },
      () => cb(new opts.errorClass(opts.messages.addressNotFound), ""),
    );
  };

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const done = (err: Error | null, result?: SafeFetchResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err instanceof opts.errorClass ? err : new opts.errorClass(opts.messages.requestFailed));
      else resolvePromise(result!);
    };
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: opts.method,
        agent: false, // a fresh connection: never reuse a socket to another address
        lookup: lookup as unknown as net.LookupFunction,
        headers: opts.headers,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return done(new opts.errorClass(opts.messages.redirected));
        }
        if (opts.onHeaders) {
          const headerErr = opts.onHeaders(res);
          if (headerErr) {
            res.resume();
            return done(headerErr);
          }
        }
        const declared = Number(res.headers["content-length"] ?? 0);
        if (declared > opts.maxBytes) {
          res.destroy();
          return done(new opts.errorClass(opts.messages.tooLarge));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            res.destroy();
            done(new opts.errorClass(opts.messages.tooLarge));
          } else chunks.push(c);
        });
        res.on("end", () => done(null, { status, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => done(e));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(new opts.errorClass(opts.messages.timedOut));
    }, opts.timeoutMs);
    req.on("error", (e) => done(e));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}
