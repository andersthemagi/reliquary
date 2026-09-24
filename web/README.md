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
