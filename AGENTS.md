# Reliquary: operating manual

Facts and guardrails for any agent working in this repo. The design is
[docs/design.md](docs/design.md); read it before changing schema, auth,
secrets or the feed.

## Build order

Milestones and their exit checks are in the design's Build order table. Work
on the current milestone only. A milestone is done when its check has held
for a week of real use, not when the code merges.

Current milestone: **1, core, MCP and UI** (vaults, files with canon/open
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
  for your own proposal in the web UI.
Both need podman or docker; nothing needs Node installed on the host.

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
  `routine_runs` history are never updated or deleted in place.
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
  `TEST_SLOT`, it takes that slot and the next two). CI runs it on every push
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

## Conventions

- Conventional commits (`feat(feed): ...`, `fix(rls): ...`).
- Migrations are numbered SQL files in `supabase/migrations/`, never edited
  after they ship; fix forward.
- No real client data in fixtures, seeds or tests.
