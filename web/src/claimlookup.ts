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

export async function activeClaim(c: pg.PoolClient, vaultId: string, path: string): Promise<Claim | undefined> {
  return (await c.query(`${ACTIVE} and path = $2`, [vaultId, path])).rows[0];
}
