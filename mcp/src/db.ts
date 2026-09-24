// Database access. The server logs in as `reliquary_mcp`, which can do two
// things: resolve a token, and become `authenticated` for one transaction with
// the resolved person and agent in the claims. RLS and the security-definer
// API in supabase/migrations decide everything else.

import { createHash } from "node:crypto";
import pg from "pg";

export type Identity = {
  userId: string;
  tokenId: string;
  agent: string; // the token's name, e.g. "Claude Code on MacBook"
};

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX ?? 10),
});

const TOKEN_SHAPE = /^rlq_[0-9a-f]{64}$/;

export async function resolveToken(token: string): Promise<Identity | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const hash = createHash("sha256").update(token).digest("hex");
  const { rows } = await pool.query(
    "select token_id, user_id, name from private.resolve_access_token($1)",
    [hash],
  );
  if (rows.length !== 1) return null;
  return { tokenId: rows[0].token_id, userId: rows[0].user_id, agent: rows[0].name };
}

// Runs fn in one transaction as the identity's person, acting through their
// agent. The `act` claim is always set for token calls, so the database's
// delegation ceiling (no approving, no policy or member changes, no erasure)
// always applies.
export async function asIdentity<T>(id: Identity, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({
        sub: id.userId,
        role: "authenticated",
        act: { sub: id.tokenId, name: id.agent },
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
