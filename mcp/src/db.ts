// Database access. The server logs in as `reliquary_mcp`, which can do two
// things: resolve a token, and become `authenticated` for one transaction with
// the resolved person and agent in the claims. RLS and the security-definer
// API in supabase/migrations decide everything else.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { fail, withRequest } from "./failure.js";

export type Identity = {
  userId: string;
  tokenId: string;
  agent: string; // the token's name, e.g. "Claude Code on MacBook", or the OAuth client's
};

// DEFAULT_POOL_MAX differs deliberately from web/src/db.ts's (5 here, 3
// there): chosen together with the TLS handling below in commit f7e54f3
// ("feat(hosting): Vercel adapters, TLS to Supabase's pooler, PUBLIC_URL
// origin", 2026-09-24) and documented in docs/research/hosting.md section 2
// ("small pool per instance (`max` 3 to 5)") and section 5's env table
// ("DB_POOL_MAX | both | no | 3 web, 5 mcp"). The reason MCP gets more: a
// request that calls a tool holds one pooled connection for its Session
// (docs/research/server-load.md, "Second pass"), and one that also passes
// the rate limit checks out a second, parallel connection to count it
// ("Third pass": "one more checkout; DB_POOL_MAX is 5"). A web request is
// meant to hold one connection at a time (web/src/db.ts, readOnlyRequest).
// Below this point, through the
// end of poolConfig(), this file and web/src/db.ts are kept byte-identical;
// web/test/db_tls.test.mjs pins that.
const DEFAULT_POOL_MAX = 5;

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

// A connection that drops (a pooler reset, a database restart, the network)
// makes pg emit 'error' on its client, and an 'error' nobody listens for is an
// uncaught exception: the process ends, and every request on it. pg-pool
// listens only while a client is idle; this listens for the client's whole
// life, so one a request is holding is covered too. The pool discards the dead
// client by itself. pg can emit twice for one drop (the server's FATAL, then
// "Connection terminated"); the first is the cause, so only it is logged.
pool.on("connect", (client) => {
  let logged = false;
  client.on("error", (err) => {
    if (logged) return;
    logged = true;
    withRequest("Keeping a database connection open", "db connection", () => fail(err, { where: "database" }));
  });
});
// pg-pool re-emits an idle client's error here, after the listener above.
pool.on("error", () => {});

const TOKEN_SHAPE = /^rlq_[0-9a-f]{64}$/;

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

export async function resolveToken(token: string, db: pg.Pool = pool): Promise<Identity | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const { rows } = await db.query(
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

export async function resolveOAuthToken(token: string, resource: string, db: pg.Pool = pool): Promise<Identity | null> {
  if (!OAUTH_SHAPE.test(token)) return null;
  const { rows } = await db.query(
    "select token_id, user_id, name from private.resolve_oauth_token($1, $2)",
    [hashOf(token), resource],
  );
  if (rows.length !== 1) return null;
  return { tokenId: rows[0].token_id, userId: rows[0].user_id, agent: rows[0].name };
}

// Records the name the MCP client reported at initialize (clientInfo.name),
// for the Connections page. Keyed by the token's hash, so only a caller holding
// the token can set it. Best effort: never fails the request.
export async function recordClient(token: string, clientName: string): Promise<void> {
  if (!TOKEN_SHAPE.test(token)) return;
  await pool
    .query("select private.record_token_client($1, $2)", [hashOf(token), clientName.slice(0, 200)])
    .catch(() => console.error("record client failed"));
}

// A token as the database resolves it: its hash, and for an OAuth access
// token the resource it must have been issued for (null for a personal
// token). Null when the token has neither shape.
export type TokenRef = { hash: string; resource: string | null };

export function tokenRef(token: string, resource: string): TokenRef | null {
  if (TOKEN_SHAPE.test(token)) return { hash: hashOf(token), resource: null };
  if (OAUTH_SHAPE.test(token)) return { hash: hashOf(token), resource };
  return null;
}

// One MCP request's database work on one pooled connection
// (docs/research/server-load.md, "Second pass"). open() checks the
// connection out and, in one round trip, begins a transaction, resolves the
// token and becomes its person (private.mcp_begin: the same claims
// asIdentity sets, so scope and the agent ceiling apply unchanged). The
// first tool call works in that transaction; a later call in the same
// request (a batch) begins another, resolving the token again. Calls run
// one at a time. close() commits a transaction no call used (resolving may
// have written last_used_at) and releases the connection.
//
// Before, a tool call resolved the token on one checkout (1 round trip),
// then took a second for begin, the claims, the work and commit (3 + work).
// Now: 1 checkout, begin-and-resolve in 1 round trip, the work, commit.
export class Session {
  private client: pg.PoolClient | null = null;
  private inTx = false;
  private broken = false;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ref: TokenRef,
    private readonly db: pg.Pool = pool,
  ) {}

  // The token's identity, or null (no such live token; nothing is held).
  async open(): Promise<Identity | null> {
    this.client = await this.db.connect();
    let id: Identity | null = null;
    try {
      id = await this.begin();
    } finally {
      if (!id) await this.close();
    }
    return id;
  }

  // Both values are checked shapes (hex, and our own configured URL), and
  // escaped anyway: inlined so begin and the resolve go in one simple-query
  // round trip (a parameterised query can't carry two statements).
  private async begin(): Promise<Identity | null> {
    const c = this.client!;
    const resource = this.ref.resource === null ? "null" : c.escapeLiteral(this.ref.resource);
    this.inTx = true;
    let results: pg.QueryResult[];
    try {
      results = (await c.query(
        `begin; select token_id, user_id, name from private.mcp_begin(${c.escapeLiteral(this.ref.hash)}, ${resource})`,
      )) as unknown as pg.QueryResult[];
    } catch (err) {
      await this.end("rollback");
      throw err;
    }
    const rows = results[1]?.rows ?? [];
    if (rows.length !== 1) {
      await this.end("rollback");
      return null;
    }
    return { tokenId: rows[0].token_id, userId: rows[0].user_id, agent: rows[0].name };
  }

  private async end(how: "commit" | "rollback"): Promise<void> {
    this.inTx = false;
    try {
      await this.client!.query(how);
    } catch (err) {
      if (how === "rollback") this.broken = true;
      else throw err;
    }
  }

  run<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.closed || !this.client) throw new Error("session closed");
      // A later call re-resolves: a token revoked mid-batch stops working.
      if (!this.inTx && !(await this.begin())) throw new TokenGone();
      try {
        const result = await fn(this.client);
        await this.end("commit");
        return result;
      } catch (err) {
        if (this.inTx) await this.end("rollback");
        throw err;
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }

  close(): Promise<void> {
    const done = this.queue.then(async () => {
      if (this.closed) return;
      this.closed = true;
      if (!this.client) return;
      if (this.inTx) await this.end("commit").catch(() => (this.broken = true));
      this.client.release(this.broken || undefined);
      this.client = null;
    });
    this.queue = done.catch(() => {});
    return done;
  }
}

export class TokenGone extends Error {
  constructor() {
    super("token no longer valid");
  }
}

// Runs fn in one transaction as the identity's person, acting through their
// agent. The `act` claim is always set for token calls, so the database's
// delegation ceiling (no approving, no policy or member changes, no erasure)
// always applies. `act.tok` names the token; the database limits every call
// to that token's vaults and access (read-only or read-write).
// Tool calls normally go through a Session; this stays for callers that
// already hold an identity.
export async function asIdentity<T>(id: Identity, fn: (c: pg.PoolClient) => Promise<T>, db: pg.Pool = pool): Promise<T> {
  const client = await db.connect();
  try {
    // Two round trips before the work: begin, then the role and the claims
    // in one statement (set_config('role', ..., true) is SET LOCAL ROLE).
    // The claims carry the token's name, which its person chose, so they go
    // as a parameter, never inlined.
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
