// Where the web app looks up claims: the Claims page (claimspage.ts) and,
// later, the file page, so "active" has one definition.
//
// A claim covers exactly one path. public.path_claims is keyed by
// (vault_id, path); claim rules' folder prefixes decide how long a lease
// lasts, never what it covers. Reads go through the member_read policy, so
// a person sees the claims of the vaults they are in and no others.

import type pg from "pg";

export type Claim = { path: string; holder: string; holder_label: string | null; expires_at: Date };

// A released or broken claim keeps its row (the fence is never reused) with
// its expiry set to now, so "active" is "not yet expired".
const ACTIVE = `select path, holder, holder_label, expires_at from public.path_claims
        where vault_id = $1 and expires_at > now()`;

export async function activeClaims(c: pg.PoolClient, vaultId: string): Promise<Claim[]> {
  return (await c.query(`${ACTIVE} order by path`, [vaultId])).rows;
}

// The agent that took the claim on each of `paths`, by its connection's
// name. Whether a connection took it is a fact the claims table doesn't
// keep; the log's claim.grant for the path does (a claim granted over MCP is
// always by a connection). The newest grant is the active claim's: a renewal
// keeps the holder, and any new holder comes with a new grant. A path whose
// claim a person took in person has no entry.
export async function claimAgents(c: pg.PoolClient, vaultId: string, paths: string[]): Promise<Map<string, string>> {
  if (!paths.length) return new Map();
  const { rows } = await c.query(
    `select distinct on (path) path, agent from public.log
      where vault_id = $1 and event = 'claim.grant' and path = any($2::text[]) order by path, seq desc`,
    [vaultId, paths],
  );
  return new Map(rows.filter((r) => r.agent !== null).map((r) => [r.path as string, r.agent as string]));
}

export async function activeClaim(c: pg.PoolClient, vaultId: string, path: string): Promise<Claim | undefined> {
  return (await c.query(`${ACTIVE} and path = $2`, [vaultId, path])).rows[0];
}
