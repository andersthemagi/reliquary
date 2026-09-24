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

Numbers 2 to 6 were done in the second pass (below); 1 was evaluated in
the third and not adopted (see "`attachDatabasePool`: not adopted").

1. **`attachDatabasePool(pool)`**: evaluated, not adopted.
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

## Third pass

2026-09-25, `20260925150000_efficiency_3.sql` and the app changes with it:
seven of the ten items the second pass left (the vault lookup, the env
API's resolve, search lines, the form limit, the Review lists, search
storage, and `attachDatabasePool`, evaluated). Database numbers
are on Postgres 17 over the local socket, median of 25 runs or second of two
`explain analyze` runs, on synthetic data: 2,000 other people with a vault
of 4 notes each; Ana's vault Big with 3,000 notes of about 1.5 KB, each
written 5 times (history), and 10 files of 8,000 lines (about 510 KB); ten
vaults R1 to R10 with a canon folder (quorum 2) and a canon file (quorum 3),
10 open proposals each, all waiting on Ana. 23,010 versions in all.

### The vault in the tool's query (MCP)

Every tool that names a vault looked it up first (`vaultId()`, one round
trip), then did its work. The lookup is now `private.vault_ref(ref)`, called
inside the tool's own query: by id when the reference is shaped like one,
else by name among the caller's memberships, only when exactly one matches,
under RLS (security invoker), as before. "No vault" is an error it raises
(`RLV01`), so a tool can't mistake a missing vault for an empty one: the
tools join their work laterally to a one-row `(select private.vault_ref($1)
offset 0) v`, which the planner can't flatten or skip, and the MCP server
answers `RLV01` with the same message as before. Two more tools needed a
query each for things that fit in one: `changes_since` read the events and
then their notes, and `read_proposal` the proposal and then its thread;
each is one query now (JSON aggregates for the second part).

| One tool call (measured by `mcp/test/round_trips.test.mjs`) | Before | After |
|---|---:|---:|
| `list_files`, `read_file`, `search`, `write_file`, `delete_file`, `propose`, `list_proposals`, `list_variables`: the tool's queries | 2 | 1 |
| `changes_since` | 3 | 1 |
| `read_proposal` | 2 | 1 |
| Typical call in round trips (begin with resolve, work, commit) | 4 to 5 | 3 |

The lookup itself costs what it did (about 1 ms by name among 2,000 other
vaults' memberships); `list_files` for 200 of Big's files with it inline
takes 2.4 ms, against 1.4 ms plus the separate lookup and its round trip.
`tools/list` and every response are byte for byte as before
(`mcp/test/token_load.test.mjs` unchanged, 26,044 bytes for the pass).
`create_vault` keeps two queries: the vault it creates isn't visible to the
statement that creates it.

### The env API's token in its transaction

`reliquary run` resolved its token on one checkout, then read the values on
a second. GET routes (`/api/env/vaults`, `/api/env/<vault>/<environment>`,
`/api/env/imports/<id>`) now begin, resolve and become the grant's person in
one round trip (`private.env_begin`, callable only by the web app's role,
as `private.mcp_begin` is by the MCP server's), then do their work and
commit (`asCliToken` in `web/src/db.ts`). Values are decrypted after the
commit. A push still resolves first: it reads its body after
authenticating, and a transaction must not stay open across that.

| One GET (measured by `web/test/efficiency_3.test.mjs`) | Before | After |
|---|---:|---:|
| Pool checkouts | 2 | 1 |
| Round trips besides the route's own query | 4 (resolve, begin, claims, commit) | 2 (begin with resolve, commit) |

### Search lines in the database (MCP)

MCP `search` fetched every result's whole text (up to 50 files of up to
1 MiB) to pick three lines each in Node. The lines are now picked in the
query (`SEARCH_SQL` in `mcp/src/tools.ts`: `string_to_table` with
ordinality, matched with `lower()` and `strpos`, the first non-blank line
when only the path matched, each cut to 201 characters for Node to finish
exactly as before). `mcp/test/search_lines.test.mjs` compares it with the
old way on words, phrases, exclusions, `or`, case, accents, Greek and
Cyrillic, long lines, emoji, CRLF and path-only matches: same files, order
and lines. `lower()` follows the database's locale; for the scripts tested
it agrees with JavaScript's `toLowerCase()`, but a few special cases (a
dotted capital I) can differ, which could only change which line is shown.

| `search`, 10 results | Before | After |
|---|---:|---:|
| Transfer, 10 files of 510 KB ("workshop line") | 5,106,128 bytes | about 1 KB |
| Transfer in the test (one 510 KB file) | 510,532 bytes | 84 bytes |
| Database time, the 510 KB files (median of 25) | 13.0 ms | 14.2 ms |
| Database time, 10 notes of 1.5 KB ("agenda") | 7.8 ms | 8.9 ms |

The database now does about 0.1 ms more work per result. For large files
that buys megabytes less through Supavisor and TLS and no 5 MB string to
split in the function; for notes of a few KB it's about even (1 ms of
database time for 14 KB less transfer). Measured over a local socket,
where transfer is nearly free, so the table understates the win on Vercel.

### Review and Home: one rule lookup per list

The Review inbox, Home's waiting list and Review's "changes requested" list
called `rule_for()` per proposal (a membership check each), across vaults,
so `rules_for()` (one vault) didn't fit. `private.rules_for_pairs(vaults[],
paths[])` answers many (vault, path) pairs with one set-based check
(`readable_vaults()`, token scope included); a test checks it agrees with
`rule_for()` pair by pair for owners, editors, viewers, outsiders and a
scoped token. The Review badge's count never read the quorum and is
unchanged.

| Ana's waiting list, 100 proposals across 10 vaults | Before | After |
|---|---:|---:|
| Query | 21.1 ms | 2.7 ms |

### File forms and non-ASCII text

Browsers percent-encode each non-ASCII UTF-8 byte as three characters, so
the 2 MB form cap stopped non-Latin text at about 680 KB though the
database takes 1 MiB. The forms that carry a file's text (write or propose a
file, revise, edit and approve) now take 3 MiB + 64 KiB, enough for 1 MiB
of any text plus the other fields; every other form keeps 2 MB. The field
ceilings are unchanged (1 MiB of text in bytes), so a file form between
1 MiB of text and the body cap is still refused with the ceiling, not a
413. Vercel's own limit on a function's request body is 4.5 MB.
`multipart/form-data` would have saved the 3x, but needs a parser; not
worth it for three forms.

### Search words for current versions only

The second pass stored each version's words (`file_versions.body_tsv`, a
generated column), history included, though search only reads each file's
current version. `body_tsv` is now a plain column kept by triggers: a new
version gets its words when written (every new version becomes its file's
current one), the version it replaces loses them, erasing a version erases
them. `versions_erase_only` allows exactly one more change: clearing a
version's words with every other column as it was. The migration backfills
(`private.clear_history_words()`, 0.23 s here).

| `file_versions` on this data | Before | After |
|---|---:|---:|
| Versions with stored words | 23,010 | 11,010 |
| Stored words | 15 MB | 8.0 MB |
| Table total (after `vacuum full`) | 24 MB | 16 MB |

Each write now also updates the previous version's row (clearing its
words), one small extra write per file write; search answers exactly as
before (`supabase/tests/efficiency_2_test.sql`'s comparison still passes).
Space freed by the backfill is reused by Postgres, not returned to the
disk, until a `vacuum full`, which isn't needed.

### `attachDatabasePool`: not adopted

Evaluated and left out, deliberately:

- **There is no version "without the Supavisor leak" to pin.** The leak
  (pooler client connections climbing until "Max client connections
  reached") was in Supavisor: fatal TLS alerts left zombie client handlers.
  Supabase fixed it server-side (supavisor#783), rolled out in July 2026;
  the thread is explicit that `attachDatabasePool`, Fluid and the idle
  timeout only changed how often the bug was hit
  ([discussion #40671](https://github.com/orgs/supabase/discussions/40671)).
- **Versions before 3.9.5 stop working after an instance's first 15
  minutes.** The helper waits (`waitUntil`) for the pool's idle timeout
  after each release, capped at `15 min - (now - module load)`; on a Fluid
  instance older than 15 minutes that cap is 100 ms, so idle clients stay
  open when the instance suspends, which is the thing it exists to prevent.
  3.9.5 (2026-08-20) caps by the invocation's deadline instead.
- **3.9.5 and later pull in 17 more packages.** `@vercel/functions` 3.9.x
  depends on `@vercel/oidc` 3.8.x, which depends on `@vercel/cli-exec`,
  `@vercel/cli-config`, `execa`, `jose` and their dependencies (a process
  spawner among them), for a helper we'd use one function of. The web
  function holds `VARIABLES_KEY`; adding a process-spawning dependency tree
  to it for connection hygiene is the wrong trade.
- **Without it, the cost is bounded.** A suspended instance keeps at most
  its idle clients (3 for web, 5 for MCP) open to Supavisor until it
  resumes and the 10 s idle timer closes them, or it is torn down. With the
  leak fixed that is a handful of the 200 pooler clients per instance, not a
  climb.

What would change the answer: the pooler client count (Supabase dashboard,
Database, Connection pooling) approaching 200 in real use. Then the
cheapest fix is our own twenty lines doing what the helper does (on the
pool's `release`, `waitUntil` a timer of the idle timeout plus 100 ms,
capped by the request deadline, through Vercel's request context), with the
idle timeout at 5 s on Vercel, and no new dependency; or 3.9.5+ pinned
exactly, accepting the tree above.

## Final sweep

2026-09-25, `20260925190000_final_sweep.sql` and the app changes with it:
items 1, 2 and 5 the third pass left. Numbers are `explain analyze` on
Postgres 17 in a container, second of two runs, on synthetic data: 2,000
vaults with 100 access-log rows each (a CLI read of one name), Ana's vault
Big with 60 variables in three environments (set 300 days ago, two of them
yesterday) and 100,000 CLI reads of development (each naming all 60, by 9
readers) plus 2,000 reveals, all in time order over 300 days; and Ana's
vault Old, whose 50,000 rows are the oldest in the log. 352,000 rows, 151 MB.

### Readers since a value was set, exactly

The Variables page's "read by" note looked at the vault's last 500 log
rows, so a value read only long ago in a busy vault showed no readers. The
suggested fix, an index on the log's reads `(vault_id, environment, at)`,
makes the answer exact but not cheap: every read since the oldest value was
set has to be grouped by its names (arrays of 60 here), and the planner
doesn't even use the index (every read qualifies).

Instead, `private.env_readers` keeps each reader's (environment, action,
person, agent) newest read per set of names, maintained by an insert
trigger on `env_access_log`; a read naming everything an older group named
replaces it, so a CLI reader that reads the same environment keeps one row.
`public.variable_readers(vault)` joins those groups to the values (owners and
editors only, as the log's RLS). The migration backfills it from the whole
log. On this data it gives exactly the rows a scan of the whole log gives
(599; 0 missing, 0 extra).

| Big's "read by" note | Rows looked at | Answer | Time |
|---|---:|---|---:|
| Before: the last 500 log rows | 500 | 543 rows (misses older readers) | 7.6 ms |
| Exact, with the suggested partial index | 102,000 | 599 rows | 245 ms |
| After: `variable_readers` | 69 groups | 599 rows | 3.8 ms |

`private.env_readers` is 2,070 rows and 736 kB for the whole log. The
trigger adds about 0.05 ms to a read (0.90 ms to 0.95 ms per insert-and-commit
over 2,000 single-read transactions). A reader whose names grow on every
read (a variable added between reads, 500 times) still has one group.

### The access log's order for one vault

The log's primary key was `(seq)`, and `where vault_id = $1 order by seq
desc limit n` could walk it backwards from the newest row of the whole log.
When one vault's rows are the oldest, that passes every other vault's rows
first. The primary key is now `(vault_id, seq)`, which replaces the old
`(vault_id, seq)` index: no index orders the log across vaults any more, so
every plan for a vault's page starts at that vault, whatever the planner
estimates. `seq` stays unique (an identity nobody may set).

| Access log page (Ana, under RLS) | Before | After |
|---|---:|---:|
| Old, first page (its rows the oldest) | 62 ms, 302,000 rows filtered | 0.34 ms |
| Big, first page | 0.42 ms | 0.34 ms |
| Old, page after 40,000 rows | | 0.28 ms |
| Old, filtered to an action it has none of | 62 ms (the whole log) | 9.8 ms (its own 50,000 rows) |
| Big, filtered to one variable's name | | 0.33 ms |

A rare action in a vault with many rows still reads all of that vault's
rows; an index on `(vault_id, action, seq)` would fix that if the filter is
used on big vaults, at the cost of another index on every log insert.

## Still to do

1. **Confirm the pg_cron job after the next `db push`** (`select jobname,
   active from cron.job`), and that `cron.job_run_details` shows it
   succeeding.
2. **Watch the pooler client count** in the week of real use (see
   `attachDatabasePool` above); act only if it climbs.
3. **`vault_ref` by name costs about 1 ms** among thousands of other
   vaults, mostly RLS on `vault_members` and `vaults`; a security-definer
   lookup keyed on `(user_id)` then name would be faster but would move
   an access decision out of RLS. Not worth it at this size.
4. **A rare action filter on a big vault's access log** reads that vault's
   rows (9.8 ms for 50,000): add `(vault_id, action, seq)` only if the
   Access log page's timing shows it.
