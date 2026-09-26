// The OAuth 2.1 authorization server for the remote MCP endpoint
// (docs/research/hosting.md, section 4). Small on purpose: public clients
// only, the authorization code grant with PKCE S256, rotating refresh
// tokens, clients identified by Client ID Metadata Documents (cimd.ts).
//
//   GET  /.well-known/oauth-authorization-server   metadata (RFC 8414)
//   GET  /oauth/authorize    consent page (signed-in person)
//   POST /oauth/authorize    allow or deny (CSRF + same-origin, like every form)
//   POST /oauth/token        authorization_code, refresh_token
//   POST /oauth/revoke       RFC 7009
//   GET  /cli/oauth-client.json   our own CLI's client metadata document
//
// A grant is an access_tokens row, made by the person in
// public.create_oauth_grant (never by an agent: the web session has no `act`
// claim, and the database refuses one). Codes and tokens are random, handed
// out once and stored as SHA-256 by the database. None of them, and no
// request value, is ever logged or echoed in an error.
//
// Config: the issuer is PUBLIC_URL (else this server's local address). Two
// resources are accepted: MCP_RESOURCE (else MCP_PUBLIC_URL), byte for byte
// the value the MCP server has, and this app's env API, `<issuer>/api/env`
// (envapi.ts). The env API is for one client only, the Reliquary CLI, whose
// client id is `<issuer>/cli/oauth-client.json`, served here rather than
// fetched; the CLI is for the env API only. Its grants are kind 'cli' in the
// database (public.create_cli_grant), and its access tokens are `rle_`, so
// neither side's tokens work at the other (docs/variables.md).
// CIMD_ALLOW_LOOPBACK=1 lets tests serve client metadata from loopback; it is
// refused when VERCEL or SELF_HOSTED is set.

import { createHash, randomBytes } from "node:crypto";
import type http from "node:http";
import { CimdError, clientMetadata, isLoopbackHost, redirectAllowed, type ClientMetadata } from "./cimd.js";
import { asPerson, pool } from "./db.js";
import { csrfField, html, page } from "./html.js";
import { clientIp, limit, RateLimited, tooManyPage, type LimitName } from "./ratelimit.js";
import type { Ctx, Reply } from "./pages.js";
import { doing, fail, failure } from "./failure.js";

function config() {
  // Hosted on Vercel, or self-hosted (SELF_HOSTED=1, deploy/): the same
  // refusals, since either way real clients depend on these URLs.
  const onVercel = !!process.env.VERCEL;
  const strict = onVercel ? "VERCEL" : process.env.SELF_HOSTED === "1" ? "SELF_HOSTED" : "";
  const allowLoopback = process.env.CIMD_ALLOW_LOOPBACK === "1";
  if (strict && allowLoopback) throw new Error(`Refusing to start: CIMD_ALLOW_LOOPBACK is for tests and must not be set with ${strict}`);
  let issuer = `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8790}`;
  if (process.env.PUBLIC_URL) issuer = new URL(process.env.PUBLIC_URL).origin;
  else if (strict) throw new Error(`Refusing to start: ${strict} is set but PUBLIC_URL (the OAuth issuer) is not`);
  const resource = process.env.MCP_RESOURCE ?? process.env.MCP_PUBLIC_URL ?? "http://127.0.0.1:8787/mcp";
  if (strict && !process.env.MCP_RESOURCE && !process.env.MCP_PUBLIC_URL) {
    throw new Error(`Refusing to start: ${strict} is set but MCP_RESOURCE is not`);
  }
  let r: URL;
  try {
    r = new URL(resource);
  } catch {
    throw new Error("MCP_RESOURCE must be an absolute URL");
  }
  if ((r.protocol !== "https:" && r.protocol !== "http:") || r.hash) throw new Error("MCP_RESOURCE must be an http(s) URL without a fragment");
  return { issuer, resource, allowLoopback };
}

// Set by configureOAuth() at server start, after sign-in's own checks, so a
// misconfigured deploy reports the first missing setting in a fixed order.
let ISSUER = "";
let RESOURCE = "";
let ALLOW_LOOPBACK = false;
let ENV_RESOURCE = "";
let CLI_CLIENT_ID = "";
const CLI_METADATA_PATH = "/cli/oauth-client.json";
export function configureOAuth(): void {
  ({ issuer: ISSUER, resource: RESOURCE, allowLoopback: ALLOW_LOOPBACK } = config());
  ENV_RESOURCE = `${ISSUER}/api/env`;
  CLI_CLIENT_ID = `${ISSUER}${CLI_METADATA_PATH}`;
}
export const issuer = () => ISSUER;
export const envResource = () => ENV_RESOURCE;

// The CLI listens on a free port on this computer (RFC 8252, 7.3), so any
// port matches (cimd.ts, redirectAllowed); the host and path must be these.
export const cliClient = () => ({
  client_id: CLI_CLIENT_ID,
  client_name: "Reliquary CLI",
  client_uri: ISSUER,
  redirect_uris: ["http://127.0.0.1/callback", "http://[::1]/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  application_type: "native",
});

const ACCESS_SECONDS = 3600;
const MAX_FORM = 16 * 1024;
const TOKEN_ENDPOINT = "/oauth/token";
const REVOKE_ENDPOINT = "/oauth/revoke";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const secret = (prefix: string) => `${prefix}${randomBytes(32).toString("hex")}`;

export const metadata = () => ({
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  token_endpoint: `${ISSUER}${TOKEN_ENDPOINT}`,
  revocation_endpoint: `${ISSUER}${REVOKE_ENDPOINT}`,
  response_types_supported: ["code"],
  response_modes_supported: ["query"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  revocation_endpoint_auth_methods_supported: ["none"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  scopes_supported: [],
});

// ---------------------------------------------------------------------------
// Endpoints without a session: metadata, token, revocation. Returns false
// for any other path, so the caller carries on.

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-protocol-version",
};

function json(res: http.ServerResponse, status: number, body: object, extra: Record<string, string> = {}): void {
  res
    .writeHead(status, {
      "content-type": "application/json",
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
      ...CORS,
      ...extra,
    })
    .end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_FORM) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Per address and per client id (ratelimit.ts), before any database work
// on the request. The client id is counted as sent: any string, hashed.
// Fails open. Over a limit: 429, Retry-After, and an error body that says
// to wait, never what was counted.
async function limited(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  names: [LimitName, LimitName],
  clientId: string,
): Promise<boolean> {
  const wait = await limit([
    { name: names[0], kind: "ip", value: clientIp(req) },
    { name: names[1], kind: "client", value: clientId },
  ]);
  if (!wait) return false;
  const f = failure({ status: 429, where: "rate limit", why: `Too many requests from this address or client. Retry after ${wait} seconds`, code: "rate_limited" });
  json(res, 429, { error: "rate_limited", error_description: `Too many requests. Retry after ${wait} seconds.`, where: f.where, ref: f.ref }, {
    "retry-after": String(wait),
    "access-control-expose-headers": "retry-after",
  });
  return true;
}

// OAuth parameters must not repeat (RFC 6749, 3.1 and 3.2).
function single(params: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const k of params.keys()) {
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

const CODE = /^rlc_[0-9a-f]{64}$/;
const REFRESH = /^rlr_[0-9a-f]{64}$/;
const ACCESS = /^rl[oe]_[0-9a-f]{64}$/;

// OAuth error answers (RFC 6749, 5.2): `error` from the spec's list, the
// reason in `error_description` (printable ASCII without quotes or
// backslashes, as 5.2 requires), and the error model's `where` and `ref`
// beside them (failure.ts). Never an echo of what was sent.
const DESCRIPTIONS: Record<string, string> = {
  invalid_request: "the request is missing a parameter, repeats one, or is not a form post",
  invalid_client: "public clients only: this request carried a client secret or an Authorization header",
  invalid_grant:
    "the code or refresh token is unknown, already used, expired (codes last 60 seconds), revoked, or was issued for another client, redirect URI, resource or PKCE verifier",
  invalid_target: "the resource is not this server's MCP endpoint or env API, or the env API was asked for by a client other than the Reliquary CLI",
  unsupported_grant_type: "grant_type must be authorization_code or refresh_token",
};
const ascii = (s: string) => s.replace(/[’‘]/g, "'").replace(/[“”"\\]/g, "").replace(/[^\x20-\x7e]/g, "");
export function oauthError(res: http.ServerResponse, status: number, error: string, why = DESCRIPTIONS[error] ?? error, extra: Record<string, string> = {}): string {
  const f = failure({ status, where: "OAuth", why, code: error });
  json(res, status, { error, error_description: ascii(`${f.what} failed: ${f.why}`), where: f.where, ref: f.ref }, extra);
  return error;
}

async function token(req: http.IncomingMessage, res: http.ServerResponse): Promise<string> {
  const fail = (status: number, error: string, why?: string) => oauthError(res, status, error, why);
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
    return fail(400, "invalid_request");
  }
  const p = new URLSearchParams(await readBody(req));
  if (!single(p)) return fail(400, "invalid_request");
  // Public clients only: a secret in any form is a client we don't know.
  if (p.has("client_secret") || req.headers.authorization) return fail(401, "invalid_client");
  const clientId = p.get("client_id");
  if (!clientId) return fail(400, "invalid_request");
  if (await limited(req, res, ["oauth_token_ip", "oauth_token_client"], clientId)) return "rate_limited";
  const resource = p.get("resource");
  if (!resource) return fail(400, "invalid_request");
  if (resource !== RESOURCE && resource !== ENV_RESOURCE) return fail(400, "invalid_target");
  // The env API is the CLI's alone, and the CLI has no other resource.
  if ((resource === ENV_RESOURCE) !== (clientId === CLI_CLIENT_ID)) return fail(400, "invalid_target");

  const access = secret(resource === ENV_RESOURCE ? "rle_" : "rlo_");
  const refresh = secret("rlr_");
  let outcome: string;
  const grantType = p.get("grant_type");
  if (grantType === "authorization_code") doing("Exchanging a sign-in code for tokens");
  else if (grantType === "refresh_token") doing("Refreshing a sign-in");
  if (grantType === "authorization_code") {
    const code = p.get("code") ?? "";
    const redirectUri = p.get("redirect_uri");
    const verifier = p.get("code_verifier");
    if (!redirectUri || !verifier) return fail(400, "invalid_request");
    if (!CODE.test(code)) return fail(400, "invalid_grant");
    outcome = (
      await pool.query("select private.oauth_redeem_code($1, $2, $3, $4, $5, $6, $7) as r", [
        sha256(code), clientId, redirectUri, resource, verifier, sha256(access), sha256(refresh),
      ])
    ).rows[0].r;
  } else if (grantType === "refresh_token") {
    const old = p.get("refresh_token") ?? "";
    if (!REFRESH.test(old)) return fail(400, "invalid_grant");
    outcome = (
      await pool.query("select private.oauth_refresh($1, $2, $3, $4, $5) as r", [
        sha256(old), clientId, resource, sha256(access), sha256(refresh),
      ])
    ).rows[0].r;
  } else {
    return fail(400, grantType ? "unsupported_grant_type" : "invalid_request");
  }
  if (outcome !== "ok") return fail(400, outcome === "invalid_request" ? "invalid_request" : "invalid_grant");
  json(res, 200, { access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh });
  return "ok";
}

// RFC 7009: 200 whatever the token was, so it can't be used to probe.
async function revoke(req: http.IncomingMessage, res: http.ServerResponse): Promise<string> {
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
    return oauthError(res, 400, "invalid_request", "a revocation must be a form post (application/x-www-form-urlencoded)");
  }
  const p = new URLSearchParams(await readBody(req));
  const tok = p.get("token") ?? "";
  const clientId = p.get("client_id");
  if (!single(p) || !tok || !clientId) {
    return oauthError(res, 400, "invalid_request", "a revocation needs token and client_id, each once");
  }
  if (await limited(req, res, ["oauth_revoke_ip", "oauth_revoke_client"], clientId)) return "rate_limited";
  if (ACCESS.test(tok) || REFRESH.test(tok)) {
    await pool.query("select private.oauth_revoke($1, $2)", [sha256(tok), clientId]);
  }
  json(res, 200, {});
  return "ok";
}

export async function oauthPublic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const known =
    path === "/.well-known/oauth-authorization-server" || path === TOKEN_ENDPOINT || path === REVOKE_ENDPOINT ||
    path === CLI_METADATA_PATH;
  if (!known) return false;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS, "access-control-max-age": "600" }).end();
    return true;
  }
  let outcome: string;
  // Fixed words and the endpoint's path only: never a client id or code.
  doing(
    path === TOKEN_ENDPOINT ? "Getting a token" : path === REVOKE_ENDPOINT ? "Revoking a token" : "Reading the OAuth metadata",
    `oauth ${req.method} ${path}`,
  );
  try {
    if (path === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      json(res, 200, metadata(), { "cache-control": "public, max-age=300" });
      outcome = "ok";
    } else if (path === CLI_METADATA_PATH && req.method === "GET") {
      json(res, 200, cliClient(), { "cache-control": "public, max-age=300" });
      outcome = "ok";
    } else if (path === TOKEN_ENDPOINT && req.method === "POST") {
      outcome = await token(req, res);
    } else if (path === REVOKE_ENDPOINT && req.method === "POST") {
      outcome = await revoke(req, res);
    } else {
      const allow = path === TOKEN_ENDPOINT || path === REVOKE_ENDPOINT ? "POST" : "GET";
      oauthError(res, 405, "invalid_request", `${req.method} is not accepted here; this endpoint takes ${allow}`, { allow });
      outcome = "method";
    }
  } catch (err) {
    // server_error is the spec's own code; the reason and the reference
    // that finds the detail in the log go beside it (failure.ts).
    const f = fail(err, { where: "OAuth" });
    if (!res.headersSent) json(res, f.status >= 500 ? f.status : 500, { error: "server_error", error_description: ascii(`${f.what} failed: ${f.why}`), where: f.where, ref: f.ref });
    outcome = `server_error ref=${f.ref}`;
  }
  // Path and outcome only: never a code, token, client id or redirect.
  console.info(`${req.method} ${path} ${res.statusCode} ${outcome}`);
  return true;
}

// ---------------------------------------------------------------------------
// Authorize and consent (behind the web session, mounted in pages.ts)

type AuthRequest = {
  client: ClientMetadata;
  redirectUri: string;
  challenge: string;
  state: string | null;
  resource: string;
  scope: string | null;
};

const shell = (ctx: Ctx, title: string, body: ReturnType<typeof html>, status = 200, formAction?: string): Reply => ({
  status,
  formAction,
  html: page(title, body, { user: ctx.userId, theme: ctx.theme, csrf: ctx.csrf, path: "/", shell: ctx.shell }),
});

// Problems with the client or its redirect are shown here and never sent
// back to the redirect URI: it isn't known to be the client's (RFC 6749,
// 4.1.2.1).
const refuse = (ctx: Ctx, why: string): Reply => {
  const f = failure({ status: 400, where: "OAuth (the connecting app’s request)", why });
  return shell(
    ctx,
    "Can’t connect",
    html`<h1>This connection can’t be set up</h1><p class="lede">${why}</p>
      <p>Nothing was shared. Go back to the app you were connecting and try again, or <a href="/connect">connect another way</a>.</p>
      <p class="small muted">Where: ${f.where}. Reference: <code>ref ${f.ref}</code>.</p>`,
    400,
  );
};

function backTo(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.href;
}

// Validates an authorization request, from the query (GET) or the consent
// form's hidden fields (POST). Either a checked request, or a Reply: an error
// page, or a redirect with an OAuth error.
async function check(ctx: Ctx, p: URLSearchParams): Promise<AuthRequest | Reply> {
  const oauthKeys = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource", "scope"];
  if (oauthKeys.some((k) => p.getAll(k).length > 1)) return refuse(ctx, "The app sent a malformed request.");
  const clientId = p.get("client_id");
  if (!clientId) return refuse(ctx, "The app didn’t say who it is.");
  let client: ClientMetadata;
  if (clientId === CLI_CLIENT_ID) {
    client = { clientId, clientName: "Reliquary CLI", redirectUris: cliClient().redirect_uris };
  } else {
    try {
      client = await clientMetadata(clientId, { allowLoopback: ALLOW_LOOPBACK, beforeFetch: cimdLimit });
    } catch (err) {
      if (err instanceof CimdError) return refuse(ctx, `Reliquary couldn’t check the app. ${err.message}`);
      if (err instanceof RateLimited) return tooMany(ctx, err.retryAfter);
      throw err;
    }
  }
  const redirectUri = p.get("redirect_uri") ?? "";
  if (!redirectAllowed(client, redirectUri)) {
    return refuse(ctx, "The app asked to send you somewhere it hasn’t registered.");
  }
  const state = p.get("state");
  const error = (code: string): Reply => ({ redirect: backTo(redirectUri, { error: code, state, iss: ISSUER }) });
  if (state !== null && state.length > 1024) return error("invalid_request");
  if (p.get("response_type") !== "code") return error("unsupported_response_type");
  const challenge = p.get("code_challenge") ?? "";
  if (p.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return error("invalid_request");
  const resource = p.get("resource");
  if (!resource) return error("invalid_request");
  if (resource !== RESOURCE && resource !== ENV_RESOURCE) return error("invalid_target");
  if ((resource === ENV_RESOURCE) !== (client.clientId === CLI_CLIENT_ID)) return error("invalid_target");
  return { client, redirectUri, challenge, state, resource, scope: p.get("scope") };
}

// Fetches of a client's metadata document per client host (cimd.ts calls
// this on a cache miss only), so no one can make Reliquary fetch from one
// site over and over. Fails open.
async function cimdLimit(host: string): Promise<void> {
  const wait = await limit([{ name: "cimd_fetch_host", kind: "host", value: host.toLowerCase() }]);
  if (wait) throw new RateLimited(wait);
}

const tooMany = (ctx: Ctx, wait: number): Reply => ({
  status: 429,
  retryAfter: wait,
  html: tooManyPage(wait, ctx.theme, "That was too many connection requests in a short time"),
});

export async function authorize(ctx: Ctx): Promise<Reply> {
  // Per address and per client id (ratelimit.ts), before the client's
  // metadata is fetched. Fails open.
  const wait = await limit([
    { name: "oauth_authorize_ip", kind: "ip", value: ctx.ip },
    { name: "oauth_authorize_client", kind: "client", value: (ctx.method === "GET" ? ctx.url.searchParams : ctx.form).get("client_id") ?? "" },
  ]);
  if (wait) return tooMany(ctx, wait);
  if (ctx.method === "GET") {
    const r = await check(ctx, ctx.url.searchParams);
    return "client" in r ? consent(ctx, r) : r;
  }
  const r = await check(ctx, ctx.form);
  if (!("client" in r)) return r;
  const iss = ISSUER;
  if (ctx.form.get("decision") !== "approve") {
    return { redirect: backTo(r.redirectUri, { error: "access_denied", state: r.state, iss }) };
  }
  // Ticked vaults always narrow the grant, as on the Connections page.
  const ticked = ctx.form.getAll("vault");
  const some = ticked.length > 0 || ctx.form.get("reach") === "some";
  const access = ctx.form.get("access") === "write" ? "write" : "read";
  if (some && ticked.length === 0) return consent(ctx, r, "Tick at least one vault, or choose all your vaults.");
  if (!ticked.every((v) => /^[0-9a-f-]{36}$/.test(v))) return consent(ctx, r, "Choose vaults from the list.");
  const host = new URL(r.client.clientId).hostname;
  const name = `${r.client.clientName}${r.client.clientName === host ? "" : ` (${host})`}`.slice(0, 100);
  const cli = r.client.clientId === CLI_CLIENT_ID;
  let code: string;
  try {
    code = await asPerson(ctx.userId, async (c) =>
      (
        cli
          ? await c.query("select public.create_cli_grant($1, $2, $3, $4, $5::uuid[], $6) as code", [
              r.client.clientId, r.redirectUri, r.resource, r.challenge, some ? ticked : null, ctx.form.get("push") === "yes",
            ])
          : await c.query("select public.create_oauth_grant($1, $2, $3, $4, $5, $6::uuid[], $7) as code", [
              name, r.client.clientId, r.redirectUri, r.resource, r.challenge, some ? ticked : null, access,
            ])
      ).rows[0].code as string,
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "22023" || e.code === "42501") {
      const m = e.message ?? "Not allowed";
      return consent(ctx, r, m.charAt(0).toUpperCase() + m.slice(1) + ".");
    }
    throw err;
  }
  return { redirect: backTo(r.redirectUri, { code, state: r.state, iss }) };
}

async function consent(ctx: Ctx, r: AuthRequest, problem?: string): Promise<Reply> {
  const vaults = (await asPerson(ctx.userId, async (c) =>
    (
      await c.query(
        `select v.id, v.name from public.vaults v
           join public.vault_members m on m.vault_id = v.id and m.user_id = $1
          order by v.name`,
        [ctx.userId],
      )
    ).rows)) as { id: string; name: string }[];
  const back = new URL(r.redirectUri);
  const local = isLoopbackHost(back.hostname);
  const clientHost = new URL(r.client.clientId).hostname;
  const hidden = (name: string, value: string | null) =>
    value === null ? "" : html`<input type="hidden" name="${name}" value="${value}">`;
  const fields = html`${csrfField(ctx.csrf)}
      ${hidden("response_type", "code")}${hidden("client_id", r.client.clientId)}${hidden("redirect_uri", r.redirectUri)}
      ${hidden("code_challenge", r.challenge)}${hidden("code_challenge_method", "S256")}${hidden("state", r.state)}
      ${hidden("resource", r.resource)}${hidden("scope", r.scope)}`;
  const vaultChoice = (what: string) => html`<fieldset>
        <legend>Vaults</legend>
        <label class="choice"><input type="radio" name="reach" value="all" checked> All my vaults, including ones I join later</label>
        <label class="choice"><input type="radio" name="reach" value="some"> Only the vaults I tick</label>
        ${vaults.length
          ? html`<div class="choice-list">${vaults.map(
              (v) => html`<label class="choice"><input type="checkbox" name="vault" value="${v.id}"> ${v.name}</label>`,
            )}</div>`
          : html`<p class="hint">You don’t belong to any vaults yet.</p>`}
        <p class="hint">Ticking a vault limits ${what} to the ticked vaults.</p>
      </fieldset>`;
  if (r.client.clientId === CLI_CLIENT_ID) {
    // Our own CLI: environment variables only, on this computer.
    return shell(
      ctx,
      "Connect the Reliquary CLI",
      html`<div class="page-head"><div class="page-title-row"><div class="page-title"><h1>Connect the Reliquary CLI?</h1></div></div></div>
      <p class="lede">The Reliquary CLI on a computer wants to connect to your account and read environment variables as you, for <code>reliquary run</code> and <code>reliquary env pull</code>. It gets the values you may use (as an editor, development and preview; as an owner, production too), in the vaults you choose. It can’t read files, write, propose or change anything, and it never sets a value. Every read is in the vault’s access log. It shows on your <a href="/connections">Connections</a> page as Reliquary CLI, where you can revoke it any time.</p>
      ${problem ? html`<p class="callout attention" role="alert">${problem}</p>` : ""}
      <p class="callout attention loopback-warning"><strong>Only allow this if you just ran <code>reliquary login</code> on this computer yourself.</strong> It sends you back to ${back.host}, a program on this device, and any program here could have started this request.</p>
      <form method="post" action="/oauth/authorize" class="panel token-form">
        ${fields}
        ${vaultChoice("the CLI")}
        <fieldset>
          <legend>Sending values</legend>
          <label class="choice"><input type="checkbox" name="push" value="yes" checked> Also let it send <code>.env</code> files here (<code>reliquary env push</code>). They wait for you, or another owner or editor, to apply them on the Variables page; it can’t apply them itself.</label>
        </fieldset>
        <div class="actions"><button name="decision" value="deny">Deny</button> <button class="primary" name="decision" value="approve">Allow</button></div>
        <p class="hint">To change its vaults later, revoke it and run <code>reliquary login</code> again.</p>
      </form>`,
      200,
      back.origin,
    );
  }
  return shell(
    ctx,
    "Connect an app",
    html`<div class="page-head"><div class="page-title-row"><div class="page-title"><h1>Connect ${r.client.clientName}?</h1></div></div></div>
    <p class="lede">An app that calls itself <strong>${r.client.clientName}</strong> wants to act as you in Reliquary, over MCP. It can never approve, change rules or manage members. It shows on your <a href="/connections">Connections</a> page as an app, where you can revoke it any time.</p>
    ${problem ? html`<p class="callout attention" role="alert">${problem}</p>` : ""}
    <div class="panel">
      <p><span class="muted small">After you answer, you go back to</span><br><strong class="redirect-host">${back.host}</strong></p>
      <p><span class="muted small">The app is published at</span><br><code>${clientHost}</code></p>
      <p><span class="muted small">It will reach this MCP server</span><br><code>${r.resource}</code></p>
    </div>
    ${local
      ? html`<p class="callout attention loopback-warning"><strong>This app runs on a computer, not a website.</strong> It sends you back to ${back.host}, a program on this device, and any program here could have started this request. Only allow it if you just started connecting from an app on this computer yourself.</p>`
      : ""}
    <form method="post" action="/oauth/authorize" class="panel token-form">
      ${fields}
      ${vaultChoice("the app")}
      <fieldset>
        <legend>Access</legend>
        <label class="choice"><input type="radio" name="access" value="read" checked> Read only: read, search and follow changes</label>
        <label class="choice"><input type="radio" name="access" value="write"> Read and write: also write open files and propose changes</label>
      </fieldset>
      <div class="actions"><button name="decision" value="deny">Deny</button> <button class="primary" name="decision" value="approve">Allow</button></div>
      <p class="hint">The app’s vaults and access can’t be changed later. To change them, revoke it and connect again.</p>
    </form>`,
    200,
    // The answer is a redirect to the app: the page's form-action must allow
    // that origin, or the browser blocks it (CSP applies to form redirects).
    back.origin,
  );
}
