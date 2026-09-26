# Reliquary: operating manual

Facts and guardrails for any agent working in this repo. The design is
[docs/design.md](docs/design.md); read it before changing schema, auth,
secrets or the feed.

## Build order

Milestones and their exit checks are in the design's Build order table. Work
on the current milestone only. A milestone is done when its check has held
for a week of real use, not when the code merges.

Current milestones (owner's decision, 2026-09-24): **1** is built and hosted,
and in its week of real use; **2, environment variables**, is being built
alongside it. Nothing from milestone 3 on.

Milestone 1: **core, MCP and UI** (vaults, files with canon/open
policies, proposals with quorum, log, gate, remote MCP with OAuth, web UI).
Done so far:
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
- parity between people and agents ([docs/parity.md](docs/parity.md), kept
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
  person only: sign out everywhere (`20260926140000_sign_out_everywhere.sql`:
  Supabase's global logout, then a cutoff that `private.check_session`, run
  with the claims at the start of every web transaction, holds sessions to;
  `RLA01`), change of email through Supabase Auth (nothing in the database:
  invites match the address at acceptance), and deleting the account
  (`20260926140200_delete_account.sql`; the model is in the design's
  "Deleting an account"), with hostile tests in
  `supabase/tests/sign_out_everywhere_test.sql`, `email_change_test.sql` and
  `delete_account_test.sql`, and `web/test/account.test.mjs`.

Milestone 2: **environment variables**. Done so far (phase 1, the core;
interface and phase 2's work in [docs/variables.md](docs/variables.md)):
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
  `reliquary_ops`, not the web app's; procedure in `docs/ops/runbook.md`) and
  custom environments (owners, typed-name delete), with limits (1000
  variables per vault, no NUL in values).
Milestone 2 is built; next is its week of real use.

Alongside: the public docs, roadmap and llms.txt (see Docs below), a
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

All of it needs podman or docker; nothing needs Node installed on the host.

`spikes/` and `pilot/` are research that informed v3 (the audience gate, session
minting, a Telegram surface). They are not product code, and are not
milestone work.

## Guardrails

- **Secrets never reach a model.** No MCP tool, log line, change event,
  error message or routine prompt may contain a variable's value. Only
  `reliquary run` (into one process) and `reliquary env pull` (into a
  gitignored `.env`) deliver values. A change that could route a value
  anywhere else is wrong even if a test passes.
- **The database enforces access, not the API.** Every permission in the
  design's access table is an RLS policy or trigger. Adding a check only in
  route handlers does not count.
- **Every access rule has a hostile test** that runs on every push: a session
  for vault A reading vault B, an agent approving a proposal, anyone editing a
  `log` row, an agent revealing a variable, a routine escaping its
  declaration.
- **An agent is its person, minus a ceiling.** Agents act with the
  connecting member's permissions, except approving, revealing variable
  values, managing members, and deleting or exporting a vault. Those need the
  person present in the UI.
- **Append-only means append-only.** `log`, `env_access_log` and
  `routine_runs` history are never updated or deleted in place. The one
  sanctioned exception is `delete_vault` (an owner, in person, typed name):
  it removes a whole vault for erasure and leaves a record in
  `private.vault_deletions`. Any new append-only table must let that path
  through, and nothing else.
- **Nothing becomes canon without a person.** Agents and routines write notes
  or proposals; people approve or write canon.
- **A run is only `ok` with an artifact.** A run that reports nothing it
  produced is a failure.
- **Routines are declarative.** No code execution, no git, no outbound call
  that isn't a declared notify target. Anything needing more is a design
  decision, not a patch.
- **No customer runs a server.** Nothing a vault needs may depend on a
  member's machine staying on.
- **Entry text is data.** MCP responses wrap it as quoted content with author
  and approval date; never let an entry read as an instruction.
- **Never ship a generic error message.** No "something went wrong", "an
  error occurred" or "try again later" alone: every failure a person or
  agent sees says what was being done, where it broke, why, and a reference
  that is in the server log with the detail. Every new failure path uses the
  shared model (`web/src/failure.ts`, the same file as `mcp/src/failure.ts`;
  `web/src/errorpage.ts` for pages; `serverSays` in `cli/src/errors.ts`):
  throw a `Refusal` (status, where, why) or a database exception with a
  message written for people, and let `fail()` / `failure()` build and log
  the rest. Public reference: `docs/public/reference/errors.md`; finding a
  ref: the runbook's "Finding an error by its ref".
  `web/test/errors_unit.test.mjs` fails on the banned phrases.

## Testing

Policy and sources: [docs/research/testing-strategy.md](docs/research/testing-strategy.md).

- **Every feature lands with tests derived from its acceptance criteria**
  (one behaviour per test, named as the criterion) and a row in
  [tests/features.md](tests/features.md) citing them, in the same commit.
  `scripts/check-registry.sh` fails on unmapped test files or dead citations.
- **Existing tests change only when the change's goal is to change that
  behaviour.** Declare it with a commit trailer (last paragraph, beside Co-Authored-By),
  `Changes-behaviour: <feature id> <why>`, and update the registry row. Test
  restructuring with the same assertions uses `Test-refactor: <why>`.
  `scripts/test-guard.sh` (CI, on every push and PR) fails otherwise.
- **Run `./test.sh` before committing** (all suites in parallel; use your own
  `TEST_SLOT`, it takes that slot and the next three). CI runs it on every push
  and pull request.
- **Mutation-check every new access rule once:** break it, watch its hostile
  test fail, restore it, and say so in the commit body.
- A bug fix adds a test that fails without the fix. Before refactoring a
  thinly tested feature, add characterization tests in a separate commit.
- A changed MCP tool name, description or schema fails
  `mcp/test/contract.test.mjs`; regenerate with `UPDATE_SNAPSHOTS=1
  ./mcp/test.sh` and commit the snapshot with a `Changes-behaviour` trailer.
- New test files seed their own data or use unique paths; never depend on
  another file's side effects. Flaky means failing: fix, don't retry.

## Docs

The public docs are `docs/public/` (Markdown, Diátaxis: tutorials, concepts,
how-to guides, reference; the sidebar is `docs/public/SUMMARY.md`), served by
the web app at `/docs` (`web/src/docs.ts`), each page also as Markdown at
`/docs/<page>.md`, with `/llms.txt`, `/llms-full.txt` and `/roadmap`. The rest
of `docs/` is internal: never publish it, link it from `docs/public` or copy
it there.

- **Every feature lands with its docs updated in the same change:** the page
  that explains it, and the Docs column of its row in
  [tests/features.md](tests/features.md) (`scripts/check-registry.sh` fails on
  a row without an existing page). Shipping a feature also moves its item in
  `docs/public/roadmap.yml` to `shipped`, with its docs page.
- **The docs are for people and agents.** Write plainly: short pages, sentence
  case, no em dashes, the exact commands and button names. Never put a secret,
  a token or real client data in them, not even as an example.
- **Generated parts aren't edited by hand.** `web/scripts/gen-docs.mjs` (run by
  `npm run build` and `web/test.sh`) writes the MCP tool reference from
  `mcp/test/contract.snapshot.json` and `docs/public/reference/mcp-access.json`
  (who may call each tool: a new tool needs an entry there or the build
  fails), the CLI's help from `cli/src/cli.ts`, the changelog from
  `CHANGELOG.md` and the roadmap from `docs/public/roadmap.yml`.
- `web/test/docs.test.mjs` fails when the docs drift: an MCP tool, CLI command
  or option left out or invented, a link or anchor that doesn't resolve, a page
  missing from the sidebar, an invalid roadmap.

## Conventions

- Conventional commits (`feat(feed): ...`, `fix(rls): ...`). Trailers
  (`Changes-behaviour:`, `Test-refactor:`, `Co-Authored-By:`) go together in
  the last paragraph, no blank line between them.
- **Commit types write the changelog.** Pushes to `main` only test; a bot
  (release-please, `.github/workflows/release.yml`) keeps a "Release vX.Y.Z"
  pull request whose `CHANGELOG.md` is built from commit subjects, and only
  merging it tags a release and deploys it (`docs/ops/runbook.md`,
  "Deploy"). So:
  - every user-visible change needs a `feat`, `fix`, `perf` or `security`
    commit whose subject a person reading the changelog understands
    ("feat(web): export a vault as .tar.gz", not "feat: wip"); `feat` bumps
    the minor, the others the patch;
  - `chore`, `test`, `ci`, `refactor`, `docs` and merge commits are left out
    of the changelog and release nothing on their own;
  - a breaking change to an MCP tool, the CLI, the env API or anything else
    people or their agents depend on is `feat!:` / `fix!:` or carries a
    `BREAKING CHANGE: <what to do>` footer;
  - commits touching `cli/` go to the CLI's own release (`cli/CHANGELOG.md`,
    tags `cli-vX.Y.Z`).
- **0.x is pre-alpha.** Any release may change or remove anything; while
  below 1.0 a breaking change bumps the minor, not the major, and GitHub
  Releases are marked prereleases. 1.0 is a deliberate owner decision (a
  `Release-As: 1.0.0` footer when they make it), never a side effect.
- Never edit `version.txt`, `.release-please-manifest.json`, the package
  versions or a released `CHANGELOG.md` entry by hand; the release pull
  request does. Never tag or publish a release: people merge the release
  pull request.
- Migrations are numbered SQL files in `supabase/migrations/`, never edited
  after they ship; fix forward.
- No real client data in fixtures, seeds or tests.
