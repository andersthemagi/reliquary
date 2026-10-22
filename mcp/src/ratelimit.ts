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
//  - Per token, thread writes (open_thread, post_message) a minute and a
//    day, inside the same count: every member reads a thread, so it is a
//    place to spam, and the general limit is far too loose for that.
//  - Per token, asking for work (request_work, and claim_step, which runs
//    the same evaluation for a named step) a minute, inside the same count
//    (docs/design.md "Claims and work plans" item 8: the spike measured 30).
//    An agent told to wait that asks again at once is answered cheaply by
//    the database, but it is still a request; this keeps a careless one
//    from costing everyone.
//  - Per person, tool calls and asking for work a minute, across all their
//    tokens, inside the same count (private.rate_limit_token_and_person,
//    20261022110000_rate_limit_person.sql). A person may connect as many
//    agents as they like; their calls count together, so many tokens are
//    no more allowance than one person's (issue #487: 500 connections
//    asking at once each got their own 30 before any was refused).
//  - Per address, for requests answered 401 (no token, or one that isn't
//    live): HMAC-SHA256 of the address under the database's salt
//    (private.rate_limit_salt()); never the address itself, in the
//    database or a log line. An address over its limit is remembered by
//    this instance until its window ends, so its next token-less requests
//    are refused without asking the database.
//
// Client IP: on Netlify (NETLIFY set), x-nf-client-connection-ip only
// (Netlify's edge sets it and overwrites what the client sent, so it holds
// while requests reach the function through Netlify alone). With
// TRUST_PROXY_IP=1 (a self-hosted reverse proxy), x-real-ip, else the first
// x-forwarded-for entry. Anywhere else, or when that header is missing, the
// socket's address. IPv6 counts by its /64.
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
  mcp_thread_post_minute: { limit: 20, window: 60 }, // thread writes per token (grant)
  mcp_thread_post_day: { limit: 300, window: 86400 },
  mcp_request_work_minute: { limit: 30, window: 60 }, // asking for work per token (grant)
  mcp_person_minute: { limit: 1200, window: 60 }, // tool calls per person, all their tokens
  mcp_person_request_work_minute: { limit: 120, window: 60 }, // asking for work per person: 20 agents at the 10 s floor
} satisfies Record<string, Limit>;

// The tools whose calls also count as thread writes.
export const THREAD_WRITES: ReadonlySet<string> = new Set(["open_thread", "post_message"]);
// The tools whose calls also count as asking for work. Not my_places: it
// writes nothing and is one indexed read, the call an agent makes instead of
// request_work per plan, so it counts only against the general limit.
export const WORK_REQUESTS: ReadonlySet<string> = new Set(["request_work", "claim_step"]);

export type LimitName = keyof typeof DEFAULT_LIMITS;
let LIMITS: Record<LimitName, Limit> = { ...DEFAULT_LIMITS };
// Which forwarding headers name the client: Netlify's own, a self-hosted
// proxy's, or none (the socket's address).
let PROXY: "netlify" | "self" | undefined;

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
  if (env.TRUST_PROXY_IP !== undefined && env.TRUST_PROXY_IP !== "1" && env.TRUST_PROXY_IP !== "0") throw new Error("TRUST_PROXY_IP must be 1, 0 or unset");
  LIMITS = limits;
  PROXY = env.NETLIFY ? "netlify" : env.TRUST_PROXY_IP === "1" ? "self" : undefined;
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
  const header = (name: string) => {
    const v = req.headers[name];
    return normalizeIp((Array.isArray(v) ? v[0] : v)?.split(",")[0]);
  };
  // Netlify passes x-real-ip and x-forwarded-for through from the client
  // (checked on a deployed function, #221), so on Netlify only its own header
  // counts; a self-hosted proxy doesn't set Netlify's, so there it's ignored.
  const ip =
    PROXY === "netlify" ? header("x-nf-client-connection-ip")
    : PROXY === "self" ? header("x-real-ip") ?? header("x-forwarded-for")
    : undefined;
  if (ip) return ip;
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

// A token's tool calls against its grant and its person, `threadWrites` of
// them counted again as thread writes and `workRequests` as asking for
// work. The hash is the token's SHA-256, as the database stores it. 0, the
// seconds to wait, or "unavailable" when the count couldn't be made: the
// caller fails open, except for asking for work (busyWait).
export async function limitToolCalls(tokenHash: string, calls: number, threadWrites = 0, workRequests = 0): Promise<number | "unavailable"> {
  if (calls < 1) return 0;
  const names: LimitName[] = ["mcp_token_minute", "mcp_token_day"];
  if (threadWrites > 0) names.push("mcp_thread_post_minute", "mcp_thread_post_day");
  if (workRequests > 0) names.push("mcp_request_work_minute");
  const person: LimitName[] = workRequests > 0 ? ["mcp_person_minute", "mcp_person_request_work_minute"] : ["mcp_person_minute"];
  const cost = (n: LimitName) => (n.startsWith("mcp_thread_") ? threadWrites : n.endsWith("request_work_minute") ? workRequests : calls);
  try {
    const { rows } = await pool.query(
      "select o_wait, o_person from private.rate_limit_token_and_person($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        tokenHash,
        names, names.map((n) => LIMITS[n].window), names.map((n) => LIMITS[n].limit), names.map(cost),
        person, person.map((n) => LIMITS[n].window), person.map((n) => LIMITS[n].limit), person.map(cost),
      ],
    );
    const wait = Number(rows[0]?.o_wait ?? 0);
    // A refused call counts nothing, so only a refused single call shows a
    // count already at its limit: a refused batch may leave room for one.
    if (wait && calls === 1) {
      remember(limited, limitedKey(tokenHash, threadWrites > 0, workRequests > 0), wait);
      const owner = owners.get(tokenHash);
      if (rows[0]?.o_person && owner) remember(limited, personKey(owner, workRequests > 0), wait);
    }
    return wait;
  } catch (err) {
    unavailable(err);
    return "unavailable";
  }
}

// Asking for work with its count out of reach is told to wait instead of
// going ahead uncounted: under overload the counts time out, and a crowd let
// through then is what overloads the database further
// (docs/research/server-load.md, "Waiting in line through the MCP server,
// simulated"). Other tool calls still fail open. Spread over 5 to 15
// seconds, so the agents told together don't come back together.
export const busyWait = () => 5 + Math.floor(Math.random() * 11);

// Tokens whose single call was refused, until that limit's window ends: the
// same shortcut as `blocked` below, so a crowd ignoring its 429s stops
// reaching the database (and stops making the counts that fail open when
// it is overloaded; docs/research/server-load.md, "Waiting in line through
// the MCP server, simulated"). Keyed by which buckets the refused call was
// counted in: the refusal came from one of them, so a call counted in all
// of them is refused too, and any other goes to the database. A token
// revoked meanwhile is told to wait, not that it isn't live, until then.
const limited = new Map<string, number>();
const limitedKey = (tokenHash: string, threadWrite: boolean, workRequest: boolean) =>
  `${tokenHash}:${threadWrite ? "t" : ""}${workRequest ? "w" : ""}`;

// A person refused, the same way: their tokens this instance has seen
// (`owners`, learned as each token resolves) are refused from memory too, so
// a person's crowd of connections costs the database one refusal, not one
// per connection. A token not seen yet goes to the database once.
const personKey = (userId: string, workRequest: boolean) => `person:${userId}:${workRequest ? "w" : ""}`;
const owners = new Map<string, string>();

// Called once a token resolves: whose it is, for the person shortcut.
export function noteOwner(tokenHash: string, userId: string): void {
  if (owners.get(tokenHash) === userId) return;
  if (owners.size >= BLOCKED_MAX) owners.delete(owners.keys().next().value!);
  owners.set(tokenHash, userId);
}

// Seconds this instance already knows the token must wait before a request
// with these calls, else 0.
export function knownLimited(tokenHash: string, threadWrites: number, workRequests: number): number {
  if (!limited.size) return 0;
  let wait = 0;
  for (const t of threadWrites > 0 ? [false, true] : [false]) {
    for (const w of workRequests > 0 ? [false, true] : [false]) wait = Math.max(wait, left(limited, limitedKey(tokenHash, t, w)));
  }
  const owner = owners.get(tokenHash);
  if (owner) {
    for (const w of workRequests > 0 ? [false, true] : [false]) wait = Math.max(wait, left(limited, personKey(owner, w)));
  }
  return wait;
}

// Addresses over their 401 limit, by key, until their window ends: this
// instance's shortcut, so a flood without a token doesn't reach the
// database. Bounded; the database stays the authority.
const blocked = new Map<string, number>();
const BLOCKED_MAX = 10_000;

function remember(map: Map<string, number>, key: string, wait: number): void {
  if (map.size >= BLOCKED_MAX) map.delete(map.keys().next().value!);
  map.set(key, Date.now() + wait * 1000);
}

// Seconds left of what `map` remembers for `key`, else 0.
function left(map: Map<string, number>, key: string): number {
  const until = map.get(key);
  if (!until) return 0;
  const s = Math.ceil((until - Date.now()) / 1000);
  if (s > 0) return s;
  map.delete(key);
  return 0;
}

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
  return key ? left(blocked, key) : 0;
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
    if (wait) remember(blocked, key, wait);
    return wait;
  } catch (err) {
    unavailable(err);
    return 0;
  }
}

// The answer over a limit: 429, Retry-After, and a JSON-RPC error that tells
// the agent to wait. Short, and nothing about what was counted or how.
// Busy uses the same code: either way the agent's next step is to wait.
const RATE_LIMITED_CODE = -32029;
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

// The answer when asking for work couldn't be counted: 503, Retry-After,
// and the same JSON-RPC error to wait as a rate limit, saying why.
export function busyBody(wait: number, id: unknown = null): object {
  const f = failure({ status: 503, where: "rate limit", why: `The database is too busy to count asking for work; retry after ${wait} seconds`, code: "busy" });
  return {
    jsonrpc: "2.0",
    id: typeof id === "string" || typeof id === "number" ? id : null,
    error: {
      code: RATE_LIMITED_CODE,
      message: `Reliquary is busy. Wait ${wait} seconds, then ask for work again.`,
      data: { retry_after: wait, where: f.where, ref: f.ref },
    },
  };
}
