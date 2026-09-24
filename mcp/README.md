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

`list_vaults`, `list_files`, `read_file`, `search`, `write_file` (open files
only), `propose`, `list_proposals`, `revise_proposal`, `read_proposal` (one
proposal with its whole thread), `comment_on_proposal`, `changes_since`.
There is no approve tool: approving needs a person in the web UI. There is no
snooze tool either, so an agent can't hide its proposals from its person.

## How a call is authorised

1. The bearer token is hashed and resolved by `private.resolve_access_token`,
   which only the server's role (`reliquary_mcp`) can call.
2. The call runs in one transaction as `authenticated`, with the person as
   `sub` and the token as `act`. The act claim means every token call gets the
   delegation ceiling.
3. RLS and the security-definer API do the rest.

File text is returned between `BEGIN-<nonce>` and `END-<nonce>` markers, with
a fresh random value each response, so a file can't fake its own end. Review
notes and thread comments are fenced the same way (`NOTE-<nonce>`), with a
nonce none of the response's texts contains.

## Test

```bash
./test.sh    # real Postgres + server + the official MCP client; checks logs for leaks
```

Not yet: OAuth (needed for ChatGPT connectors), protected resource metadata,
and hosting.
