# @reliquary-ai/web

The web UI: where people browse vaults, edit open files, propose canon
changes, and approve or reject proposals. It's the only place human-present
actions happen: it runs as the signed-in person with no agent claim.

```bash
./mcp/dev.sh up    # starts Postgres, the MCP server and this UI on http://127.0.0.1:8790
./mcp/dev.sh ui    # opens it in your browser, signed in; the link is single-use and never printed
```

Server-rendered HTML with no client-side script. Every value is escaped;
file text is shown as plain text, never rendered. The CSP forbids scripts,
every POST needs the session's CSRF token and a same-origin Origin, and
sessions are HttpOnly, SameSite=Strict cookies.

The look follows `docs/research/ui-design-system.md`: tokens for light and
dark (the OS setting, or the Account menu's Auto / Light / Dark, stored in a
cookie) at the top of `public/style.css`, Inter self-hosted from
`public/fonts/` (SIL Open Font License, `OFL-Inter.txt`), sentence case,
neutral surfaces, and vermilion only for the logo diamond, "you are here"
bars and the Review count. Filled and hollow diamonds mark canon and open.
`test/contrast.test.mjs` checks every token pair against WCAG AA in both
themes.

Controls sit at the top of every page (`pageHeader` in `src/html.ts`: crumbs,
title with a status badge, actions with the primary last, meta), never
only at the bottom. A proposal page opens with its status, the latest
request for changes, the decision (note, Approve, Request changes, Reject,
Edit then approve) and snooze; the diff follows, then the stated reason,
approvals, and the discussion: comments from editors, owners and their
agents (over MCP), with review notes and approvals in the same timeline.
Reviewers can snooze a proposal from its page or its row in Review, for a
day, a week or until it changes; snoozes are private to each person.

Proposal diffs come in three views, picked with `?diff=unified|split|rendered`
links: a line diff with changed words marked, the same side by side, and both
versions rendered as markdown (raw HTML escaped). Very large files skip the
diff and show the proposed text whole. **Activity** (`/activity` across your
vaults, `/v/:vault/activity`, and a file's History tab) reads the append-only
log as you, so RLS limits it to your vaults. It filters by person, agent
(or people / agents only), action, path prefix and date, 50 events a page,
and never shows file text.

**Local sign-in is a stand-in.** The server acts only as the one local
person `dev.sh` created. Hosted, it will verify a Supabase Auth session
instead; nothing else changes.

Tokens (`/tokens`) are scoped to chosen vaults or all of yours, read-only or
read-write, with an expiry of 7 days to a year. The form defaults to all
vaults, read-only; ticking any vault narrows the token to those vaults. Scope
can't be edited: revoke and create another. The list shows last use and the
client name the agent reported. The database enforces the scope, not this
page.

```bash
./test.sh    # real Postgres + this server; sign-in, escaping, CSRF, approve, threads, snooze, tokens, contrast; log leak check
```

## OAuth for MCP clients

This app is the OAuth 2.1 authorization server for the MCP endpoint
(`src/oauth.ts`; plan in `docs/research/hosting.md`, section 4). Claude,
ChatGPT and Claude Code add Reliquary by its MCP URL: the MCP server's 401
points them at its protected resource metadata, which names this app.

| Endpoint | Does |
|---|---|
| `GET /.well-known/oauth-authorization-server` | Metadata: S256 only, public clients only (`none`), Client ID Metadata Documents, `iss` in the response |
| `GET /oauth/authorize` | Checks the client (`src/cimd.ts`), its redirect URI and `resource` = `MCP_RESOURCE`, then shows the consent page (signed in only) |
| `POST /oauth/authorize` | Allow or deny, with the CSRF token and same-origin check of every form; 303 back with `code` (60 s, single use) or `error`, plus `state` and `iss` |
| `POST /oauth/token` | `authorization_code` (PKCE verifier, same redirect and resource) and `refresh_token` (rotated; a reused one revokes the grant). Access tokens `rlo_` last 1 h; refresh tokens `rlr_` 30 days, sliding, at most a year from consent |
| `POST /oauth/revoke` | RFC 7009: revokes the whole grant |

- **Clients** are identified by the URL of their metadata document, fetched
  with SSRF fences: https only, public addresses only (checked in the
  socket's own DNS lookup), no redirects, 5 s, 5 KB, and the document's
  `client_id` must equal the URL. Cached an hour per instance. Redirect URIs
  must match exactly, except loopback ones (native apps), which match on any
  port. No dynamic client registration.
- **Consent** is the person's: it shows the client's self-chosen name, where
  it sends you back (the redirect host, with a warning for loopback
  clients), where the client is published, and the MCP URL, then the same
  vault and read / read-write choice as the Tokens page. The page's CSP opens
  `form-action` to the redirect origin only, since browsers apply it to the
  303 after the form.
- **A grant is an `access_tokens` row** (`kind = 'oauth'`), so it's on the
  Tokens page next to personal tokens, with its scope and "from <redirect
  host>", and revoking it there stops the client on its next request. The
  database does the rest (`supabase/migrations/20260924220000_oauth.sql`):
  only a person consents, only this app's role redeems and refreshes, only
  the MCP role resolves, and only for the resource the grant was made for.
- Nothing secret is logged: token endpoint lines are method, path, status
  and an OAuth error code. Errors never echo request values.

Config: the issuer is `PUBLIC_URL` (locally `http://HOST:PORT`);
`MCP_RESOURCE` (else `MCP_PUBLIC_URL`) is the one resource accepted and must
be byte for byte the MCP app's `MCP_RESOURCE`. On Vercel both are required.
`CIMD_ALLOW_LOOPBACK=1` lets tests serve client metadata on loopback; the
server refuses to start with it on Vercel.

Not signed in, `/oauth/authorize` currently shows the sign-in notice; with
Supabase Auth (chunk B) it should send the person to sign in and back to the
same authorize URL. The session cookie must be `SameSite=Lax` for that: the
consent page is reached by a top-level redirect from the client's site.

Tests: `test/oauth.test.mjs` (starts its own server, signed in as Ben, with
a metadata fixture on loopback) and `test/cimd.test.mjs` (the SSRF fence);
the MCP side end to end in `mcp/test/oauth.test.mjs`.

`test.sh` also starts a second server as hosted (`PUBLIC_URL=https://...`,
no `public/`) for `test/hosting.test.mjs`.

## Deploy (Vercel)

Plan and reasons: `docs/research/hosting.md` (sections 1, 2, 5). One Vercel
project, `reliquary-web`, Root Directory `web`. Vercel's zero-config Node
server runs `src/server.ts`; `vercel.json` sets region `fra1`, Fluid
compute, `maxDuration` 30 s, bundles `supabase-ca.crt` into the function, and
turns off automatic deploys from `main` (the deploy workflow applies
migrations first). `public/` is served by Vercel's CDN.

What the server does differently when hosted:

- **`VERCEL` set**: listens on the platform's `PORT` without binding a host,
  and refuses to start unless `DATABASE_CA_FILE` is set.
- **`PUBLIC_URL`** (e.g. `https://app.example.com`): every POST must carry
  exactly that `Origin`; any other, `null` or none gets 403. With `https`,
  cookies are `__Host-rlq_session` / `__Host-rlq_theme`, `Secure`, `Path=/`,
  no `Domain`. Unset (dev.sh, tests), the old rule applies: `http://<Host>`,
  absent Origin allowed, unprefixed cookies.
- **No `public/`**: the static map stays empty and the stylesheet version
  comes from `VERCEL_GIT_COMMIT_SHA`.
- **Database**: `DATABASE_URL` is the Supavisor transaction pooler (port
  6543, user `reliquary_web.<project-ref>`) with no `sslmode` in it;
  `DATABASE_CA_FILE=supabase-ca.crt` turns on TLS verified against
  Supabase's root CA. Pool `max` is `DB_POOL_MAX`, default 3.

Env vars: see `/.env.example`. Mark `DATABASE_URL` (and later
`SESSION_SECRET`) Sensitive.

**Not deployable yet:** the local sign-in stand-in (`LOCAL_USER_ID`, a login
file) stays until chunk B (Supabase Auth) replaces it; its login file can't
be written on Vercel's read-only filesystem.

### The Supabase CA

`supabase-ca.crt` (same file as `mcp/supabase-ca.crt`) is "Supabase Root
2021 CA", valid 2021-04-28 to 2031-04-26, fetched on 2026-09-24 from
<https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt>,
the file behind the dashboard's Database Settings, SSL Configuration,
"Download certificate" (named `prod-ca-2021.crt` in
<https://supabase.com/docs/guides/platform/ssl-enforcement>).

```
sha256 (file)        700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7
sha256 (certificate) 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
```

Before the first deploy, download the certificate from the project's
dashboard and check it matches (`openssl x509 -noout -fingerprint -sha256
-in prod-ca-2021.crt`). If Supabase rotates its CA, replace both copies.
