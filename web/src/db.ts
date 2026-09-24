// Database access for the web UI. Every request runs in one transaction as
// the signed-in person, with no `act` claim: this is the human-present
// surface, so approvals and policy changes are allowed here and nowhere else.

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

export async function asPerson<T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    // Two round trips before the work: begin, then the role and the claims
    // in one statement (set_config('role', ..., true) is SET LOCAL ROLE).
    await client.query("begin");
    await client.query("select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId, role: "authenticated" }),
    ]);
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
