// Database access. The server logs in as `reliquary_mcp`, which can do two
// things: resolve a token, and become `authenticated` for one transaction with
// the resolved person and agent in the claims. RLS and the security-definer
// API in supabase/migrations decide everything else.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export type Identity = {
  userId: string;
  tokenId: string;
  agent: string; // the token's name, e.g. "Claude Code on MacBook", or the OAuth client's
};

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
// The same function lives in web/src/db.ts (separate deployables, no shared
// package); keep them in step.
const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const URL_TLS_PARAM = /[?&](sslmode|ssl|sslrootcert|sslcert|sslkey|uselibpqcompat)=/i;

export function poolConfig(env: NodeJS.ProcessEnv = process.env, appDir = APP_DIR): pg.PoolConfig {
  const url = env.DATABASE_URL ?? "";
  const max = Number(env.DB_POOL_MAX ?? 5);
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

const TOKEN_SHAPE = /^rlq_[0-9a-f]{64}$/;

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

export async function resolveToken(token: string): Promise<Identity | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const { rows } = await pool.query(
    "select token_id, user_id, name from private.resolve_access_token($1)",
    [hashOf(token)],
  );
  if (rows.length !== 1) return null;
  return { tokenId: rows[0].token_id, userId: rows[0].user_id, agent: rows[0].name };
}

// An OAuth access token (`rlo_`, issued by the web app's authorization
// server) resolves to its grant, which is an access_tokens row: the same
// identity as a personal token, so scope and the ceiling apply unchanged.
// The database only resolves it for the resource the grant was made for, and
// this server asks for its own MCP_RESOURCE, so a token issued for another
// resource is refused (RFC 8707 audience binding).
const OAUTH_SHAPE = /^rlo_[0-9a-f]{64}$/;

export async function resolveOAuthToken(token: string, resource: string): Promise<Identity | null> {
  if (!OAUTH_SHAPE.test(token)) return null;
  const { rows } = await pool.query(
    "select token_id, user_id, name from private.resolve_oauth_token($1, $2)",
    [hashOf(token), resource],
  );
  if (rows.length !== 1) return null;
  return { tokenId: rows[0].token_id, userId: rows[0].user_id, agent: rows[0].name };
}

// Records the name the MCP client reported at initialize (clientInfo.name),
// for the Tokens page. Keyed by the token's hash, so only a caller holding
// the token can set it. Best effort: never fails the request.
export async function recordClient(token: string, clientName: string): Promise<void> {
  if (!TOKEN_SHAPE.test(token)) return;
  await pool
    .query("select private.record_token_client($1, $2)", [hashOf(token), clientName.slice(0, 200)])
    .catch(() => console.error("record client failed"));
}

// Runs fn in one transaction as the identity's person, acting through their
// agent. The `act` claim is always set for token calls, so the database's
// delegation ceiling (no approving, no policy or member changes, no erasure)
// always applies. `act.tok` names the token; the database limits every call
// to that token's vaults and access (read-only or read-write).
export async function asIdentity<T>(id: Identity, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    // Two round trips before the work: begin, then the role and the claims
    // in one statement (set_config('role', ..., true) is SET LOCAL ROLE).
    await client.query("begin");
    await client.query("select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({
        sub: id.userId,
        role: "authenticated",
        act: { sub: id.tokenId, name: id.agent, tok: id.tokenId },
      }),
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
