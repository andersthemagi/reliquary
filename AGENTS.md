# Reliquary: operating manual

Facts and guardrails for any agent working in this repo. The design is
[docs/design.md](docs/design.md); read it before changing schema, auth,
secrets or the feed.

## Build order

Milestones and their exit checks are in the design's Build order table
([docs/design.md](docs/design.md#build-order)). Work on the current
milestone only; it is done when its check has held for a week of real use,
not when the code merges. Milestones 1 and 2 are done; milestone 3 (links)
is current until the owner marks it done in [docs/progress.md](docs/progress.md).
Three owner decisions started work early (path ownership and flags; claims
and work plans; Threads and the Tasks view). Each is a logged exception, not
a precedent: read [the decision log](docs/progress.md#decisions) and the
milestone's section there before building ahead of anything. Not built:
waiting in line (`request_work`, `leave_queue`, places in line; issue #74).
`spikes/` and `pilot/` are research, not product code or milestone work.

## Commands

Everything runs in containers (podman or docker); no Node on the host.

- `./test.sh` runs every suite in parallel and `scripts/check-registry.sh` first; `./test.sh mcp web` runs only those (`sql`, `mcp`, `web`, `cli`).
- `TEST_SLOT=8 ./test.sh`: the run takes slots 8 to 11, so two sessions need bases 4 or more apart.
- One MCP test file: `MCP_TESTS=test/links.test.mjs ./mcp/test.sh`. The other suites have no per-file switch.
- There is no formatter, and no linter for TypeScript: `tsc`, inside each suite's build, is its only static check. The `lint` workflow runs actionlint on the workflows and shellcheck on the scripts (settings in `.shellcheckrc`); errors block, warnings are listed.
- `./scripts/test-guard.sh origin/main` is CI's `guard` job; `./test.sh` does not run it, and it reads commit messages, so commit first.
- Docs build without host Node, from the repo root: `podman run --rm --network none -v "$PWD":/repo:z -w /repo/web docker.io/library/node:22-slim node scripts/gen-docs.mjs` (writes `web/docs-build/`); `./test.sh web` checks them.
- Run the app: `./mcp/dev.sh up` (web UI on `http://127.0.0.1:8790`, MCP on `http://127.0.0.1:8787/mcp`), `./mcp/dev.sh ui`, `./mcp/dev.sh down`.
- CI also runs `./deploy/test.sh` (self-host smoke test), the CLI unit tests on Linux, macOS and Windows (`cd cli && npm test`, needs Node 20 or 22, only when `cli/` changed), TruffleHog, `npm audit` and CodeQL.

## Guardrails

- **Secrets never reach a model.** No MCP tool, log line, change event,
  error message or routine prompt may contain a variable's value. Only
  `reliquary run` (into one process) and `reliquary env pull` (into a
  gitignored `.env`) deliver values. A change that could route a value
  anywhere else is wrong even if a test passes.
- **Secrets, for you.** Never read or print `.env*` (not `.env.example`), `mcp/.env.dev`, `mcp/.tokens/`, `web/.login*`, `mcp/.login-oauth-*`, `supabase/.access-token` or `supabase/.vercel-*.env`, `supabase/.*password`, `supabase/.*-secret`: they hold live values, and a database password reached a model that way once (`docs/ops/runbook.md`, "Rules that came from incidents").
  Scripts print names, not values; don't ask the person to paste terminal output that may show one.
  A command that might print a value is for the person to run in their own terminal.
- **The database enforces access, not the API.** Every permission in the
  design's access table is an RLS policy or trigger. Adding a check only in
  route handlers does not count.
- **Every access rule has a hostile test** that runs on every push: a session
  for vault A reading vault B, an agent approving a proposal, anyone editing a
  `log` row, an agent revealing a variable, a routine escaping its
  declaration.
- **An agent is its person, minus a ceiling.** Agents act with the
  connecting member's permissions, except the actions that are irreversible,
  grant trust or reveal a secret. Those need the person present in the UI.
  The one list is [the ceiling](docs/public/concepts/agents.md#the-ceiling);
  an action that fits goes on it, with a hostile test.
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
`/docs/<page>.md`, with `/llms.txt` and `/llms-full.txt`. The rest
of `docs/` is internal: never publish it, link it from `docs/public` or copy
it there.

- **Every feature lands with its docs updated in the same change:** the page
  that explains it, and the Docs column of its row in
  [tests/features.md](tests/features.md) (`scripts/check-registry.sh` fails on
  a row without an existing page). There is no second list to update when a
  feature ships: its issue closes (Issues, below) and the PR title writes the
  changelog entry.
- **The docs are for people and agents.** Write plainly: short pages, sentence
  case, no em dashes, the exact commands and button names. Never put a secret,
  a token or real client data in them, not even as an example.
- **Generated parts aren't edited by hand.** `web/scripts/gen-docs.mjs` (run by
  `npm run build` and `web/test.sh`) writes the MCP tool reference from
  `mcp/test/contract.snapshot.json` and `docs/public/reference/mcp-access.json`
  (who may call each tool: a new tool needs an entry there or the build
  fails), the CLI's help from `cli/src/cli.ts`, the changelog from
  and `CHANGELOG.md`.
- `web/test/docs.test.mjs` fails when the docs drift: an MCP tool, CLI command
  or option left out or invented, a link or anchor that doesn't resolve, a page
  missing from the sidebar.

## Issues

If it isn't logged, log it; if it's logged, keep it true. Open work lives in
GitHub issues, and the roadmap is [the project board](https://github.com/users/andersthemagi/projects/3) over them
(`reliquary.redmage.cc/roadmap` goes there); what shipped is
[CHANGELOG.md](CHANGELOG.md); what was built and why is
[docs/progress.md](docs/progress.md). Keep no to-do list and no roadmap
anywhere else, the site included.
Issues went stale once because every close was by hand and no PR named its
issue; these rules make the PR carry that, and CI checks what it can.

- **Before you start,** find the issue (`gh issue list --search "<words>"`).
  A feature with none gets one first, with the job it does and what done
  looks like; it lands on the board as Considering, which commits nothing.
  Don't build a Considering item: only the owner moves one to Planned, so
  comment and ask, unless the owner has already told you to build it (say so
  on the issue and set it Planned). Set In progress when you take up a Planned
  one, and if you stop without finishing, put it back to what is true.
- **Every PR's description has one line saying which issue it is for:**
  `Closes #N` when merging finishes the issue, `Part of #N` when it is one
  step of it, `No issue: <why>` for a dependency bump, a docs fix or a bug
  found on the way (never for a `feat` PR). The `issue-line` job in
  `.github/workflows/pr-title.yml` fails a PR without one. Only `Closes`,
  `Fixes` and `Resolves` close anything, and GitHub does it when the PR
  merges, so never close an issue by hand to match a merge.
- **A PR that ships part of an issue says what is left,** in the PR and in
  a comment on the issue: the PR numbers shipped, what remains, anything now
  unblocked. The next agent reads the issue, not your diff. Don't write
  `Closes` on a partial one to be tidy, and don't leave a finished one open.
  If the scope changed or you stopped halfway, say so on the issue before
  you end the session.
- **A tracking issue's children are sub-issues,** not a checklist someone
  ticks by hand; attach each child to its parent when you open it
  (Relationships in the issue's sidebar), and GitHub keeps the count.
- **Out of scope but real? File it:** one problem per issue, how to see it,
  a `bug` or `type:` label, linked from your PR. Not a line in a PR
  description or `docs/progress.md` that nobody will reopen.
- **Could someone new do it? Say so.** When an issue you file or find is
  small and self-contained, label it `good first issue` and `help wanted`,
  and write it so a stranger can take it: the file or page to start from,
  what done looks like, and the command that checks it (`./test.sh web`).
  Never one that touches an access rule, the schema, auth or secrets, or that
  needs a decision from the owner. Contributors arrive in bursts (October is
  Hacktoberfest), and an issue with no trail in it costs more to explain than
  to do. Don't stretch the label to fill a quota.
- **The roadmap is the board, so a real issue is on it,** with a Status
  (Considering, Planned, In progress) that says what is true, and the matching
  label: `status: considering` (the issue template's default, and the status of
  anything not definitively being worked), `status: planned` (the owner
  committed to it), `status: in progress` (someone is working on it now). Set
  the Status and the label together; the board adds a new issue as Considering.
  A tracking issue's sub-issues carry neither, their parent does. Closing takes an issue off the roadmap: done is
  `Closes #N`; closing as not planned is the owner's decision, never a way to
  tidy up. A tracking issue's sub-issues stay off the roadmap view on purpose.
  The commands and the settings that must stay on: `docs/ops/runbook.md`,
  "The roadmap board".
- `owner` marks what needs the owner: an account, money or a decision. Don't
  guess at those; comment on the issue.

## Conventions

- Conventional commits (`feat(feed): ...`, `fix(rls): ...`). Trailers
  (`Changes-behaviour:`, `Test-refactor:`, `Hotfix:`, `Co-Authored-By:`) go
  together in the last paragraph, no blank line between them. `Hotfix: <why>`
  on a commit pushed to `main` pings the repo (`docs/ops/runbook.md`,
  "Hotfix") so whoever's free can merge the release pull request; it isn't a
  different deploy path, just a louder one.
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
