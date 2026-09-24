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
  tables moved in the second pass (below).
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

## Recommendations from the first pass

Numbers 2 to 6 were done in the second pass (below); 1 is still open, in
"Still to do".

1. **`attachDatabasePool(pool)`**: still to do.
2. **Resolve the token inside the tool's transaction**: done.
3. **Move the variables tables' policies to the set-based check**: done.
4. **Fold the Review badge count into each page's transaction, and cut the
   vault shell's three queries**: done.
5. **Web input ceilings before the database**: done.
6. **Search**: done, but not as proposed (a `union` couldn't have used the
   index; see below).

## Second pass

2026-09-25, `20260925130000_efficiency_2.sql` and the app changes with it.
Database numbers are `explain analyze` on Postgres 17, second of two runs,
on synthetic data: 5,000 other people with a vault each (4 notes, 10
variables in 3 environments, 40 access-log rows), and Ana's vault Big with
3,000 files of about 1.5 KB, 100 variables in 3 environments, 60,000
access-log rows (two thirds CLI reads of a whole environment, a third
reveals) interleaved with the others' 200,000, and 100 open proposals. In
all: 23,000 files, 150,300 variable values, 260,000 access-log rows.

### One pooled connection per MCP request

The token is resolved inside the tool call's transaction:
`private.mcp_begin(hash, resource)` resolves a personal or OAuth token (the
same definer functions as before, so `last_used_at` is still written at
most once a minute) and sets the role and claims for the rest of the
transaction. `begin` and the resolve go as one simple query (the hash is
hex, the resource our own URL; both escaped anyway), so it is one round
trip. A request that calls a tool holds one connection (`Session` in
`mcp/src/db.ts`); a batch's later calls run one at a time on it, each in a
new transaction that re-resolves the token, so a token revoked mid-batch
stops working. Requests that call no tool (initialize, `tools/list`) keep
the one autocommit resolve.

| One tool call (measured by `mcp/test/session.test.mjs`) | Before | After |
|---|---:|---:|
| Pool checkouts | 2 | 1 |
| Round trips besides the tool's own queries | 4 (resolve, begin, claims, commit) | 2 (begin with resolve, commit) |
| Typical total (vault lookup, 1 to 2 queries) | 6 to 7 | 4 to 5 |

With Supavisor in transaction mode a checkout that sits idle between two
transactions holds nothing server-side, but each checkout is a wait for a
free client in a pool of 5 per instance; halving them halves the queueing
under load.

`list_variables` reads environments, names and pending pushes in one query
instead of three (identical output). `list_proposals` (and the web
Proposals page) take quorums from one `rules_for()` for the page instead of
`rule_for()` per row: 100 open proposals, 20 ms to 1.1 ms.

### The variables tables' policies

`environments`, `variables` and `variable_values` use `readable_vaults()`;
`env_access_log` and `env_imports` use the new `writable_vaults()` (the set
where `role_in()` is owner or editor, token scope included). Same rules:
every hostile test passes unchanged, a new test checks `writable_vaults()`
equals `role_in() in ('owner', 'editor')` for owners, editors, viewers,
outsiders and four kinds of token, and breaking each policy fails tests
(the commit lists which).

| Query, as Ana | Before | After |
|---|---:|---:|
| A vault's 300 names and who set them (the Variables page, `list_variables`) | 36 to 45 ms | 1.0 ms |
| Every value row Ana can see (150,300 in the table) | 11,621 ms | 10 ms |
| Every access-log row Ana can see (260,000 in the table) | 3,210 ms | 37 ms |
| Pending pushes across her vaults (Review) | 25 ms | 1.0 ms |
| The access log page (51 newest in a vault) | 1.2 ms | 0.4 ms |

### Search

The first pass suggested splitting the `or` into two indexed branches. The
plans showed the real cost: under RLS, `@@` isn't leakproof, so Postgres
could never use the GIN index there; it took the vault's versions by
`vault_id` and parsed every text with `to_tsvector` on every search (about
65 us per 1.5 KB note). Each version now stores its words
(`file_versions.body_tsv`, a generated column, so erasing a version's text
erases its words; a test checks) and search matches and ranks on those. The
path branch was already cheap (1.5 ms over 3,000 paths, no index needed),
so there is no `union` and no trigram index. The unused GIN index is
dropped. The rule for each result comes from one `rules_for()` call.

| Search in a 3,000-file vault | Before | After |
|---|---:|---:|
| A word in every file ("workshop") | 407 ms | 7.8 ms |
| A word in 6 files | 205 ms | 6.1 ms |
| A path fragment | 212 ms | 5.8 ms |

A test compares the new function with the old query on words, phrases,
`or`, exclusions, paths, case, empty and blank queries and clamped limits:
same rows, same ranks, same order. Storage: `file_versions` went from 34 MB
(27 MB table, 4.8 MB GIN index) to 36 MB (34 MB table, no GIN index) on
this data; the words are kept for every version, history included.

The web search page reads the first 4,000 characters of each result for its
200-character snippet instead of 30 whole files.

### One transaction per web page

Every GET page (except the OAuth consent page, which fetches client
metadata over the network) runs in one transaction on one connection
(`readOnlyRequest` in `web/src/db.ts`): the Review count and every
`asPerson()` the page makes. A call that fails rolls it back and the next
opens a fresh one. POSTs keep one transaction per call. Every transaction
now begins with its claims in one round trip (the user id is checked as a
UUID before it is inlined), in the web app too; the env API's takes two
instead of three (its claims carry a token name, so they stay a parameter).

| Page | Before | After |
|---|---|---|
| Any vault page (file, folder, proposals, activity, search) | 2 checkouts; count 4 round trips, page 3 + queries, sidebar 3 queries | 1 checkout; 3 + queries, sidebar 1 query |
| The Variables page | 6 transactions (6 checkouts, 18 round trips of begin, claims and commit), 500 access-log rows (451 kB) | 1 transaction (1 checkout, 2), 271 reader rows (23 kB) |

The Variables page's "since then: read by ..." note used to load the
vault's 500 newest access-log rows and match them in the page (each CLI
read names every variable in the environment, so 500 rows were 451 kB and
300 cells scanned them). The database now answers it directly
(`readersSinceSet`): the same 500-row window, grouped, joined to the values
and filtered by when each was set, 8 ms, same labels in the same order.

### Limits before the database

Form fields over their ceilings (file text 1 MiB in bytes; reasons, notes
and comments 4,000 characters, counted as Postgres counts them; paths 1,024;
names 200) are refused in `web/src/server.ts` before any handler runs: back
to the form's page (this site's Referer only, else home) with the ceiling,
never the input. The database still enforces the same ceilings. A form over
2 MB is a 413 instead of a 500.

### Imports

- `env_import_precheck()` checks the rate limit before the web app seals
  anything (a push can be 200 values times each environment), in the same
  transaction as the create; the create checks again under its lock. Only
  rate-limit refusals come from the precheck; every other refusal is left
  to the create, so logging is unchanged.
- A pending import past its time no longer counts against the 20-pending
  limit, even before a sweep marks it.
- `private.cleanup_expired_imports()` does the sweep; pg_cron runs it every
  five minutes where the platform has pg_cron (Supabase does; the migration
  creates the extension and the job only then, and carries on without it).
  Without the job, the old request-time sweep runs as before. docs/variables.md
  has the query to check the job on a project.

## Still to do

1. **`attachDatabasePool(pool)`** from `@vercel/functions`, with an idle
   timeout near 5 s, as Vercel advises for Fluid (hosting.md, section 2).
   It adds a dependency and there was a Supavisor client leak with it until
   July 2026, so turn it on deliberately and watch the pooler client count.
2. **Fold the vault lookup into each MCP tool's query.** Every tool call
   still spends a round trip on `vaultId()` before its work (4 to 5 round
   trips a call; this would make it 3 to 4). Each tool's SQL would take the
   vault reference and resolve it in a CTE, keeping the "no vault with that
   name" answer.
3. **The env API's token resolve in its transaction**, as MCP now does: `reliquary run`
   costs two checkouts (resolve, then the read). A push reads its body
   after authenticating, and the transaction must not stay open across
   that, so resolve in the transaction only for the GET routes.
4. **MCP `search` fetches whole texts** (up to 10 files of up to 1 MiB)
   from the database to pick three matching lines each. Picking the lines
   in SQL (`regexp_split_to_table` with ordinality, filtered by the terms)
   would move kilobytes instead of megabytes for large files.
5. **The web form limit and non-ASCII text.** A form body is capped at
   2 MB, and browsers percent-encode each non-ASCII UTF-8 byte as three
   characters, so a file of about 680 KB of non-Latin text can't be saved
   from the web UI though the database takes 1 MiB. Raise the cap to about
   3.2 MB for the file forms, or accept `multipart/form-data` there.
6. **The Review and home lists** still call `rule_for()` per waiting
   proposal (across vaults, so one `rules_for()` call doesn't fit); fine
   while a person has tens waiting. A lateral `rules_for()` per vault would
   fix it if lists grow.
7. **Readers "since it was set" look back 500 log rows.** A value read only
   long ago, in a busy vault, shows no readers. An index on
   `env_access_log (vault_id, environment, at) where action in ('read',
   'reveal')` would let the page answer exactly; that's a behaviour change,
   so not done here.
8. **Planner choice on the access log.** With RLS now cheap, `order by seq
   desc limit n` for one vault can pick a backward scan of the primary key
   instead of `(vault_id, seq)`; on data where one vault's rows were all the
   oldest it took 26 ms instead of 1 ms. Realistic, interleaved data picks
   the index. Watch the Access log page's timing; a partial or covering
   index would pin it if needed.
9. **Search storage.** The stored words are kept for every version; if
   history grows large, keep them for current versions only (a table keyed
   by file, maintained where `current_version_id` changes).
10. **Confirm the pg_cron job after the next `db push`** (`select jobname,
    active from cron.job`), and that `cron.job_run_details` shows it
    succeeding.
