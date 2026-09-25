// Rate limits for the web app's public surfaces (docs/public/reference/limits.md,
// "Rate limits"; supabase/migrations/20260925200000_rate_limits.sql).
//
// The app runs as many short-lived instances on Vercel, so a counter in one
// instance's memory limits nothing: every count is one upsert in Postgres
// (private.rate_limit_hit, or private.rate_limit_token for a token's grant),
// shared by every instance. Fixed windows; a refused request counts nothing.
//
// Keys: an IP address, an email address or a session is never sent to the
// database or logged. The key is HMAC-SHA256 under a salt the database made
// at random (private.rate_limit_salt(), readable by the apps' roles only,
// fetched once per instance), of the kind and the value. A token is keyed
// by its grant, in the database.
//
// Client IP: on Vercel (VERCEL set) or with TRUST_PROXY_IP=1, the address
// Vercel's edge puts in x-real-ip (else the first x-forwarded-for entry).
// Vercel sets both itself and overwrites what the client sent, so they
// can't be forged from outside; that holds only while requests reach the
// function through Vercel alone (a proxy in front would make every request
// its address). Anywhere else, the socket's address. IPv6 addresses count
// by their /64, which one household or server usually holds whole.
//
// When the counter can't be reached: sign-in (asking for a code, entering
// one, opening a link) fails closed, with the "sign-in is unavailable"
// answer, since that is where guessing pays; everything else fails open and
// logs "rate limit unavailable", since everything else needs the same
// database and refusing would turn a counter problem into an outage.
//
// Limits are the constants below. RATE_LIMITS overrides some
// ("name=limit/seconds,..."), and RATE_LIMIT_SCALE multiplies every limit
// (the tests' shared servers use it); both are checked at start.

import { createHmac } from "node:crypto";
import type http from "node:http";
import net from "node:net";
import { pool } from "./db.js";
import { html, notice, when, type Theme } from "./html.js";

export type Limit = { limit: number; window: number };

export const DEFAULT_LIMITS = {
  // Sign-in (AUTH_MODE=supabase)
  signin_email_address: { limit: 5, window: 3600 }, // codes asked for, per email address
  signin_email_ip: { limit: 20, window: 3600 }, // codes asked for, per IP
  signin_code_address: { limit: 5, window: 900 }, // codes entered, per email address
  signin_code_ip: { limit: 30, window: 900 }, // codes entered and links opened, per IP
  signin_refresh_session: { limit: 30, window: 3600 }, // session refreshes, per session
  // OAuth
  oauth_authorize_ip: { limit: 60, window: 600 },
  oauth_authorize_client: { limit: 600, window: 600 },
  oauth_token_ip: { limit: 120, window: 600 },
  oauth_token_client: { limit: 1200, window: 600 },
  oauth_revoke_ip: { limit: 60, window: 600 },
  oauth_revoke_client: { limit: 600, window: 600 },
  cimd_fetch_host: { limit: 20, window: 600 }, // client metadata fetches, per client host
  // Invites
  invite_ip: { limit: 30, window: 3600 }, // invite links opened or accepted, per IP
  // The env API (the CLI)
  env_grant_minute: { limit: 60, window: 60 }, // requests per CLI grant
  env_grant_day: { limit: 5000, window: 86400 },
  // Web forms
  web_write_minute: { limit: 60, window: 60 }, // form posts per session
  web_write_hour: { limit: 1000, window: 3600 },
} satisfies Record<string, Limit>;

export type LimitName = keyof typeof DEFAULT_LIMITS;
let LIMITS: Record<LimitName, Limit> = { ...DEFAULT_LIMITS };
let TRUST_PROXY = false;

// Reads RATE_LIMITS, RATE_LIMIT_SCALE and TRUST_PROXY_IP once, at start.
// Throws an Error naming the variable; the server prints it and exits.
export function configureRateLimits(env: NodeJS.ProcessEnv): void {
  const scale = env.RATE_LIMIT_SCALE === undefined ? 1 : Number(env.RATE_LIMIT_SCALE);
  if (!Number.isInteger(scale) || scale < 1 || scale > 1_000_000) throw new Error("RATE_LIMIT_SCALE must be a whole number from 1");
  const limits = { ...DEFAULT_LIMITS } as Record<LimitName, Limit>;
  for (const name of Object.keys(limits) as LimitName[]) limits[name] = { ...limits[name], limit: limits[name].limit * scale };
  for (const part of (env.RATE_LIMITS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([a-z_]+)=([0-9]{1,9})\/([0-9]{1,6})$/.exec(part);
    if (!m || !(m[1] in limits)) throw new Error("RATE_LIMITS must be name=limit/seconds pairs, with names from web/src/ratelimit.ts");
    const [limit, window] = [Number(m[2]), Number(m[3])];
    if (limit < 1 || window < 1 || window > 604800) throw new Error("RATE_LIMITS: a limit is at least 1, a window 1 s to 7 days");
    limits[m[1] as LimitName] = { limit, window };
  }
  if (env.TRUST_PROXY_IP !== undefined && env.TRUST_PROXY_IP !== "1") throw new Error("TRUST_PROXY_IP must be 1 or unset");
  LIMITS = limits;
  TRUST_PROXY = !!env.VERCEL || env.TRUST_PROXY_IP === "1";
}
export const limitOf = (name: LimitName): Limit => LIMITS[name];

// ---------------------------------------------------------------------------
// The client's address

function normalizeIp(raw: string | undefined): string | undefined {
  let ip = (raw ?? "").trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  const kind = net.isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return undefined;
  // The /64: the first four groups, expanded.
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
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0];
    const fromXff = normalizeIp(first);
    if (fromXff) return fromXff;
  }
  return normalizeIp(req.socket.remoteAddress) ?? "unknown";
}

// ---------------------------------------------------------------------------
// Counting

let salt: Promise<string> | undefined;
function getSalt(): Promise<string> {
  salt ??= pool.query("select private.rate_limit_salt() as s").then(
    (r) => {
      const s = r.rows[0]?.s;
      if (typeof s !== "string" || !/^[0-9a-f]{64}$/.test(s)) throw new Error("no salt");
      return s;
    },
    (err) => {
      salt = undefined;
      throw err;
    },
  );
  return salt;
}

// The kind names what the value is ("ip", "email", "session", "client",
// "host"), so equal strings of different kinds never share a key.
export type Check = { name: LimitName; kind: string; value: string; cost?: number };

export class RateLimited extends Error {
  constructor(readonly retryAfter: number) {
    super("rate limited");
  }
}

// 0 when every check is within its limit, else the seconds to wait. Throws
// when the counter can't be reached (limit and limitStrict decide what then).
async function count(checks: Check[]): Promise<number> {
  if (!checks.length) return 0;
  const s = await getSalt();
  const key = (c: Check) => createHmac("sha256", s).update(`${c.kind}\0${c.value}`).digest("hex");
  const { rows } = await pool.query("select private.rate_limit_hit($1, $2, $3, $4, $5) as wait", [
    checks.map((c) => c.name),
    checks.map(key),
    checks.map((c) => LIMITS[c.name].window),
    checks.map((c) => LIMITS[c.name].limit),
    checks.map((c) => c.cost ?? 1),
  ]);
  return Number(rows[0]?.wait ?? 0);
}

const unavailableLog = (err: unknown) =>
  console.error("rate limit unavailable", (err as { code?: string }).code ?? (err as Error).name);

// Fails open: 0 (and a log line) when the counter can't be reached.
export async function limit(checks: Check[]): Promise<number> {
  try {
    return await count(checks);
  } catch (err) {
    unavailableLog(err);
    return 0;
  }
}

// Fails closed: "unavailable" when the counter can't be reached.
export async function limitStrict(checks: Check[]): Promise<number | "unavailable"> {
  try {
    return await count(checks);
  } catch (err) {
    unavailableLog(err);
    return "unavailable";
  }
}

// A token's request, counted against its grant (private.rate_limit_token).
// Fails open. The hash is the token's SHA-256, as the database stores it.
export async function limitToken(tokenHash: string, checks: { name: LimitName; cost?: number }[]): Promise<number> {
  try {
    const { rows } = await pool.query("select private.rate_limit_token($1, $2, $3, $4, $5) as wait", [
      tokenHash,
      checks.map((c) => c.name),
      checks.map((c) => LIMITS[c.name].window),
      checks.map((c) => LIMITS[c.name].limit),
      checks.map((c) => c.cost ?? 1),
    ]);
    return Number(rows[0]?.wait ?? 0);
  } catch (err) {
    unavailableLog(err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Answers

// "12 seconds", "3 minutes", "2 hours": rounded up.
export function waitText(seconds: number): string {
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  if (seconds < 90) return unit(Math.max(1, Math.ceil(seconds)), "second");
  if (seconds < 90 * 60) return unit(Math.ceil(seconds / 60), "minute");
  return unit(Math.ceil(seconds / 3600), "hour");
}

// The 429 page: when to try again, in words and as a time.
export function tooManyPage(retryAfter: number, theme: Theme, what = "That was too many requests in a short time"): string {
  // Rounded up to the minute, as when() shows minutes.
  const at = new Date(Math.ceil((Date.now() + retryAfter * 1000) / 60_000) * 60_000);
  return notice(
    "Too many requests",
    html`${what}, so Reliquary is pausing them. Try again in ${waitText(retryAfter)}, after ${when(at)}. Nothing was changed.`,
    theme,
  );
}
