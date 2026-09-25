# @reliquary-ai/mcp

Reliquary's remote MCP endpoint. Streamable HTTP, stateless, one request per
transaction as the caller. Access is decided by the database (see
`supabase/migrations/`); this server only resolves who is calling.

## Run it locally

```bash
./dev.sh up                    # Postgres + server on http://127.0.0.1:8787/mcp
./dev.sh vault "My vault"      # a vault owned by you
./dev.sh token "Hermes"        # token saved to mcp/.tokens/ (mode 600), never printed
./dev.sh claude "Claude Code"  # with the claude CLI: wires it in without showing the token
./dev.sh revoke "Hermes"       # revoke by name
```

### Claude Code (desktop app or CLI)

Add this to `~/.claude.json` under `mcpServers` (user scope, every project),
then restart the Code session or run `/reload-plugins`:

```json
"reliquary": {
  "type": "http",
  "url": "http://127.0.0.1:8787/mcp",
  "headersHelper": "/home/<you>/Projects/reliquary/mcp/headers-helper.sh"
}
```

`headers-helper.sh` reads `mcp/.tokens/Claude-Code-on-Linux.token` at connect
time, so the token is never stored in any config file.

Tokens are never printed, because terminal output can land in an agent's
context (Claude Code's `!` commands, for one), and secrets must never reach a
model. If one does get printed, revoke it and mint another.

Any MCP client that can send a header works the same way (Hermes, Cursor):
`Authorization: Bearer rlq_...`.

## Tools

`list_vaults`, `create_vault`, `list_files`, `read_file`, `search`,
`write_file` and `delete_file` (open files only), `propose`, `list_proposals`,
`revise_proposal`, `read_proposal` (one proposal with its whole thread),
`comment_on_proposal`, `changes_since`, `list_variables` (environment
variable names only: no tool returns a value, and this app refuses to start
with `VARIABLES_KEY` set; docs/variables.md). There is no approve tool: approving
needs a person in the web UI. There is no snooze tool either, so an agent
can't hide its proposals from its person, and no rules or members tool.
`create_vault` only works through a token (or OAuth grant) that reaches all
of the person's vaults with read-write access; the person owns the vault.
What each side can do, and why not: [docs/parity.md](../docs/parity.md).

`changes_since` brings the discussion with it: each comment, request for
changes, rejection, revision or edit event is followed by that note's text
(fenced, with author, agent, kind, proposal id and revision), so an agent
learns about replies from the feed instead of polling `read_proposal`. The
log itself never holds note text; the server reads it through
`public.change_notes`, as the caller, so RLS and token scope apply and erased
notes show as `(erased)`.

## How a call is authorised

1. The bearer token is hashed and resolved by `private.resolve_access_token`
   (personal tokens, `rlq_`) or `private.resolve_oauth_token` (OAuth access
   tokens, `rlo_`, only for this server's `MCP_RESOURCE`), which only the
   server's role (`reliquary_mcp`) can call.
2. The call runs in one transaction as `authenticated`, with the person as
   `sub` and the token as `act`. The act claim means every token call gets the
   delegation ceiling.
3. RLS and the security-definer API do the rest. `act.tok` names the token,
   and `private.role_in` limits the call to the token's vaults and access: a
   vault outside its scope doesn't exist for it, and a read-only token is a
   viewer. A revoked or expired token stops working on its next call.

At `initialize` the server records the client's `clientInfo.name` for the
Tokens page (by token hash, through `private.record_token_client`). It is
never logged. Tokens made with `./dev.sh token` reach all your vaults,
read-write; make scoped ones in the web UI.

File text is returned between `BEGIN-<nonce>` and `END-<nonce>` markers, with
a fresh random value each response, so a file can't fake its own end. Review
notes and thread comments are fenced the same way (`NOTE-<nonce>`), with a
nonce none of the response's texts contains.

## OAuth

Clients that sign in (Claude, ChatGPT, Claude Code) find where through this
server (plan: `docs/research/hosting.md`, section 4):

- A request without a valid token gets 401 with
  `WWW-Authenticate: Bearer realm="reliquary", resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"`
  (plus `error="invalid_token"` when a token was sent).
- `GET /.well-known/oauth-protected-resource/mcp` (and without `/mcp`)
  serves RFC 9728 metadata: `resource` is `MCP_RESOURCE` exactly,
  `authorization_servers` is `[AUTH_ISSUER]`, the web app.
- The web app issues `rlo_` access tokens bound to that resource. An OAuth
  grant is an `access_tokens` row, so from here on it is a token like any
  other: `act.tok` is the grant, scope and the ceiling apply, revoking it on
  the Tokens page stops it on the next request. A token for another
  resource, a refresh token or a code is refused; no token is passed on.

`MCP_RESOURCE` defaults to `http://HOST:PORT/mcp` and `AUTH_ISSUER` to
`http://127.0.0.1:8790` (dev.sh's web app); on Vercel both are required.

## Test

```bash
./test.sh    # real Postgres + server + the official MCP client; checks logs for leaks
```

`test.sh` also builds and starts the web app (from a copy of `web/`, signed
in as Ben) as the authorization server for `test/oauth.test.mjs`: a client
goes from a 401 to `tools/list` through discovery, consent and the token
endpoint.

## Deploy (Vercel)

Plan and reasons: `docs/research/hosting.md` (sections 1, 2, 5). One Vercel
project, `reliquary-mcp`, Root Directory `mcp`. Vercel runs the app as one function, `api/index.js`, which hands every
request to the handler `src/server.ts` exports (built by `npm run build`: `tsc` into `dist/`, then `stamp-version.mjs` writes `dist/version.json` from `../version.txt` for `GET /version`);
every path is rewritten to it after `public/` gets its turn on the CDN. The
zero-config Node server detection only recognises Express-style apps, so it
failed on this plain `node:http` server. `vercel.json` sets region `fra1`, Fluid
compute, `maxDuration` 60 s, bundles `supabase-ca.crt` into the function, and
turns off automatic deploys from `main`: only a published release deploys
(the deploy workflow applies its migrations first, then deploys exactly the
tagged commit; `docs/ops/runbook.md`, "Deploy"). Answers are plain JSON, so nothing streams.

- **`VERCEL` set**: opens no port (the function calls the exported handler),
  and refuses to start unless `DATABASE_CA_FILE` is set.
- **Database**: `DATABASE_URL` is the Supavisor transaction pooler (port
  6543, user `reliquary_mcp.<project-ref>`) with no `sslmode` in it;
  `DATABASE_CA_FILE=supabase-ca.crt` turns on TLS verified against
  Supabase's root CA (provenance and fingerprint: `web/README.md`, "The
  Supabase CA"; the two copies are identical). Pool `max` is `DB_POOL_MAX`,
  default 5. Every call is one transaction with `set local`, which is safe in
  transaction mode; never pass `name` to a query (no named prepared
  statements) and never a session-level `SET`.

Env vars: see `/.env.example`. Mark `DATABASE_URL` Sensitive. Production
needs the custom domain: Deployment Protection puts a Vercel login in front
of `*.vercel.app`, which MCP clients can't pass.

OAuth needs `MCP_RESOURCE` (e.g. `https://mcp.example.com/mcp`, the URL
people paste, byte for byte the web app's `MCP_RESOURCE`) and `AUTH_ISSUER`
(the web app's `PUBLIC_URL`); the server refuses to start on Vercel without
them.
