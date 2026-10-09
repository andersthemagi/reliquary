# Environment variables: the interface

2026-09-25. Milestone 2, phase 1 (the core). This is the contract phase 2
builds on: the web Variables page and the CLI (`npx @reliquary-ai/cli`).
Design: [design.md, Environment variables](design.md#environment-variables).
Guardrails: AGENTS.md ("Secrets never reach a model", "The database
enforces access", "Append-only means append-only").

Code: `supabase/migrations/20260925090000_variables.sql`,
`web/src/secrets.ts` (encryption), `web/src/variables.ts` (the web UI's
module), `web/src/envapi.ts` (the CLI's API), `web/src/oauth.ts` (the CLI's
sign-in), `mcp/src/tools.ts` (`list_variables`). Imports (paste a `.env`,
`reliquary env push`): `supabase/migrations/20260925100000_env_imports.sql`,
`web/src/dotenv.ts` (= `cli/src/dotenv.ts`), below under
[Imports](#imports). Key rotation, custom environments and limits:
`supabase/migrations/20260925170000_variables_keys.sql`, `web/src/rekey.ts`,
`scripts/rotate-variables-key.sh`, `scripts/variables-keys.sh`, below under
[Key rotation](#key-rotation) and [Environments](#environments). The
operator's role, exact readers and the access log's key:
`supabase/migrations/20260925190000_final_sweep.sql`. Tests: rows F50 to
F71, F130 to F133 and F150 to F155 in
[tests/features.md](../tests/features.md).

## What holds

| Who | Names, environments, who set them | Set, rotate, delete | A value |
|---|---|---|---|
| Owner, in the web UI | yes | every environment | reveal one at a time, logged |
| Editor, in the web UI | yes | not in owners-only environments (production) | reveal, not production |
| Viewer | yes | no | no |
| Any agent: MCP token, OAuth grant, `act` without a token | yes, within its token's vaults | no | **never**, and the attempt is logged |
| The CLI (a `cli` grant) | only through `/api/env/vaults` | no; with the push permission, sends values as a pending import for a person to apply | a whole environment within its person's role and chosen vaults, logged as `read` |
| A session logged in as `reliquary_mcp` | as its claims allow | no (always an agent) | never, whatever its claims |

- The web app encrypts; the database stores a key id, a nonce and the
  ciphertext and never sees the key or a value. The MCP app refuses to start
  with `VARIABLES_KEY` or `VARIABLES_KEYS` set.
- Ciphertext lives in `private.variable_secrets`: no grants to any role, RLS
  on with no policies. To people and their clients only `reveal_variable`
  and `read_variables` return it, and both write `env_access_log` in the
  same transaction. To seal values again, the operator's role
  (`reliquary_ops`) reads it for a key rotation, and the web app's own role
  only an environment's values inside an owner's rename of it
  ([Key rotation](#key-rotation)).
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
| `public.environments` | `vault_id`, `name` (`^[a-z][a-z0-9_-]{0,31}$`), `owners_only`, `created_at` | members and their agents (RLS `is_member`) | a trigger: every vault gets `development`, `preview`, `production` (owners-only); owners add, rename and delete others ([Environments](#environments)) |
| `public.variables` | `id`, `vault_id`, `name` (`^[A-Za-z_][A-Za-z0-9_]{0,127}$`), `created_by`, `created_at`; unique `(vault_id, name)` | members and their agents | `set_variable`, `delete_variable` only |
| `public.variable_values` | `variable_id`, `vault_id`, `environment`, `version` (1, then +1 per rotation), `updated_by`, `updated_at`; one row per environment with a value | members and their agents | same |
| `private.variable_secrets` | `variable_id`, `environment`, `key_id` (`^[A-Za-z0-9_-]{1,32}$`), `nonce` (12 bytes), `ciphertext` (16 to 65 552 bytes: encrypted bytes, then the 16-byte GCM tag) | nobody directly | same |
| `public.env_access_log` | `seq`, `vault_id`, `at`, `actor` (the person), `agent` (null in person; `Reliquary CLI` for the CLI; the token's name for an agent), `token_id`, `client_id` (the grant's OAuth client), `action`, `environment`, `names text[]`, `detail jsonb` | owners and editors of the vault, and their agents within scope (RLS on `role_in`); not viewers, not read-only agents, not the CLI | the functions below only. Append-only: update, delete and truncate raise, even for the table owner |

`action` is one of `set`, `rotate`, `delete`, `read` (the CLI), `reveal` (the
web UI), `refused`, for imports `push` (a CLI push was made) and `reject`
(a person rejected one, or its environment was renamed or deleted:
`detail.reason`), `rotate_key` (the operator re-encrypted values under a new
key: `actor` null, `agent` `Reliquary operator`, `names`, `detail` `{"key_ids",
"values", "imports"}`), and `create_environment`, `rename_environment`
(`detail` `{"from", "to"}`, `names` the values moved), `delete_environment`
(`names` the values destroyed). A `refused` row's `detail` is `{"attempt": "read" |
"reveal" | "push" | "apply" | "reject", "reason": "..."}`. No column holds a value.

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
- `VARIABLES_KEYS`: `id:key` pairs, comma-separated, the current (sealing)
  key first, e.g. `k2:<key>,k1:<key>`. An id is `[A-Za-z0-9_-]{1,32}`; a key
  is 32 random bytes, base64url, no padding (43 characters). A value is
  sealed with the current key and its id stored beside it, and opened with
  the key its stored id names. A malformed list, an id given twice or one
  key under two ids refuses to start, naming at most an id, never a key.
- `VARIABLES_KEY` (the single key from before rotation, id
  `VARIABLES_KEY_ID`, default `k1`) still works. Alone it is the current
  key; beside `VARIABLES_KEYS` it is one more key for opening, and giving its
  id a different key there refuses to start.
- On Vercel the web app refuses to start without a key; locally it starts,
  and value routes answer 503 `not_configured`. With keys, it also refuses to
  start while a stored value (or a pending import's) names a key id it
  doesn't hold (`private.stored_key_ids()`, ids only), naming the id.
- Values are UTF-8 text up to 64 KiB, without NUL characters (an environment
  variable can't hold one).

## Key rotation

Rotating the key never takes values offline: the web app holds the old and
the new key while every ciphertext moves to the new one. Link credentials
(`private.link_secrets`, sealed by `sealLink` with the same keys) move with
the values. The owner's steps
are in the [runbook](ops/runbook.md#rotating-variables_key); what each
piece does:

- **Keys file.** `scripts/variables-keys.sh` keeps the keys in
  `supabase/.variables-keys-secret` (gitignored, mode 600, one `id:key` per
  line, current first): `new` adds `k<n+1>` as the current key, `drop <id>`
  forgets an old one, `list` prints ids. `scripts/vercel-env.sh web` turns
  the file into `VARIABLES_KEYS`; an older `supabase/.variables-secret` is
  taken over as `k1`, the id its values carry. Neither prints a key.
- **The operator's role.** `reliquary_ops` exists only for this: it can't
  log in until an owner gives it a password (`scripts/set-role-passwords.sh
  ops`, into gitignored `supabase/.ops-db-password`, never printed), is no
  API role, reads no table itself, and may call only the four functions
  below. `scripts/set-role-passwords.sh ops-off` makes it nologin again
  between rotations.
- **Re-encryption.** `scripts/rotate-variables-key.sh [--check]` runs
  `web/src/rekey.ts` in a container against the database, as the
  operator's role, with the `DATABASE_URL` and `VARIABLES_KEYS` of
  `supabase/.vercel-web.env` and the password in
  `supabase/.ops-db-password` (`rekey.ts` logs in as `reliquary_ops` to the
  database the web app's `DATABASE_URL` names, keeping the pooler's
  `.project-ref` suffix, from `OPS_DB_PASSWORD`). Vault by vault, in one transaction each, it
  reads the sealed values, pending imports' values and link credentials
  under any other key (`private.sealed_rows`), opens each with its key and
  its slot's additional data (a link's is its vault alone), seals it again
  under the current key for the same slot, and swaps it in
  (`private.reseal`). It prints counts and key ids only, and exits 0 only
  when nothing is left on another key.
- **What a reseal changes.** Only the ciphertext, nonce and key id. Version,
  `updated_by`, `updated_at` and the feed stay as they were; the access log
  gets one `rotate_key` row per vault (variable names, and counts:
  `values`, `imports`, and `links` when any moved). A row is replaced only if it still
  has the nonce that was read, so a value a person sets meanwhile (already
  under the new key) is left alone. A value that doesn't open with its key
  (moved between rows, or a key given the wrong id) stays as it is and the
  run exits 1: keep the old key.
- **Who can.** `private.variable_key_ids`, `rekey_vaults`, `sealed_rows` and
  `reseal` are granted to `reliquary_ops` alone: people, agents, CLI grants,
  `reliquary_mcp` and `reliquary_web` get 42501. So the web app's own role
  reads ciphertext only as people do (reveal and read, each logged), plus
  one case: inside an owner's rename of an environment, that environment's
  values, to seal them again for the new name (`private.renamed_rows` and
  `private.reseal_renamed`). The rename records itself for its own
  transaction (`private.environment_renames`, by transaction id), so a
  setting the role could set for itself doesn't open it, and nothing is
  open once that transaction ends. For its start-up check the web app gets
  key ids only (`private.stored_key_ids`).
- **The MCP app** refuses to start with `VARIABLES_KEY` or `VARIABLES_KEYS`
  set.

| Function | Returns | Who may call |
|---|---|---|
| `private.variable_key_ids()` | table `(key_id, values, imports, links)`: key ids in use by values, by pending, unexpired imports and by link credentials | `reliquary_ops` |
| `private.rekey_vaults(p_key_id text)` | setof uuid: vaults with anything under another key | `reliquary_ops` |
| `private.sealed_rows(p_vault uuid, p_environment text default null, p_not_key text default null)` | table `(kind 'value', 'import' or 'link', ref, name, environment, key_id, nonce, ciphertext)`; a link's ref is the link id, its environment null, and it is left out when `p_environment` is given | `reliquary_ops` |
| `private.reseal(p_vault uuid, p_reason text, p_items jsonb)` | int, the rows replaced. `p_reason` `rotate_key` or `rename_environment` (only for an environment renamed in this transaction, else 42501); items `[{"kind", "ref", "name", "environment", "old_nonce", "key_id", "nonce", "ciphertext"}]` (base64), a `link` item with no environment (so never for a rename); malformed 22023 | `reliquary_ops` |
| `private.stored_key_ids()` | setof text: the key ids stored values, pending imports and link credentials name | `reliquary_web` |
| `private.renamed_rows(p_vault uuid, p_environment text)` | table `(ref, name, key_id, nonce, ciphertext)`: the values of an environment renamed to `p_environment` in this transaction; otherwise 42501 | `reliquary_web` |
| `private.reseal_renamed(p_vault uuid, p_items jsonb)` | `private.reseal(p_vault, 'rename_environment', p_items)` | `reliquary_web` |

## Environments

Every vault starts with `development`, `preview` and `production`
(owners-only). Owners add others, in person (agents, CLI grants, editors
and viewers are refused by the database), on the Variables page's
**Environments** page (`/v/:v/variables/environments`, with rename and a
typed-name delete).

| Function | Returns | Notes |
|---|---|---|
| `public.create_environment(p_vault uuid, p_name text, p_owners_only boolean default false)` | void | Name `^[a-z][a-z0-9_-]{0,31}$` (22023), unique (23505), at most 20 a vault (55000). Owners-only: only owners set and read its values, as production. Logs `create_environment`, and `environment.create` in the feed |
| `public.rename_environment(p_vault uuid, p_name text, p_new_name text)` | jsonb `{"moved", "names", "rejected_imports"}` | Not a default (55000). Its values move with it, versions kept. The caller must then seal every moved value again for the new name (the additional data names the environment) in the same transaction: `renameEnvironment` in `web/src/variables.ts` does, through `private.renamed_rows` and `private.reseal_renamed`, and a value that doesn't open rolls the whole rename back. Logs `rename_environment` and `environment.rename` |
| `public.delete_environment(p_vault uuid, p_name text, p_confirm text)` | jsonb `{"deleted", "names"}` | `p_confirm` must be the name (22023). A default holding values is refused (55000), and a vault keeps one environment (55000). Destroys its values; a variable left with no value goes too. Logs `delete_environment` with the names, and `environment.delete` |

Pending imports (drafts and pushes) for an environment that is renamed or
deleted are rejected, their values deleted, each logged as `reject` with
`detail.reason`: they were sealed for the old name. The CLI's `--env` takes
any environment's name; `env_vaults()` lists custom environments after the
defaults, by name.

## Limits and retention

- A value: 64 KiB of UTF-8, no NUL. An import: 200 names, 4 MiB, 20 pending
  a person a vault, 60 an hour. A vault: 1000 variables (55000) and 20
  environments.
- `env_access_log` is kept for the vault's life: append-only, it goes only
  with the vault (`delete_vault`). A CLI read logs one row naming every
  variable read, so a busy vault grows by a row per `run` or `env pull`.
  Nothing prunes it; a retention shorter than the vault's life would be a
  design decision (it is the audit record), not a patch.

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
accessLog(userId, vaultId, { before?: seq, limit?: 1..500 = 100, action?, name? }): Promise<{
  seq, at, actor, agent, tokenId, clientId, action, environment, names, detail }[]>   // newest first
createEnvironment(userId, vaultId, name, ownersOnly): Promise<void>
renameEnvironment(userId, vaultId, from, to): Promise<{ moved: number; rejectedImports: number }>
  // seals the moved values again for the new name, in the same transaction
deleteEnvironment(userId, vaultId, name, confirm): Promise<{ deleted: number; names: string[] }>
readersSinceSet(userId, vaultId): Promise<{ name, environment, action: "read" | "reveal", actor, agent }[]>
  // who read or revealed each value since it was last set, newest first, from
  // public.variable_readers (owners and editors; others get none): exact over the
  // whole access log, from each reader's newest read per set of names
  // (private.env_readers, kept by a trigger on env_access_log)
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
person's role may read (empty for a viewer). Works without a key.
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
| 503 | `{"error": "not_configured"}` | the server has no key (`VARIABLES_KEYS` or `VARIABLES_KEY`) |
| 500 | `{"error": "server_error"}` | anything else |

No dotenv format: the CLI formats (below), so escaping lives in one place.

## MCP

`list_variables` (`vault`, optional `environment`): the environments
(owners-only marked), then each name with the environments it has a value
in and who set it when. Read-only, within the token's vaults. An unknown
environment is an error naming those there are. No tool sets, reveals or
reads a value, and the database refuses agents anyway.

## Imports

Bringing a whole `.env` in at once, two ways. Both end in a **pending
import** that a person applies in the web UI; nothing else sets a value.

- **Paste** (the Variables page, like Vercel's): Import .env, paste the file,
  tick environments. The web app parses it (`web/src/dotenv.ts`), seals every
  value for every ticked environment and stores a **draft** (30 minutes, its
  author's alone), then redirects to a preview. The preview names each
  variable as new or replacing a version, lists the lines not taken and why,
  and never shows a value. Apply sets them; Discard drops them.
- **Push** (`reliquary env push`): an agent may run the CLI, so a push never
  sets a value. The CLI parses the file with the same code, sends names and
  values over TLS to the env API, which seals them on receipt and makes a
  **pending import** (24 hours). An owner or editor applies or rejects it on
  the vault's Variables page (a notice lists pending pushes) or from Review.
  The agent only runs a command; the values go from disk to the server, never
  through a model.

**Why the preview's values stay on the server.** The alternative was to carry
the parsed values back in hidden fields of a no-store confirm form. Stashing
them sealed in the database is safer: the values are sent by the browser
once and never come back to it (no form restore, bfcache, extension or
view-source copy, no second copy in a page), the confirm request carries only
an import id and the CSRF token, and an abandoned preview expires and is
swept instead of living in a tab. The draft is bound to its author (RLS and
the functions), and to the vault, environment and name by the encryption's
additional data.

### Parsing

`web/src/dotenv.ts` and `cli/src/dotenv.ts` are the same file (a CLI test
compares them byte for byte), and both suites run
`web/test/dotenv-vectors.json`.

- A UTF-8 byte order mark at the start is dropped; lines end in LF, CRLF or CR.
- Blank lines and lines starting with `#` are skipped; `export ` before a name is ignored.
- `NAME=value`, spaces around the `=` ignored; an `=` inside a value is kept.
- Unquoted values end at the line's end or at a `#` after a space or tab, trailing spaces dropped.
- `"double quotes"` take `\n`, `\r`, `\t`, `\"`, `\\` and `\$` (any other backslash is kept) and may span lines.
- `'single quotes'` and `` `backticks` `` are literal and may span lines.
- After a closing quote only spaces and a `# comment` may follow.
- No `${VAR}` expansion: values are taken as written.

Refused, each with its line number and a reason (and the name only when it
is a well-formed name, never any of the value): no `=`, a bad name, a name
that changes how programs start, an empty value, a NUL character, a value
over 64 KiB, text after a closing quote, over 200 variables. A name given
twice: the later line is used and the earlier one refused, saying so. A
quote never closed stops the parse there, so the rest of a value can't be
read as more variables. A file over 512 KiB or 5000 lines is refused whole.

### Data

In `20260925100000_env_imports.sql`.

| Table | Columns | Who reads | Who writes |
|---|---|---|---|
| `public.env_imports` | `id`, `vault_id`, `environments text[]`, `names text[]` (1 to 200), `refused jsonb` (`[{"line", "name" or null, "reason"}]`), `source` (`web` draft or `cli` push), `created_by`, `agent`, `token_id`, `client_id`, `created_at`, `expires_at`, `status` (`pending`, `applied`, `rejected`, `expired`), `decided_by`, `decided_at` | owners and editors (and their agents within scope) see pushes; a draft only its author, in person; not a CLI grant (it asks `env_import_status`) | the functions below only |
| `private.env_import_secrets` | `import_id`, `name`, `environment`, `key_id`, `nonce`, `ciphertext` (as `variable_secrets`) | nobody; no function returns them | the functions below; deleted when the import is applied, rejected or found expired |
| `public.access_tokens.env_push` | whether a `cli` grant may push (only a `cli` grant can carry it) | the person, on the Tokens page | consent |

Values are sealed with the stored-value key and the same additional data
(vault, environment, name), so applying copies the ciphertext into
`variable_secrets` without opening it.

| Function | Returns | Who may call | Notes |
|---|---|---|---|
| `public.create_env_import(p_vault uuid, p_environments text[], p_items jsonb, p_refused jsonb default '[]')` | jsonb `{"ok": true, "id", "source", "environments", "names", "overwrites", "expires_at"}` or `{"ok": false, "error": "unauthorized" \| "forbidden" \| "push_not_allowed" \| "not_found" \| "rate_limited"}` | a person in person (a draft), or a live CLI grant with `env_push` that reaches the vault (a push) | `p_items`: `[{"name", "environment", "key_id", "nonce", "ciphertext"}]` (base64), one per name per environment. Owners in every environment, editors outside owners-only (an editor's push to production is refused when made), viewers never. Any other agent, a `reliquary_mcp` session: `forbidden`. Refusals are logged. Malformed input raises 22023. Limits: 200 names, 4 MiB; 20 pending (not yet expired) per person per vault, 60 a person an hour. A push is logged as `push` with its names |
| `public.apply_env_import(p_import uuid)` | jsonb `{"ok": true, "applied", "names", "environments"}` or `{"ok": false, "error": "unauthorized" \| "forbidden" \| "not_found" \| "expired" \| "applied" \| "rejected"}` | a person in person, within their role in every environment of the import; a draft only its author | Any `act` (the CLI included) or `reliquary_mcp` session: `forbidden`, logged. Each value goes through `private.put_variable` (the path `set_variable` uses): `set` or `rotate`, one access-log row per variable and environment with `detail.import`, and a feed event; the import becomes `applied` and its values are deleted, all in one transaction |
| `public.reject_env_import(p_import uuid)` | as apply, `{"ok": true}` | the same people, or the import's author | Deletes the values; a push's rejection is logged as `reject` |
| `public.env_import_precheck(p_vault uuid, p_names text[] default '{}')` | jsonb `{"ok": true}` or `{"ok": false, "error": "unauthorized" \| "rate_limited"}` | a person, or a CLI grant | Called before the web app seals anything (sealing every value for every environment is the costly part), in the same transaction as the create that follows. Refuses only a person over a rate limit, logged exactly as `create_env_import` logs it (with `p_names`, which must be names); a caller `create_env_import` would refuse for who they are or for the vault gets `{"ok": true}`, and create refuses and logs them. Create checks the limit again, under its lock |
| `public.env_import_limit(p_vault uuid)` | `'pending'`, `'hourly'` or null | any signed-in person, or a CLI grant | Which import limit the caller has reached, for the env API to tell the two `rate_limited` answers apart: `'pending'` is 20 pending (not yet expired) imports of the caller's in the vault (it clears when they are applied or rejected), `'hourly'` is 60 made in the last hour anywhere (it clears with time); `'pending'` wins. Counts only the caller's own imports, so it says nothing about anyone else's. Not logged |
| `public.env_import_status(p_import uuid)` | jsonb `{"ok": true, "id", "status", "source", "environments", "names", "expires_at", "decided_at"}` or not found | the import's author in person, or through a live CLI grant of theirs that reaches the vault | For `--wait`. Not logged (no values) |
| `public.create_cli_grant(..., p_push boolean default false)` | as before | a person | Records `env_push` |

A pending import past `expires_at` reads as `expired` everywhere
(`private.env_import_state`), can't be applied, and doesn't count against
the rate limit. `private.cleanup_expired_imports()` marks such imports
`expired` and deletes the values of every import that isn't pending; pg_cron
runs it every five minutes (job `reliquary-expired-imports`, created by
`20260925130000_efficiency_2.sql` where the platform has pg_cron, as
Supabase does). Where pg_cron isn't there (plain Postgres, as in the
tests), the next create, apply or reject runs it instead
(`private.sweep_env_imports`, a no-op when the job is active). No app role
can call it. To check the job on a project: `select jobname, schedule,
active from cron.job;` and `select status, start_time from
cron.job_run_details order by start_time desc limit 5;`.

### The env API, for pushes

`POST /api/env/<vault uuid>/<environment>/imports`, `content-type:
application/json`, at most 1 MiB:

```json
{ "variables": { "API_KEY": "...", "DATABASE_URL": "..." },
  "refused": [ { "line": 4, "name": "PATH", "reason": "changes how programs start, so it can't be a shared variable" } ] }
```

```json
201 { "import": "<uuid>", "status": "pending", "vault": "<uuid>", "environment": "development",
      "names": ["API_KEY", "DATABASE_URL"], "overwrites": ["API_KEY"], "expires_at": "...",
      "url": "<issuer>/v/<vault>/variables/imports/<import>" }
```

Errors: 400 `invalid_request` (not JSON, a bad or refused name, an empty,
non-string or oversized value, a bad `refused` list; never echoed), 403
`forbidden` (role) or `push_not_allowed` (the sign-in wasn't allowed to push:
sign in again and leave the box ticked), 404 `not_found`, 405 (only POST),
413 `too_large`, 415 `unsupported_media_type`, 429 `rate_limited` or
`too_many_pending` (the database answers `rate_limited` for both the 60 an
hour and the 20 pending in a vault, and only deciding pushes clears the
second, so the route asks `public.env_import_limit` which it was; the second
has no `Retry-After`), 503
`not_configured`.

`GET /api/env/imports/<uuid>`: `200 {"import", "status", "environments",
"names", "expires_at", "decided_at"}` for its author, else 404.

The log line is the route's shape (`POST /api/env/:vault/:environment/imports
201 pending`), never an id, name or value.

### Web routes

| Route | Does |
|---|---|
| `GET /v/:v/variables/import` | The paste form: a `<textarea>` (autocomplete and spellcheck off) and the environments the role may set |
| `POST /v/:v/variables/import` | Parses, seals, stores a draft, redirects (303) to its preview. Nothing importable, no environment or too big: the form again with the reasons, never the text |
| `GET /v/:v/variables/imports/:id` | The preview of a draft or a push: names by environment, new or `Replaces vN`, lines not taken, Apply and Discard (Reject for a push) when the role allows; a push warns that an agent may have sent it |
| `POST /v/:v/variables/imports/:id/apply`, `.../reject` | CSRF and same-origin as every POST; redirect with a flash |

The Variables page lists pending pushes (owners and editors), and Review
lists the ones the person may apply. The consent page for the CLI has a box
(ticked) "Also let it send .env files here"; the Tokens page shows a grant
that may push as "Environment variables (reads; sends for approval)".

### The CLI

`reliquary env push [--vault V] [--env E] [--file .env] [--wait [--timeout 15m]]`:
reads the file (a regular file, at most 512 KiB), prints each line it can't
take with its reason, refuses before sending if the role can't set values in
that environment, sends the rest, prints the names (new and replacing) on
stderr and the approval link on stdout. `--wait` polls the status (2 s, then
backing off to 15 s) and exits 0 when applied, 1 when rejected or expired, 3
when the timeout runs out first (the push stays pending). It never prints a
value.

### MCP

No tool sends, applies or rejects a push. `list_variables` also lists the
pushes waiting for a person (environments, names, who, when, expiry), and its
description tells an agent to run `env push` rather than read a `.env`'s
values into the conversation.

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
the OS keychain (macOS Keychain, Secret Service via `secret-tool`, Windows
DPAPI) where one answers, else the file.

A small Node package, no native dependencies. It talks to exactly the
endpoints above.

- **Server**: `--server <url>` or `RELIQUARY_URL`, default the hosted web
  app (`https://reliquary.redmage.cc`). Discover the authorization server metadata; `client_id` and
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

- Keys come from `scripts/variables-keys.sh` (through `scripts/vercel-env.sh
  web`), never pasted into a chat. Set `VARIABLES_KEYS` in the **web** Vercel
  project only, marked Sensitive. Never in the mcp project (it refuses to
  start with it). To rotate: the [runbook](ops/runbook.md#rotating-variables_key).
- Keep a copy somewhere safe outside Vercel (a password manager). Sensitive
  variables can't be read back from Vercel, and without the key every
  stored value is lost.
- Apply the migration (`scripts/db-push.sh`) before deploying the web app
  that uses it.
