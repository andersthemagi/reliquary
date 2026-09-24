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
//
// A grant is an access_tokens row, made by the person in
// public.create_oauth_grant (never by an agent: the web session has no `act`
// claim, and the database refuses one). Codes and tokens are random, handed
// out once and stored as SHA-256 by the database. None of them, and no
// request value, is ever logged or echoed in an error.
//
// Config: the issuer is PUBLIC_URL (else this server's local address); the
// one resource accepted is MCP_RESOURCE (else MCP_PUBLIC_URL), byte for byte
// the value the MCP server has. CIMD_ALLOW_LOOPBACK=1 lets tests serve client
// metadata from loopback; it is refused when VERCEL is set.

import { createHash, randomBytes } from "node:crypto";
import type http from "node:http";
import { CimdError, clientMetadata, isLoopbackHost, redirectAllowed, type ClientMetadata } from "./cimd.js";
import { asPerson, pool } from "./db.js";
import { csrfField, html, page } from "./html.js";
import type { Ctx, Reply } from "./pages.js";

function config() {
  const onVercel = !!process.env.VERCEL;
  const allowLoopback = process.env.CIMD_ALLOW_LOOPBACK === "1";
  if (onVercel && allowLoopback) throw new Error("Refusing to start: CIMD_ALLOW_LOOPBACK is for tests and must not be set on Vercel");
  let issuer = `http://${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8790}`;
  if (process.env.PUBLIC_URL) issuer = new URL(process.env.PUBLIC_URL).origin;
  else if (onVercel) throw new Error("Refusing to start: VERCEL is set but PUBLIC_URL (the OAuth issuer) is not");
  const resource = process.env.MCP_RESOURCE ?? process.env.MCP_PUBLIC_URL ?? "http://127.0.0.1:8787/mcp";
  if (onVercel && !process.env.MCP_RESOURCE && !process.env.MCP_PUBLIC_URL) {
    throw new Error("Refusing to start: VERCEL is set but MCP_RESOURCE is not");
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

const { issuer: ISSUER, resource: RESOURCE, allowLoopback: ALLOW_LOOPBACK } = config();

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
const ACCESS = /^rlo_[0-9a-f]{64}$/;

async function token(req: http.IncomingMessage, res: http.ServerResponse): Promise<string> {
  const fail = (status: number, error: string) => {
    json(res, status, { error });
    return error;
  };
  if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers["content-type"] ?? "")) {
    return fail(400, "invalid_request");
  }
  const p = new URLSearchParams(await readBody(req));
  if (!single(p)) return fail(400, "invalid_request");
  // Public clients only: a secret in any form is a client we don't know.
  if (p.has("client_secret") || req.headers.authorization) return fail(401, "invalid_client");
  const clientId = p.get("client_id");
  if (!clientId) return fail(400, "invalid_request");
  const resource = p.get("resource");
  if (!resource) return fail(400, "invalid_request");
  if (resource !== RESOURCE) return fail(400, "invalid_target");

  const access = secret("rlo_");
  const refresh = secret("rlr_");
  let outcome: string;
  const grantType = p.get("grant_type");
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
    json(res, 400, { error: "invalid_request" });
    return "invalid_request";
  }
  const p = new URLSearchParams(await readBody(req));
  const tok = p.get("token") ?? "";
  const clientId = p.get("client_id");
  if (!single(p) || !tok || !clientId) {
    json(res, 400, { error: "invalid_request" });
    return "invalid_request";
  }
  if (ACCESS.test(tok) || REFRESH.test(tok)) {
    await pool.query("select private.oauth_revoke($1, $2)", [sha256(tok), clientId]);
  }
  json(res, 200, {});
  return "ok";
}

export async function oauthPublic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const known =
    path === "/.well-known/oauth-authorization-server" || path === TOKEN_ENDPOINT || path === REVOKE_ENDPOINT;
  if (!known) return false;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...CORS, "access-control-max-age": "600" }).end();
    return true;
  }
  let outcome: string;
  try {
    if (path === "/.well-known/oauth-authorization-server" && req.method === "GET") {
      json(res, 200, metadata(), { "cache-control": "public, max-age=300" });
      outcome = "ok";
    } else if (path === TOKEN_ENDPOINT && req.method === "POST") {
      outcome = await token(req, res);
    } else if (path === REVOKE_ENDPOINT && req.method === "POST") {
      outcome = await revoke(req, res);
    } else {
      json(res, 405, { error: "invalid_request" }, { allow: path.startsWith("/.well-known") ? "GET" : "POST" });
      outcome = "method";
    }
  } catch (err) {
    console.error("oauth error", (err as { code?: string }).code ?? (err as Error).name);
    if (!res.headersSent) json(res, 500, { error: "server_error" });
    outcome = "server_error";
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
  html: page(title, body, { user: ctx.userId, theme: ctx.theme, csrf: ctx.csrf, path: "/", reviewCount: ctx.reviewCount }),
});

// Problems with the client or its redirect are shown here and never sent
// back to the redirect URI: it isn't known to be the client's (RFC 6749,
// 4.1.2.1).
const refuse = (ctx: Ctx, why: string): Reply =>
  shell(
    ctx,
    "Can’t connect",
    html`<h1>This connection can’t be set up</h1><p class="lede">${why}</p>
      <p>Nothing was shared. Go back to the app you were connecting and try again, or <a href="/connect">connect another way</a>.</p>`,
    400,
  );

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
  try {
    client = await clientMetadata(clientId, { allowLoopback: ALLOW_LOOPBACK });
  } catch (err) {
    if (err instanceof CimdError) return refuse(ctx, `Reliquary couldn’t check the app. ${err.message}`);
    throw err;
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
  if (resource !== RESOURCE) return error("invalid_target");
  return { client, redirectUri, challenge, state, resource, scope: p.get("scope") };
}

export async function authorize(ctx: Ctx): Promise<Reply> {
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
  // Ticked vaults always narrow the grant, as on the Tokens page.
  const ticked = ctx.form.getAll("vault");
  const some = ticked.length > 0 || ctx.form.get("reach") === "some";
  const access = ctx.form.get("access") === "write" ? "write" : "read";
  if (some && ticked.length === 0) return consent(ctx, r, "Tick at least one vault, or choose all your vaults.");
  if (!ticked.every((v) => /^[0-9a-f-]{36}$/.test(v))) return consent(ctx, r, "Choose vaults from the list.");
  const host = new URL(r.client.clientId).hostname;
  const name = `${r.client.clientName}${r.client.clientName === host ? "" : ` (${host})`}`.slice(0, 100);
  let code: string;
  try {
    code = await asPerson(ctx.userId, async (c) =>
      (
        await c.query("select public.create_oauth_grant($1, $2, $3, $4, $5, $6::uuid[], $7) as code", [
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
  return shell(
    ctx,
    "Connect an app",
    html`<div class="page-head"><div class="page-title-row"><div class="page-title"><h1>Connect ${r.client.clientName}?</h1></div></div></div>
    <p class="lede">An app that calls itself <strong>${r.client.clientName}</strong> wants to act as you in Reliquary, over MCP. It can never approve, change rules or manage members, and you can revoke it any time on the <a href="/tokens">Tokens</a> page.</p>
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
      ${csrfField(ctx.csrf)}
      ${hidden("response_type", "code")}${hidden("client_id", r.client.clientId)}${hidden("redirect_uri", r.redirectUri)}
      ${hidden("code_challenge", r.challenge)}${hidden("code_challenge_method", "S256")}${hidden("state", r.state)}
      ${hidden("resource", r.resource)}${hidden("scope", r.scope)}
      <fieldset>
        <legend>Vaults</legend>
        <label class="choice"><input type="radio" name="reach" value="all" checked> All my vaults, including ones I join later</label>
        <label class="choice"><input type="radio" name="reach" value="some"> Only the vaults I tick</label>
        ${vaults.length
          ? html`<div class="choice-list">${vaults.map(
              (v) => html`<label class="choice"><input type="checkbox" name="vault" value="${v.id}"> ${v.name}</label>`,
            )}</div>`
          : html`<p class="hint">You don’t belong to any vaults yet.</p>`}
        <p class="hint">Ticking a vault limits the app to the ticked vaults.</p>
      </fieldset>
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
