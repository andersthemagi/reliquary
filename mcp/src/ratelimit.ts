// Rate limits for the MCP endpoint (docs/public/reference/limits.md, "Rate
// limits"; supabase/migrations/20260925200000_rate_limits.sql). The web app
// has the same machinery in web/src/ratelimit.ts (separate deployables, no
// shared package); keep them in step.
//
// Counters live in Postgres, shared by every serverless instance: one upsert
// per counted request, in parallel with resolving the token, so it adds no
// round trip to a request's latency.
//
//  - Per token: tool calls a minute and a day, counted against the grant a
//    live token belongs to (private.rate_limit_token), so an OAuth client's
//    hourly access tokens share one count. Only requests that call tools
//    count, by how many they call.
//  - Per address, for requests answered 401 (no token, or one that isn't
//    live): HMAC-SHA256 of the address under the database's salt
//    (private.rate_limit_salt()); never the address itself, in the
//    database or a log line. An address over its limit is remembered by
//    this instance until its window ends, so its next token-less requests
//    are refused without asking the database.
//
// Client IP: on Vercel (VERCEL set) or with TRUST_PROXY_IP=1, x-real-ip,
// else the first x-forwarded-for entry. Vercel's edge sets both and
// overwrites what the client sent, so they hold while requests reach the
// function through Vercel alone. Anywhere else, the socket's address. IPv6
// counts by its /64.
//
// If the counter can't be reached, requests go through (fail open) and
// "rate limit unavailable" is logged: every tool call needs the same
// database, so refusing would only turn a counter problem into an outage.
//
// Limits are the constants below; RATE_LIMITS ("name=limit/seconds,...")
// overrides some and RATE_LIMIT_SCALE multiplies all, checked at start.

import { createHmac } from "node:crypto";
import type http from "node:http";
import net from "node:net";
import { pool } from "./db.js";
import { failure } from "./failure.js";

export type Limit = { limit: number; window: number };

export const DEFAULT_LIMITS = {
  mcp_token_minute: { limit: 120, window: 60 }, // tool calls per token (grant)
  mcp_token_day: { limit: 10000, window: 86400 },
  mcp_unauth_ip: { limit: 30, window: 60 }, // 401 answers per address
} satisfies Record<string, Limit>;

export type LimitName = keyof typeof DEFAULT_LIMITS;
let LIMITS: Record<LimitName, Limit> = { ...DEFAULT_LIMITS };
let TRUST_PROXY = false;

// Throws an Error naming the variable; the server prints it and exits.
export function configureRateLimits(env: NodeJS.ProcessEnv): void {
  const scale = env.RATE_LIMIT_SCALE === undefined ? 1 : Number(env.RATE_LIMIT_SCALE);
  if (!Number.isInteger(scale) || scale < 1 || scale > 1_000_000) throw new Error("RATE_LIMIT_SCALE must be a whole number from 1");
  const limits = { ...DEFAULT_LIMITS } as Record<LimitName, Limit>;
  for (const name of Object.keys(limits) as LimitName[]) limits[name] = { ...limits[name], limit: limits[name].limit * scale };
  for (const part of (env.RATE_LIMITS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z_]+)=([0-9]{1,9})\/([0-9]{1,6})$/.exec(part);
    if (!m || !(m[1] in limits)) throw new Error("RATE_LIMITS must be name=limit/seconds pairs, with names from mcp/src/ratelimit.ts");
    const [limit, window] = [Number(m[2]), Number(m[3])];
    if (limit < 1 || window < 1 || window > 604800) throw new Error("RATE_LIMITS: a limit is at least 1, a window 1 s to 7 days");
    limits[m[1] as LimitName] = { limit, window };
  }
  if (env.TRUST_PROXY_IP !== undefined && env.TRUST_PROXY_IP !== "1") throw new Error("TRUST_PROXY_IP must be 1 or unset");
  LIMITS = limits;
  TRUST_PROXY = !!env.VERCEL || env.TRUST_PROXY_IP === "1";
}

function normalizeIp(raw: string | undefined): string | undefined {
  let ip = (raw ?? "").trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const kind = net.isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return undefined;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export function clientIp(req: http.IncomingMessage): string {
  if (TRUST_PROXY) {
    const real = req.headers["x-real-ip"];
    const fromReal = normalizeIp(typeof real === "string" ? real : undefined);
    if (fromReal) return fromReal;
    const xff = req.headers["x-forwarded-for"];
    const fromXff = normalizeIp((Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]);
    if (fromXff) return fromXff;
  }
  return normalizeIp(req.socket.remoteAddress) ?? "unknown";
}

const unavailable = (err: unknown) =>
  console.error("rate limit unavailable", (err as { code?: string }).code ?? (err as Error).name);

let salt: Promise<string> | undefined;
function getSalt(): Promise<string> {
  salt ??= pool.query("select private.rate_limit_salt() as s").then(
    (r) => String(r.rows[0]?.s ?? ""),
    (err) => {
      salt = undefined;
      throw err;
    },
  );
  return salt;
}

// A token's tool calls against its grant. The hash is the token's SHA-256,
// as the database stores it. 0, or the seconds to wait. Fails open.
export async function limitToolCalls(tokenHash: string, calls: number): Promise<number> {
  if (calls < 1) return 0;
  const names: LimitName[] = ["mcp_token_minute", "mcp_token_day"];
  try {
    const { rows } = await pool.query("select private.rate_limit_token($1, $2, $3, $4, $5) as wait", [
      tokenHash,
      names,
      names.map((n) => LIMITS[n].window),
      names.map((n) => LIMITS[n].limit),
      names.map(() => calls),
    ]);
    return Number(rows[0]?.wait ?? 0);
  } catch (err) {
    unavailable(err);
    return 0;
  }
}

// Addresses over their 401 limit, by key, until their window ends: this
// instance's shortcut, so a flood without a token doesn't reach the
// database. Bounded; the database stays the authority.
const blocked = new Map<string, number>();
const BLOCKED_MAX = 10_000;

// The address's key: an HMAC, or undefined if the salt can't be read.
async function ipKey(ip: string): Promise<string | undefined> {
  try {
    return createHmac("sha256", await getSalt()).update(`ip\0${ip}`).digest("hex");
  } catch (err) {
    unavailable(err);
    return undefined;
  }
}

// Seconds this instance already knows the address must wait, else 0.
export async function knownBlocked(ip: string): Promise<number> {
  if (!blocked.size) return 0;
  const key = await ipKey(ip);
  const until = key ? blocked.get(key) : undefined;
  if (!until) return 0;
  const left = Math.ceil((until - Date.now()) / 1000);
  if (left > 0) return left;
  blocked.delete(key!);
  return 0;
}

// A 401 answer, counted per address. 0, or the seconds to wait (then the
// answer is a 429 instead). Fails open.
export async function limitUnauthorized(ip: string): Promise<number> {
  const key = await ipKey(ip);
  if (!key) return 0;
  const l = LIMITS.mcp_unauth_ip;
  try {
    const { rows } = await pool.query("select private.rate_limit_hit($1, $2, $3, $4, $5) as wait", [
      ["mcp_unauth_ip"], [key], [l.window], [l.limit], [1],
    ]);
    const wait = Number(rows[0]?.wait ?? 0);
    if (wait) {
      if (blocked.size >= BLOCKED_MAX) blocked.delete(blocked.keys().next().value!);
      blocked.set(key, Date.now() + wait * 1000);
    }
    return wait;
  } catch (err) {
    unavailable(err);
    return 0;
  }
}

// The answer over a limit: 429, Retry-After, and a JSON-RPC error that tells
// the agent to wait. Short, and nothing about what was counted or how.
export const RATE_LIMITED_CODE = -32029;
export function rateLimitedBody(wait: number, id: unknown = null): object {
  // The error model's where and reference (failure.ts), logged like any failure.
  const f = failure({ status: 429, where: "rate limit", why: `Rate limit reached; retry after ${wait} seconds`, code: "rate_limited" });
  return {
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" ? id : null,
    error: {
      code: RATE_LIMITED_CODE,
      message: `Rate limit reached. Wait ${wait} seconds, then retry.`,
      data: { retry_after: wait, where: f.where, ref: f.ref },
    },
  };
}
