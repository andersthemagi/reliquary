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
