# Server load: per-request work in the MCP and web apps

2026-09-25. A review of what each request costs the database and the
functions, what changed, and what is left. The database is the scarce part:
Supabase's shared pooler in transaction mode, small pools per Fluid instance
(docs/research/hosting.md, section 2), and every read goes through RLS.

## The biggest cost: RLS evaluated per row

Every read policy was `using (private.is_member(vault_id))`. Postgres calls
that for each row the query looks at, and each call is two security-definer
functions, a parse of the JWT claims and a join to `access_tokens`: about
0.1 ms a row. Measured on Postgres 17 with 5,000 other vaults, 200,000 log
rows and a 2,000-file vault (the numbers are `explain analyze`, one run):

| Query | Before | After |
|---|---:|---:|
| MCP vault lookup by name (`id::text = $1 or name = $1`) | 421 ms (seq scan, `is_member` on 5,002 rows) | 0.6 ms (memberships by `user_id`, then the vault's key) |
| `list_vaults` | 388 ms | 0.8 ms |
| List a 2,000-file vault's paths (RLS only) | 185 ms | 3.7 ms |
| The same with each file's rule (`rule_for` per row) | 585 ms | 8.4 ms (`rules_for`, one call) |

What changed (`20260925110000_hardening.sql`, sections 7 and 8):

- Read policies compare `vault_id` with `private.readable_vaults()`, the set
  of vaults where `role_in()` is not null, which Postgres computes once per
  statement (a hashed subplan). Same rule, token scope included; every
  hostile test in `supabase/tests` passes unchanged, and breaking the set
  (dropping the `role_in` condition) fails a dozen of them. The variables
  tables keep `is_member()` for now (another change is editing them).
- `private.rules_for(vault, paths[])` answers the rule for many paths with
  one membership check. `list_files` over MCP, the vault sidebar and the
  folder page use it instead of `rule_for()` per file and per folder. A test
  checks it agrees with `rule_for()` path by path.
- The MCP server looks a vault up by id when it is shaped like one, else by
  name among the caller's memberships; `list_vaults` starts from
  memberships too.

The account-wide activity page was already fine: its join starts from the
caller's memberships and uses `log(vault_id, seq)` (6 ms on the same data).

## Round trips per request

A round trip to the pooler is the unit that matters on Vercel (both apps and
the database are in Frankfurt).

**MCP, one tool call** (each HTTP request is stateless: resolve, then one
transaction):

| Step | Before | After |
|---|---|---|
| Resolve the token | 1 (an `UPDATE` of `last_used_at`, every call) | 1 (a read; the write at most once a minute) |
| Open the transaction as the caller | 3 (`begin`, `set local role`, `set_config`) | 2 (`begin`, one `select` setting role and claims) |
| Find the vault | 1 | 1 |
| The tool's queries | 1 to 2 | 1 to 2 |
| `commit` | 1 | 1 |
| **Total** | **7 to 8, one row written** | **6 to 7, no write** |

`tools/list` no longer converts fourteen zod schemas to JSON Schema per
request; it is built once per instance.

The write on every resolve mattered beyond the round trip: concurrent calls
with one token (an agent working in parallel) queued on that row's lock, and
every call wrote WAL. `last_used_at` is shown as "3 min ago" on the Tokens
page; a minute's precision is enough.

**Web, one page**: every request opened a transaction for the Review badge
count, then another for the page.

- `asPerson` opens with 2 round trips instead of 3 (same as MCP).
- POSTs no longer count the Review badge (they redirect): one transaction
  (4 round trips) fewer per form post.
- The folder page read the text of every file under the folder to find a
  README; now only the README's text is read. On a folder of large files
  that was most of the page's database time and transfer.

## Indexes

Added in the hardening migration: the foreign keys the Supabase advisor
flagged as unindexed (`file_versions.vault_id`, `proposal_notes.vault_id`,
`review_snoozes.proposal_id`, `review_snoozes.vault_id`), which matter when a
vault or proposal is deleted (cascades) and for vault-wide reads of those
tables, and `log(vault_id, path, seq)`, which a file's History tab and a
rule's "set by" read (both filtered by path within a vault, newest first).
A test fails if any foreign key in `public` lacks an index that leads with
its columns, so new tables keep this true.

The token resolve path was already indexed (`token_hash` is unique;
`oauth_tokens.token_hash` is the primary key).

## Timeouts and ceilings

- Both app roles now close a connection idle inside a transaction after 15 s
  (`idle_in_transaction_session_timeout`), next to the existing 10 s
  `statement_timeout`, so a stuck request can't pin one of a handful of
  pooled connections.
- The MCP server refuses a JSON-RPC batch of more than 10 messages: each
  message is a transaction, and a 1 MB body could otherwise queue thousands.
- Locally, the MCP server's `headersTimeout` is 10 s and `requestTimeout`
  30 s (Node's default is five minutes). On Vercel the platform owns the
  socket and `maxDuration` bounds a request.
- Stored text has ceilings in the database (file and proposal text 1 MiB,
  reasons and notes 4000 characters, paths 1024), matching what the apps
  accept, so no surface can store more.

## Caching and compression

- The stylesheet is linked as `/style.css?v=<content hash>` (the deployed
  commit on Vercel), so it is now served `public, max-age=31536000,
  immutable`, locally and through `web/vercel.json`; fonts already were. The
  icon and an unversioned stylesheet request stay at five minutes.
- Pages are `no-store` and stay so (they are per person).
- Compression: Vercel compresses function responses for clients that accept
  it, so the apps don't compress themselves. Locally it doesn't matter.
- Sign-in (`AUTH_MODE=supabase`) verifies the JWT locally with the JWKS
  cached for 10 minutes; it now also caches each parsed public key (building
  a `KeyObject` was the costliest step of a verification) and shares one
  JWKS fetch between requests that find the cache stale together.

## Cold start

Module load is cheap in both apps: pool construction (no connection until
the first query), reading the CA and the static files, building the CIMD
blocklists. Nothing to change.

## Recommendations not done here

1. **`attachDatabasePool(pool)`** from `@vercel/functions`, with an idle
   timeout near 5 s, as Vercel advises for Fluid (hosting.md, section 2).
   It closes idle clients before an instance suspends. It adds a dependency
   and there was a Supavisor client leak with it until July 2026, so turn it
   on deliberately and watch the pooler client count.
2. **Resolve the token inside the tool's transaction** (one pool checkout
   per MCP request instead of two). Needs the resolve function callable
   after `set local role`, or the transaction opened as `reliquary_mcp`
   first; a design change to the auth path, so not in a hardening pass.
3. **Move the variables tables' policies** (`environments`, `variables`,
   `variable_values`, `env_access_log`) to `readable_vaults()` once the
   change editing them lands. The test that checks every `member_read`
   policy lists them as the exceptions.
4. **Fold the Review badge count into each page's transaction**, and cut
   the vault shell's three queries (file list, rules, open count) to one or
   two. Worth it once pages show up in the function's duration metrics.
5. **Web input ceilings before the database**: the database now refuses
   over-long text with a clear message, but the web app still reads up to
   2 MB of form body first. A per-field check would answer sooner.
6. **Search**: `public.search` ORs the full-text match with a path
   substring match, so the GIN index can't be used and a search scans the
   vault's files. Fine at hundreds of files; split it into two indexed
   branches (`union`) when a vault reaches thousands.
