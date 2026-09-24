# Feature registry

One row per shipped feature: what it must do (its acceptance criteria, in
one line) and the tests that prove it. Policy and background:
[docs/research/testing-strategy.md](../docs/research/testing-strategy.md).

How to read the Tests column: `file#prefix` means every test in `file`
whose name starts with `prefix` (SQL: the first argument of `t.expect*`;
node: the `test("...")` name). `scripts/check-registry.sh` runs first in
`./test.sh` and fails if a referenced file or prefix no longer exists, or if
a test file is not referenced by any row.

A new feature adds a row in the same commit as its tests. A change that
retires or changes a row's behaviour edits the row and carries a
`Changes-behaviour:` trailer (see `scripts/test-guard.sh`).

Suites: **sql** `./supabase/tests/run.sh` (hostile RLS tests, one fresh
database per file), **mcp** `./mcp/test.sh` (official MCP client against the
server), **web** `./web/test.sh` (HTTP against the server). All three:
`./test.sh`.

## Core (milestone 1)

| ID | Feature | Acceptance criteria | Tests |
|---|---|---|---|
| F01 | Vaults and members | A person creates a vault and is its owner; the owner adds editors and viewers; an outsider sees no trace of it; an agent or anonymous caller can't create one; a removed member reads and writes nothing | `supabase/tests/core_test.sql#identity:`, `supabase/tests/core_test.sql#read:`, `supabase/tests/core_test.sql#members:`, `supabase/tests/core_test.sql#removal:`, `supabase/tests/core_test.sql#cross-vault:`, `mcp/test/e2e.test.mjs#vaults:`, `mcp/test/e2e.test.mjs#outsider:`, `web/test/web.test.mjs#isolation:` |
| F02 | Open files | Editors and their agents write open files directly, versioned and attributed; viewers read, can't write; path traversal refused | `supabase/tests/core_test.sql#open:`, `mcp/test/e2e.test.mjs#write: an editor`, `mcp/test/e2e.test.mjs#viewer:`, `mcp/test/e2e.test.mjs#paths:`, `web/test/web.test.mjs#edit:` |
| F03 | Canon policies (rules) | The owner (not an editor, not an agent) marks folders or files canon with a quorum; nested paths inherit; a file-level rule overrides; canon files refuse direct writes, even from the owner | `supabase/tests/core_test.sql#policy:`, `mcp/test/e2e.test.mjs#write: canon`, `web/test/web.test.mjs#rules:`, `web/test/web.test.mjs#tree:`, `web/test/web.test.mjs#folder:`, `web/test/web.test.mjs#create under canon` |
| F04 | rule_for (rules visible only to readers) | A member reads a path's rule and quorum through `rule_for`; a non-member or a token scoped elsewhere learns nothing; `policy_for` is not callable by signed-in users; canon writes still refused | `supabase/tests/rule_for_test.sql#rules:` |
| F05 | Proposals and quorum | Anyone who can write proposes; only people approve (never an agent, viewer or outsider); nothing is written before quorum; one person approves once; the applied write is credited to the proposer's agent; a proposal on an old base goes stale; one rejection closes it | `supabase/tests/core_test.sql#quorum:`, `supabase/tests/core_test.sql#stale:`, `supabase/tests/core_test.sql#reject:`, `mcp/test/e2e.test.mjs#propose:`, `web/test/web.test.mjs#approve:` |
| F06 | Delete | Editors and their agents delete open files (versions kept, logged, path reusable); viewers, outsiders and anonymous can't; canon files are deleted only by an approved delete proposal | `supabase/tests/delete_test.sql#delete:`, `supabase/tests/delete_test.sql#delete proposal:`, `web/test/delete.test.mjs#delete:`, `mcp/test/scope.test.mjs#read-only: cannot write, propose, delete` |
| F07 | Erase | Only the owner (in person) erases a file; every version's text and its proposals' notes and comments are blanked; the log keeps every row and gains one; erased text is never found or fed | `supabase/tests/core_test.sql#erase:`, `supabase/tests/review_test.sql#notes: erasing`, `supabase/tests/threads_test.sql#erase:`, `supabase/tests/changes_comments_test.sql#erased:`, `supabase/tests/access_tokens_test.sql#search: erased`, `mcp/test/changes_comments.test.mjs#feed: erased` |
| F08 | Append-only log and locked tables | `log`, approvals and version text can't be updated, deleted or truncated; no direct inserts into files, roles or the log; internal helpers are not callable | `supabase/tests/core_test.sql#append-only:`, `supabase/tests/core_test.sql#tables:` |
| F09 | Agent ceiling | An agent acts as its person except: it can't approve, set rules, manage members, create vaults, mint tokens, snooze or erase; the MCP surface has no approve tool | `supabase/tests/core_test.sql#quorum: an agent cannot approve`, `supabase/tests/core_test.sql#policy: owner`, `supabase/tests/core_test.sql#members: the owner`, `supabase/tests/core_test.sql#identity: an agent`, `supabase/tests/core_test.sql#erase: the owner`, `supabase/tests/token_scope_test.sql#ceiling:`, `supabase/tests/access_tokens_test.sql#create: an agent`, `supabase/tests/threads_test.sql#agent:`, `mcp/test/e2e.test.mjs#tools:`, `mcp/test/threads.test.mjs#snooze is not a tool` |
| F10 | Feed (changes_since) | A cursor returns only later events, in order; outsiders get nothing | `supabase/tests/core_test.sql#feed:`, `mcp/test/changes_comments.test.mjs#events without a note` |

## Review flow

| ID | Feature | Acceptance criteria | Tests |
|---|---|---|---|
| F11 | Request changes, revise, reject | Request changes and reject need a note and a person; requested changes keep it alive and block approval until revised; only the proposer revises; a revision voids earlier approvals; the applied text is the latest revision | `supabase/tests/review_test.sql#request changes:`, `supabase/tests/review_test.sql#revise:`, `supabase/tests/review_test.sql#revision:`, `supabase/tests/review_test.sql#reject:`, `mcp/test/e2e.test.mjs#revise:`, `web/test/web.test.mjs#request changes:` |
| F12 | Edit & approve | A person (not an agent, not an outsider) edits a proposal and approves it; the file is credited to the editor; the edit is a note; with quorum 2 it waits for a second approval of the edit | `supabase/tests/review_test.sql#edit & approve`, `web/test/web.test.mjs#edit, then approve:` |
| F13 | Review notes | Notes can't be inserted directly, rewritten, or read by outsiders | `supabase/tests/review_test.sql#notes:` |
| F14 | Review inbox and home | The nav count and the cross-vault list show what waits on me; home leads with it | `web/test/web.test.mjs#review:`, `web/test/web.test.mjs#home:` |
| F15 | Proposal page: evidence first | The diff comes before the agent's reason, which is labelled unverified; the result view renders the proposed text; reviewing your own agent's change says so | `web/test/web.test.mjs#proposal:` |
| F16 | Controls at the top | Title and status, then the decision, then the diff; verdict buttons never inside a disclosure; latest requested changes shown at the top; page actions in the header; closed or viewer pages show status and no controls | `web/test/controls.test.mjs#proposal:`, `web/test/controls.test.mjs#pages:`, `web/test/controls.test.mjs#changes requested:` |
| F17 | Threads (comments) | Members comment, agents as their person; viewers read but can't comment; outsiders learn nothing; 1 to 4000 characters, 200 per proposal; comments can't be edited, deleted, forged or turned into notes; closed proposals take no more; an agent comment approves nothing | `supabase/tests/threads_test.sql#comment:`, `supabase/tests/threads_test.sql#forged author:`, `supabase/tests/threads_test.sql#edit:`, `supabase/tests/threads_test.sql#delete:`, `supabase/tests/threads_test.sql#agent comment:`, `supabase/tests/threads_test.sql#live:`, `supabase/tests/threads_test.sql#closed:`, `supabase/tests/threads_test.sql#cap:`, `mcp/test/threads.test.mjs#thread:`, `mcp/test/threads.test.mjs#comment:`, `mcp/test/threads.test.mjs#list_proposals:`, `mcp/test/threads.test.mjs#viewer:`, `mcp/test/threads.test.mjs#outsider:`, `mcp/test/threads.test.mjs#closed:`, `mcp/test/threads.test.mjs#limits:`, `web/test/threads.test.mjs#thread:`, `web/test/threads.test.mjs#comment:`, `web/test/threads.test.mjs#viewer:`, `web/test/threads.test.mjs#closed:` |
| F18 | Snooze | A person snoozes an open proposal for a day or until it changes (at most a year); it's private to them and unlogged; someone else's comment or a new revision wakes it; agents can't snooze; closed proposals can't be snoozed | `supabase/tests/threads_test.sql#snooze:`, `supabase/tests/threads_test.sql#private:`, `supabase/tests/threads_test.sql#outsider:`, `supabase/tests/threads_test.sql#change:`, `supabase/tests/threads_test.sql#time:`, `supabase/tests/threads_test.sql#unsnooze:`, `supabase/tests/threads_test.sql#removed member:`, `supabase/tests/threads_test.sql#grants:`, `supabase/tests/threads_test.sql#anonymous:`, `web/test/threads.test.mjs#snooze:`, `web/test/controls.test.mjs#review:` |
| F19 | Comments and notes in the feed | `changes_since` and `change_notes` bring each discussion event's own note, fenced, in order, for members only and within the token's scope; erased ones come back without text; no note text in the log | `supabase/tests/changes_comments_test.sql#feed:`, `supabase/tests/changes_comments_test.sql#notes:`, `supabase/tests/changes_comments_test.sql#log:`, `supabase/tests/changes_comments_test.sql#members:`, `supabase/tests/changes_comments_test.sql#outsider:`, `supabase/tests/changes_comments_test.sql#anonymous:`, `supabase/tests/changes_comments_test.sql#token:`, `mcp/test/changes_comments.test.mjs#feed:`, `mcp/test/changes_comments.test.mjs#members only:` |
| F20 | Diffs | Word highlights inside paired lines; unified (default), split and rendered views; unchanged middles fold; huge inputs fall back to a whole-file replace; text escaped in every view | `web/test/diff_activity.test.mjs#diff:`, `web/test/diff_activity.test.mjs#proposal:` |
| F21 | Activity and history | Account-wide and per-vault activity with who, what and where, never file text and never another vault's events; filters by agent, person, action, path and date; malformed filters ignored; paging without gaps; a file's History is the same log | `web/test/diff_activity.test.mjs#activity:`, `web/test/diff_activity.test.mjs#history:`, `web/test/diff_activity.test.mjs#nav:` |

## Tokens and MCP

| ID | Feature | Acceptance criteria | Tests |
|---|---|---|---|
| F22 | Access tokens | A person (not an agent, not anonymous) mints a token with bounded lifetime; only its hash is stored; only its person sees it; the MCP role resolves live tokens only; revoke and expiry stop it; the MCP role can't read tables or call unchecked helpers | `supabase/tests/access_tokens_test.sql#create:`, `supabase/tests/access_tokens_test.sql#read:`, `supabase/tests/access_tokens_test.sql#resolve:`, `supabase/tests/access_tokens_test.sql#revoke:`, `supabase/tests/access_tokens_test.sql#expiry:`, `supabase/tests/access_tokens_test.sql#mcp role:`, `mcp/test/e2e.test.mjs#auth:` |
| F23 | Token scope | A token reaches all its person's vaults or a chosen set, read-only or read-write, always expiring; the database enforces it (another vault is invisible, read-only writes nothing); scope can't be edited; forged, revoked, expired tokens reach nothing; client name and last use are recorded | `supabase/tests/token_scope_test.sql#create:`, `supabase/tests/token_scope_test.sql#read:`, `supabase/tests/token_scope_test.sql#scope:`, `supabase/tests/token_scope_test.sql#read-only:`, `supabase/tests/token_scope_test.sql#read-write:`, `supabase/tests/token_scope_test.sql#forged:`, `supabase/tests/token_scope_test.sql#revoke:`, `supabase/tests/token_scope_test.sql#expiry:`, `supabase/tests/token_scope_test.sql#client:`, `supabase/tests/token_scope_test.sql#grants:`, `supabase/tests/token_scope_test.sql#leaving:`, `mcp/test/scope.test.mjs#read-only:`, `mcp/test/scope.test.mjs#scoped:`, `mcp/test/scope.test.mjs#client name`, `mcp/test/scope.test.mjs#revoked mid-session`, `mcp/test/scope.test.mjs#expired:` |
| F24 | Tokens page | Name, vaults to tick, read or read-write and a required expiry; shown once; unknown access becomes read-only; refused without a vault, for someone else's vault, or past a year; list shows last use and client, escaped; expired and left vaults shown honestly; revocable | `web/test/tokens.test.mjs#form:`, `web/test/tokens.test.mjs#create:`, `web/test/tokens.test.mjs#list:`, `web/test/tokens.test.mjs#revoke:`, `web/test/web.test.mjs#tokens:` |
| F25 | Search | Finds by content and path within the caller's vaults and reports the policy; outsiders find nothing; wildcards match nothing extra; erased text is never found | `supabase/tests/access_tokens_test.sql#search:`, `mcp/test/e2e.test.mjs#search:`, `mcp/test/e2e.test.mjs#outsider: Team`, `web/test/web.test.mjs#search:` |
| F26 | Entry text is data | File text, reasons, notes and comments reach agents inside markers with author and date, and can't close their fence; the UI escapes them | `mcp/test/e2e.test.mjs#read:`, `mcp/test/e2e.test.mjs#data, not instructions`, `mcp/test/threads.test.mjs#data, not instructions`, `mcp/test/changes_comments.test.mjs#data, not instructions`, `web/test/web.test.mjs#file:` |
| F27 | MCP tool contract | Tool names, titles, descriptions, input schemas and annotations match the approved snapshot; every token sees the same tools | `mcp/test/contract.test.mjs#contract:`, `mcp/test/contract.snapshot.json` |
| F28 | No secrets in server logs | MCP and web server logs contain no tokens, login codes or file text | `mcp/test.sh`, `web/test.sh` |

## Web shell and design system

| ID | Feature | Acceptance criteria | Tests |
|---|---|---|---|
| F29 | Sign-in stand-in and request safety | No session is refused; a login link works once; strict, HttpOnly cookie; scripts forbidden by CSP, no caching; every POST needs the form token and a same-origin Origin | `web/test/web.test.mjs#auth:`, `web/test/web.test.mjs#headers:`, `web/test/web.test.mjs#csrf:`, `web/test/delete.test.mjs#delete: needs the form token` |
| F30 | Connect page | Per-client setup with the MCP URL and no token anywhere | `web/test/web.test.mjs#connect:` |
| F31 | Design system | Every token pair meets WCAG AA in light and dark; the explicit dark theme matches the automatic one; the theme switch sets a cookie and refuses off-site returns; fonts, icon and stylesheet are local; copy has no em dashes or straight apostrophes | `web/test/contrast.test.mjs#contrast:`, `web/test/web.test.mjs#theme:`, `web/test/web.test.mjs#assets:`, `web/test/web.test.mjs#copy:`, `web/test/threads.test.mjs#copy:`, `web/test/diff_activity.test.mjs#copy:` |
| F32 | Web routes contract | Every page the UI links to renders with the shell; unknown paths and malformed ids are 404 | `web/test/routes.test.mjs#route:` |

## Hosting

| ID | Feature | Acceptance criteria | Tests |
|---|---|---|---|
| F33 | Web as hosted (PUBLIC_URL, no public/) | With `PUBLIC_URL=https://...` a POST passes only with exactly that Origin (any other, `null` or none gets 403); session and theme cookies are `__Host-` prefixed, Secure, Path=/, no Domain; the server starts and renders pages without `public/` | `web/test/hosting.test.mjs#hosted:` |
| F34 | Database TLS and pool for serverless | On Vercel, `DATABASE_URL` without `DATABASE_CA_FILE` is refused at start; with it, TLS is verified against the bundled Supabase CA; TLS parameters in the URL are refused next to a CA; refusals never contain the URL; pools default small (web 3, mcp 5); local runs unchanged | `web/test/db_tls.test.mjs#db tls:`, `web/test/db_tls.test.mjs#db pool:`, `mcp/test/db_tls.test.mjs#db tls:`, `mcp/test/db_tls.test.mjs#db pool:` |
| F35 | Health and keepalive | `/healthz` answers `ok` without the database; `/healthz?db=1` runs `select 1` and answers only `ok` or 503 `unavailable`, uncached; with `KEEPALIVE_TOKEN` set it needs a matching `x-keepalive` header (constant-time compare), and the token never reaches the log | `mcp/test/healthz.test.mjs#healthz:` |
| F36 | Role statement timeouts | `reliquary_web` and `reliquary_mcp` log in with a 10s `statement_timeout`, kept across `set local role authenticated` | `supabase/tests/role_timeouts_test.sql#timeout:`, `mcp/test/healthz.test.mjs#timeout:` |
| F37 | Pinned search_path | Every function in `public` and `private` sets its own `search_path`, so a caller's search_path can never redirect a name (Supabase advisor 0011) | `supabase/tests/search_path_test.sql#search_path:` |

## Not built yet (no rows until they ship)

OAuth for MCP, Supabase Auth in the web UI, plain export, environment
variables, connections, routines. Each lands with its row and tests.

## Known gaps

| Gap | Why it matters | Plan |
|---|---|---|
| Agents delete through MCP only by `propose` with `delete: true`; the positive path (agent proposes a delete, person approves) is tested in SQL but not end to end over MCP | The tool argument could break without a failing test | Add to a new MCP test file with its own vault in the seed |
| `propose-delete` from the web file page has no test | Same, for the UI | Add with its own vault in the web seed, so Review counts in `web.test.mjs` don't move |
| No HTML snapshots of whole pages | Structural assertions cover what matters; full snapshots would churn with every design change while the UI is still moving | Revisit once the design system settles |
| Mutation checks are manual | A test that can't fail proves nothing | See the policy: every new access rule is mutation-checked once by hand, noted in the commit |
