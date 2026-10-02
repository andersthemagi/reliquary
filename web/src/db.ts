// Database access for the web UI. Every request runs in one transaction as
// the signed-in person, with no `act` claim: this is the human-present
// surface, so approvals and policy changes are allowed here and nowhere else.

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// DEFAULT_POOL_MAX differs deliberately from mcp/src/db.ts's (3 here, 5
// there): chosen together with the TLS handling below in commit f7e54f3
// ("feat(hosting): Vercel adapters, TLS to Supabase's pooler, PUBLIC_URL
// origin", 2026-09-24) and documented in docs/research/hosting.md section 2
// ("small pool per instance (`max` 3 to 5)") and section 5's env table
// ("DB_POOL_MAX | both | no | 3 web, 5 mcp"). The reason MCP gets more, not
// less: a request there holds one pooled connection for its Session
// (docs/research/server-load.md, "Second pass"), and one that also passes
// the rate limit checks out a second, parallel connection to count it
// ("Third pass": "one more checkout; DB_POOL_MAX is 5") — this app never
// holds more than one connection per request. Below this point, through the
// end of poolConfig(), this file and mcp/src/db.ts are kept byte-identical;
// web/test/db_tls.test.mjs pins that.
const DEFAULT_POOL_MAX = 3;

// Pool settings from the environment. Hosted (Vercel sets VERCEL), the
// database is Supabase's shared pooler in transaction mode, so:
//  - TLS is verified against the CA in DATABASE_CA_FILE (the app's
//    supabase-ca.crt; see README). Without it the server refuses to start,
//    rather than connect in plain text or trust any certificate.
//  - sslmode and friends stay out of DATABASE_URL: node-postgres lets URL
//    parameters override the `ssl` object built here.
//  - a small pool per instance (Fluid compute shares it between requests).
// Self-hosted (SELF_HOSTED=1, deploy/), the database is the operator's, so
// TLS is their choice, but a choice must be made: DATABASE_CA_FILE as above,
// DATABASE_TLS=system (verified against Node's built-in CAs), or
// DATABASE_TLS=off (plain, for a database on the same private network, as
// in deploy/compose). Neither, and the server refuses to start. `off` is
// refused on Vercel.
// Errors name the variable, never its value: DATABASE_URL holds a password.
// Never pass `name` to a query (no named prepared statements in transaction
// mode) and never a session-level SET.
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_TLS_PARAM = /[?&](sslmode|ssl|sslrootcert|sslcert|sslkey|uselibpqcompat)=/i;

export function poolConfig(env: NodeJS.ProcessEnv = process.env, appDir = APP_DIR): pg.PoolConfig {
  const url = env.DATABASE_URL ?? "";
  const max = Number(env.DB_POOL_MAX ?? DEFAULT_POOL_MAX);
  if (!Number.isInteger(max) || max < 1) throw new Error("DB_POOL_MAX must be a positive integer");
  const config: pg.PoolConfig = {
    connectionString: url,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  };
  const tls = env.DATABASE_TLS ?? "";
  if (tls !== "" && tls !== "off" && tls !== "system") throw new Error("DATABASE_TLS must be off or system");
  if (tls && env.DATABASE_CA_FILE) throw new Error("Set DATABASE_CA_FILE or DATABASE_TLS, not both");
  if (tls && URL_TLS_PARAM.test(url)) {
    throw new Error("DATABASE_URL must not carry sslmode or other TLS parameters when DATABASE_TLS is set");
  }
  if (env.DATABASE_CA_FILE) {
    if (URL_TLS_PARAM.test(url)) {
      throw new Error("DATABASE_URL must not carry sslmode or other TLS parameters when DATABASE_CA_FILE is set");
    }
    let ca: string;
    try {
      ca = readFileSync(resolve(appDir, env.DATABASE_CA_FILE), "utf8");
    } catch {
      throw new Error("DATABASE_CA_FILE can't be read");
    }
    if (!ca.includes("-----BEGIN CERTIFICATE-----")) throw new Error("DATABASE_CA_FILE holds no PEM certificate");
    config.ssl = { ca, rejectUnauthorized: true };
  } else if (tls === "system") {
    config.ssl = { rejectUnauthorized: true };
  } else if (tls === "off") {
    if (env.VERCEL) throw new Error("Refusing to start: DATABASE_TLS=off is for a database on the same private network, never on Vercel");
    config.ssl = false;
  } else if (env.VERCEL) {
    throw new Error("Refusing to start: VERCEL is set but DATABASE_CA_FILE is not, so DATABASE_URL has no verified TLS");
  } else if (env.SELF_HOSTED === "1") {
    throw new Error(
      "Refusing to start: SELF_HOSTED is set but neither DATABASE_CA_FILE nor DATABASE_TLS is. Set DATABASE_CA_FILE to verify the database's certificate against a CA, DATABASE_TLS=system to verify it against the system's CAs, or DATABASE_TLS=off for a database on the same private network",
    );
  }
  return config;
}

export const pool = new pg.Pool(poolConfig());

// The pool asPerson() checks out from; tests swap in one that counts.
let db: pg.Pool = pool;
export function usePool(p: pg.Pool): void {
  db = p;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The browser session a request runs for (server.ts sets it around a
// request's pages): when its access JWT was issued. begin() passes it to
// the database with the claims, and private.check_session() refuses the
// transaction (SQLSTATE RLA01) if the person has signed out everywhere
// since (20260926140100_sign_out_everywhere.sql). Outside a request (the
// OAuth token endpoint, tests) there is none, and nothing is checked.
const sessionStore = new AsyncLocalStorage<{ issuedAt?: number }>();
export function inSession<T>(s: { issuedAt?: number }, fn: () => Promise<T>): Promise<T> {
  return sessionStore.run(s, fn);
}
const CHECK_SESSION = "select private.check_session()";

// Begins a transaction as the person, in one round trip: begin, the role
// and claims (set_config('role', ..., true) is SET LOCAL ROLE) and the
// session check as one simple query, the claims inlined as an escaped
// literal, since a parameterised query can't carry several statements. A
// user id that isn't a UUID (sessions always carry one) takes three round
// trips with a parameter.
async function begin(client: pg.PoolClient, userId: string): Promise<void> {
  const iat = sessionStore.getStore()?.issuedAt;
  const claims = JSON.stringify(
    Number.isInteger(iat) ? { sub: userId, role: "authenticated", iat } : { sub: userId, role: "authenticated" },
  );
  if (UUID_SHAPE.test(userId)) {
    await client.query(
      `begin; select set_config('role', 'authenticated', true), set_config('request.jwt.claims', ${client.escapeLiteral(claims)}, true); ${CHECK_SESSION}`,
    );
    return;
  }
  await client.query("begin");
  await client.query("select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)", [claims]);
  await client.query(CHECK_SESSION);
}

// One page, one transaction (docs/research/server-load.md, "Second pass").
// Inside readOnlyRequest(), every asPerson() for the same person shares one
// connection and one transaction, opened by the first call and committed
// when the page is built: the Review badge's count and all of the page's
// queries, however many asPerson() calls it makes. Only GET pages run this
// way; they only read, so one snapshot for the page is also more
// consistent. A call that fails rolls the transaction back and the next
// call opens a fresh one, so a caught error can't poison the rest of the
// page. POSTs keep a transaction per call. Calls must not overlap (none do:
// no page runs asPerson() calls concurrently).
//
// The transaction commits only when the whole page was built: if fn throws
// (a query, or rendering after the queries), it rolls back. That matters
// for the one write a GET makes, Home taking its deletion notices
// (public.take_deletion_notices): a page that failed to render leaves them
// for next time.
type Shared = { userId: string; client: pg.PoolClient | null; open: boolean; done: boolean; broken: boolean };
const shared = new AsyncLocalStorage<Shared>();

export async function readOnlyRequest<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const s: Shared = { userId, client: null, open: false, done: false, broken: false };
  let ok = false;
  try {
    const result = await shared.run(s, fn);
    ok = true;
    return result;
  } finally {
    s.done = true;
    const client = s.client;
    s.client = null;
    if (client) {
      if (s.open) await client.query(ok ? "commit" : "rollback").catch(() => (s.broken = true));
      s.open = false;
      client.release(s.broken || undefined);
    }
  }
}

async function inShared<T>(s: Shared, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  if (!s.client) s.client = await db.connect();
  const client = s.client;
  if (!s.open) {
    try {
      await begin(client, s.userId);
    } catch (err) {
      await client.query("rollback").catch(() => (s.broken = true));
      throw err;
    }
    s.open = true;
  }
  try {
    return await fn(client);
  } catch (err) {
    s.open = false;
    await client.query("rollback").catch(() => (s.broken = true));
    throw err;
  }
}

// A CLI grant, as the env API resolves it (envapi.ts).
export type Grant = { grantId: string; userId: string; name: string };

const HEX64 = /^[0-9a-f]{64}$/;

// One env API request's work on one pooled connection, as the MCP server
// does it (docs/research/server-load.md, "Third pass"): check out, then in
// one round trip begin, resolve the CLI token's hash for `resource` and
// become its person through the grant (private.env_begin: the claims
// envapi's asGrant sets), run fn, commit. Null when the token doesn't
// resolve (nothing held, nothing written). For GET routes only: a push
// reads its body after authenticating, and a transaction must not stay
// open across that.
//
// Before: resolve on one checkout (1 round trip), then begin, the claims,
// the work and commit on a second (3 + work). Now: 1 checkout, 2 + work.
export async function asCliToken<T>(
  tokenHash: string,
  resource: string,
  fn: (c: pg.PoolClient, g: Grant) => Promise<T>,
): Promise<{ grant: Grant; result: T } | null> {
  // The hash is hex we computed; the resource our own configured URL. Both
  // are escaped anyway: inlined so begin and the resolve go as one simple
  // query (a parameterised query can't carry two statements).
  if (!HEX64.test(tokenHash)) return null;
  const client = await db.connect();
  let broken = false;
  try {
    const results = (await client.query(
      `begin; select token_id, user_id, name from private.env_begin(${client.escapeLiteral(tokenHash)}, ${client.escapeLiteral(resource)})`,
    )) as unknown as pg.QueryResult[];
    const rows = results[1]?.rows ?? [];
    if (rows.length !== 1) {
      await client.query("rollback");
      return null;
    }
    const grant: Grant = { grantId: rows[0].token_id, userId: rows[0].user_id, name: rows[0].name };
    const result = await fn(client, grant);
    await client.query("commit");
    return { grant, result };
  } catch (err) {
    await client.query("rollback").catch(() => (broken = true));
    throw err;
  } finally {
    client.release(broken || undefined);
  }
}

export async function asPerson<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const s = shared.getStore();
  if (s && !s.done && s.userId === userId) return inShared(s, fn);
  const client = await db.connect();
  let broken = false;
  try {
    await begin(client, userId);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => (broken = true));
    throw err;
  } finally {
    client.release(broken || undefined);
  }
}
