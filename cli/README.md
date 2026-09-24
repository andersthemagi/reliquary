# @reliquary-ai/cli

`reliquary`: a vault's environment variables on this computer. It signs in
with your browser, then either runs one command with the variables in its
environment, or writes them to a `.env` that git ignores. Those are the only
two ways a value leaves Reliquary for a machine (AGENTS.md, "Secrets never
reach a model"); nothing here prints a value.

The contract it implements is [docs/variables.md](../docs/variables.md)
("The CLI's sign-in", "The env API", "CLI"). No runtime dependencies: Node
20 or later and its built-ins.

```bash
npx @reliquary-ai/cli login          # once published; until then, see "From this repo"
reliquary run --vault Team -- npm run dev
reliquary env pull --vault Team --env preview
```

## Commands

| Command | Does |
|---|---|
| `reliquary login [--no-browser]` | Opens the server's consent page (and prints the link, for a browser elsewhere). You choose which vaults the CLI may read; it can't read files or write anything. Waits 5 minutes, then lists the vaults and environments it can read. Signing in again revokes the previous sign-in on this computer |
| `reliquary logout` | Revokes the sign-in on the server, then forgets it |
| `reliquary vaults` | Each vault this sign-in reaches: id, name, your role, the environments you may read |
| `reliquary run [--vault V] [--env E] -- <command> [args...]` | Fetches the environment and starts the command directly (no shell) with your environment plus the variables. stdio is inherited, SIGINT, SIGTERM, SIGHUP, SIGQUIT and SIGUSR2 are forwarded, and it exits with the command's code (128 + signal if it was killed; 127 if it wasn't found). Writes nothing to disk. If a variable replaces one you already had, it says so by name |
| `reliquary env pull [--vault V] [--env E] [--file .env] [--outside-repo]` | Writes the environment to the file (default `.env`), mode 600, one `NAME="value"` per line in name order (`\`, `"`, newline and carriage return escaped) under a header saying where it came from. Prints the names, never the values |

Options for every command: `--server <url>`, `-h`/`--help`; and
`-v`/`--version`.

**Choosing the vault and environment.** `--vault` takes a name or an id; a
name two vaults share is an error listing their ids. Without `--vault`, the
one vault you can reach, if there's only one. `--env` defaults to
`development`; owners also read `production`, editors don't, viewers read
nothing. A project may commit `.reliquary.json` (found from the current
directory upwards) to set defaults; it holds ids and names, never values:

```json
{ "server": "https://reliquary-context.vercel.app", "vault": "<vault id>", "environment": "development" }
```

**The server** is `--server`, else `RELIQUARY_URL`, else `server` in
`.reliquary.json`, else `https://reliquary-context.vercel.app`. It must be
https (plain http only for 127.0.0.1, [::1] or localhost). The CLI reads its
`/.well-known/oauth-authorization-server`, requires the issuer to be that
same origin and every endpoint on it, and derives its client id
(`<issuer>/cli/oauth-client.json`) and resource (`<issuer>/api/env`) from
the issuer.

## env pull only writes where git won't look

The file must be inside a git work tree and ignored there: `git check-ignore`
decides, so a file that isn't in `.gitignore`, or is tracked (even if
`.gitignore` now names it), is refused, and nothing is written. The check runs
before anything is fetched and again just before writing. Outside any
repository it is refused too, unless you pass `--outside-repo` to say you
know. A symbolic link is refused.

The file is created with mode 600 (an existing one is tightened before any
value lands). If the temporary name `<file>.reliquary-<random>.tmp` is ignored
as well (a `.gitignore` line like `.env*` or `.env.*`), the file is written
beside it and renamed into place; otherwise it is rewritten in place, so a
value never sits in a file git could pick up.

## Sign-in and where it's kept

OAuth 2.1 against Reliquary's own authorization server: the authorization
code grant with PKCE S256, a redirect to `http://127.0.0.1:<free port>/callback`
(RFC 8252), `resource` = `<issuer>/api/env`. The answer must carry the
`state` it sent and `iss` equal to the issuer, or it's refused. Access tokens
(`rle_`) last an hour and are refreshed a minute before they expire, or once
after a 401; refresh tokens (`rlr_`) rotate on every use.

Tokens are kept per server in `credentials.json` in your config directory:
`RELIQUARY_CONFIG_DIR`, else `%APPDATA%\reliquary` on Windows, else
`$XDG_CONFIG_HOME/reliquary`, else `~/.config/reliquary`. The directory is
0700 and the file 0600, written atomically. Refreshing happens under a lock
file there, because two processes presenting the same refresh token would
revoke the grant. No token is ever printed, logged, put in a URL, an argument
or a child's environment.

The sign-in shows on the web app's Tokens page as "Reliquary CLI"
(Environment variables). Revoke it there or with `reliquary logout`; either
way the next command says to run `reliquary login` and forgets the stored
tokens. Every read is in the vault's access log.

Not yet: the OS keychain (macOS Keychain, libsecret). docs/variables.md
allows the file where there's no keychain; it's a known gap in
tests/features.md.

## Errors

Plain sentences on stderr, prefixed `reliquary:`, never a value, a token or
a response body. 401: your sign-in was revoked or expired, run `reliquary
login`. 403: your role can't read that environment. 404: no such vault or
environment for this sign-in. 503: the server has no key for variables.
Exit codes: 1 for errors, 2 for usage, and `run` passes the command's own.

## From this repo

Build with podman or docker (nothing needs Node on the host):

```bash
podman run --rm -v "$PWD/cli":/app:Z -w /app docker.io/library/node:22-slim sh -c 'npm ci && npx tsc'
node cli/dist/cli.js --help     # with Node 20+ on the host
```

To try it against production (the hosted web app must have the phase 1
migration and `VARIABLES_KEY`): `node cli/dist/cli.js login`, allow it in the
browser, set a value on the web app's Variables page, then
`node cli/dist/cli.js run --vault <name> -- node -e 'console.log(Object.keys(process.env).length)'`
and `node cli/dist/cli.js env pull --vault <name>` inside a repository that
ignores `.env`. `node cli/dist/cli.js logout` when done. Or `npm link` in
`cli/` for a `reliquary` on your PATH.

## Tests

```bash
./cli/test.sh         # or ./test.sh cli; part of ./test.sh
```

Postgres with every migration, the web app (built from a read-only copy of
`web/`, with a `VARIABLES_KEY` made for the run) and the MCP server, then
`node --test` in a `node:22` container (it has git) drives `dist/cli.js`:
login through the consent form over HTTP with a signed-in session, refresh
and concurrent refresh, revocation on the Tokens page, logout, the token
refused at `/mcp`, `run` (hashes of values in the child, exit codes, SIGTERM,
nothing on disk), and `env pull` (ignored, not ignored, tracked, outside a
repository, symlink, modes, atomic and in-place). Every value and token the
tests see is recorded; none may appear in the CLI's output or either
server's log. Registry rows F60 to F62 in
[tests/features.md](../tests/features.md).
