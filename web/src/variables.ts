// Variables for a person in the web UI (docs/variables.md, "Web module").
// Phase 2's Variables page calls these; each runs as the signed-in person
// through asPerson() (no `act` claim), and the database decides who may do
// what (supabase/migrations/20260925090000_variables.sql).
//
// Values exist in plaintext only inside setVariable (before sealing) and
// revealVariable (after opening). Never log them, put them in a URL, a
// flash message, an error or a redirect.

import { asPerson } from "./db.js";
import { fromDb, open, seal, SecretsError } from "./secrets.js";

export type Environment = { name: string; ownersOnly: boolean };
export type VariableValue = { environment: string; version: number; updatedBy: string; updatedAt: Date };
export type Variable = { name: string; values: VariableValue[] };
export type AccessLogRow = {
  seq: string;
  at: Date;
  actor: string | null;
  agent: string | null;
  tokenId: string | null;
  clientId: string | null;
  action: "set" | "rotate" | "delete" | "read" | "reveal" | "refused";
  environment: string | null;
  names: string[];
  detail: Record<string, unknown>;
};
export type RevealResult =
  | { ok: true; value: string; updatedAt: string; updatedBy: string }
  | { ok: false; error: "unauthorized" | "forbidden" | "not_found" | "decrypt_failed" };

const ENV_ORDER = "case e.name when 'development' then 0 when 'preview' then 1 when 'production' then 2 else 3 end, e.name";

// Names, environments and who set what: what every member (and their agent,
// over MCP) may see. `role` is the person's role in the vault, or null.
export async function listVariables(userId: string, vaultId: string): Promise<{
  role: string | null;
  environments: Environment[];
  variables: Variable[];
}> {
  return asPerson(userId, async (c) => {
    const role = (await c.query("select private.role_in($1) as role", [vaultId])).rows[0]?.role ?? null;
    const environments = (
      await c.query(`select e.name, e.owners_only from public.environments e where e.vault_id = $1 order by ${ENV_ORDER}`, [vaultId])
    ).rows.map((r) => ({ name: r.name as string, ownersOnly: r.owners_only as boolean }));
    const rows = (
      await c.query(
        `select v.name, vv.environment, vv.version, vv.updated_by, vv.updated_at
           from public.variables v join public.variable_values vv on vv.variable_id = v.id
          where v.vault_id = $1
          order by v.name, case vv.environment when 'development' then 0 when 'preview' then 1 when 'production' then 2 else 3 end, vv.environment`,
        [vaultId],
      )
    ).rows;
    const variables: Variable[] = [];
    for (const r of rows) {
      if (variables.at(-1)?.name !== r.name) variables.push({ name: r.name, values: [] });
      variables.at(-1)!.values.push({ environment: r.environment, version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at });
    }
    return { role, environments, variables };
  });
}

// Sets or rotates one value. Resolves to 'set' or 'rotate'. Database refusals
// reject with their SQLSTATE (42501 not allowed, 22023 bad name or value,
// P0002 no such vault or environment) and a message safe to show; a value
// over 64 KiB rejects with SecretsError.
export async function setVariable(userId: string, vaultId: string, name: string, environment: string, value: string): Promise<"set" | "rotate"> {
  const s = seal(value, { vaultId, environment, name });
  return asPerson(userId, async (c) =>
    (
      await c.query("select public.set_variable($1, $2, $3, $4, $5, $6) as action", [
        vaultId, name, environment, s.keyId, s.nonce, s.ciphertext,
      ])
    ).rows[0].action,
  );
}

export async function deleteVariable(userId: string, vaultId: string, name: string, environment: string): Promise<void> {
  await asPerson(userId, (c) => c.query("select public.delete_variable($1, $2, $3)", [vaultId, name, environment]));
}

// One value, for the person to see. Logged as `reveal` (or `refused`) by the
// database in the same transaction, whatever happens next.
export async function revealVariable(userId: string, vaultId: string, name: string, environment: string): Promise<RevealResult> {
  const r = await asPerson(userId, async (c) =>
    (await c.query("select public.reveal_variable($1, $2, $3) as r", [vaultId, name, environment])).rows[0].r,
  );
  if (!r.ok) return { ok: false, error: r.error };
  try {
    return { ok: true, value: open(fromDb(r), { vaultId, environment, name }), updatedAt: r.updated_at, updatedBy: r.updated_by };
  } catch (err) {
    if (err instanceof SecretsError) return { ok: false, error: "decrypt_failed" };
    throw err;
  }
}

// The vault's env_access_log, newest first, for owners and editors (RLS
// gives others nothing). Page with `before` (a seq).
export async function accessLog(userId: string, vaultId: string, opts: { before?: string; limit?: number } = {}): Promise<AccessLogRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return asPerson(userId, async (c) =>
    (
      await c.query(
        `select seq, at, actor, agent, token_id, client_id, action, environment, names, detail
           from public.env_access_log
          where vault_id = $1 and ($2::bigint is null or seq < $2::bigint)
          order by seq desc limit $3`,
        [vaultId, opts.before ?? null, limit],
      )
    ).rows.map((r) => ({
      seq: String(r.seq),
      at: r.at,
      actor: r.actor,
      agent: r.agent,
      tokenId: r.token_id,
      clientId: r.client_id,
      action: r.action,
      environment: r.environment,
      names: r.names,
      detail: r.detail,
    })),
  );
}
