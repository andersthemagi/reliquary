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
Done so far: the core schema in `supabase/migrations/`, with hostile tests in
`supabase/tests/` (`./supabase/tests/run.sh`, needs podman or docker).

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

## Conventions

- Conventional commits (`feat(feed): ...`, `fix(rls): ...`).
- Migrations are numbered SQL files in `supabase/migrations/`, never edited
  after they ship; fix forward.
- No real client data in fixtures, seeds or tests.
