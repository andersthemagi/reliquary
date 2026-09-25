// The env API: how the Reliquary CLI gets variable values (docs/variables.md).
//
//   GET  /api/env/vaults                  vaults and environments it may read
//   GET  /api/env/<vault id>/<environment>   that environment's values
//   POST /api/env/<vault id>/<environment>/imports   a push: values for a
//        person to approve in the web UI (never set directly)
//   GET  /api/env/imports/<import id>     a push's status, for --wait
//   GET  /.well-known/oauth-protected-resource/api/env   RFC 9728 metadata
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
// Pushed values are sealed here on receipt and stored as a pending import
// (create_env_import); only a person in the web UI applies them.

import { createHash } from "node:crypto";
import type http from "node:http";
import type pg from "pg";
import { asCliToken, pool, type Grant } from "./db.js";
import { DOTENV_MAX_ENTRIES, DOTENV_MAX_VALUE_BYTES, isVariableName, startsPrograms } from "./dotenv.js";
import { envResource, issuer } from "./oauth.js";
import { fromDb, open, SecretsError, variablesConfigured } from "./secrets.js";
import { limitToken } from "./ratelimit.js";
import { precheckImport, sealItems, type ImportRefusal } from "./variables.js";
import { apiBody, classify, doing, fail, failure } from "./failure.js";

// An own raise's reason, for a 400 (classify: our messages are for people).
const refusalWhy = (err: unknown) => classify(err).why.replace(/\.$/, "");

const PRM_PATH = "/.well-known/oauth-protected-resource/api/env";
const TOKEN = /^Bearer (rle_[0-9a-f]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENVIRONMENT = /^[a-z][a-z0-9_-]{0,31}$/;
// A push is a .env file: 1 MiB is plenty, and bounds what one request can
// make the server seal (200 values of 64 KiB would be 12.8 MiB).
const MAX_PUSH_BYTES = 1024 * 1024;

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

// Every error answer (failure.ts): {"error": <code>, "message", "where",
// "ref"}. The codes are the API's own, unchanged; the message says what was
// being done and why, and never echoes the request.
const REASONS: Record<string, [string, string]> = {
  invalid_token: ["env API (sign-in)", "No live sign-in: the access token is missing, expired or revoked. Sign in again with `reliquary login`"],
  forbidden: ["database (your role)", "Your role can’t use this environment’s values (a viewer, or an editor in an owners-only environment such as production)"],
  not_found: ["database (only what’s shared with you is visible)", "There’s no such vault, environment or push for this sign-in"],
  push_not_allowed: ["env API (sign-in)", "This sign-in wasn’t allowed to send values: “Also let it send .env files” wasn’t ticked when it was approved"],
  rate_limited: ["rate limit", "Too many requests from this sign-in in a short time"],
  not_configured: ["encryption", "This server has no key for variables (VARIABLES_KEY), so it can’t deliver or seal values"],
  method_not_allowed: ["env API", "That method isn’t accepted on this path"],
  unsupported_media_type: ["env API", "A push must be sent as application/json"],
  too_large: ["env API", `A push is at most ${MAX_PUSH_BYTES / 1024 / 1024} MiB`],
  invalid_request: ["env API", "The request’s body isn’t a push this API takes (variables: names that are allowed, non-empty string values)"],
};
function sendError(res: http.ServerResponse, status: number, code: string, extra: Record<string, string> = {}, why?: string): void {
  const [where, reason] = REASONS[code] ?? ["env API", code];
  const f = failure({ status, where, why: why ?? reason, code });
  send(res, status, apiBody(f, code), extra);
}

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

// Resolves on its own checkout: for a push (which reads its body after
// authenticating) and a wrong method. GET routes resolve inside their
// transaction instead (asCliToken, getRoute).
async function resolve(token: string): Promise<Grant | null> {
  const { rows } = await pool.query("select token_id, user_id, name from private.resolve_cli_token($1, $2)", [
    hashOf(token),
    envResource(),
  ]);
  return rows.length === 1 ? { grantId: rows[0].token_id, userId: rows[0].user_id, name: rows[0].name } : null;
}

// One transaction as the grant's person, through the grant: the same claims
// shape the MCP server uses, with the CLI grant as `act.tok`.
async function asGrant<T>(g: Grant, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    // Begin, then the role and the claims in one statement (as the web
    // app's asPerson and the MCP server do): two round trips, not three.
    await client.query("begin");
    await client.query("select set_config('role', 'authenticated', true), set_config('request.jwt.claims', $1, true)", [
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

const STATUS: Record<string, number> = { unauthorized: 401, forbidden: 403, not_found: 404, push_not_allowed: 403, rate_limited: 429 };

// A refusal with a fixed code: never an echo of the request.
class BadRequest extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly why?: string, // fixed text, never the request's
  ) {
    super(code);
  }
}

// The request body as JSON, at most `limit` bytes. Never logged or echoed.
function readJson(req: http.IncomingMessage, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/.test(req.headers["content-type"] ?? "")) {
      req.resume();
      reject(new BadRequest(415, "unsupported_media_type"));
      return;
    }
    if (Number(req.headers["content-length"] ?? 0) > limit) {
      req.resume();
      reject(new BadRequest(413, "too_large"));
      return;
    }
    let size = 0;
    let done = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        reject(new BadRequest(413, "too_large"));
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new BadRequest(400, "invalid_request"));
      }
    });
    req.on("error", reject);
  });
}

// A push: {"variables": {"NAME": "value", ...}, "refused": [{"line", "name", "reason"}]}.
// The CLI parsed its file with the same rules (dotenv.ts); names and values
// are checked again here, and names once more by the database.
function pushBody(body: unknown): { entries: { name: string; value: string }[]; refused: ImportRefusal[] } {
  const bad = () => new BadRequest(400, "invalid_request");
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad();
  const { variables, refused = [] } = body as { variables?: unknown; refused?: unknown };
  if (typeof variables !== "object" || variables === null || Array.isArray(variables)) throw bad();
  const entries = Object.entries(variables as Record<string, unknown>);
  if (entries.length === 0 || entries.length > DOTENV_MAX_ENTRIES) throw bad();
  for (const [name, value] of entries) {
    if (!isVariableName(name) || startsPrograms(name)) throw bad();
    if (typeof value !== "string" || value === "" || value.includes("\u0000")) throw bad();
    if (Buffer.byteLength(value, "utf8") > DOTENV_MAX_VALUE_BYTES) throw bad();
  }
  if (!Array.isArray(refused) || refused.length > 1000) throw bad();
  const lines = refused.map((r): ImportRefusal => {
    const o = (r ?? {}) as { line?: unknown; name?: unknown; reason?: unknown };
    if (typeof o !== "object" || !Number.isInteger(o.line) || (o.line as number) < 1) throw bad();
    if (typeof o.reason !== "string" || o.reason.length > 200) throw bad();
    if (o.name !== null && o.name !== undefined && (typeof o.name !== "string" || !isVariableName(o.name))) throw bad();
    return { line: o.line as number, name: (o.name as string | null | undefined) ?? null, reason: o.reason };
  });
  return { entries: entries.map(([name, value]) => ({ name, value: value as string })), refused: lines };
}

type Route = "vaults" | ":vault/:environment" | ":vault/:environment/imports" | "imports/:id" | "other";

function routeOf(parts: string[]): Route {
  if (parts.length === 1 && parts[0] === "vaults") return "vaults";
  if (parts.length === 2 && parts[0] === "imports") return "imports/:id";
  if (parts.length === 2) return ":vault/:environment";
  if (parts.length === 3 && parts[2] === "imports") return ":vault/:environment/imports";
  return "other";
}

// A GET route's answer: a reply, or the variables to decrypt and send.
type Answer =
  | { status: number; body: object; outcome: string }
  | { status: number; error: string; outcome: string; why?: string }
  | { read: { variables: any[] }; vaultId: string; environment: string };

// A GET route's database work, in the transaction asCliToken opened as the
// grant's person. Values are decrypted by the caller, after commit.
async function getRoute(c: pg.PoolClient, route: Route, parts: string[]): Promise<Answer> {
  if (route === "vaults") {
    const rows = (await c.query("select vault_id, vault_name, role, environments from public.env_vaults()")).rows;
    return {
      status: 200,
      body: { vaults: rows.map((r) => ({ id: r.vault_id, name: r.vault_name, role: r.role, environments: r.environments })) },
      outcome: "ok",
    };
  }
  if (route === ":vault/:environment" && UUID.test(parts[0]) && ENVIRONMENT.test(parts[1])) {
    const [vaultId, environment] = parts;
    if (!variablesConfigured()) return { status: 503, error: "not_configured", outcome: "not_configured" };
    const r = (await c.query("select public.read_variables($1, $2) as r", [vaultId, environment])).rows[0].r;
    if (!r.ok) return { status: STATUS[r.error] ?? 403, error: r.error, outcome: r.error };
    return { read: r, vaultId, environment };
  }
  if (route === "imports/:id" && UUID.test(parts[1])) {
    const r = (await c.query("select public.env_import_status($1) as r", [parts[1]])).rows[0].r;
    if (!r.ok) return { status: STATUS[r.error] ?? 404, error: r.error, outcome: r.error };
    return {
      status: 200,
      body: {
        import: r.id,
        status: r.status,
        environments: r.environments,
        names: r.names,
        expires_at: r.expires_at,
        decided_at: r.decided_at,
      },
      outcome: r.status,
    };
  }
  return { status: 404, error: "not_found", outcome: "not_found", why: `There’s no env API route at /api/env/${route === "other" ? "…" : route}, or its vault id or environment name isn’t well formed` };
}

// What an env API request is doing, for its errors (never a value).
function describeRoute(route: Route, parts: string[]): string {
  const vault = (id: string) => `vault ${UUID.test(id) ? id.slice(0, 8) : "?"}`;
  const env = (e: string) => (ENVIRONMENT.test(e) ? e : "an environment");
  if (route === "vaults") return "Listing your vaults and environments";
  if (route === ":vault/:environment") return `Reading ${env(parts[1])} in ${vault(parts[0])}`;
  if (route === ":vault/:environment/imports") return `Sending values to ${env(parts[1])} in ${vault(parts[0])} for approval`;
  if (route === "imports/:id") return `Checking push ${UUID.test(parts[1]) ? parts[1].slice(0, 8) : "?"}`;
  return "Calling the env API";
}

// Handles the env API's paths and returns true; false for any other path.
export async function envApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path === PRM_PATH) {
    if (req.method !== "GET") sendError(res, 405, "method_not_allowed", { allow: "GET" }, `${req.method} isn’t accepted on this path; it takes GET`);
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
  const route = routeOf(parts);
  const method = route === ":vault/:environment/imports" ? "POST" : "GET";
  // The log names the route's shape only, never a vault id or environment.
  doing(describeRoute(route, parts), `env api ${req.method} /api/env/${route}`);
  let outcome = "ok";
  const challenge = () => {
    // RFC 6750: no error code when no credentials were sent.
    const value = `Bearer realm="reliquary", resource_metadata="${issuer()}${PRM_PATH}"${req.headers.authorization ? ', error="invalid_token"' : ""}`;
    sendError(res, 401, "invalid_token", { "www-authenticate": value });
    outcome = "invalid_token";
  };
  try {
    const bearer = TOKEN.exec(req.headers.authorization ?? "");
    // Requests per CLI grant (ratelimit.ts): counted against the grant a
    // live token belongs to, before any work; a token that isn't live
    // counts nothing and is refused below. Fails open.
    const wait = bearer ? await limitToken(hashOf(bearer[1]), [{ name: "env_grant_minute" }, { name: "env_grant_day" }]) : 0;
    if (wait) {
      req.resume();
      sendError(res, 429, "rate_limited", { "retry-after": String(wait) }, `Too many requests from this sign-in in a short time; retry after ${wait} seconds`);
      outcome = "rate_limited";
    } else if (method === "GET" && req.method === "GET") {
      // One checkout: the token is resolved inside the route's transaction.
      const out = bearer ? await asCliToken(hashOf(bearer[1]), envResource(), (c) => getRoute(c, route, parts)) : null;
      if (!out) challenge();
      else if ("read" in out.result) {
        // Decrypted after the transaction has committed (the read is logged).
        const { vaultId, environment, read } = out.result;
        // No prototype: a variable named __proto__ (a valid name) is a key
        // like any other, not a setter that drops it.
        const variables: Record<string, string> = Object.create(null);
        try {
          for (const v of read.variables) variables[v.name] = open(fromDb(v), { vaultId, environment, name: v.name });
          send(res, 200, { vault: vaultId, environment, variables });
        } catch (err) {
          if (!(err instanceof SecretsError)) throw err;
          // Names the variable and environment (never a value or a key).
          sendError(res, 500, "decrypt_failed", {}, `${err.message}; nothing was delivered. Set that value again in the web app`);
          outcome = "decrypt_failed";
        }
      } else if ("error" in out.result) {
        sendError(res, out.result.status, out.result.error, {}, out.result.why);
        outcome = out.result.outcome;
      } else {
        send(res, out.result.status, out.result.body);
        outcome = out.result.outcome;
      }
    } else {
      const grant = bearer ? await resolve(bearer[1]) : null;
      if (!grant) challenge();
      else if (req.method !== method) {
        sendError(res, 405, "method_not_allowed", { allow: method }, `${req.method} isn’t accepted on this path; it takes ${method}`);
        outcome = "method";
      } else if (route === ":vault/:environment/imports" && UUID.test(parts[0]) && ENVIRONMENT.test(parts[1])) {
        outcome = await push(req, res, grant, parts[0], parts[1]);
      } else {
        sendError(res, 404, "not_found", {}, "There’s no env API route at this path, or its vault id or environment name isn’t well formed");
        outcome = "not_found";
      }
    }
  } catch (err) {
    if (err instanceof BadRequest) {
      if (!res.headersSent) sendError(res, err.status, err.code, {}, err.why);
      outcome = err.code;
    } else {
      // What was being done, where it broke and why, with the reference
      // that finds the detail in the log (failure.ts).
      const f = fail(err, { where: "env API" });
      if (!res.headersSent) send(res, f.status, apiBody(f, "server_error"));
      outcome = `server_error ref=${f.ref}`;
    }
  }
  // The route's shape only: never a vault id, environment, name, token or value.
  console.info(`${req.method} /api/env/${route} ${res.statusCode} ${outcome}`);
  return true;
}

// POST /api/env/<vault>/<environment>/imports: seal what the CLI sent and
// make a pending import for a person to approve. Nothing is set here.
async function push(req: http.IncomingMessage, res: http.ServerResponse, grant: Grant, vaultId: string, environment: string): Promise<string> {
  if (!variablesConfigured()) {
    req.resume();
    sendError(res, 503, "not_configured");
    return "not_configured";
  }
  const { entries, refused } = pushBody(await readJson(req, MAX_PUSH_BYTES));
  let r;
  try {
    // The rate limit before sealing (up to 200 values), in the same
    // transaction as the import itself (create_env_import checks it again).
    r = await asGrant(grant, async (c) => {
      const pre = await precheckImport(c, vaultId, entries);
      if (!pre.ok) return pre;
      const items = sealItems(vaultId, [environment], entries);
      return (
        await c.query("select public.create_env_import($1, $2, $3, $4) as r", [
          vaultId, [environment], JSON.stringify(items), JSON.stringify(refused),
        ])
      ).rows[0].r;
    });
  } catch (err) {
    // 22023: the database refused the input (a name, the shape).
    // The database's own message names the rule, never a value.
    if ((err as { code?: string }).code === "22023") throw new BadRequest(400, "invalid_request", refusalWhy(err));
    throw err;
  }
  if (!r.ok) {
    sendError(res, STATUS[r.error] ?? 403, r.error);
    return r.error;
  }
  send(res, 201, {
    import: r.id,
    status: "pending",
    vault: vaultId,
    environment,
    names: r.names,
    overwrites: r.overwrites,
    expires_at: r.expires_at,
    url: `${issuer()}/v/${vaultId}/variables/imports/${r.id}`,
  });
  return "pending";
}
