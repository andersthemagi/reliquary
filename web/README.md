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

**Sign-in** has two modes (`AUTH_MODE`). `local`, the default under `dev.sh`,
is a stand-in: the server acts only as the one local person `dev.sh`
created, and refuses to start on Netlify. `supabase` is the hosted one: see
"Sign-in with Supabase Auth" below.

Tokens (made on Connections, `/connections/new`; the old `/tokens` URLs
redirect) are scoped to chosen vaults or all of yours, read-only or
read-write, with an expiry of 7 days to a year. The form defaults to all
vaults, read-only; ticking any vault narrows the token to those vaults. Scope
can't be edited: revoke and create another. The list shows last use and the
client name the agent reported. The database enforces the scope, not this
page.

```bash
./test.sh    # real Postgres + this server; sign-in, escaping, CSRF, approve, threads, snooze, tokens, contrast; log leak check
```

## Docs

`/docs` serves the public docs (`src/docs.ts`), public and indexable like the
legal pages, in the public site's frame: a sidebar from
`docs/public/SUMMARY.md`, on-page contents, previous and next. Every page is
also Markdown at `/docs/<page>.md`, and `/llms.txt` and `/llms-full.txt` index
and concatenate them for agents. `/roadmap` redirects to the GitHub project
board, which is the roadmap (`ROADMAP_URL` in `src/docs.ts`). Pages are rendered with the file-preview Markdown renderer
(`src/markdown.ts`, raw HTML off), plus heading ids and resolved links.

`scripts/gen-docs.mjs` (`npm run docs`) builds them into `docs-build/`
(gitignored), first in `npm run build` (then `npm run compile`: `tsc` and the
version stamp): it copies `docs/public` and fills in the generated parts (the
MCP tools from `mcp/test/contract.snapshot.json`, the CLI's help,
`CHANGELOG.md`). It reads outside `web/`, so it needs the whole
checkout (the deploy workflow builds from one); `netlify.toml` ships `docs-build/**` with
the function. Only pages in the build's manifest are served; without
`docs-build/`, `/docs` is a 404. Drift tests: `test/docs.test.mjs`.

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
be byte for byte the MCP app's `MCP_RESOURCE`. On Netlify both are required.
`CIMD_ALLOW_LOOPBACK=1` lets tests serve client metadata on loopback; the
server refuses to start with it on Netlify.

**The Reliquary CLI** is a first-party client of the same server
(docs/variables.md): its client id is `<issuer>/cli/oauth-client.json`,
served here, never fetched; it may only ask for the env API's resource,
`<issuer>/api/env`, and no other client may. Its grants are kind `cli`
(read environment variables, nothing else), its access tokens `rle_`, and
`src/envapi.ts` serves `GET /api/env/vaults` and
`GET /api/env/<vault>/<environment>` to them.

Not signed in, `/oauth/authorize` currently shows the sign-in notice; with
Supabase Auth (chunk B) it should send the person to sign in and back to the
same authorize URL. The session cookie must be `SameSite=Lax` for that: the
consent page is reached by a top-level redirect from the client's site.

Tests: `test/oauth.test.mjs` (starts its own server, signed in as Ben, with
a metadata fixture on loopback) and `test/cimd.test.mjs` (the SSRF fence);
the MCP side end to end in `mcp/test/oauth.test.mjs`.

`test.sh` also starts a second server as hosted (`PUBLIC_URL=https://...`,
no `public/`) for `test/hosting.test.mjs`, and a split one (`PUBLIC_URL` and
`SITE_URL`, driven by the Host header) for `test/split_hosts.test.mjs`.

## Deploy (Netlify)

Plan and reasons: `docs/research/hosting.md` (sections 1, 2, 5 for the
shape, 11 for the move to Netlify). One Netlify site, `reliquary-web`, not
connected to the repository: the deploy workflow builds the tagged commit
itself (`npm run build`: the docs into `docs-build/`, `tsc` into `dist/`, then
`stamp-version.mjs` writes `dist/version.json` from `../version.txt` for `GET
/version`) and uploads `public/` and the function with the Netlify CLI
(`scripts/netlify-deploy.sh`; `docs/ops/runbook.md`, "Deploy"). The app runs
as one function, `netlify/functions/index.mjs`, routed to every path after
`public/` has had its turn on the CDN (`preferStatic`): it keeps the real
`node:http` server listening on a loopback port inside the function and
relays each web `Request` to it, so nothing imitates `IncomingMessage` or
`ServerResponse`. `netlify.toml` names the files the function needs at run
time (`dist/**`, `node_modules/**` after `npm prune --omit=dev`,
`docs-build/**`, the invite email template, `supabase-ca.crt`, `public/**`),
and the long cache headers for `/style.css` and `/fonts/`. The function runs
in Frankfurt (`region: "fra"` in its config; a Pro plan setting) within
Netlify's 60 s synchronous limit and 6 MB request ceiling.

What the server does differently when hosted:

- **`NETLIFY` set** (the entry point sets it before loading the server, since
  Netlify's runtime doesn't promise it): opens no port (the function relays
  into the exported handler), and refuses to start unless `DATABASE_CA_FILE`
  is set.
- **`PUBLIC_URL`** (e.g. `https://app.example.com`): every POST must carry
  exactly that `Origin`; any other, `null` or none gets 403. With `https`,
  cookies are `__Host-rlq_session` / `__Host-rlq_theme`, `Secure`, `Path=/`,
  no `Domain`. Unset (dev.sh, tests), the old rule applies: `http://<Host>`,
  absent Origin allowed, unprefixed cookies.
- **`SITE_URL`** (optional, e.g. `https://example.com`): the public site
  (landing, docs, legal pages, robots.txt, sitemap.xml,
  security.txt) on a host of its own, `PUBLIC_URL` staying the app's
  (`src/hosts.ts`). The Host header picks the side: the site host serves only
  those pages and sets no cookie, anything else is a 308 to the app host;
  the app host sends them to the site host with a 308 and says `noindex` on
  every answer; static files answer on both. Canonical and Open Graph URLs,
  the sitemap and llms.txt use it. Unset, one host serves both.
- **No `public/`**: the static map stays empty and the stylesheet version
  comes from the build's commit (`dist/version.json`).
- **Client address**: `x-nf-client-connection-ip`, which Netlify's edge sets
  (`src/ratelimit.ts`).
- **Database**: `DATABASE_URL` is the Supavisor transaction pooler (port
  6543, user `reliquary_web.<project-ref>`) with no `sslmode` in it;
  `DATABASE_CA_FILE=supabase-ca.crt` turns on TLS verified against
  Supabase's root CA. Pool `max` is `DB_POOL_MAX`, default 3.

Env vars: see `/.env.example`. Mark `DATABASE_URL`, `SESSION_SECRET`,
`VARIABLES_KEYS` and `LINK_PROXY_SECRET` secret.

Hosted, set `AUTH_MODE=supabase` (below); the local stand-in refuses to
start when `NETLIFY` is set.

## Sign-in with Supabase Auth

Plan: `docs/research/hosting.md`, section 3. `AUTH_MODE=supabase` signs
people in by email with Supabase Auth, entirely server-side: the server calls
the Auth REST API with `fetch` and the publishable key (`src/auth.ts`); the
pages are plain forms (`src/signin.ts`), since the CSP forbids scripts.

1. `/signin`: the person enters their email; the server asks Supabase to
   email a 6-digit code and a link (`create_user: false`: members are
   invited, nobody signs up). Every address gets the same "check your
   email" page, whether it has an account or not.
2. The code goes into the form on that page (works when the email is read on
   another device), or the link opens `/auth/confirm`, a page with one
   **Sign in** button (so a mail scanner fetching the link doesn't spend
   it); either way the server calls `/auth/v1/verify`.
3. The session is two cookies, `__Host-rlq_at` (the Supabase access JWT,
   Max-Age its lifetime) and `__Host-rlq_rt` (the refresh token, 30 days):
   HttpOnly, Secure, SameSite=Lax (so the OAuth consent page, reached by a
   redirect from claude.ai or chatgpt.com, sees you signed in), Path=/.
   Responses that set them are `Cache-Control: private, no-store`.
4. Every request verifies the JWT against the project's JWKS (cached 10
   minutes, refetched on an unknown key id at most every 30 s): signature
   with the pinned `JWT_ALG` only (`none`, HS256 and the other asymmetric
   algorithm are refused), `iss` = `SUPABASE_URL/auth/v1`, `aud` =
   `authenticated`, `role` = `authenticated`, a `sub` and a `session_id`,
   not anonymous, and no `client_id` (tokens from Supabase's OAuth server
   belong to third-party apps). An expired JWT is refreshed once with the
   refresh token and both cookies are rewritten; a refused refresh signs
   you out. Supabase unreachable: 503, cookies kept.
5. Nothing is stored on the server: any instance serves any session. The
   CSRF token is `HMAC(SESSION_SECRET, session_id)`; before sign-in the
   forms use a double-submit cookie (`rlq_pre`). Flash notices are an
   HMAC'd cookie.
6. The database sees only `{ sub, role: "authenticated" }`, as with the
   stand-in: never `act` or any other claim from the JWT.
7. **Sign out** (Account menu) calls `/auth/v1/logout` for this session and
   clears the cookies. A signed-out JWT stays valid until it expires (at
   most an hour) if someone copied it; the refresh token is dead at once.

Logs carry method, path and status, and fixed reasons for refused tokens;
never a JWT, refresh token, code, token hash or email (`test.sh` checks).

| Var | Secret | Value |
|---|---|---|
| `AUTH_MODE` | no | `supabase` |
| `SUPABASE_URL` | no | `https://bigonndpibguxuwtysnx.supabase.co` (https, no path) |
| `SUPABASE_PUBLISHABLE_KEY` | no, but server-only | `sb_publishable_...` (Project Settings, API Keys) |
| `JWT_ALG` | no | `ES256` or `RS256`: the `alg` of the current key in `/auth/v1/.well-known/jwks.json` |
| `SESSION_SECRET` | **yes** | 32 random bytes, base64url; rotating it signs nobody out but voids open forms and flash notices |
| `VARIABLES_KEY` | **yes** | 32 random bytes, base64url: encrypts environment variables (`src/secrets.ts`, docs/variables.md). Required on Netlify; keep a copy outside Netlify, since losing it loses every value. Never in the mcp project |
| `PUBLIC_URL` | no | the app's https URL (required on Netlify) |
| `SITE_URL` | no | optional: the public site's https origin, when it has its own host |
| `RESEND_API_KEY` | **yes** | optional: a Resend API key with sending access only, to email vault invites (`src/mailer.ts`) |
| `EMAIL_FROM` | no | optional, with `RESEND_API_KEY`: the sender, e.g. `Reliquary <no-reply@mail.reliquary.redmage.cc>`, on a domain verified in Resend |
| `FEEDBACK_EMAIL` | no | optional: where feedback notices go (`src/feedback.ts`); unset, only the hosted service (`NETLIFY`) falls back to the operator's contact address, and a self-hosted instance emails nobody |

The server refuses to start without these, naming the variable, never its
value. It never uses a Supabase key that bypasses RLS.

### Supabase dashboard (the owner, once)

- **Authentication, Sign In / Providers**: Email enabled. Email OTP
  expiration: 600 seconds. Email OTP length: 6. **Allow new users to sign
  up**: decides how invited people who have no account get one (members and
  invites, `src/members.ts`):
  - **on**: an invitee signs up by opening their invite link and signing in
    with the invited address; the app asks Supabase to create an account
    only for that address. But Supabase then also accepts sign-ups sent to
    its API directly, by anyone; such an account sees no vault until
    someone invites it (it can create its own vaults).
  - **off** (the default so far): the invitee is told there's no account
    for their address yet. Add them under **Authentication, Users, Add
    user** (their address, auto-confirmed), then they open the link again.
  Either way, only the account whose email is the invite's can accept it.
- **Authentication, URL Configuration**: Site URL = `PUBLIC_URL` (e.g.
  `https://app.<domain>`); Redirect URLs: that origin only.
- **Authentication, Emails** (every email Supabase sends): paste
  Reliquary's templates, `emails/*.html`, written by `emails/build.mjs` (the
  one source; self-hosted instances serve the same files, `src/selfhost.ts`).
  `scripts/email-templates.sh` lists each with its place and subject;
  `scripts/email-templates.sh <id>` copies one to the clipboard. For each:
  1. **Templates** tab: Confirm sign up, Invite user, Magic link or OTP,
     Change email address, Reset password, Reauthentication. Open it, set
     **Subject** to the script's subject, switch the body to **Source**,
     replace everything with the file, **Save changes**.
  2. **Security notifications** (same page): Password changed, Email
     address changed, Phone number changed, Sign-in method linked,
     Sign-in method removed, Verification method added, Verification
     method removed. Turn each on, then set its subject and body the same way.

  What they carry: the sign-in emails (Magic link, Confirm sign up) a
  6-digit code and a link to our `/auth/confirm?token_hash={{ .TokenHash }}&type=email`;
  Invite user and Reset password the same link (Reliquary has no
  passwords, so a reset signs in); Change email address
  `type=email_change`. Never `{{ .ConfirmationURL }}`: that goes through
  Supabase's own verify endpoint and returns tokens in a URL fragment,
  which a server can't read. The emails say a code works "within 10
  minutes": keep **Email OTP expiration** at 600 seconds, or change the
  words in `emails/build.mjs` (then `node emails/build.mjs`, in the node
  image, and paste again). `test/emails.test.mjs` checks them.
- **Authentication, Emails, SMTP Settings**: custom SMTP through Resend
  (the built-in sender reaches only the project team, 2 emails an hour);
  steps in `docs/ops/runbook.md`, "Email sender". Keep link tracking off at
  the provider, which would rewrite the link.
- **Project Settings, JWT Keys**: the current signing key must be
  asymmetric (ES256 or RS256); set `JWT_ALG` to match. Rotating keys is
  safe: new key ids are fetched on first sight.
- **Authentication, Users**: with sign-ups off, add each invited person
  here before they accept (see above). Their user id is the `sub` their
  vault memberships use; the Members page shows their email from here.
- **Email for invites**: the web app sends them itself (not Supabase),
  through Resend's HTTP API (`src/mailer.ts`, `deliverInvite` in
  `src/invites.ts`, the email `vaultInviteEmail()` in `src/emails.ts`), when
  `RESEND_API_KEY` and `EMAIL_FROM` are set. Without both, or when Resend
  refuses or doesn't answer (4 s a try, one retry on a timeout, 429 or 5xx,
  with the same `Idempotency-Key`), the invite is still made and the
  Members page shows the link to copy, with why (and a ref for a failure).
  `RESEND_API_URL` points it at a fake in tests; it is ignored with
  `NETLIFY` or `SELF_HOSTED` set. `netlify.toml` ships `emails/` with the
  function for this.

### Tests

`test.sh` runs two `AUTH_MODE=supabase` instances sharing a
`SESSION_SECRET` against `test/fake-auth.mjs`, a fake Supabase Auth (OTP,
verify, refresh with rotation and reuse revocation, logout, JWKS with a key
generated at start, and test-only `/_last_email`, `/_mint`, `/_stats`).
`test/auth.test.mjs` covers sign-in by code and by link, no enumeration,
cookies, both instances, refresh, sign-out, refused JWTs (another key, `alg:
none`, HS256, wrong `iss`/`aud`/`role`, `client_id`, tampered), claims, and
the start-up refusals.

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
