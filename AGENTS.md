# Reliquary: operating manual

Facts and guardrails for any agent working in this repo. The design is
[docs/design.md](docs/design.md); read it before changing schema, auth,
secrets or the feed.

## Build order

Milestones and their exit checks are in the design's Build order table
([docs/design.md](docs/design.md#build-order)). Work on the current
milestone only. A milestone is done when its check has held for a week of
real use, not when the code merges.

What's shipped for each milestone — file by file, with the hostile-test
suite that proves it and the decision that shaped it — is
[docs/progress.md](docs/progress.md). Read the section for the milestone
you're touching before changing it.

Current (updated 2026-09-29): milestones 1 and 2 have both held their week
of real use and are done. Milestone 3 (links) is current; it started early
(owner's decision, 2026-09-28), alongside path ownership and flags, before
milestone 2's week had finished. That head start was a deliberate, logged
exception to "work on the current milestone only," not a new default —
check `docs/progress.md` before assuming the same is fine for something
else mid-flight.

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
- **Before adding, changing, or sweeping tests, run the `test-audit` skill**
  (`.claude/skills/test-audit/SKILL.md`): its authoring gate and junk-pattern
  checklist catch low-value or duplicate tests that traceability and the
  guard above don't — a test that re-proves an access rule SQL already
  covers, or keeps a test-only export alive for no real caller.

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
- **A commit is one reviewable change.** Roughly what Google's [Small
  CLs](https://google.github.io/eng-practices/review/developer/small-cls.html)
  guide argues for: about 100 changed lines is normal, 1000 is a sign to
  split. One thing means one thing — a refactor and the feature or fix it
  enables are different commits even inside the same PR, because a reviewer
  (human or agent) reads them as separate claims about what changed and
  why. When a change genuinely needs several steps, stack them as separate
  commits in the same PR rather than squashing unrelated work into one; see
  `2820364`, `b517aa0` and `7644621` for the shape this looks like in
  practice here.
- **Every PR is squash-merged.** GitHub is configured so the squash
  commit's subject is always the PR title, never an individual commit
  message; merge commits and rebase merges are disabled at the repo level.
  That means release-please only ever reads one conventional-commit line
  per PR — **the PR title**, not what any commit inside it says — so the
  title, not the commits, is what has to be `type(scope): subject`-shaped.
  A GitHub Action lints this on open and on edit (`.github/workflows/pr-title.yml`).
  This replaced a dual squash/merge-commit policy that depended on a
  contributor knowing an unwritten GitHub-merge-title rule; it had already
  caused a duplicated changelog entry and a changelog wipe before it was
  replaced 2026-09-30. Full incident history: `docs/ops/runbook.md`, "Rules
  that came from incidents."
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
  - **Read the release PR's `CHANGELOG.md` before merging it,** as a person
    who wasn't in the room would. Exact procedure: `docs/ops/runbook.md`,
    "Rules that came from incidents."
- **Comments say why, never what.** A well-named function and its types
  already say what; a comment earns its place only for a hidden
  constraint, an invariant, or the reasoning behind a non-obvious choice —
  see `mcp/src/tools-shared.ts`'s file header, or `poolConfig()` in
  `mcp/src/db.ts` and `web/src/db.ts`, for the pattern already in use. A
  comment that would confuse no one if deleted along with the code it
  explains shouldn't be there.
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
