// Variables for a person in the web UI (docs/variables.md, "Web module").
// Phase 2's Variables page calls these; each runs as the signed-in person
// through asPerson() (no `act` claim), and the database decides who may do
// what (supabase/migrations/20260925090000_variables.sql).
//
// Values exist in plaintext only inside setVariable (before sealing) and
// revealVariable (after opening). Never log them, put them in a URL, a
// flash message, an error or a redirect.

import type pg from "pg";
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
  action: "set" | "rotate" | "delete" | "read" | "reveal" | "refused" | "push" | "reject";
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
// gives others nothing). Page with `before` (a seq); narrow to one `action`,
// or to the rows naming one variable (`name`).
export async function accessLog(
  userId: string,
  vaultId: string,
  opts: { before?: string; limit?: number; action?: string; name?: string } = {},
): Promise<AccessLogRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  return asPerson(userId, async (c) =>
    (
      await c.query(
        `select seq, at, actor, agent, token_id, client_id, action, environment, names, detail
           from public.env_access_log
          where vault_id = $1 and ($2::bigint is null or seq < $2::bigint)
            and ($4::text is null or action = $4) and ($5::text is null or $5 = any(names))
          order by seq desc limit $3`,
        [vaultId, opts.before ?? null, limit, opts.action || null, opts.name || null],
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

// Who read or revealed each value since it was last set, for the Variables
// page: one row per variable, environment, action, person and client, newest
// first, looking back over the vault's last 500 access-log entries as the
// page always has. The database does the matching, so the page gets a few
// rows instead of 500 log entries (each CLI read names every variable).
export type ReaderRow = { name: string; environment: string; action: "read" | "reveal"; actor: string | null; agent: string | null };
export async function readersSinceSet(userId: string, vaultId: string): Promise<ReaderRow[]> {
  return asPerson(userId, async (c) =>
    (
      await c.query(
        `with recent as (
           select seq, at, action, actor, agent, environment, names from public.env_access_log
            where vault_id = $1 order by seq desc limit 500),
         g as (
           select environment, action, actor, agent, names, max(seq) as last, max(at) as at
             from recent where action in ('read', 'reveal') group by 1, 2, 3, 4, 5)
         select n.name, g.environment, g.action, g.actor, g.agent, max(g.last) as last
           from g cross join unnest(g.names) n(name)
           join public.variables v on v.vault_id = $1 and v.name = n.name
           join public.variable_values vv on vv.variable_id = v.id and vv.environment = g.environment and g.at > vv.updated_at
          group by 1, 2, 3, 4, 5
          order by last desc`,
        [vaultId],
      )
    ).rows.map((r) => ({ name: r.name, environment: r.environment, action: r.action, actor: r.actor, agent: r.agent })),
  );
}

// ---------------------------------------------------------------------------
// Imports (docs/variables.md, "Imports"): a pasted .env becomes a draft here;
// a CLI push (envapi.ts) becomes a pending import. Either way the values are
// sealed for their final slot (vault, environment, name) before the database
// sees them, and applying copies the ciphertext without opening it. The
// database decides who may create, see, apply and reject.

export type ImportItem = { name: string; environment: string; key_id: string; nonce: string; ciphertext: string };
export type ImportRefusal = { line: number; name: string | null; reason: string };
export type CreateImportResult =
  | { ok: true; id: string; source: "web" | "cli"; environments: string[]; names: string[]; overwrites: string[]; expires_at: string }
  | { ok: false; error: "unauthorized" | "forbidden" | "push_not_allowed" | "not_found" | "rate_limited" };
export type EnvImport = {
  id: string;
  vaultId: string;
  environments: string[];
  names: string[];
  refused: ImportRefusal[];
  source: "web" | "cli";
  createdBy: string;
  agent: string | null;
  createdAt: Date;
  expiresAt: Date;
  status: "pending" | "applied" | "rejected" | "expired";
  decidedBy: string | null;
  decidedAt: Date | null;
};
export type DecideResult =
  | { ok: true; applied?: number; names?: string[]; environments?: string[] }
  | { ok: false; error: "unauthorized" | "forbidden" | "not_found" | "expired" | "applied" | "rejected" };

// Every value in every environment, sealed for its slot, as create_env_import
// takes them. Throws SecretsError (no key, or a value over 64 KiB).
export function sealItems(vaultId: string, environments: string[], entries: { name: string; value: string }[]): ImportItem[] {
  const items: ImportItem[] = [];
  for (const e of entries) {
    for (const environment of environments) {
      const s = seal(e.value, { vaultId, environment, name: e.name });
      items.push({ name: e.name, environment, key_id: s.keyId, nonce: s.nonce.toString("base64"), ciphertext: s.ciphertext.toString("base64") });
    }
  }
  return items;
}

// A pasted .env, as a draft for the person to review and apply (30 minutes).
export async function createImport(
  userId: string,
  vaultId: string,
  environments: string[],
  entries: { name: string; value: string }[],
  refused: ImportRefusal[],
): Promise<CreateImportResult> {
  return asPerson(userId, async (c) => {
    const pre = await precheckImport(c, vaultId, entries);
    if (!pre.ok) return pre;
    const items = sealItems(vaultId, environments, entries);
    return (
      await c.query("select public.create_env_import($1, $2, $3, $4) as r", [
        vaultId, environments, JSON.stringify(items), JSON.stringify(refused),
      ])
    ).rows[0].r;
  });
}

// Before sealing anything (the costly part: every value for every
// environment): is the person over an import rate limit? The database logs
// the refusal; every other refusal waits for create_env_import, which
// checks everything again. Used by the paste form and the CLI's pushes.
export async function precheckImport(
  c: pg.PoolClient,
  vaultId: string,
  entries: { name: string }[],
): Promise<{ ok: true } | { ok: false; error: "unauthorized" | "rate_limited" }> {
  return (await c.query("select public.env_import_precheck($1, $2) as r", [vaultId, entries.map((e) => e.name)])).rows[0].r;
}

const IMPORT_COLUMNS = `i.id, i.vault_id, i.environments, i.names, i.refused, i.source, i.created_by, i.agent,
  i.created_at, i.expires_at, private.env_import_state(i.status, i.expires_at) as status, i.decided_by, i.decided_at`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toImport = (r: any): EnvImport => ({
  id: r.id,
  vaultId: r.vault_id,
  environments: r.environments,
  names: r.names,
  refused: r.refused,
  source: r.source,
  createdBy: r.created_by,
  agent: r.agent,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  status: r.status,
  decidedBy: r.decided_by,
  decidedAt: r.decided_at,
});

// One import the person may see (RLS: pushes for owners and editors, a draft
// for its author), with the version each of its names already has in each
// of its environments.
export async function getImport(
  userId: string,
  vaultId: string,
  importId: string,
): Promise<{ imp: EnvImport; existing: Map<string, Map<string, number>> } | null> {
  return asPerson(userId, async (c) => {
    const rows = (await c.query(`select ${IMPORT_COLUMNS} from public.env_imports i where i.id = $1 and i.vault_id = $2`, [importId, vaultId])).rows;
    if (!rows.length) return null;
    const imp = toImport(rows[0]);
    const existing = new Map<string, Map<string, number>>();
    const found = (
      await c.query(
        `select v.name, vv.environment, vv.version from public.variables v join public.variable_values vv on vv.variable_id = v.id
          where v.vault_id = $1 and v.name = any($2) and vv.environment = any($3)`,
        [vaultId, imp.names, imp.environments],
      )
    ).rows;
    for (const r of found) {
      if (!existing.has(r.name)) existing.set(r.name, new Map());
      existing.get(r.name)!.set(r.environment, r.version);
    }
    return { imp, existing };
  });
}

// Pending pushes (from the CLI) the person may see, in one vault or across
// all of theirs, newest first. `mayApply`: their role allows every
// environment the push is for.
export async function pendingPushes(userId: string, vaultId?: string): Promise<(EnvImport & { vaultName: string; mayApply: boolean })[]> {
  return asPerson(userId, async (c) =>
    (
      await c.query(
        `select ${IMPORT_COLUMNS}, v.name as vault_name,
                coalesce(private.role_in(i.vault_id) = 'owner'
                  or (private.role_in(i.vault_id) = 'editor'
                      and not exists (select 1 from public.environments e
                                       where e.vault_id = i.vault_id and e.name = any(i.environments) and e.owners_only)), false) as may_apply
           from public.env_imports i join public.vaults v on v.id = i.vault_id
          where i.source = 'cli' and i.status = 'pending' and i.expires_at > now()
            and ($1::uuid is null or i.vault_id = $1)
          order by i.created_at desc limit 50`,
        [vaultId ?? null],
      )
    ).rows.map((r) => ({ ...toImport(r), vaultName: r.vault_name, mayApply: r.may_apply })),
  );
}

export async function applyImport(userId: string, importId: string): Promise<DecideResult> {
  return asPerson(userId, async (c) => (await c.query("select public.apply_env_import($1) as r", [importId])).rows[0].r);
}

export async function rejectImport(userId: string, importId: string): Promise<DecideResult> {
  return asPerson(userId, async (c) => (await c.query("select public.reject_env_import($1) as r", [importId])).rows[0].r);
}
