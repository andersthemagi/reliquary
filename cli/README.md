# @reliquary-ai/cli

`reliquary`: a vault's environment variables on this computer. It signs in
with your browser, then either runs one command with the variables in its
environment, or writes them to a `.env` that git ignores. Those are the only
two ways a value leaves Reliquary for a machine (AGENTS.md, "Secrets never
reach a model"); nothing here prints a value. It can also send a project's
`.env` to a vault, where a person applies it in the web UI: an agent can run
that for you without a value ever passing through the conversation.

The contract it implements is [docs/variables.md](../docs/variables.md)
("The CLI's sign-in", "The env API", "CLI"). No runtime dependencies: Node
20 or later and its built-ins.

```bash
npx @reliquary-ai/cli login                    # sign this computer in (once)
npx @reliquary-ai/cli run --vault Team -- npm run dev
npx @reliquary-ai/cli env pull --vault Team --env preview
npx @reliquary-ai/cli env push --vault Team --file .env --wait
```

Or install it once: `npm install -g @reliquary-ai/cli`, then `reliquary ...`.

## Commands

| Command | Does |
|---|---|
| `reliquary login [--no-browser]` | Opens the server's consent page (and prints the link, for a browser elsewhere). You choose which vaults the CLI may read; it can't read files or write anything. Waits 5 minutes, then lists the vaults and environments it can read. Signing in again revokes the previous sign-in on this computer |
| `reliquary logout` | Revokes the sign-in on the server, then forgets it |
| `reliquary vaults` | Each vault this sign-in reaches: id, name, your role, the environments you may read |
| `reliquary run [--vault V] [--env E] -- <command> [args...]` | Fetches the environment and starts the command directly (no shell) with your environment plus the variables. stdio is inherited, SIGINT, SIGTERM, SIGHUP, SIGQUIT and SIGUSR2 are forwarded, and it exits with the command's code (128 + signal if it was killed; 127 if it wasn't found). Writes nothing to disk. If a variable replaces one you already had, it says so by name |
| `reliquary env pull [--vault V] [--env E] [--file .env] [--outside-repo]` | Writes the environment to the file (default `.env`), mode 600, one `NAME="value"` per line in name order (`\`, `"`, newline and carriage return escaped) under a header saying where it came from. Prints the names, never the values |
| `reliquary env push [--vault V] [--env E] [--file .env] [--wait [--timeout 15m]]` | Sends the file's variables to the vault **for approval**: nothing is set until an owner or editor applies it on the vault's Variables page (it expires in 24 hours). Lines it can't take (bad or reserved names, empty values, an unclosed quote) are listed with their reasons and not sent. Prints the names, which are new and which replace a value, and the approval link (stdout); never a value. `--wait` exits 0 once it's applied, 1 if it's rejected or expires, 3 if the timeout comes first |

Options for every command: `--server <url>`, `-h`/`--help`; and
`-v`/`--version`.

**Choosing the vault and environment.** `--vault` takes a name or an id; a
name two vaults share is an error listing their ids. Without `--vault`, the
one vault you can reach, if there's only one. `--env` defaults to
`development`; owners also read `production`, editors don't, viewers read
nothing. A project may commit `.reliquary.json` (found from the current
directory upwards) to set defaults; it holds ids and names, never values:

```json
{ "server": "https://app.reliquary.redmage.cc", "vault": "<vault id>", "environment": "development" }
```

**The server** is `--server`, else `RELIQUARY_URL`, else `server` in
`.reliquary.json`, else `https://app.reliquary.redmage.cc`. It must be
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

## env push: send a .env without showing it to anyone

For "please add this project's `.env` to the vault": the agent (or you) runs
`reliquary env push --vault Team --file .env`. The CLI parses the file with
the web app's own parser (`src/dotenv.ts` is the same file as
`web/src/dotenv.ts`): comments, `export`, quotes, escapes in double quotes and
multi-line quoted values; no `${VAR}` expansion. It sends the names and values
over TLS to the env API, where they are encrypted on receipt and held as a
pending import. The link it prints opens the preview: names, new or replacing
a value, never a value; Apply sets them (as you, logged per variable), Reject
drops them.

A push needs a sign-in that was allowed to push: the consent page's box "Also
let it send .env files here", ticked by default. A sign-in without it is told
to log in again. Editors can't push production values; the CLI says so before
sending anything.

## Sign-in and where it's kept

OAuth 2.1 against Reliquary's own authorization server: the authorization
code grant with PKCE S256, a redirect to `http://127.0.0.1:<free port>/callback`
(RFC 8252), `resource` = `<issuer>/api/env`. The answer must carry the
`state` it sent and `iss` equal to the issuer, or it's refused. Access tokens
(`rle_`) last an hour and are refreshed a minute before they expire, or once
after a 401; refresh tokens (`rlr_`) rotate on every use.

Tokens are kept per server in the OS keychain where there is one
(`src/credentials.ts`, all behind one interface):

- **macOS**: the login Keychain, generic passwords with service
  `reliquary-cli` and the server's origin as the account, through
  `/usr/bin/security`. Writing runs `security -i`, which reads its command
  line, secret included, from standard input; reading prints it on standard
  output.
- **Linux**: the Secret Service (GNOME Keyring, KWallet) through
  libsecret's `secret-tool`, when it's installed and a keyring answers (a
  `lookup` that finds nothing is an answer; no D-Bus session is not).
  `secret-tool store` reads the secret from standard input.
- **Windows**: `credentials.dpapi` in the config directory, the whole store
  encrypted with DPAPI (`ProtectedData`, current user) by a fixed Windows
  PowerShell script that reads and writes base64 on standard input and
  output. `cmdkey` is not used: it takes the secret as an argument.

Otherwise (servers, containers, Linux without `secret-tool`) they are kept
in `credentials.json` in your config directory: `RELIQUARY_CONFIG_DIR`, else
`%APPDATA%\reliquary` on Windows, else `$XDG_CONFIG_HOME/reliquary`, else
`~/.config/reliquary`. The directory is 0700 and the file 0600, written
atomically. `RELIQUARY_CREDENTIALS=file` forces the file;
`RELIQUARY_CREDENTIALS=keychain` forces the keychain and fails if none
answers. `reliquary login` says where the sign-in went.

A sign-in in `credentials.json` from before the keychain keeps working: a
server the keychain doesn't have is read from the file, and the next write
for it (a refresh, a login, a logout) puts it in the keychain and takes it
out of the file.

Refreshing happens under a lock file in the config directory, because two
processes presenting the same refresh token would revoke the grant. No
token is ever printed, logged, put in a URL, an argument (a keychain tool's
included) or a child's environment, and nothing a keychain tool prints is
shown, only its exit code.

The sign-in shows on the web app's Tokens page as "Reliquary CLI"
(Environment variables). Revoke it there or with `reliquary logout`; either
way the next command says to run `reliquary login` and forgets the stored
tokens. Every read is in the vault's access log.

## Errors

Plain sentences on stderr, prefixed `reliquary:`, never a value, a token or
a response body. 401: your sign-in was revoked or expired, run `reliquary
login`. 403: your role can't read that environment. 404: no such vault or
environment for this sign-in. 503: the server has no key for variables.
Exit codes: 1 for errors, 2 for usage, and `run` passes the command's own.

## Publishing

The package is `@reliquary-ai/cli`, published from `cli/` by
`.github/workflows/publish-cli.yml` for a tag `cli-v<version>` (the version
must match `package.json`; the CLI's tests run first; no npm provenance while the repository is private). Licence: MIT (`LICENSE`).
Tags come from release-please: commits touching `cli/` collect in a
"Release cli vX.Y.Z" pull request (version bump and `CHANGELOG.md`), and
merging it tags the release and starts the publish. It needs the repository secret `NPM_TOKEN`; without it the
workflow skips. To check what would be published:

```bash
podman run --rm -v "$PWD/cli":/app:Z -w /app docker.io/library/node:22-slim sh -c 'npm ci && npm pack --dry-run'
```

It holds `dist/`, `README.md` and `package.json`; no tests, sources or maps.

## From this repo

Build with podman or docker (nothing needs Node on the host):

```bash
podman run --rm -v "$PWD/cli":/app:Z -w /app docker.io/library/node:22-slim sh -c 'npm ci && npx tsc'
node cli/dist/cli.js --help     # with Node 20+ on the host
```

To try it against production (the hosted web app must have the variables
migrations and `VARIABLES_KEY`): `node cli/dist/cli.js login`, allow it in the
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
repository, symlink, modes, atomic and in-place), and `env push` (the
approval link, the web UI applying and rejecting, `--wait` and its timeout, a
sign-in without the push permission, an editor's production). Every value and
token the tests see is recorded; none may appear in the CLI's output or
either server's log. Registry rows F60 to F62, F67, F70 and F190 to F193 in
[tests/features.md](../tests/features.md).
