// Database access for the web UI. Every request runs in one transaction as
// the signed-in person, with no `act` claim: this is the human-present
// surface, so approvals and policy changes are allowed here and nowhere else.

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

// Pool settings from the environment. Hosted (Vercel sets VERCEL), the
// database is Supabase's shared pooler in transaction mode, so:
//  - TLS is verified against the CA in DATABASE_CA_FILE (the app's
//    supabase-ca.crt; see README). Without it the server refuses to start,
//    rather than connect in plain text or trust any certificate.
//  - sslmode and friends stay out of DATABASE_URL: node-postgres lets URL
//    parameters override the `ssl` object built here.
//  - a small pool per instance (Fluid compute shares it between requests).
// Errors name the variable, never its value: DATABASE_URL holds a password.
// Never pass `name` to a query (no named prepared statements in transaction
// mode) and never a session-level SET.
// The same function lives in mcp/src/db.ts (separate deployables, no shared
// package); keep them in step.
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_TLS_PARAM = /[?&](sslmode|ssl|sslrootcert|sslcert|sslkey|uselibpqcompat)=/i;

export function poolConfig(env: NodeJS.ProcessEnv = process.env, appDir = APP_DIR): pg.PoolConfig {
  const url = env.DATABASE_URL ?? "";
  const max = Number(env.DB_POOL_MAX ?? 3);
  if (!Number.isInteger(max) || max < 1) throw new Error("DB_POOL_MAX must be a positive integer");
  const config: pg.PoolConfig = {
    connectionString: url,
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  };
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
  } else if (env.VERCEL) {
    throw new Error("Refusing to start: VERCEL is set but DATABASE_CA_FILE is not, so DATABASE_URL has no verified TLS");
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

// Begins a transaction as the person, in one round trip: begin and the
// role and claims (set_config('role', ..., true) is SET LOCAL ROLE) as one
// simple query, the claims inlined as an escaped literal, since a
// parameterised query can't carry two statements. A user id that isn't a
// UUID (sessions always carry one) takes two round trips with a parameter.
async function begin(client: pg.PoolClient, userId: string): Promise<void> {
  const claims = JSON.stringify({ sub: userId, role: "authenticated" });
  if (UUID_SHAPE.test(userId)) {
    await client.query(
      `begin; select set_config('role', 'authenticated', true), set_config('request.jwt.claims', ${client.escapeLiteral(claims)}, true)`,
    );
    return;
  }
  await client.query("begin");
  await client.query("select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)", [claims]);
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
type Shared = { userId: string; client: pg.PoolClient | null; open: boolean; done: boolean; broken: boolean };
const shared = new AsyncLocalStorage<Shared>();

export async function readOnlyRequest<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const s: Shared = { userId, client: null, open: false, done: false, broken: false };
  try {
    return await shared.run(s, fn);
  } finally {
    s.done = true;
    const client = s.client;
    s.client = null;
    if (client) {
      if (s.open) await client.query("commit").catch(() => (s.broken = true));
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

export async function asPerson<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const s = shared.getStore();
  if (s && !s.done && s.userId === userId) return inShared(s, fn);
  const client = await db.connect();
  try {
    await begin(client, userId);
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
