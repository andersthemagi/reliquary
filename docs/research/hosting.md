# Hosting: Vercel, Supabase, sign-in and MCP OAuth

2026-09-24 · Status: RESEARCH and PLAN · Companions:
[design.md](../design.md) (Access surfaces, Architecture, Privacy, Open
decisions 3 and 5), [testing-strategy.md](testing-strategy.md)

The owner has decided: the app runs on **Vercel** (Hobby now, Pro when
commercial, functions in `fra1` Frankfurt); the database is a **free Supabase
project in `eu-central-1`** (Frankfurt), kept awake by a scheduled ping. This
note works out how our code gets there, what each piece costs, and a build plan
that parallel agents can follow.

Sources were checked on 2026-09-24. *(unverified)* marks claims taken from
search snippets, third parties, or my own reading of code, not the vendor's
page.

## 0. Answers in one table

| # | Question | Answer |
|---|---|---|
| 1 | Our Node servers on Vercel | **Two Vercel projects** (`web/`, `mcp/`), each using Vercel's zero-config Node server support (a `src/server.ts` that calls `listen()`). Around 15 changed lines each, plus `vercel.json`. Fluid compute, `fra1`, `maxDuration` 30 to 60 s. MCP needs no streaming: we answer with JSON |
| 2 | DB from serverless | Supavisor **transaction mode, port 6543**, user `reliquary_web.<ref>` / `reliquary_mcp.<ref>`. Our `begin; set local role; set_config(...,true)` pattern is transaction-scoped, so it is safe. No named prepared statements. Small pool per instance (`max` 3 to 5). TLS verified against Supabase's CA |
| 3 | Web sign-in | Supabase Auth **email OTP / link**, handled entirely server-side by calling the Auth REST API. Session in `__Host-` HttpOnly, Secure, SameSite=Lax cookies. Verify the JWT against the project's JWKS (ES256 or RS256, whichever it publishes). DB layer stays: connect as `reliquary_web`, claims `{sub}` from the verified JWT. **Custom SMTP required** (Resend or an EU sender) |
| 4 | MCP OAuth 2.1 | **Build a small authorization server in `web/`**, with sign-in delegated to Supabase Auth, CIMD first, DCR optional, opaque tokens stored hashed like `rlq_`. Supabase's OAuth 2.1 server (beta) can't bind tokens to our resource, has no CIMD, and its tokens also work against PostgREST without the agent ceiling. PATs keep working unchanged |
| 5 | Secrets | Vercel env vars marked Sensitive; DB role passwords set once by the owner in SQL, never in migrations or CI; the Supabase secret key is not needed in milestone 1 |
| 6 | Keepalive | GitHub Actions cron every 6 h hitting `GET /healthz?db=1` on the MCP app (returns `ok` only). Private repo, so the 60-day auto-disable doesn't apply |
| 7 | Local parity | Keep plain Postgres + `stub.sql` for all suites. Add a **fake Supabase Auth** (tiny Node server signing JWTs with a throwaway key) for sign-in tests. No `supabase start` in CI |
| 8 | Migrations | `supabase link` + `supabase db push` from a manual GitHub workflow. Our filenames already fit. Check `grant authenticated to reliquary_*` on the hosted project first |
| 9 | Costs | $0 now. Move to Vercel Pro ($20/mo) the day it's commercial (Hobby terms), and Supabase Pro ($25/mo) at the first real client data (backups, no pausing) |

## 1. Web and MCP on Vercel Functions

### What Vercel offers now

| Fact | Source |
|---|---|
| Zero-config **Node server**: Vercel detects `server.{js,mjs,ts,mts}` at the project root or `src/server.*` that calls `server.listen()` at module load, and routes every request to it. Plain `IncomingMessage` / `ServerResponse`. GA 2026-06-23 | [Node.js runtime](https://vercel.com/docs/functions/runtimes/node-js), [changelog](https://vercel.com/changelog/deploy-node-servers-with-zero-configuration) |
| Alternatives still work: `api/*.ts` exporting a `(req, res)` handler, `export default { fetch }`, or `GET`/`POST` exports | same |
| **Fluid compute** is on by default for new projects (since 2025-04-23). One instance serves several requests at once in one process, so a module-level `pg.Pool` is shared | [Fluid compute](https://vercel.com/docs/fluid-compute), [limitations](https://vercel.com/docs/functions/limitations) |
| Duration: Hobby 300 s default and max; Pro 300 s default, 800 s max. 2 GB / 1 vCPU default. Bodies capped at 4.5 MB | [limits](https://vercel.com/docs/limits) |
| Regions: default `iad1`; set `"regions": ["fra1"]`. Hobby gets one region, of your choice | [regions](https://vercel.com/docs/functions/configuring-functions/region) |
| Node functions stream by default; SSE works up to `maxDuration` | [streaming](https://vercel.com/docs/functions/streaming-functions) |
| Cold starts: bytecode caching on Node 20+ in production; pre-warmed instances on paid plans only | [cold starts KB](https://vercel.com/kb/guide/improve-function-cold-start-performance-on-vercel) |
| Monorepo: one Vercel project per app, each with a Root Directory; unchanged projects are skipped | [monorepos](https://vercel.com/docs/monorepos) |
| `public/` under the Root Directory is served from the CDN before the function sees the request. Documented for Express; assumed for the plain Node server *(unverified)* | [Express on Vercel](https://vercel.com/docs/frameworks/backend/express) |

### One project or two

**Two**: `reliquary-web` (Root Directory `web`) and `reliquary-mcp` (Root
Directory `mcp`).

| | Two projects | One project ("Services", beta) |
|---|---|---|
| Domains | `app.<domain>` and `mcp.<domain>` | one domain, path-routed |
| Env vars | separate: web never holds the MCP role's password and vice versa | shared |
| Logs, protection, rollbacks | per app | together |
| Maturity | standard | beta ([services](https://vercel.com/docs/services)) |

Separate env vars fit our least-privilege roles. Cross-host OAuth is fine:
the MCP's protected resource metadata points at the web app as its
authorization server ([Claude connector auth](https://claude.com/docs/connectors/building/authentication#cross-host-authorization-servers)).

### The minimal code change

Both `web/src/server.ts` and `mcp/src/server.ts` already call `listen()` at
module load from `src/server.ts`, which is the shape Vercel detects. What must
change:

| Where | Why | Change |
|---|---|---|
| both `server.ts` | Vercel supplies the port and owns the socket *(host handling unverified)* | `listen(PORT, process.env.VERCEL ? undefined : HOST)` |
| `web/src/server.ts` static map | On Vercel `public/` goes to the CDN and may be missing from the function bundle; `readdirSync` would crash the cold start | Build the map only if `public/` exists; take the style version from `VERCEL_GIT_COMMIT_SHA` when set |
| `web/src/server.ts` Origin check | Compares with `http://${host}`; on Vercel the page is `https://` and would be refused | Compare with `PUBLIC_URL` (e.g. `https://app.<domain>`) |
| `web/src/server.ts` cookies | Need `Secure` on https | `__Host-` prefix + `Secure` when `PUBLIC_URL` is https |
| `web/src/server.ts` sessions | The in-memory `sessions` Map and `loginCode` don't survive across instances | Replaced by chunk B (cookie-held Supabase session, HMAC'd CSRF) |
| both `db.ts` | TLS and pool size (section 2) | `ssl` with the CA; `max` from env, default 3 |

```ts
// web/src/server.ts and mcp/src/server.ts (sketch)
const onVercel = !!process.env.VERCEL;
server.listen(PORT, onVercel ? undefined : HOST, () => console.info("listening"));
```

```jsonc
// web/vercel.json (mcp/vercel.json is the same with maxDuration 60)
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["fra1"],
  "fluid": true,
  "functions": { "src/server.ts": { "maxDuration": 30 } },
  "headers": [
    { "source": "/fonts/(.*)", "headers": [{ "key": "cache-control", "value": "public, max-age=31536000, immutable" }] }
  ],
  "git": { "deploymentEnabled": { "main": false } }
}
```

`git.deploymentEnabled.main: false` lets the deploy workflow (chunk D) apply
migrations before code ships. If the zero-config detection misbehaves, the
fallback is to export the handler (`export const handle = (req, res) => ...`),
start the server only when `!process.env.VERCEL`, and add `api/index.ts`
re-exporting it with `"rewrites": [{ "source": "/(.*)", "destination": "/api/index" }]`.

### MCP on Vercel

- We use `StreamableHTTPServerTransport` stateless with `enableJsonResponse:
  true`, a fresh server per request, POST only. That is plain request and
  response; streaming isn't needed, and would work anyway.
- Known SDK issue: a client sending only `Accept: application/json` gets 406
  ([typescript-sdk#1944](https://github.com/modelcontextprotocol/typescript-sdk/issues/1944)).
  Claude and ChatGPT send both types.
- Vercel's [`mcp-handler`](https://github.com/vercel/mcp-handler) v2 (spec
  2026-07-28, `withMcpAuth`, `protectedResourceHandler`) needs Web
  `Request`/`Response` and SDK v2. Not worth a migration now; revisit when we
  move to SDK v2.
- Cold start on Hobby: no pre-warming. Expect roughly a second on the first
  call after idle *(unverified)*. Both functions and the DB are in Frankfurt,
  so the pooler round trip is small.

### Things that bite

- **Hobby is non-commercial only**, including "a paid employee or consultant
  writing the code" ([fair use](https://vercel.com/docs/limits/fair-use-guidelines)).
  Fine for Andrés's own vault; switch to Pro before any client.
- **Deployment Protection** is on by default and puts a Vercel login in front of
  preview and `*.vercel.app` URLs, production's included. MCP clients and
  OAuth callbacks can't pass it, so production needs the custom domain
  ([deployment protection](https://vercel.com/docs/deployment-protection)).
- Hobby over quota: the feature pauses until the 30-day window resets
  ([Hobby](https://vercel.com/docs/plans/hobby)).
- Hobby keeps runtime logs 1 hour. Our logs already carry no secrets.

## 2. Database connections from serverless

| Setting | Value | Source |
|---|---|---|
| Host | the shared pooler host shown in the dashboard's Connect panel (e.g. `aws-0-eu-central-1.pooler.supabase.com`) | [connecting](https://supabase.com/docs/guides/database/connecting-to-postgres) |
| Mode | **transaction, port 6543**. Recommended for serverless | same |
| User | `reliquary_web.<project-ref>` / `reliquary_mcp.<project-ref>`: custom roles work through the shared pooler | same |
| IPv4 | the shared pooler is IPv4 on every plan; the direct host is IPv6 unless you buy the add-on. Vercel needs IPv4 | same |
| TLS | `sslmode=require` at least; better, verify against the downloadable Supabase root CA | same |

Why our pattern is safe in transaction mode: every request runs `begin; set
local role authenticated; select set_config('request.jwt.claims', $1, true);
...; commit`. `SET LOCAL` and `set_config(..., true)` end with the transaction,
which is exactly the unit Supavisor pins to one server connection, so no
claims leak into another client's transaction. `resolveToken` and
`recordClient` are single statements outside a transaction, also fine.

Caveats and settings:

- **Prepared statements**: transaction mode doesn't support them.
  node-postgres only creates *named* prepared statements when a query passes
  `name` ([pg queries](https://node-postgres.com/features/queries)); Supabase's
  fix for pg is "omit the name value"
  ([troubleshooting](https://supabase.com/docs/guides/troubleshooting/disabling-prepared-statements-qL8lEL)).
  Rule: never pass `name`. Never a session-level `SET` either: it would leak
  to other clients sharing the server connection.
- **Pool**: module-level `pg.Pool`, shared by the concurrent requests in a
  Fluid instance. `max: 3` (web) and `max: 5` (MCP), `idleTimeoutMillis:
  10_000`, `connectionTimeoutMillis: 5_000`. Many instances x small pools
  stays well under the pooler's limit (Free/Nano and Micro: 60 direct
  connections, **200 pooler clients**,
  [compute](https://supabase.com/docs/guides/platform/compute-and-disk)). Each
  role gets its own Supavisor pool. Supabase says pool size 1 for serverless;
  Vercel says not 1 on Fluid, idle timeout about 5 s, and call
  `attachDatabasePool(pool)` from `@vercel/functions` right after creating it
  ([Vercel KB](https://vercel.com/kb/guide/connection-pooling-with-functions)).
  A Supavisor leak of client connections with Fluid + `attachDatabasePool` was
  fixed in July 2026 ([discussion #40671](https://github.com/orgs/supabase/discussions/40671));
  watch the pooler client count in the first week.
- **TLS with node-postgres**: `pg-connection-string` treats `sslmode=require`
  as full verification against Node's default CAs unless `uselibpqcompat=true`
  ([README](https://github.com/brianc/node-postgres/blob/master/packages/pg-connection-string/README.md)),
  and Supabase's CA isn't a public root. So leave `sslmode` out of the URL and
  pass the CA explicitly: `ssl: { ca: readFileSync("supabase-ca.crt"),
  rejectUnauthorized: true }`. The CA is public; commit it at `web/` and `mcp/`
  roots (or one copy referenced by both builds).
- `statement_timeout`: set per role (`alter role reliquary_web set
  statement_timeout = '10s'`) in a migration, so a slow query can't hold a
  pooled connection.

## 3. Web sign-in with Supabase Auth, no client script

### Flow

The UI's CSP forbids scripts, so supabase-js in the browser is out. We call
Supabase Auth's REST API from the server with `fetch` (no dependency), using
the publishable key as `apikey`.

| Step | Request | Notes |
|---|---|---|
| 1. `/signin` form (email) | `POST {SUPABASE_URL}/auth/v1/otp` `{ email, create_user: false }` | `create_user: false`: members are invited, nobody self-signs-up in milestone 1 |
| 2. Email | template has the 6-digit `{{ .Token }}` **and** a link `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` | [PKCE email flow for SSR](https://supabase.com/docs/guides/auth/server-side/email-based-auth-with-pkce-flow-for-ssr) |
| 3a. Link | `GET /auth/confirm` renders a page with one **Sign in** button (form POST). The POST calls `POST /auth/v1/verify` `{ type: "email", token_hash }` | The button stops mail scanners from burning the single-use link ([production checklist](https://supabase.com/docs/guides/deployment/going-into-prod), "Email link validity") |
| 3b. Code | form with the 6 digits: `POST /auth/v1/verify` `{ type: "email", email, token }` | Works when the email opens on another device |
| 4. Session | response has `access_token` (JWT, 1 h), `refresh_token`, `expires_in` | |
| 5. Refresh | when the JWT expired and a refresh cookie exists: `POST /auth/v1/token?grant_type=refresh_token` | rotation; write both new cookies |
| 6. Sign out | `POST /auth/v1/logout` with the access token; clear cookies | |

PKCE: the `token_hash` link is verified by our server, so there is no
browser-side code to intercept; the `flow_type=pkce` code exchange isn't needed
for this shape. If we later add OAuth sign-in providers (Google), use PKCE
with the verifier in an HttpOnly cookie and exchange server-side.

### Cookies and CSRF

| Cookie | Content | Attributes |
|---|---|---|
| `__Host-rlq_at` | Supabase access JWT | HttpOnly, Secure, SameSite=**Lax**, Path=/, Max-Age 3600 |
| `__Host-rlq_rt` | refresh token | HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age 30 days |
| `__Host-rlq_flash` | one-shot notice | HttpOnly, Secure, SameSite=Lax |

- **Lax, not Strict**: the OAuth consent page (section 4) is reached by a
  top-level redirect from claude.ai or chatgpt.com; Strict cookies aren't
  sent on that navigation, and the person would look signed out. Lax is sent
  on top-level GETs only; every POST still needs the CSRF token and the
  same-origin check.
- Responses that set auth cookies send `Cache-Control: private, no-store`
  (already `no-store` on every page).
- Two tabs refreshing at once: the 10 s reuse window covers it; outside it
  Supabase revokes the session and the person signs in again.
- **CSRF without server state**: `csrf = HMAC(SESSION_SECRET, jwt.session_id)`.
  Rotates with each sign-in, needs no store.

### Verifying the JWT

- JWKS: `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`, cached 10
  min at Supabase's edge ([signing keys](https://supabase.com/docs/guides/auth/signing-keys)).
  Use asymmetric keys; the legacy HS256 secret still exists but is "not
  recommended for production". The docs disagree on the default: the
  signing-keys page recommends ES256, the
  [changelog](https://supabase.com/changelog/29289-supabase-auth-asymmetric-keys-support-in-2025)
  says new projects since 2025-05-01 get RS256. Read `alg` from the project's
  JWKS and pin that.
- Code: `jose`'s `createRemoteJWKSet` + `jwtVerify(token, jwks, { issuer:
  `${SUPABASE_URL}/auth/v1`, audience: "authenticated", algorithms: [JWT_ALG] })`.
  Claims available: `sub`, `role`, `aud`, `aal`, `session_id`, `email`, `exp`
  ([JWT fields](https://supabase.com/docs/guides/auth/jwt-fields)).
  Refuse tokens carrying `client_id` (OAuth-server tokens, section 4).
- Local verification doesn't see a revoked session until the JWT expires (up
  to 1 h). Acceptable for milestone 1; sign-out also clears our cookies.
- Then, unchanged: `asPerson(payload.sub, ...)`: connect as `reliquary_web`,
  `set local role authenticated`, claims `{ sub, role }`, **no `act`**. The
  database stays the only judge. The web server never uses a Supabase key that
  bypasses RLS.

### Email: rate limits and SMTP

| Limit | Value | Source |
|---|---|---|
| Built-in SMTP | **2 emails/h, delivered only to the project team's addresses**, "not meant for production use" | [SMTP](https://supabase.com/docs/guides/auth/auth-smtp) |
| With custom SMTP | starts at 30 emails/h, adjustable | same |
| OTP / magic link | one per user per 60 s; link or code valid 1 h by default | [passwordless](https://supabase.com/docs/guides/auth/auth-email-passwordless) |
| Sign-in and verify | 30 per 5 min each; token refresh 150 per 5 min | [rate limits](https://supabase.com/docs/guides/auth/rate-limits) |
| Refresh tokens | single-use, 10 s reuse window; reuse after that revokes the session | [sessions](https://supabase.com/docs/guides/auth/sessions) |

**Custom SMTP is required** for anyone but Andrés. Resend's free plan: 3,000
emails/month, 100/day, sending from an EU region, but account data and logs
stay in the US ([Resend limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits),
[EU region](https://resend.com/changelog/multi-region-for-everyone)). That
makes Resend a sub-processor with US data. Acceptable for milestone 1 (sign-in
emails only); for the GDPR story, an EU sender (e.g. AWS SES in
`eu-central-1`) is the alternative. Both need a verified domain, so **the domain
comes first**. Disable link tracking in the SMTP provider: it rewrites the
sign-in link.

Also set in Supabase Auth: Site URL = `https://app.<domain>`; redirect allow
list = that origin only (add `https://*-<slug>.vercel.app/**` only if previews
need sign-in, [redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls));
OTP expiry 10 min; signups disabled.

## 4. OAuth 2.1 for the remote MCP endpoint

### What the spec and the clients need

Current MCP spec revision **2026-07-28**
([authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization)):

| Piece | Requirement |
|---|---|
| Protected resource metadata (RFC 9728) | MCP server **MUST** serve it; 401 carries `WWW-Authenticate: Bearer resource_metadata="..."` |
| AS metadata | RFC 8414 or OIDC discovery; `code_challenge_methods_supported: ["S256"]` |
| Registration | Client priority: pre-registered, then **Client ID Metadata Documents** (SHOULD), then DCR (**deprecated**, kept for compatibility) |
| PKCE | S256, mandatory |
| `resource` (RFC 8707) | Clients MUST send it on authorize and token; server **MUST** check tokens were issued for it |
| `iss` in authorization response (RFC 9207) | SHOULD, expected to become MUST |
| No passthrough | server MUST NOT accept or forward other tokens |
| Refresh | public clients: rotate refresh tokens |

| Client | Registration | Redirect | Notes |
|---|---|---|---|
| Claude (web, desktop, mobile, Cowork) | CIMD only if AS metadata has `client_id_metadata_document_supported: true` **and** `"none"` in `token_endpoint_auth_methods_supported`; else DCR | `https://claude.ai/api/mcp/auth_callback` | 10 s timeout on discovery/token; `/token` must accept form-urlencoded; refresh on 401 ([Claude](https://claude.com/docs/connectors/building/authentication)) |
| Claude Code | its own CIMD `https://claude.ai/oauth/claude-code-client-metadata` | loopback, **any port** (`http://localhost/callback`, `http://127.0.0.1/callback`) | AS must match loopback ignoring the port |
| ChatGPT | CIMD preferred, then DCR, then predefined | `https://chatgpt.com/connector_platform_oauth_redirect` if the AS supports `iss`, else `https://chatgpt.com/connector/oauth/{callback_id}` | sends `resource`, expects it in `aud` ([OpenAI auth](https://developers.openai.com/plugins/build/auth)) |

### Supabase Auth's OAuth 2.1 server: checked, not chosen

| Need | Supabase OAuth server | Source |
|---|---|---|
| Status | public beta, free on all plans during beta | [getting started](https://supabase.com/docs/guides/auth/oauth-server/getting-started) |
| Consent UI | we host it at Site URL + "Authorization Path"; server-rendered works (approve/deny return a `redirect_url`) | same |
| DCR | yes, toggle, off by default | [MCP auth](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication) |
| CIMD | **no** (feature request with a proposed flag, not merged) | [discussion #41695](https://github.com/orgs/supabase/discussions/41695) |
| Loopback any-port redirect | **no**, exact string match (breaks Claude Code OAuth) | same |
| `resource` / audience | **no**: `aud` is `"authenticated"`; only a Custom Access Token Hook can change it, not from the request | [flows](https://supabase.com/docs/guides/auth/oauth-server/oauth-flows), [FastMCP note](https://gofastmcp.com/integrations/supabase) *(third party)* |
| `iss` response param | not advertised *(unverified)* | |
| Token reach | a normal `authenticated` user JWT plus `client_id`: it also works **directly against PostgREST as the person, with no `act` claim**, so an agent's token would skip the delegation ceiling unless every policy checks `client_id` | [token security](https://supabase.com/docs/guides/auth/oauth-server/token-security) |

The last row alone rules it out: it breaks "an agent is its person, minus a
ceiling" at the database. Revisit if Supabase ships CIMD and `resource`
binding; the consent page we build would carry over.

### Options compared

| Criterion | **Own AS in `web/`** | Supabase OAuth server | Hosted IdP (WorkOS, Auth0, Stytch, Descope, Clerk) |
|---|---|---|---|
| Audience binding (spec MUST, ChatGPT asks) | yes | no | yes |
| CIMD | yes, we build it | no | mostly yes |
| Token can't bypass MCP to PostgREST | yes (opaque) | **no** | yes |
| Ceiling, scope and revocation in the DB | yes, reuses `access_tokens` | partial | no, external |
| One user store, EU data | yes | yes | no: second identity store, mostly US *(unverified)* |
| Effort | medium; we own the security | low | low |

Libraries: `oidc-provider` (panva) is certified and has resource indicators,
but CIMD is experimental and it's heavy for a stateless function. The MCP TS
SDK's AS helpers (`mcpAuthRouter`, `ProxyOAuthServerProvider`) are deprecated
and frozen in SDK v2 ([migration](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/upgrade-to-v2.md)).

**Recommendation: our own minimal AS in the web app.** The surface is small
(one grant type plus refresh, public clients, S256 only), and it slots into
what exists: an OAuth grant *is* an `access_tokens` row, so vault scope,
read/write access, the Tokens page, revocation, the `act` claim and every
hostile test apply unchanged.

### Shape of it

| Endpoint (web app) | Does |
|---|---|
| `GET /.well-known/oauth-authorization-server` | `issuer`, `authorization_endpoint`, `token_endpoint`, `revocation_endpoint`, optional `registration_endpoint`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported: ["none"]`, `client_id_metadata_document_supported: true`, `authorization_response_iss_parameter_supported: true`, `grant_types_supported: ["authorization_code","refresh_token"]` |
| `GET /oauth/authorize` | validate `client_id` (CIMD fetch or DCR row), `redirect_uri` (exact; loopback any port), `code_challenge` S256, `resource` == `MCP_RESOURCE` exactly. Not signed in: to `/signin?next=...`. Then a consent page: client name, **redirect host**, a loopback warning, vault choice and read-only / read-write, like the Tokens page |
| `POST /oauth/authorize` | CSRF-checked approve: create the grant (an `access_tokens` row with `kind = 'oauth'`, client id, resource), a single-use code (hash, 60 s), then 303 to `redirect_uri?code&state&iss` |
| `POST /oauth/token` | form-urlencoded; `authorization_code` (verifier, same redirect_uri and resource) and `refresh_token` (rotate; reuse of an old one revokes the grant); returns `rlo_` access token (1 h) and `rlr_` refresh token (30 days, sliding) |
| `POST /oauth/revoke` | RFC 7009 |
| `POST /oauth/register` | DCR, optional; public clients only, rate-limited. Add only if a client we need lacks CIMD |

| MCP app | Does |
|---|---|
| `GET /.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource` | `{ resource: MCP_RESOURCE, authorization_servers: [AUTH_ISSUER], scopes_supported: [] , bearer_methods_supported: ["header"] }` |
| 401 | `WWW-Authenticate: Bearer resource_metadata="https://mcp.<domain>/.well-known/oauth-protected-resource/mcp"` |
| Bearer `rlq_...` | PAT, unchanged |
| Bearer `rlo_...` | `private.resolve_oauth_token(hash, resource)` returns the same `(token_id, user_id, name)` as PATs; then the same `asIdentity` |

New migration (chunk C): `oauth_clients` (CIMD cache or DCR row: id, name,
redirect URIs, fetched_at), `oauth_codes` (hash, grant, challenge,
redirect_uri, resource, expires_at, used_at), `oauth_tokens` (hash, grant,
kind access/refresh, family, expires_at, used_at); `access_tokens.kind` and
`client_id`. Only `reliquary_web` can mint; only `reliquary_mcp` can resolve.
Codes and tokens are working state, not history, so deleting expired ones is
allowed (unlike `log`).

Gotchas to design in:

- **CSP `form-action` also governs the redirect after a form POST** in
  Chromium *(unverified per-browser)*. The consent page's CSP must add the
  validated redirect origin (`form-action 'self' https://claude.ai`), or the
  303 to the client is blocked. A browser e2e check is worth one test.
- **CIMD fetch is SSRF-prone**: https only, no redirects, resolve DNS and
  refuse private, loopback and link-local addresses, 5 s timeout, 5 KB cap,
  JSON only, `client_id` must equal the document URL, cache for hours
  ([CIMD draft, security](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)).
- The consent screen must show the redirect hostname and warn on loopback-only
  clients (local impersonation).
- Never log codes or tokens; OAuth errors never echo request values.
- One URL for all vaults: the design says "one URL per vault"; with vault
  choice at consent and token scope already in the DB, one URL is simpler and
  equivalent. Update the design when C lands.

### PATs alongside

Claude Code and headless agents keep `rlq_` tokens via the `headersHelper`
setup on the Connect page. Claude Code can also use OAuth (its CIMD plus
loopback redirect), so the Connect page can offer both. Both kinds are rows in
`access_tokens`, listed and revoked on one page.

## 5. Secrets and config

| Var | App | Sensitive | Notes |
|---|---|---|---|
| `DATABASE_URL` | web | yes | `postgres://reliquary_web.<ref>:<pw>@<pooler>:6543/postgres` |
| `DATABASE_URL` | mcp | yes | same with `reliquary_mcp` |
| `DB_POOL_MAX` | both | no | 3 web, 5 mcp |
| `PUBLIC_URL` | web | no | `https://app.<domain>`; also the OAuth `issuer` |
| `MCP_PUBLIC_URL` / `MCP_RESOURCE` | web, mcp | no | `https://mcp.<domain>/mcp`, byte-for-byte the same everywhere |
| `AUTH_ISSUER` | mcp | no | = web `PUBLIC_URL` |
| `SUPABASE_URL` | web | no | `https://<ref>.supabase.co` |
| `SUPABASE_PUBLISHABLE_KEY` | web | no (public by design), still server-only | `sb_publishable_...`; `apikey` for Auth REST calls. The legacy `anon` / `service_role` keys are deprecated by end of 2026 ([API keys](https://supabase.com/docs/guides/api/api-keys)) |
| `JWT_ALG` | web | no | `ES256` or `RS256`, as the project's JWKS says |
| `SESSION_SECRET` | web | yes | 32 random bytes; CSRF HMAC |
| `KEEPALIVE_TOKEN` | mcp | yes | optional; GitHub secret of the same value |

Never on Vercel in milestone 1: the Supabase **secret key** (`sb_secret_`,
bypasses RLS), the `postgres` password, the SMTP credentials (they live in the
Supabase dashboard only). Mark every secret **Sensitive** in Vercel: it can't
be read back, even by `vercel env pull`
([sensitive vars](https://vercel.com/docs/environment-variables/sensitive-environment-variables)),
which keeps values away from any agent session. Role passwords are set once by
the owner in the SQL editor (`alter role reliquary_web login password '...'`)
and pasted into Vercel; they never appear in migrations, CI logs or chat.

Region: Vercel functions `fra1`, Supabase `eu-central-1`. Vercel's CDN and
logs are global and Vercel is a US company: list it and Resend as
sub-processors (design, Privacy section).

`.env.example` (committed, no values):

```sh
# web
DATABASE_URL=postgres://reliquary_web.<project-ref>:<password>@<pooler-host>:6543/postgres
DB_POOL_MAX=3
PUBLIC_URL=https://app.example.com
MCP_PUBLIC_URL=https://mcp.example.com/mcp
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SESSION_SECRET=<32 random bytes, base64url>
# mcp
# DATABASE_URL=postgres://reliquary_mcp.<project-ref>:<password>@<pooler-host>:6543/postgres
# DB_POOL_MAX=5
# MCP_RESOURCE=https://mcp.example.com/mcp
# AUTH_ISSUER=https://app.example.com
# KEEPALIVE_TOKEN=<random>
```

## 6. Keepalive

Supabase pauses free projects with too little "user database activity" over 7
days; "a few user requests to the database each day" is enough, and a warning
email comes a week ahead ([project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)).

- **Endpoint**: `GET https://mcp.<domain>/healthz?db=1` runs `select 1` on the
  pool (as `reliquary_mcp`, no role switch, touches no table) and returns
  `ok` or `503 unavailable`. No version, no error text. With
  `KEEPALIVE_TOKEN` set, it requires `x-keepalive: <token>` so it can't be used
  to hammer the pooler. Plain `/healthz` stays DB-free.
- **Workflow** `.github/workflows/keepalive.yml`: `schedule: cron: "17 */6 * * *"`
  plus `workflow_dispatch`; `curl -fsS --max-time 30 -H "x-keepalive: $TOKEN"`;
  retry once. A failed run emails the owner, which is the alert.
- GitHub notes: at least 5 min interval, may run late at the top of the hour;
  the 60-day auto-disable applies **only to public repos**, and this repo is
  private ([schedule](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule)).
  4 runs a day is about 120 billed minutes a month, under the free 2,000.
- Vercel Cron on Hobby is once a day with hour-level jitter
  ([cron](https://vercel.com/docs/cron-jobs/usage-and-pricing)): a fallback,
  not the primary.

## 7. Local development and tests

| Option | Verdict |
|---|---|
| `supabase start` (all services) under podman via `DOCKER_HOST=unix:///run/user/1000/podman/podman.sock` | Works with caveats; rootless podman had issues ([cli#3099](https://github.com/supabase/cli/issues/3099)), needs about 7 GB RAM. `-x` can exclude most services ([supabase start](https://supabase.com/docs/reference/cli/supabase-start)). Too heavy for every CI run |
| GoTrue container alone on our test Postgres | Needs Supabase's `auth` schema roles and its own migrations; more moving parts than it buys |
| **Fake Supabase Auth** in tests | **Chosen.** ~150 lines of Node in `web/test/fake-auth.mjs`: `/auth/v1/otp` (records the code), `/auth/v1/verify`, `/auth/v1/token?grant_type=refresh_token`, `/auth/v1/logout`, `/auth/v1/.well-known/jwks.json`; signs JWTs (same `alg` as production) with a key generated at start; a test-only `/_last_email` read by the tests. Runs in the same `node:22-slim` container |

- The existing local sign-in stand-in (`LOCAL_USER_ID`, `/login?code=`)
  stays as `AUTH_MODE=local` for `dev.sh` and the current web tests, so no
  existing test changes (test guard). It **refuses to start when `VERCEL` is
  set**, and a test proves it.
- New web tests run the server in `AUTH_MODE=supabase` against the fake:
  sign-in by code and by link, expired JWT refreshes, a JWT signed by another
  key is refused, a JWT with `client_id` is refused, cookies are
  `__Host-`/HttpOnly/Secure, CSRF differs per session.
- OAuth tests run web + mcp + Postgres: full code flow, then MCP calls with
  the token. The CIMD fetcher needs a loopback fixture; allow it only with
  `CIMD_ALLOW_LOOPBACK=1`, refused when `VERCEL` is set.
- Optional later: a weekly workflow against a real GoTrue (`supabase start
  -x ...`) to catch drift between the fake and Supabase.

## 8. Migrations to the hosted project

- Our files are `<14-digit timestamp>_name.sql`, which is what the CLI expects.
  `supabase link --project-ref <ref>` then `supabase db push` applies pending
  files and records them in `supabase_migrations.schema_migrations`
  ([db push](https://supabase.com/docs/reference/cli/supabase-db-push)).
  `--dry-run` first. In CI it needs `SUPABASE_ACCESS_TOKEN` and
  `SUPABASE_DB_PASSWORD` as GitHub secrets.
- The CLI wants a `supabase/config.toml`; `supabase init` creates it. Keep
  `supabase/tests/` out of anything the CLI runs. **`stub.sql` is never pushed.**
- Plain `psql` in CI is the fallback, but then we own the tracking table (as
  `dev.sh` does). Prefer the CLI.

`stub.sql` vs real Supabase:

| Thing | stub | Supabase | Risk |
|---|---|---|---|
| `anon`, `authenticated`, `service_role` | created | exist | none |
| `extensions` schema, `pgcrypto` there | created | exist | `create extension if not exists pgcrypto` in core is a no-op |
| default privileges on `public` to API roles | mirrored | exist | the stub exists to prove our revokes; good |
| Superuser | tests run as superuser | `postgres` is **not** superuser ([roles](https://supabase.com/docs/guides/database/postgres/roles-superuser)) | `create role` should work; **`grant authenticated to reliquary_web` needs ADMIN OPTION on `authenticated` in PG 16+** *(unverified for Supabase's `postgres`)*. Check with `--dry-run` and a test transaction first. If refused, fix forward in a new migration (e.g. grant the needed rights to our roles another way), never by editing shipped files |
| `auth` schema, `auth.uid()` | absent | present | we use `private.uid()` from claims, so no dependency |
| Data API (PostgREST) | absent | on, exposing `public` | we don't use it; **turn it off** (or unexpose `public`) so a web session JWT can't reach RPCs outside the UI |

The web role's and MCP role's `login password` are set by the owner, not by
`db push`. Add a migration with `statement_timeout` for both roles.

## 9. Costs

| Service | Free tier, what we use | Paid | Move when |
|---|---|---|---|
| Vercel | Hobby: 1M invocations, 4 h active CPU, 100 GB transfer a month; 1 region; logs 1 h; **non-commercial** ([Hobby](https://vercel.com/docs/plans/hobby)) | Pro $20/mo incl. $20 usage, 1 seat ([Pro](https://vercel.com/docs/plans/pro-plan)) | **Any commercial use** (first paid client or pilot), or needing logs, more regions, or preview protection bypass |
| Supabase | Free: 2 active projects, 500 MB DB, 50k MAU, 5 GB egress, 1 GB storage ([billing](https://supabase.com/docs/guides/platform/billing-on-supabase)); pauses after 7 idle days; **no automatic backups** (use `supabase db dump`, [backups](https://supabase.com/docs/guides/platform/backups)) | Pro $25/mo incl. $10 compute credit, 7 days of backups, no pausing, spend cap ([pricing](https://supabase.com/pricing)) | **First real client data** (backups, no pause risk), DB above ~400 MB, or needing PITR |
| Email | Resend free: 3,000/mo, 100/day | $20/mo tier *(unverified)* | >100 sign-in emails a day, or when moving to an EU sender |
| Domain | ~$10 to $40/yr (`reliquary-ai.com` looked free; design, Open decision 6) | | now: needed for SMTP, stable OAuth URLs and the MCP URL people paste |
| GitHub Actions | private repo, 2,000 min/mo free | | not soon |

Total now: the domain. At commercial launch: about $45/month plus the domain.

## 10. Build plan

Order: **A and D in parallel, then B and C in parallel.** File ownership
below keeps agents out of each other's files. `tests/features.md` is shared:
each chunk appends its own rows, so expect trivial merge conflicts there.
Every chunk follows AGENTS.md "Testing" (rows in the registry, `./test.sh`
green, own `TEST_SLOT`).

### A. Vercel adapters and config

Owns: `web/src/server.ts` (listen, static map, Origin via `PUBLIC_URL`,
Secure cookies), `mcp/src/server.ts` (listen only), `web/src/db.ts`,
`mcp/src/db.ts` (TLS, pool), `web/vercel.json`, `mcp/vercel.json`, the CA
file, `.env.example`, `web/README.md`/`mcp/README.md` deploy notes.

Acceptance:
- Both apps start unchanged under `dev.sh` and `./test.sh`.
- With `PUBLIC_URL=https://...`, a POST whose Origin is that URL passes, any
  other Origin gets 403; cookies carry `Secure` and `__Host-`.
- The web server starts with `public/` absent (CDN case).
- `DATABASE_URL` without TLS config is refused when `VERCEL` is set.
- A preview deployment on Vercel serves `/healthz` from `fra1` (check the
  `x-vercel-id` header).

Tests: web tests for the Origin rule under `PUBLIC_URL`, the Secure cookie,
start without `public/`.

### B. Web sign-in with Supabase Auth

Owns (after A): `web/src/server.ts` session code, new `web/src/auth.ts`,
new sign-in pages in a new `web/src/signin.ts`, `web/test/fake-auth.mjs`, new
`web/test/auth.test.mjs`, `web/test.sh` (start the fake; new env).
Exports `getSession(req)` and a route hook for C.

Acceptance:
- `AUTH_MODE=supabase`: sign-in by 6-digit code and by link (button POST);
  unknown emails get the same "check your email" page (no enumeration).
- Stateless: two server instances accept each other's cookies.
- Expired access token + valid refresh: one refresh, new cookies, request
  succeeds; refresh failure: signed out.
- Refused: JWT from another key, wrong `iss` or `aud`, `alg: none`, a token with
  `client_id`.
- Claims set in the DB are exactly `{ sub, role }` from the JWT; no `act`.
- `AUTH_MODE=local` refuses to start when `VERCEL` is set.
- Server logs contain no JWTs, refresh tokens, codes or emails.

### C. MCP OAuth 2.1

Owns: new migration `supabase/migrations/<ts>_oauth.sql` + `supabase/tests/oauth_test.sql`,
new `web/src/oauth.ts` (AS routes and consent page, mounted through B's hook),
new `web/src/cimd.ts`, `mcp/src/server.ts` (metadata, 401 header, `rlo_`
branch), `mcp/src/db.ts` (`resolveOAuthToken`), new `mcp/test/oauth.test.mjs`,
`mcp/test/contract` unaffected.

Acceptance (hostile tests marked H):
- MCP 401 carries `resource_metadata`; both well-known paths serve metadata
  whose `resource` equals `MCP_RESOURCE` byte-for-byte.
- AS metadata advertises S256, `none`, CIMD and `iss`.
- Full flow with a CIMD client: consent, code, token, MCP `tools/list`.
- H: wrong or missing `resource` refused at authorize and at token; a token is
  refused by the MCP if its grant's resource differs.
- H: code reused, wrong verifier, `plain` PKCE, redirect_uri mismatch (except
  loopback port) all refused; reused refresh token revokes the grant.
- H: an OAuth token can't approve, reveal, manage members (the `act` ceiling
  applies, same as PATs); scope to the vaults chosen at consent.
- H: CIMD URLs on private, loopback or link-local addresses, redirects, over
  5 KB, or a mismatched `client_id` are refused.
- Revoking on the Tokens page kills the OAuth grant within one request.
- Manual: connect from claude.ai, ChatGPT (developer mode) and Claude Code
  against production; record in the milestone log.

### D. Deploy pipeline, keepalive, migrations

Owns: `.github/workflows/deploy.yml`, `.github/workflows/keepalive.yml`,
`supabase/config.toml`, `scripts/deploy-check.sh`, `/healthz?db=1` in
`mcp/src/server.ts` (coordinate: land before C, it's 10 lines), a migration
for `statement_timeout` on both roles.

Acceptance:
- `deploy.yml` (manual `workflow_dispatch`, and on `main` after `test`
  passes): `supabase db push --dry-run`, then push, then Vercel Deploy Hooks
  for web and mcp, then smoke checks: `/healthz` on both, `/healthz?db=1`,
  MCP 401 has `resource_metadata` (after C).
- `keepalive.yml` runs every 6 h and fails loudly on non-200.
- `/healthz?db=1` returns only `ok` or `unavailable`; with a token configured
  it needs the header (test).
- The first push to the hosted project succeeds, including the role grants;
  if not, the fix-forward migration is part of D.
- Secrets appear in no workflow log (`::add-mask::` on anything derived).

### Manual steps only the owner can do

| # | Step | Needed by |
|---|---|---|
| 1 | Buy the domain (e.g. `reliquary-ai.com`); decide `app.` and `mcp.` hostnames | B (SMTP), C (stable URLs) |
| 2 | Pause the other Supabase project; create the free project in `eu-central-1`; enable MFA on the Supabase account | D |
| 3 | In Supabase: check JWT signing keys are asymmetric and note the `alg` for `JWT_ALG`; turn off the Data API or unexpose `public`; disable signups; Site URL and redirect allow list; OTP expiry; edit the magic link email template (code + `/auth/confirm` link) | B |
| 4 | Create the SMTP account (Resend or an EU sender), verify the domain (DNS records), enter SMTP settings in Supabase, disable link tracking | B |
| 5 | After the first `db push`: set passwords for `reliquary_web` and `reliquary_mcp` in the SQL editor; create his own user in Supabase Auth; create his first vault | D |
| 6 | Vercel account; two projects from the GitHub repo (Root Directory `web`, `mcp`); region `fra1`; custom domains; env vars (section 5) marked Sensitive; Deploy Hook URLs | A, D |
| 7 | GitHub secrets: `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`, the two Deploy Hook URLs, `KEEPALIVE_TOKEN`, `KEEPALIVE_URL` | D |
| 8 | Before any paid use: Vercel Pro; before client data: Supabase Pro; publish the sub-processor list (Supabase, Vercel, email sender) | later |
| 9 | Add the connectors in claude.ai, ChatGPT and Claude Code and run the week-long milestone check | after C |

### Open questions this leaves

- Does Supabase's `postgres` role hold ADMIN OPTION on `authenticated`
  (section 8)? Answered by the first dry run.
- Supavisor and node-postgres unnamed statements: proven by D's smoke test.
- Resend (US account data) or an EU sender for the privacy story.
- Design doc updates after C: Open decision 3 (decided: own AS), "one URL per
  vault" (one URL, vault chosen at consent), Architecture ("Next.js" is plain
  Node on Vercel).
