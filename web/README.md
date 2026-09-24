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

**Local sign-in is a stand-in.** The server acts only as the one local
person `dev.sh` created. Hosted, it will verify a Supabase Auth session
instead; nothing else changes.

```bash
./test.sh    # real Postgres + this server; sign-in, escaping, CSRF, approve, tokens; log leak check
```
