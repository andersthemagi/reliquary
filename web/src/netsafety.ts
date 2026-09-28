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
// are refused. Callers check with a custom DNS `lookup` at request time (not
// once when a URL is stored), so the address checked is the address
// connected to and DNS can't rebind after the check.

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
