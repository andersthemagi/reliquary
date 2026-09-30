# Build progress

What's shipped for each milestone, file by file, with the hostile-test
suite that proves it and the decision that shaped it. The milestone list
and exit checks are canonical in [design.md](design.md#build-order); this
page is the "done so far" detail behind whichever milestone
[AGENTS.md](../AGENTS.md#build-order) says is current.

Written as work lands. Read the section for the milestone you're touching,
not the whole file top to bottom.

## Milestone 1: core, MCP and UI

Vaults, files with canon/open policies, proposals with quorum, log, gate,
remote MCP with OAuth, web UI. Done so far:

- core schema, access tokens and search in `supabase/migrations/`, with hostile
  tests (`./supabase/tests/run.sh`);
- the remote MCP endpoint in `mcp/` (token auth; OAuth next), with end-to-end
  tests (`./mcp/test.sh`) and a local runner (`./mcp/dev.sh`);
- the web UI in `web/` (local sign-in stand-in until Supabase Auth): review
  inbox, proposal pages with approve / request changes / reject / edit & approve,
  folder tree, rendered files, rules with a checker, search, Connect page, with
  end-to-end tests (`./web/test.sh`). Structure: `docs/research/ux-patterns.md`;
- scoped, expiring agent tokens (chosen vaults or all, read-only or
  read-write, 1 to 366 days, last used with client name), enforced in
  `private.role_in` via the `act.tok` claim, with hostile tests
  (`supabase/tests/token_scope_test.sql`);
- proposal threads (comments from people and, over MCP, their agents, in one
  timeline with review notes) and private per-person snooze in the Review
  inbox (`20260924170000_threads_snooze.sql`, `web/src/thread.ts`);
- unified / split / rendered diffs with word highlights, and Activity
  (account-wide and per vault, filterable, paged; a file's History is the
  same log), in `web/src/diff.ts`, `diffview.ts`, `activity.ts`;
- parity between people and agents ([docs/parity.md](parity.md), kept
  true by `mcp/test/parity.test.mjs`): New vault in the web UI, and
  `create_vault` over MCP for all-vaults read-write tokens
  (`20260924230000_agent_create_vault.sql`), `delete_file` over MCP, Revise
  for your own proposal in the web UI;
- vault administration, owners in person only (agents refused in the
  database): rename and default policy, export (a streamed `.tar.gz` with a
  manifest, never variable values), immediate vault deletion (the one
  sanctioned path around the append-only triggers), and erasing a file from
  the web UI, each behind a confirm step, on the vault's Settings page
  (`20260925120000_vault_admin.sql`, `web/src/vaultadmin.ts`,
  `web/src/export.ts`, with hostile tests in
  `supabase/tests/vault_admin_test.sql`). The model is in the design's
  "Deleting a vault";
- members and invites, people in person only (`20260925140000_invites.sql`,
  `web/src/members.ts`, `web/src/invites.ts`, hostile tests in
  `supabase/tests/invites_test.sql`): members listed by email to
  co-members, invite links (single-use, 7 days, for one address, stored
  hashed), role changes and removal with a vault always keeping an owner,
  and members' agent connections an owner can cut off from the vault;
- membership polish (`20260925160000_membership_polish.sql`, hostile tests
  in `supabase/tests/membership_polish_test.sql`): invites are the only way
  in (`set_member` never adds; seeds and tests use `test_support.add_member`
  from `supabase/tests/support.sql`, which only the test runners load), 20
  invites an hour per person, leaving a vault (Settings), people shown by
  email where they share a vault with the reader (`web/src/people.ts`: one
  lookup per page), a one-time Home notice to the other members when a
  vault is deleted, and exports that are one snapshot, at most 10 an hour
  per vault, and never look whole when cut off.
- the app shell (`20260926100000_shell_inbox.sql`, `web/src/html.ts`,
  `web/src/inbox.ts`, `search.ts`, `settings.ts`, hostile tests in
  `supabase/tests/shell_inbox_test.sql`): a top bar with a vault switcher,
  search across the reader's vaults, an Inbox (reviews, proposals sent
  back, imports, invites, deletion notices; `/review` redirects to
  `/inbox`) and an account menu, drawn from one `shell_summary` call per
  page; Account settings with a display name, the person's own, in person.
- account self-service on Account settings, each the person's own, in
  person only: sign out everywhere (`20260926140100_sign_out_everywhere.sql`:
  Supabase's global logout, then a cutoff that `private.check_session`, run
  with the claims at the start of every web transaction, holds sessions to;
  `RLA01`), change of email through Supabase Auth (nothing in the database:
  invites match the address at acceptance), and deleting the account
  (`20260926140200_delete_account.sql`; the model is in the design's
  "Deleting an account"), with hostile tests in
  `supabase/tests/sign_out_everywhere_test.sql`, `email_change_test.sql` and
  `delete_account_test.sql`, and `web/test/account.test.mjs`.

## Milestone 2: environment variables

Phase 1, the core; interface and phase 2's work in
[variables.md](variables.md). Done so far:

- environments, variables, ciphertext in `private.variable_secrets` and the
  append-only `env_access_log` (`20260925090000_variables.sql`), with hostile
  tests (`supabase/tests/variables_test.sql`): people set and reveal, a
  `cli` grant reads, agents only list names;
- encryption in the web app (`web/src/secrets.ts`, `VARIABLES_KEY`), the
  web module for the Variables page (`web/src/variables.ts`), the CLI's
  OAuth sign-in and the env API (`web/src/envapi.ts`), and `list_variables`
  over MCP;
- the CLI in `cli/` (`reliquary login | logout | vaults | run | env pull`,
  to be published as `@reliquary-ai/cli`), with end-to-end tests
  (`./cli/test.sh`).
- phase 2's web Variables page (`web/src/variablespage.ts`): names by
  environment, set / rotate / delete, reveal by POST, the access log, and the
  CLI on Connect, with tests (`web/test/variables_page.test.mjs`).
- imports (`20260925100000_env_imports.sql`): paste a `.env` on the
  Variables page (a draft, previewed without values), or `reliquary env
  push` from the CLI (a pending import, for an agent to run): either way a
  person applies it in the web UI; one parser in `web/src/dotenv.ts` and
  `cli/src/dotenv.ts`. The CLI is ready to publish (`publish-cli.yml`).
- key rotation without downtime (`VARIABLES_KEYS`, several keys by id,
  `scripts/rotate-variables-key.sh`, run as the operator's role
  `reliquary_ops`, not the web app's; procedure in
  [ops/runbook.md](ops/runbook.md)) and custom environments (owners,
  typed-name delete), with limits (1000 variables per vault, no NUL in
  values).

Milestone 2 is built and has held its week of real use: done, 2026-09-29.

## Milestone 3: links

Design.md's "Links" (renamed 2026-09-28 from "connection", which the
Connections page already meant, `docs(design) 35d5078`). Done so far:

- core schema and owner-only management in
  `20260928120000_links.sql` (`links`, `link_secrets`, `link_tools`,
  `link_grants`, `link_calls`), with hostile tests
  (`supabase/tests/links_test.sql`): adding, editing, deleting a link and
  setting its tool grants are an owner's, in person, matching the
  delegation ceiling; the credential is never selectable by any
  authenticated role, sealed the same way as an environment variable;
  `link_calls` is append-only and outlives a deleted link (no foreign
  key, so a link's call history is never blocked or wiped by deleting
  it);
- `list_links` over MCP (2026-09-28, `mcp/src/tools.ts`, hostile tests
  in `mcp/test/links.test.mjs`): name and url, never the credential, any
  member's agent, read-only connections included.
- The Links web page (2026-09-28, `web/src/linkspage.ts`, its own nav
  section alongside Variables; tests in `web/test/links_page.test.mjs`):
  an owner adds, edits and deletes a link; the credential is sealed with
  `sealLink`/`openLink` (`web/src/secrets.ts`, the same `VARIABLES_KEYS`,
  AAD scoped to the vault only since renaming a link never touches its
  credential) and never rendered back once saved; delete goes through a
  confirm page.
- Discovery (2026-09-28, `20260928180000_link_discovery.sql`,
  `web/src/discovery.ts`, hostile tests in `supabase/tests/links_test.sql`
  and `web/test/discovery.test.mjs`, wiring in
  `web/test/links_page.test.mjs`): design.md's first open question
  (synchronous or a background job) answered synchronous, in the same
  request as `create_link` — a slow or unreachable upstream flashes a
  warning naming why, with a reference in the server log, and keeps the
  link; there is no rediscovery yet, so retrying today means deleting and
  re-adding the link. The MCP handshake (`initialize`, `initialized`,
  paged `tools/list`) is hand-rolled in the web app rather than pulling in
  the official SDK's client there (mcp/'s server already needs it for a
  different reason). Address safety is shared with the Client ID
  Metadata Document fetch (`web/src/netsafety.ts`, extracted from
  `cimd.ts` the same day). `is_write` comes from a tool's own
  `readOnlyHint` alone (anything but an explicit `true` stays a write
  tool, matching design.md); `set_link_tools` seeds a grant only for a
  newly discovered tool, never overwrites an owner's own flip on
  rediscovery, and never deletes a stale tool's grant, only the tool row
  itself.
- The Grants page (2026-09-28, `web/src/linkgrants.ts`, reached from a
  link's row menu; tests in `web/test/links_page.test.mjs`): an owner
  checks or unchecks a tool per role in one table, saved as a diff
  (`set_link_grant` once per changed cell); read-only for everyone else.
  No confirm step, unlike naming a path owner: a grant is adjustable and
  reversible either way, so it follows `rules.ts`'s "set a rule" pattern
  instead.
- The MCP proxy (2026-09-28, `20260928190000_link_proxy.sql`,
  `mcp/src/tools.ts`, `web/src/linkcall.ts`, `web/src/linkproxy.ts`;
  hostile tests in `supabase/tests/link_proxy_test.sql`, end-to-end in
  `mcp/test/link_proxy.test.mjs`), milestone 3's exit criterion:
  `begin_link_call`/`record_link_call` are the credential-egress
  chokepoint (`reveal_variable`/`read_variables`'s shape, split in two
  since a call's outcome crosses a network boundary SQL can't); a write
  tool also needs `private.connection_write_capable()`, mirroring F425's
  path-ownership fix, so a read-only-scoped token can't reach one even
  once its role (collapsed to viewer) is granted it. mcp/ never holds
  `VARIABLES_KEYS` (`server.ts` already refused to start with it set,
  before this existed): it forwards the still-sealed credential to the
  web app's own internal endpoint (`linkproxy.ts`, a shared secret,
  `LINK_PROXY_SECRET`), which opens it and makes the call
  (`linkcall.ts`, `discovery.ts`'s own safe-HTTP machinery, re-checking
  the address on every call, not just when the link was added).
  `private.list_callable_link_tools()` is what builds each identity's
  `<link>.<tool>` entries in `tools/list` — the exact criteria
  `begin_link_call` checks, so a tool is only ever listed if calling it
  would succeed; `tools/list` is no longer cached process-wide (it was,
  identity-independent) now that this makes it identity-dependent. An
  upstream tool's result is quoted as data, the same marker convention
  file text already uses. `link_tools` grows `input_schema`, so a
  registered tool carries the upstream's own argument names (untyped:
  the SDK's `registerTool` has no hook for a raw JSON Schema, only Zod);
  a tool discovered with none takes one `args` field instead.

Not built: rediscovering a link's tools by hand (`web/src/discovery.ts`'s
own header: today, retrying a failed discovery means deleting and
re-adding the link).

## Alongside milestone 3: path ownership

Not a numbered milestone of its own (design.md's "Path ownership", owner's
decision 2026-09-28). Built in `20260928130000_path_ownership.sql`, with
hostile tests (`supabase/tests/path_ownership_test.sql`) — a path's named
owners write, delete and decide on it directly, whatever their vault role (a
viewer may be named), and only their approvals count toward its quorum; a
path with no named owner is provably unchanged (the same suite re-runs
every existing canon/open hostile test, all still passing). This touched
`policy_for`, `write_file`, `delete_file` and `decide()`, functions every
other feature depends on, more than the schema-only shape of most
milestone work — treat any further change to those four with the same
care. Deliberately not touched: `propose`, `revise_proposal`,
`edit_and_approve`, `comment_on_proposal` (a path-owning viewer proposes
nothing since they write directly, and can still approve or reject with
plain `decide()`, but can't yet use edit-and-approve or comment unless
they also have ordinary editor or owner access).

Naming and removing owners is in the web app (2026-09-28,
`web/src/pathowners.ts`, `web/test/path_owners_page.test.mjs`): a rule's
**Owners** on Rules (`/v/:id/rules/owners?path=`), every member reading the
list, each grant and removal behind its own confirm page, and a POST
without that page's confirm field sent to it rather than acting. No MCP
tool, on purpose (the ceiling). Not built: the file, editor and proposal
pages still go by vault role and `rule_for`, not the caller-aware
`policy_for`, so in the web app a named owner still sees the canon flow
and a viewer owner gets no Edit or decide buttons (their agents write
directly over MCP).

### Fixed 2026-09-28: F425, path-owner connection scope

Fixed in review before the web UI shipped, before any real traffic used it
(`20260928170000_path_owner_connection_scope.sql`, F425):
`can_write_path`/`policy_for`'s owner branch checked only a `path_owners`
row, never `role_in()`'s token-scope check the way `can_write()` does — so
a named owner's read-only token, or a token scoped only to a different
vault, could still write their path. `private.connection_write_capable()`
now gates both; `decide()` was never exposed (`require_human()` refuses
every token outright). Mutation-checked: reverting the gate reproduces
exactly the four new hostile tests failing, restored.

## Alongside milestone 3: flags

Design.md's "Notifications" (the working name is flag, not notify) rides
alongside milestone 3 the same way, on the same owner's call (2026-09-28),
and isn't part of its exit either. Done so far:

- schema and SQL-callable functions in `20260928150000_flags.sql`, with
  hostile tests (`supabase/tests/flags_test.sql`): `flag_watermarks`,
  one per identity (the person in the web app, or one connection by its
  token) and vault, closed to direct access, moved only by `advance_flags`
  and only forward, never by reading; `subscriptions` to paths, the person's
  own, created and removed in person, listed by their agents too;
  `list_flags`, which returns proposals waiting on you (`shell_summary`'s
  review set), changes to your own proposals and to the files under them,
  and changes on watched paths. Both tables cascade from `vault_members`, so
  leaving, removal, account deletion and vault deletion take them with it.
  Built in a separate worktree from path ownership, so it touches neither
  `path_policies` nor `policy_for`, `write_file`, `propose` or `decide()`;
- `list_flags`, `advance_flags` and `list_subscriptions` over MCP
  (2026-09-28, `mcp/src/tools.ts`, hostile tests in
  `mcp/test/flags.test.mjs`): design.md's open question (ride in every
  response, or a tool of their own) answered in favour of a tool of their
  own, `list_flags`, called on request rather than automatically. No tool
  creates or removes a watch: that's still the person, in the web app,
  same as variables and rules;
- watching in the web app (2026-09-28, `web/src/watching.ts`,
  `web/test/watching_page.test.mjs`): **Watch** / **Unwatch** in the
  header of every folder and file page (not the vault root, which isn't a
  watchable path), and a Settings tab, **Watching**
  (`/v/:id/config/watching`), listing the person's own watches with a
  form to watch a typed path. Any member, a viewer too; not owner-gated.
- a Flags page for the person (2026-09-29, `web/src/flagspage.ts`,
  `/v/:id/flags`, its own nav section; `web/test/flags_page.test.mjs`):
  `list_flags`, oldest first, badged by category, each linked to its
  proposal or file; opening the page calls `advance_flags` for the
  person's own watermark only, same contract as an MCP client's ("shown
  in a response, not on request"), never a connection's.

Not built: category 1, notes addressed `to:` someone (design.md doesn't say
how `to:` is stored); staleness for files you've read (nothing logs a read);
tag subscriptions (files have no tags; `create_subscription` refuses the
kind); path owners in "waiting on you" (follows path ownership above when
someone does that follow-up).

## Also alongside: docs, plans, limits, admission, concurrency

The public docs, roadmap and llms.txt (see AGENTS.md's Docs section), a
pre-alpha notice on every frame, and plans and limits
(`20260925230000_plans.sql`, hostile tests in
`supabase/tests/plans_test.sql`): an account plan caps the vaults a person
owns, each vault's tier its people and storage (a counter kept by
triggers), refusals are SQLSTATE `RLP01`, and only the operator changes
plans and tiers (`scripts/plan.sh`, runbook "Plans and testers"). Suites
that share one database across files call `test_support.roomy_free()`.
Invite-only admission (`20260925240000_admission.sql`, hostile tests in
`supabase/tests/admission_test.sql`): while invite-only is on, an account
creates vaults only once it accepts an invite or the operator admits it
(`RLP02` otherwise); test databases start open (`supabase/tests/support.sql`),
and the tests of admission turn it on for themselves.

Concurrency on limits, invites and deletion is tested in
`web/test/races.test.mjs`: crowds of parallel connections, and forced
interleavings that stop one operation on an advisory-lock barrier (no
sleeps), so a lock-order deadlock shows on every run
(`20260925240100_lock_order.sql`).

## Alongside milestone 3: compare-and-swap writes, claims and work plans

Not a numbered milestone of its own, on the same owner's call as path
ownership and flags (2026-09-30, tracking issue #52): compare-and-swap
writes, path claims and work plans, so no agent overwrites another's edit
and no agent is handed a step before its blockers are done, all as
database predicates that don't depend on an agent behaving. Three gated
phases, each its own set of small pull requests:

- **Phase 1: compare-and-swap writes.** Starts now. `read_file` returns a
  file's current version id; `write_file` and `delete_file` take an
  optional expected version and refuse a stale one, naming the current
  version and its last writer.
- **Phase 2: path claims** (who's working a path, with a lease). Waits for
  phase 1 to ship and see 14 days of real use, and the maintainer
  confirming phase 2 should start.
- **Phase 3: work plans** (steps with blockers, waiting without polling).
  Waits for claims to be used by a second person for 30 days, and the
  maintainer confirming phase 3 should start.

Design for phases 2 and 3 is being settled in docs/design.md (tracking
issue's CL-0.2); nothing from those phases is built yet.
