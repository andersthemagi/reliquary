// Environment variable MCP tools: list_variables.
//
// Names only. No tool returns a value, a ciphertext or a nonce, on any
// token (AGENTS.md, "Secrets never reach a model"); the database gives
// agents no way to read them anyway (docs/variables.md).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type pg from "pg";
import { z } from "zod";
import type { Identity } from "./db.js";
import { at, makeRun, ok, READ, refuse, VAULT, vaultRef } from "./tools-shared.js";

// How much list_variables shows at once; one more is fetched to know whether
// there is more.
const VALUE_ROWS = 2000;
const PUSHES = 20;

export function registerVariablesTools(
  server: McpServer,
  id: Identity,
  runAs: <T>(fn: (c: pg.PoolClient) => Promise<T>) => Promise<T>,
): void {
  const run = makeRun(runAs);

  server.registerTool(
    "list_variables",
    {
      title: "List environment variables",
      description:
        "Names of a vault's environment variables per environment, who last set each, and pushes waiting for a person to apply. Never values: you can't read, set or reveal one. Your person uses them with `reliquary run` or `reliquary env pull`. To add a .env to the vault, run `npx @reliquary-ai/cli env push --env <environment> --file .env` (sends the file without printing values; a person applies it); never read the file's values into the conversation.",
      inputSchema: {
        vault: VAULT,
        environment: z.string().min(1).max(100).optional().describe("e.g. development"),
        after: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/).optional().describe("The after name the last page named, to continue"),
      },
      annotations: READ,
    },
    async ({ vault, environment, after }) =>
      run(async (c) => {
        const order = "case $ when 'development' then 0 when 'preview' then 1 when 'production' then 2 else 3 end";
        // Environments, names and pending pushes in one round trip. Pushes
        // from `reliquary env push` wait for a person (RLS: owners and
        // editors, and their agents within scope). Names only.
        const { envs, rows, pushes } = (
          await c.query(
            `select q.* from ${vaultRef("vref")} cross join lateral (select
               (select coalesce(json_agg(json_build_object('name', e.name, 'owners_only', e.owners_only)
                                 order by ${order.replace("$", "e.name")}, e.name), '[]')
                  from public.environments e where e.vault_id = vref.id) as envs,
               (select coalesce(json_agg(x order by x.ord), '[]') from (
                  select v.name, vv.environment, vv.updated_at, vv.updated_by,
                         row_number() over (order by v.name, ${order.replace("$", "vv.environment")}, vv.environment) as ord
                    from public.variables v join public.variable_values vv on vv.variable_id = v.id
                   where v.vault_id = vref.id and ($2::text is null or vv.environment = $2) and ($3::text is null or v.name > $3)
                   order by ord limit ${VALUE_ROWS + 1}) x) as rows,
               (select coalesce(json_agg(p order by p.created_at), '[]') from (
                  select environments, names, created_by, created_at, expires_at from public.env_imports
                   where vault_id = vref.id and source = 'cli' and status = 'pending' and expires_at > now()
                     and ($2::text is null or $2 = any(environments))
                   order by created_at limit ${PUSHES + 1}) p) as pushes
               offset 0) q`,
            [vault, environment ?? null, after ?? null],
          )
        ).rows[0] as {
          envs: { name: string; owners_only: boolean }[];
          rows: { name: string; environment: string; updated_at: string; updated_by: string }[];
          pushes: { environments: string[]; names: string[]; created_by: string; created_at: string; expires_at: string }[];
        };
        // A variable is listed whole or not at all: the page ends at the last
        // name that fits entirely, so `after` continues cleanly.
        let rest: string | null = null;
        if (rows.length > VALUE_ROWS) {
          const cut = rows[VALUE_ROWS].name;
          let end = VALUE_ROWS;
          while (end > 1 && rows[end - 1].name === cut) end--;
          rows.length = end;
          rest = rows[end - 1].name;
        }
        const morePushes = pushes.length > PUSHES;
        if (morePushes) pushes.length = PUSHES;
        if (environment !== undefined && !envs.some((e) => e.name === environment)) {
          return refuse(`No environment named ${environment}. This vault has: ${envs.map((e) => e.name).join(", ")}.`);
        }
        const head =
          `Environments: ${envs.map((e) => `${e.name}${e.owners_only ? " (owners only)" : ""}`).join(", ")}.\n` +
          "Names only; values never leave Reliquary over MCP.";
        const waiting = pushes.map(
          (p) =>
            `  ${p.environments.join(", ")}: ${p.names.join(", ")} (sent ${new Date(p.created_at).toISOString()} by ${p.created_by}${
              p.created_by === id.userId ? " (your person)" : ""}, expires ${new Date(p.expires_at).toISOString()})`,
        );
        const tail = waiting.length
          ? ["Waiting for a person to apply them in the web UI:", ...waiting, ...(morePushes ? [`  ... and more are waiting than the ${PUSHES} shown.`] : [])]
          : [];
        if (rows.length === 0) return ok([`${head}\nNo variables${environment ? ` in ${environment}` : ""}.`, ...tail].join("\n"));
        const out = [head];
        let last = "";
        for (const r of rows) {
          if (r.name !== last) out.push(r.name);
          last = r.name;
          out.push(`  ${r.environment}  set ${at(new Date(r.updated_at))} by ${r.updated_by}${r.updated_by === id.userId ? " (your person)" : ""}`);
        }
        if (rest !== null) out.push(`more: pass after=${JSON.stringify(rest)} for the variables after ${rest}.`);
        return ok([...out, ...tail].join("\n"));
      }),
  );
}
