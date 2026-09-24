// The env API: how the Reliquary CLI gets variable values (docs/variables.md).
//
//   GET /api/env/vaults                  vaults and environments it may read
//   GET /api/env/<vault id>/<environment>   that environment's values
//   GET /.well-known/oauth-protected-resource/api/env   RFC 9728 metadata
//
// Authorization: Bearer rle_... , an access token from our own authorization
// server (oauth.ts) for the resource `<issuer>/api/env`, issued only to the
// Reliquary CLI. It resolves (private.resolve_cli_token, as this app's
// role) to a CLI grant, and each request runs as that grant's person
// through it (`act.tok`), so the database applies the person's role, the
// vaults chosen at consent, revocation and expiry, and logs every read.
// A personal token (rlq_) or an MCP access token (rlo_) is refused here.
//
// Values are decrypted here (secrets.ts), sent once with no-store, and
// never logged: the log line is the route's shape, status and outcome.

import { createHash } from "node:crypto";
import type http from "node:http";
import type pg from "pg";
import { pool } from "./db.js";
import { envResource, issuer } from "./oauth.js";
import { fromDb, open, SecretsError, variablesConfigured } from "./secrets.js";

const PRM_PATH = "/.well-known/oauth-protected-resource/api/env";
const TOKEN = /^Bearer (rle_[0-9a-f]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVIRONMENT = /^[a-z][a-z0-9_-]{0,31}$/;

type Grant = { grantId: string; userId: string; name: string };

const HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, private",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

function send(res: http.ServerResponse, status: number, body: object, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...HEADERS, ...extra }).end(JSON.stringify(body));
}

async function resolve(token: string): Promise<Grant | null> {
  const { rows } = await pool.query("select token_id, user_id, name from private.resolve_cli_token($1, $2)", [
    createHash("sha256").update(token).digest("hex"),
    envResource(),
  ]);
  return rows.length === 1 ? { grantId: rows[0].token_id, userId: rows[0].user_id, name: rows[0].name } : null;
}

// One transaction as the grant's person, through the grant: the same claims
// shape the MCP server uses, with the CLI grant as `act.tok`.
async function asGrant<T>(g: Grant, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: g.userId, role: "authenticated", act: { sub: g.grantId, name: g.name, tok: g.grantId } }),
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

const STATUS: Record<string, number> = { unauthorized: 401, forbidden: 403, not_found: 404 };

// Handles the env API's paths and returns true; false for any other path.
export async function envApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path === PRM_PATH) {
    if (req.method !== "GET") send(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
    else {
      send(
        res,
        200,
        { resource: envResource(), authorization_servers: [issuer()], bearer_methods_supported: ["header"], resource_name: "Reliquary environment variables" },
        { "cache-control": "public, max-age=300" },
      );
    }
    console.info(`${req.method} ${PRM_PATH} ${res.statusCode}`);
    return true;
  }
  if (path !== "/api/env" && !path.startsWith("/api/env/")) return false;

  const parts = path.split("/").slice(3); // after "", "api", "env"
  const route = parts.length === 1 && parts[0] === "vaults" ? "vaults" : parts.length === 2 ? ":vault/:environment" : "other";
  let outcome = "ok";
  try {
    const bearer = TOKEN.exec(req.headers.authorization ?? "");
    const grant = bearer ? await resolve(bearer[1]) : null;
    if (!grant) {
      // RFC 6750: no error code when no credentials were sent.
      const challenge = `Bearer realm="reliquary", resource_metadata="${issuer()}${PRM_PATH}"${req.headers.authorization ? ', error="invalid_token"' : ""}`;
      send(res, 401, { error: "invalid_token" }, { "www-authenticate": challenge });
      outcome = "invalid_token";
    } else if (req.method !== "GET") {
      send(res, 405, { error: "method_not_allowed" }, { allow: "GET" });
      outcome = "method";
    } else if (route === "vaults") {
      const rows = await asGrant(grant, async (c) =>
        (await c.query("select vault_id, vault_name, role, environments from public.env_vaults()")).rows,
      );
      send(res, 200, { vaults: rows.map((r) => ({ id: r.vault_id, name: r.vault_name, role: r.role, environments: r.environments })) });
    } else if (route === ":vault/:environment" && UUID.test(parts[0]) && ENVIRONMENT.test(parts[1])) {
      const [vaultId, environment] = parts;
      if (!variablesConfigured()) {
        send(res, 503, { error: "not_configured" });
        outcome = "not_configured";
      } else {
        const r = await asGrant(grant, async (c) =>
          (await c.query("select public.read_variables($1, $2) as r", [vaultId, environment])).rows[0].r,
        );
        if (!r.ok) {
          send(res, STATUS[r.error] ?? 403, { error: r.error });
          outcome = r.error;
        } else {
          const variables: Record<string, string> = {};
          try {
            for (const v of r.variables) variables[v.name] = open(fromDb(v), { vaultId, environment, name: v.name });
            send(res, 200, { vault: vaultId, environment, variables });
          } catch (err) {
            if (!(err instanceof SecretsError)) throw err;
            send(res, 500, { error: "decrypt_failed" });
            outcome = "decrypt_failed";
          }
        }
      }
    } else {
      send(res, 404, { error: "not_found" });
      outcome = "not_found";
    }
  } catch (err) {
    console.error("env api error", (err as { code?: string }).code ?? (err as Error).name);
    if (!res.headersSent) send(res, 500, { error: "server_error" });
    outcome = "server_error";
  }
  // The route's shape only: never a vault id, environment, name, token or value.
  console.info(`${req.method} /api/env/${route} ${res.statusCode} ${outcome}`);
  return true;
}
