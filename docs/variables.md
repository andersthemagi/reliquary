# Environment variables: the interface

2026-09-25. Milestone 2, phase 1 (the core). This is the contract phase 2
builds on: the web Variables page and the CLI (`npx @reliquary-ai/cli`).
Design: [design.md, Environment variables](design.md#environment-variables).
Guardrails: AGENTS.md ("Secrets never reach a model", "The database
enforces access", "Append-only means append-only").

Code: `supabase/migrations/20260925090000_variables.sql`,
`web/src/secrets.ts` (encryption), `web/src/variables.ts` (the web UI's
module), `web/src/envapi.ts` (the CLI's API), `web/src/oauth.ts` (the CLI's
sign-in), `mcp/src/tools.ts` (`list_variables`). Tests: rows F50 to F59 in
[tests/features.md](../tests/features.md).

## What holds

| Who | Names, environments, who set them | Set, rotate, delete | A value |
|---|---|---|---|
| Owner, in the web UI | yes | every environment | reveal one at a time, logged |
| Editor, in the web UI | yes | not in owners-only environments (production) | reveal, not production |
| Viewer | yes | no | no |
| Any agent: MCP token, OAuth grant, `act` without a token | yes, within its token's vaults | no | **never**, and the attempt is logged |
| The CLI (a `cli` grant) | only through `/api/env/vaults` | no | a whole environment within its person's role and chosen vaults, logged as `read` |
| A session logged in as `reliquary_mcp` | as its claims allow | no (always an agent) | never, whatever its claims |

- The web app encrypts; the database stores a key id, a nonce and the
  ciphertext and never sees the key or a value. The MCP app refuses to start
  with `VARIABLES_KEY` set.
- Ciphertext lives in `private.variable_secrets`: no grants to any role, RLS
  on with no policies. Only `reveal_variable` and `read_variables` return it,
  and both write `env_access_log` in the same transaction.
- A value leaves Reliquary only in two ways: a person reveals one in the web
  UI, or the CLI reads an environment for `reliquary run` or `reliquary env
  pull`. No MCP tool, log line, feed event, error or redirect carries one.
- Stated plainly (design): an operator with both the database and the web
  app's environment can decrypt; an agent that can run commands where a
  value was delivered can read it.

## Data model

All in `20260925090000_variables.sql`.

| Table | Columns | Who reads | Who writes |
|---|---|---|---|
| `public.environments` | `vault_id`, `name` (`^[a-z][a-z0-9_-]{0,31}$`), `owners_only`, `created_at` | members and their agents (RLS `is_member`) | a trigger: every vault gets `development`, `preview`, `production` (owners-only). No custom environments yet |
| `public.variables` | `id`, `vault_id`, `name` (`^[A-Za-z_][A-Za-z0-9_]{0,127}$`), `created_by`, `created_at`; unique `(vault_id, name)` | members and their agents | `set_variable`, `delete_variable` only |
| `public.variable_values` | `variable_id`, `vault_id`, `environment`, `version` (1, then +1 per rotation), `updated_by`, `updated_at`; one row per environment with a value | members and their agents | same |
| `private.variable_secrets` | `variable_id`, `environment`, `key_id` (`^[A-Za-z0-9_-]{1,32}$`), `nonce` (12 bytes), `ciphertext` (16 to 65 552 bytes: encrypted bytes, then the 16-byte GCM tag) | nobody directly | same |
| `public.env_access_log` | `seq`, `vault_id`, `at`, `actor` (the person), `agent` (null in person; `Reliquary CLI` for the CLI; the token's name for an agent), `token_id`, `client_id` (the grant's OAuth client), `action`, `environment`, `names text[]`, `detail jsonb` | owners and editors of the vault, and their agents within scope (RLS on `role_in`); not viewers, not read-only agents, not the CLI | the functions below only. Append-only: update, delete and truncate raise, even for the table owner |

`action` is one of `set`, `rotate`, `delete`, `read` (the CLI), `reveal` (the
web UI), `refused`. A `refused` row's `detail` is `{"attempt": "read" |
"reveal", "reason": "..."}`. No column holds a value.

A variable exists while it has a value in at least one environment. Set,
rotate and delete also go into the vault's feed (`public.log`, so
`changes_since`) as `variable.set`, `variable.rotate`, `variable.delete`
with `detail = {"name", "environment"}`. Reads and reveals don't: they
aren't changes.

**Names that change how a program starts are refused** (22023): anything
starting `LD_`, `DYLD_`, `BASH_FUNC_`, `GIT_CONFIG_`, and `PATH`, `HOME`,
`SHELL`, `USER`, `IFS`, `ENV`, `BASH_ENV`, `PS4`, `PROMPT_COMMAND`,
`SHELLOPTS`, `BASHOPTS`, `CDPATH`, `NODE_OPTIONS`, `NODE_PATH`,
`PYTHONPATH`, `PYTHONSTARTUP`, `PYTHONHOME`, `PERL5OPT`, `PERL5LIB`,
`PERLLIB`, `RUBYOPT`, `RUBYLIB`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`,
`JDK_JAVA_OPTIONS`, `CLASSPATH`, `GIT_SSH`, `GIT_SSH_COMMAND`,
`GIT_EXEC_PATH`, `GIT_ASKPASS`, `SSH_ASKPASS`, `EDITOR`, `VISUAL`, `PAGER`,
`TMPDIR`, in any case. `reliquary run` puts every variable into a process,
so otherwise an editor could run code on the machine of whoever runs it.

## SQL functions

All `security definer`, `search_path = ''`. "Person" means a caller with no
`act` claim (the web app's `asPerson`). SQLSTATEs: `42501` not allowed,
`22023` bad input, `P0002` not found, `28000` not signed in, `23514` a check
constraint.

| Function | Returns | Who may call | Notes |
|---|---|---|---|
| `public.set_variable(p_vault uuid, p_name text, p_environment text, p_key_id text, p_nonce bytea, p_ciphertext bytea)` | `'set'` or `'rotate'` | a person (owner; editor where not owners-only) | Raises: agent or CLI 42501; non-member P0002 `no such vault`; bad name 22023; unknown environment P0002; viewer 42501; editor on production 42501 `only owners set values in production`; bad key id, nonce or length 22023. Logs `set`/`rotate` and a feed event |
| `public.delete_variable(p_vault uuid, p_name text, p_environment text)` | void | same | Deletes one environment's value; the variable goes with its last. P0002 if there is no such value. Logs `delete` and a feed event |
| `public.reveal_variable(p_vault uuid, p_name text, p_environment text)` | jsonb | a person within their role | Never raises for a refusal, so its log row commits. `{"ok": true, "name", "environment", "key_id", "nonce", "ciphertext", "updated_at", "updated_by"}` (nonce and ciphertext base64), or `{"ok": false, "error": "unauthorized" \| "forbidden" \| "not_found"}`. Agents (any `act`) and `reliquary_mcp` sessions: `forbidden`, logged. Non-members: `not_found`, logged. A missing value: `not_found`, not logged |
| `public.read_variables(p_vault uuid, p_environment text)` | jsonb | a live CLI grant (`act.tok` of kind `cli`, the caller's own, reaching the vault) within its person's role | `{"ok": true, "environment", "variables": [{"name", "key_id", "nonce", "ciphertext", "updated_at"}]}` ordered by name, logged as `read` with every name returned (an empty environment logs an empty list), or `{"ok": false, "error": ...}`. A person in person: `forbidden` (they reveal one at a time). Any other agent or a `reliquary_mcp` session: `forbidden`. A vault outside the grant, a revoked or expired grant: `not_found`. Unknown environment: `not_found`, not logged. Viewer, editor on production: `forbidden`. Every refusal but the unknown environment is logged |
| `public.env_vaults()` | table `(vault_id uuid, vault_name text, role text, environments text[])` | anyone signed in | The vaults whose values the caller may read (a person: theirs; a CLI grant: its vaults), with the environments their role allows (development, preview, production order; empty for a viewer). Any other agent: no rows. Ordered by name |
| `public.create_cli_grant(p_client_id text, p_redirect_uri text, p_resource text, p_code_challenge text, p_vaults uuid[])` | text: a one-time `rlc_` code (60 s) | a person | `p_resource` must be `<origin>/api/env` and `p_client_id` `<same origin>/cli/oauth-client.json`; `p_redirect_uri` `http://127.0.0.1[:port]/...` or `http://[::1][:port]/...`; S256 challenge; `p_vaults` null for all (including later ones) or a non-empty list of the person's vaults. Makes an `access_tokens` row: kind `cli`, name `Reliquary CLI`, access `read`, client name `this computer` |
| `private.resolve_cli_token(p_token_hash text, p_resource text)` | table `(token_id, user_id, name)` | `reliquary_web` only | A live `rle_` access token's grant, for exactly this resource, of kind `cli`, not revoked or expired. Marks `last_used_at` |
| `private.oauth_redeem_code`, `private.oauth_refresh`, `private.oauth_revoke` | as before | `reliquary_web` only | Now also accept `cli` grants. The resource is checked as before, so neither kind's tokens cross over |
| `private.resolve_oauth_token` | unchanged | `reliquary_mcp` only | Still kind `oauth` only: a CLI token never resolves at MCP |

Also changed: `private.role_in` gives a `cli` grant no role (so RLS shows it
no vault, file, proposal or feed, and every membership check fails), and
`private.require_person` refuses a `cli` grant (so it writes, proposes,
comments, creates, mints and revokes nothing). A check constraint on
`access_tokens` binds kinds: an `oauth` grant's resource never ends in
`/api/env`; a `cli` grant's is `<origin>/api/env` with client
`<origin>/cli/oauth-client.json`, access `read`.

Helpers (not callable by API roles): `private.env_role(vault)` (role for
values: a person, or a live CLI grant in scope; never another agent or a
`reliquary_mcp` session), `private.env_allows(vault, environment, role)`,
`private.env_log(...)`, `private.token_kind()` (callable: the kind of the
caller's own token), `private.valid_variable_name(name)`.

## Encryption

`web/src/secrets.ts`, in the web app only.

- AES-256-GCM, 12-byte random nonce per value, 16-byte tag appended to the
  ciphertext.
- Additional authenticated data: the UTF-8 bytes of
  `JSON.stringify(["reliquary.variable.v1", vaultId, environment, name])`.
  A ciphertext moved to another vault, environment or name fails to decrypt
  (tested by swapping two rows in the database).
- `VARIABLES_KEY`: 32 random bytes, base64url, no padding (43 characters).
  Anything else refuses to start, without printing the value.
  `VARIABLES_KEY_ID` (optional, default `k1`) is stored with every
  ciphertext. On Vercel the web app refuses to start without the key;
  locally it starts, and value routes answer 503 `not_configured`.
- Values are UTF-8 text up to 64 KiB.
- Rotation of the key itself is not built: `open()` accepts only the current
  key id. When it's needed: add old keys for decryption
  (`VARIABLES_PREVIOUS_KEYS`), re-seal every row under the new id in one
  pass, then drop the old key.

## Web module (for the Variables page)

`web/src/variables.ts`. Every function runs as the signed-in person through
`asPerson`; the database decides.

```ts
listVariables(userId, vaultId): Promise<{
  role: string | null;                          // the person's role, or null
  environments: { name: string; ownersOnly: boolean }[];   // development, preview, production, then others by name
  variables: { name: string; values: { environment: string; version: number; updatedBy: string; updatedAt: Date }[] }[];
}>
setVariable(userId, vaultId, name, environment, value): Promise<"set" | "rotate">
  // rejects with the database's error (err.code 42501 / 22023 / P0002, message safe to show),
  // or SecretsError for a value over 64 KiB or no key configured
deleteVariable(userId, vaultId, name, environment): Promise<void>
revealVariable(userId, vaultId, name, environment): Promise<
  | { ok: true; value: string; updatedAt: string; updatedBy: string }
  | { ok: false; error: "unauthorized" | "forbidden" | "not_found" | "decrypt_failed" }>
accessLog(userId, vaultId, { before?: seq, limit?: 1..500 = 100 }): Promise<{
  seq, at, actor, agent, tokenId, clientId, action, environment, names, detail }[]>   // newest first
```

`variablesConfigured()` (secrets.ts) says whether the server has a key.

## The CLI's sign-in (OAuth)

Our own authorization server (`web/src/oauth.ts`), the same endpoints as
MCP clients use, with a first-party client and its own resource.

| | |
|---|---|
| Issuer | the web app's `PUBLIC_URL` origin (locally `http://127.0.0.1:8790`). Discover endpoints at `<issuer>/.well-known/oauth-authorization-server` |
| `client_id` | `<issuer>/cli/oauth-client.json`. Served by the web app (below), never fetched by it |
| Resource (RFC 8707) | `<issuer>/api/env`, byte for byte. Required at authorize, token and refresh. Metadata at `<issuer>/.well-known/oauth-protected-resource/api/env` |
| Redirect | `http://127.0.0.1:<any port>/callback` or `http://[::1]:<any port>/callback`. Host and path must match exactly; the port is free (RFC 8252, 7.3). `localhost` is not registered |
| PKCE | S256 only; the verifier is 43 to 128 characters of `[A-Za-z0-9._~-]` |
| Scopes | none (`scope` is ignored) |
| Client auth | none (public client). Never send `client_secret` or an `Authorization` header to the token endpoint |
| Access token | `rle_` + 64 hex, 1 hour |
| Refresh token | `rlr_` + 64 hex, rotates on every use; a rotated one presented again revokes the whole grant. The grant slides 30 days per refresh, never beyond 366 days from consent |

The client metadata document (`GET /cli/oauth-client.json`, JSON, cacheable
5 minutes):

```json
{ "client_id": "<issuer>/cli/oauth-client.json", "client_name": "Reliquary CLI",
  "client_uri": "<issuer>", "redirect_uris": ["http://127.0.0.1/callback", "http://[::1]/callback"],
  "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
  "token_endpoint_auth_method": "none", "application_type": "native" }
```

Flow:

1. The CLI listens on `127.0.0.1:0`, makes a state (random, at most 1024
   characters) and a PKCE pair, and opens the browser at
   `<issuer>/oauth/authorize?response_type=code&client_id=...&redirect_uri=http://127.0.0.1:<port>/callback&code_challenge=...&code_challenge_method=S256&state=...&resource=<issuer>/api/env`.
2. The person signs in if needed and sees "Sign in the Reliquary CLI?": what
   it gets, a loopback warning, and a vault choice (all, including later
   ones, or ticked ones). No access choice: a CLI grant only reads values.
3. Allow redirects to the callback with `code`, `state` and `iss` (the
   issuer); deny with `error=access_denied`. The CLI must check `state` and
   that `iss` equals the issuer. A CLI asking for the MCP resource, or any
   other client asking for the env API, gets `error=invalid_target`.
4. `POST <issuer>/oauth/token` (form-encoded): `grant_type=authorization_code`,
   `code`, `client_id`, `redirect_uri` (the same), `code_verifier`,
   `resource`. Response: `{"access_token": "rle_...", "token_type": "Bearer",
   "expires_in": 3600, "refresh_token": "rlr_..."}`. Errors are
   `{"error": "invalid_request" | "invalid_grant" | "invalid_target" |
   "invalid_client" | "unsupported_grant_type"}` with 400 (401 for a client
   secret); they never echo input. The code works once, within 60 s.
5. Refresh: `grant_type=refresh_token`, `refresh_token`, `client_id`,
   `resource`. Same response; store the new refresh token before using the
   new access token.
6. Sign out: `POST <issuer>/oauth/revoke` with `token` (access or refresh)
   and `client_id`: revokes the grant; always 200.

The grant is on the person's Tokens page as "Reliquary CLI", access
"Environment variables", with its vaults and last use. Revoking it there,
or through step 6, refuses the next request.

## The env API

`web/src/envapi.ts`, in the web app, before the session check.

- Auth: `Authorization: Bearer rle_...` on every request. Anything else (no
  header, a personal `rlq_` token, an MCP `rlo_` token, a revoked, expired
  or foreign token) gets 401 `{"error": "invalid_token"}` with
  `WWW-Authenticate: Bearer realm="reliquary", resource_metadata="<issuer>/.well-known/oauth-protected-resource/api/env"`
  (plus `, error="invalid_token"` when a header was sent). Auth is checked
  before anything else, including the method.
- Every response: `content-type: application/json; charset=utf-8`,
  `cache-control: no-store, private`, `pragma: no-cache`,
  `x-content-type-options: nosniff`, `content-security-policy: default-src
  'none'; frame-ancestors 'none'`, `referrer-policy: no-referrer`. No CORS
  headers: browsers can't read it cross-origin.
- GET only (405 `{"error": "method_not_allowed"}` with `Allow: GET`).
- The server log gets `GET /api/env/<vaults | :vault/:environment | other>
  <status> <outcome>`: never a vault id, environment, name, token or value.

`GET /api/env/vaults`

```json
200 { "vaults": [ { "id": "<uuid>", "name": "Team", "role": "owner" | "editor" | "viewer",
                    "environments": ["development", "preview", "production"] } ] }
```

The vaults the grant reaches, by name, each with the environments the
person's role may read (empty for a viewer). Works without `VARIABLES_KEY`.
Not logged in `env_access_log` (no values).

`GET /api/env/<vault uuid>/<environment>`

```json
200 { "vault": "<uuid>", "environment": "development",
      "variables": { "API_KEY": "...", "DATABASE_URL": "..." } }
```

Every variable with a value in that environment, decrypted, keys in name
order. Logged as `read` with the names. Errors:

| Status | Body | When |
|---|---|---|
| 403 | `{"error": "forbidden"}` | the role doesn't allow the environment (viewer; editor on production). Logged as `refused` |
| 404 | `{"error": "not_found"}` | the vault isn't reachable with this grant (not a member, outside its vaults; logged as `refused`), the environment doesn't exist, or the path doesn't match `/<uuid>/<[a-z][a-z0-9_-]{0,31}>` |
| 500 | `{"error": "decrypt_failed"}` | a ciphertext doesn't decrypt (wrong key, or moved between rows). Nothing is delivered, not even the other values |
| 503 | `{"error": "not_configured"}` | the server has no `VARIABLES_KEY` |
| 500 | `{"error": "server_error"}` | anything else |

No dotenv format: the CLI formats (below), so escaping lives in one place.

## MCP

`list_variables` (`vault`, optional `environment`): the environments
(owners-only marked), then each name with the environments it has a value
in and who set it when. Read-only, within the token's vaults. An unknown
environment is an error naming those there are. No tool sets, reveals or
reads a value, and the database refuses agents anyway.

## What phase 2 builds

### Web: the Variables page

Server-rendered like the rest (no script), in `web/src/pages.ts` or a new
module mounted with a line or two, using `web/src/variables.ts` only.

- `GET /v/:v/variables`: a table, one row per variable, one column per
  environment (development, preview, production, then others). A cell says
  whether it has a value, its version, when and by whom it was set. Never a
  value, masked or not. A tab in the vault's navigation.
- Owners and editors get a form to set a value: name, environment, value
  (a `<textarea>` with `autocomplete="off"`, `spellcheck="false"`), and per
  cell Rotate (the same form, name fixed) and Delete (with a confirm step).
  Production cells are read-only for editors, with a line saying only
  owners set them. Viewers see names only. The database refuses whatever
  the page wrongly offers; show its message (`message()` in pages.ts).
- Every POST is form-encoded with the CSRF token (the existing rule), then
  redirects (303) with a flash naming the variable and environment. The
  value never goes into a URL, a flash, a redirect, an error page or a log
  line. Refused sets re-render the form without the value.
- Reveal: a POST (never a GET, so the value is never in a URL, history or
  a referrer) to e.g. `/v/:v/variables/reveal` with name and environment,
  answered with a page showing that one value (no redirect), `no-store`.
  Say on the page that the reveal is logged. `decrypt_failed` says the value
  can't be decrypted and to set it again.
- Rotation help (design): next to each value, who read or revealed it since
  it was last set (from `accessLog`: `read`/`reveal` rows naming it after
  `updatedAt`), with a link to the Tokens page to revoke.
- Access log: `GET /v/:v/variables/log` for owners and editors (others get
  an empty list from RLS; say so), newest first, paged with `before`,
  filterable by action and name. Refusals are shown with their reason.
- Without `VARIABLES_KEY` (`variablesConfigured()` false), the page lists
  names and says values can't be set or revealed on this server.
- The Connect page gains a CLI section: `npx @reliquary-ai/cli login`, then
  `run` and `env pull`.
- Tests: `web/test/*.test.mjs` with a new registry row, including a check
  that a value set or revealed never appears in the server log.

### CLI: `npx @reliquary-ai/cli` (binary `reliquary`)

Built in `cli/` (see [cli/README.md](../cli/README.md)); credentials are in
the file, not yet the keychain.

A small Node package, no native dependencies. It talks to exactly the
endpoints above.

- **Server**: `--server <url>` or `RELIQUARY_URL`, default the hosted web
  app. Discover the authorization server metadata; `client_id` and
  `resource` derive from its `issuer` as above.
- **Credentials**: the refresh token (and the current access token and its
  expiry) per server, in the OS keychain when available, else
  `~/.config/reliquary/credentials.json` (directory 0700, file 0600, written
  atomically). Take a lock while refreshing: two processes rotating the same
  refresh token revoke the grant. Never print a token; never put one in a
  child's environment, a URL, an argument or a log.
- **`reliquary login`**: the flow above. Prints the URL too (for a browser
  on another screen), waits up to 5 minutes, checks `state` and `iss`, and
  says which vaults it can reach (`GET /api/env/vaults`).
- **`reliquary logout`**: revoke (`/oauth/revoke` with the refresh token),
  then delete the stored credentials.
- **Choosing a vault and environment**: `--vault <name or id>` (resolved
  through `/api/env/vaults`; ambiguous names are an error listing ids),
  `--env <name>` (default `development`). A project may commit
  `.reliquary.json` with `{"server": ..., "vault": "<id>", "environment":
  ...}`: ids and names only, never values.
- **`reliquary run [--vault V] [--env E] -- <command> [args...]`**: fetches
  the environment, then spawns the command directly (no shell) with the
  current environment plus the variables, `stdio` inherited, signals
  forwarded, and exits with the child's code (or 128 + signal). Writes
  nothing to disk. When a variable overrides an inherited one, say so on
  stderr by name. Never prints values.
- **`reliquary env pull [--vault V] [--env E] [--file .env]`**: refuses
  unless the target file is inside a git work tree and ignored by it (`git
  check-ignore -q <file>` exits 0); outside a repository, refuse too (the
  guardrail is "only into a gitignored `.env`") unless the person passes
  `--outside-repo`, an explicit escape for a directory that is no project. Writes atomically with mode
  0600, one `NAME="value"` per line in name order, escaping `\` as `\\`,
  `"` as `\"`, newline as `\n` and carriage return as `\r`, with a header
  comment saying where it came from and when. Prints the file name and the
  names written, never values.
- **Errors**: map the API's statuses to plain messages (401: run `reliquary
  login`; 403: your role can't read that environment; 404: no such vault or
  environment for this sign-in; 503: the server has no key). Exit non-zero.
- **Tests**: against the web app from `web/test.sh`'s database, in a new
  suite wired into `./test.sh`, with registry rows; include `env pull`
  refusing a tracked or unignored `.env`, `run` leaving no file behind, and
  no value in any output.

## For the owner

- Generate the key once, yourself, and never paste it into a chat:
  `head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '='`. Set it as
  `VARIABLES_KEY` in the **web** Vercel project only, marked Sensitive.
  Never in the mcp project (it refuses to start with it).
- Keep a copy somewhere safe outside Vercel (a password manager). Sensitive
  variables can't be read back from Vercel, and without the key every
  stored value is lost.
- Apply the migration (`scripts/db-push.sh`) before deploying the web app
  that uses it.
