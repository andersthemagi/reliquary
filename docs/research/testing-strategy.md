# Testing strategy: regression, traceability and change policy

2026-09-24 · Status: ADOPTED (runner, CI, registry, guard, contract tests
built the same day) · Companions: [tests/features.md](../../tests/features.md),
[AGENTS.md](../../AGENTS.md) "Testing"

The owner's brief: make sure each feature is built properly, and that a new
feature doesn't break an earlier one unless the change's goal is to
refactor that feature. This note summarises the established practice, then
states Reliquary's policy and what was built.

Sources were checked on 2026-09-24. Claims marked *(unverified)* came from
search snippets or summaries, not the source itself.

## 1. What Reliquary had before this pass

| Suite | Runner | What it is | Count |
|---|---|---|---|
| sql | `./supabase/tests/run.sh` | Hostile RLS tests: one fresh Postgres database per `*_test.sql`, every migration applied, `harness.sql` runs each call as a given person, agent or token | 7 files, 264 checks |
| mcp | `./mcp/test.sh` | Official MCP client against the real server and database | 4 files, 41 tests |
| web | `./web/test.sh` | HTTP against the real web server, signed in as Ana; pure unit tests for diff and contrast | 6 files, 84 tests |

Strong points: every access rule already had an attack, tests read as
behaviour ("outsider: sees no trace of the vault"), and suites are isolated by
`TEST_SLOT`. Missing: one command for everything, CI, a map from feature to
tests, any rule about changing existing tests, and a contract for the MCP
surface agents depend on.

## 2. The body of knowledge

| Practice | What it says | Source | How it applies here |
|---|---|---|---|
| Regression testing | Re-testing a previously tested program after a change, to find defects introduced or uncovered in unchanged areas | [ISTQB glossary](https://glossary.istqb.org/en_US/term/regression-testing) | The whole suite is the regression suite. It runs on every change, not only the new feature's tests |
| Beyoncé Rule | "If you liked it, then you shoulda put a test on it." If a change breaks something no CI test covered, that's the missing test's fault, not the change's | [SWE at Google, ch. 11](https://abseil.io/resources/swe-book/html/ch11.html) | Behaviour we want to keep must have a test in `./test.sh`, and CI must run it |
| Unchanging tests | Tests should not change for pure refactorings, new features or bug fixes (bug fixes add tests). Only a behaviour change should require editing existing tests | [SWE at Google, ch. 12](https://abseil.io/resources/swe-book/html/ch12.html) | The test guard: removing or editing existing test lines needs a declared reason |
| Test via public APIs, state not interactions, behaviours not methods | Call the system the way its users do; assert results, not internal calls; one test per behaviour | [SWE at Google, ch. 12](https://abseil.io/resources/swe-book/html/ch12.html) | Already our style: SQL tests call the public functions as a person; MCP tests use the real client; web tests use HTTP |
| Test pyramid | Many fast low-level tests, fewer broad ones; push each check as far down as it can go; order pipeline stages by speed | [Fowler, TestPyramid](https://martinfowler.com/bliki/TestPyramid.html); [Vocke, Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) | Access rules are proved in SQL (bottom); MCP and web tests check the wiring and what people and agents see, not every rule again |
| Testing trophy | For apps, weight integration tests most: "the more your tests resemble the way your software is used, the more confidence they can give you"; static checks at the base | [Dodds](https://kentcdodds.com/blog/the-testing-trophy-and-testing-classifications) | Our MCP and web suites are integration tests against a real database; `tsc` is the static layer. Both shapes agree: few slow browser tests (we have none) |
| Specification by example | Derive scope from goals, illustrate with concrete examples, automate them without rewording, validate frequently; the result is living documentation | [Adzic, Specification by Example](https://www.manning.com/books/specification-by-example) *(unverified: publisher summary)* | Each feature's acceptance criteria become test names ("request changes: needs a note"). The registry row is the one-line criterion; the tests are its examples |
| Traceability | Map each requirement to the tests that verify it, so a gap or an orphan test is visible | Standard practice (e.g. requirements traceability matrix) | `tests/features.md`, checked by `scripts/check-registry.sh` |
| Characterization tests | Tests that capture what code actually does now, as a safety net before changing it | [Feathers, via Wikipedia](https://en.wikipedia.org/wiki/Characterization_test) *(unverified: secondary)* | Before refactoring a feature with thin coverage, first add tests pinning current behaviour, commit them, then refactor with them green |
| Contract tests | Consumers state their expectations of an interface as tests the provider runs, so the interface can't drift silently | [Vocke, Practical Test Pyramid](https://martinfowler.com/articles/practical-test-pyramid.html) | Agents are the MCP surface's consumers. Tool names, descriptions and schemas are a contract: `mcp/test/contract.test.mjs` |
| Approval / snapshot tests | Store an approved output; a difference fails and a person approves or rejects it | [ApprovalTests](https://github.com/approvals/ApprovalTests.cpp); [Falco on SE Radio 595](https://se-radio.net/2023/12/se-radio-595-llewelyn-falco-on-approval-testing/) | Used where the output is large and should change rarely: the MCP tool list. Not for whole HTML pages yet (they churn with design work) |
| Mutation testing | Insert small faults and check the tests catch them; at Google, diff-based and limited to covered, interesting lines | [Petrović and Ivanković, ICSE-SEIP 2018](https://research.google.com/pubs/archive/46584.pdf) | We do it by hand for access rules: break the rule, see the hostile test fail, restore. No tool yet |
| Coverage caveat | Coverage shows lines ran, not that they're right; hard thresholds become ceilings | [SWE at Google, ch. 11](https://abseil.io/resources/swe-book/html/ch11.html) | No coverage target. The registry and mutation checks are the measure |
| CI gating | Required status checks must pass before a PR merges into a protected branch; optionally require the branch to be up to date | [GitHub Docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) | `.github/workflows/test.yml`; make `test` and `guard` required on `main` |
| Flaky tests | Non-deterministic tests destroy trust in the whole suite; quarantine briefly, with a hard cap, then fix | [Fowler, Eradicating Non-Determinism](https://martinfowler.com/articles/nonDeterminism.html) *(unverified: summaries)*; Google targets about 0.15% flakiness, and trust collapses near 1% ([SWE at Google, ch. 11](https://abseil.io/resources/swe-book/html/ch11.html)) | Policy below: no retries, no sleeps as fixes |

## 3. Reliquary's policy

### Every feature lands with its tests

| Rule | How it's checked |
|---|---|
| A feature's acceptance criteria are written as test names before or with the code, one behaviour per test, in the suite nearest the rule (access in SQL, agent view in MCP, people's view in web) | Review |
| The feature gets a row in `tests/features.md` with its criteria in one line and the tests that prove it, in the same commit | `scripts/check-registry.sh` fails on a test file no row cites, or a cited test that no longer exists |
| Every access rule has a hostile test, and was mutation-checked once: break the rule, watch the test fail, restore, say so in the commit body | Review (manual) |
| A bug fix adds a test that fails before the fix | Review |
| Before refactoring a thinly covered feature, add characterization tests in a separate commit first | Review; the guard then proves they didn't change |

### Existing tests change only on purpose

A test that passed yesterday and is edited today is either a regression
being hidden or a deliberate behaviour change. The guard makes the author
say which.

| Change | Existing test lines | Needs |
|---|---|---|
| New feature, bug fix | Only added | Nothing |
| Pure refactor of product code | Untouched | Nothing (if a test must change, it was testing internals: fix the test's approach and declare `Test-refactor`) |
| Restructuring tests, same assertions (a shared helper, a rename, a runner change) | Changed | `Test-refactor: <why>` trailer |
| Intended behaviour change (the goal is to change that feature) | Changed or removed | `Changes-behaviour: <feature id> <why>` trailer, and the registry row updated |
| A snapshot changes (`contract.snapshot.json`) | Changed | Same as behaviour change: regenerate with `UPDATE_SNAPSHOTS=1`, review the diff, add the trailer |

`scripts/test-guard.sh [base]` implements this. It diffs `supabase/tests/`,
`mcp/test/` and `web/test/` from the merge base with `base` (default `main`)
to `HEAD`, ignoring whitespace, blank lines, comment-only lines and renames,
and lists every removed or changed line. Any such line fails the guard
unless a commit in the range has one of the two trailers. CI runs it on
every pull request (against the PR base) and every push (against the
previous tip). Locally: `scripts/test-guard.sh` after committing, before
merging a branch into `main`.

It is deliberately coarse: it can't tell a harmless import edit from a
weakened assertion, so both need a sentence. That sentence is the point;
the reviewer reads it next to the diff.

### Run everything, every time

| Where | What runs |
|---|---|
| Before each commit | `./test.sh` (all three suites in parallel on slots `TEST_SLOT`, +1, +2; about 15 s warm). A subset while iterating: `./test.sh sql` |
| Every push and PR | `.github/workflows/test.yml`: job `guard` (registry check, test guard) and job `test` (`./test.sh` with docker) |
| Merge to `main` | Both jobs green. Set them as required status checks under branch protection |

### Contracts and snapshots

| Surface | Test | Updating on purpose |
|---|---|---|
| MCP tool list: names, titles, descriptions, input schemas, annotations | `mcp/test/contract.test.mjs` against `mcp/test/contract.snapshot.json`; also every token sees the same tools | `UPDATE_SNAPSHOTS=1 ./mcp/test.sh`, review `git diff`, commit with `Changes-behaviour:` |
| Web routes | `web/test/routes.test.mjs`: a table of every GET page, each must render with the shell; unknown and malformed paths 404 | Edit the table, with `Changes-behaviour:` when a route goes |
| Whole-page HTML | Not snapshotted. Pages change with design work almost daily, and structural assertions (`controls.test.mjs`) already pin what matters (order of controls, escaping) | Revisit when the UI settles |

### Flaky tests

| Rule | Why |
|---|---|
| No retries in runners, no `sleep` to make a test pass | Both hide real races |
| A flaky test is a failing test: fix it the same day or quarantine it with a skip that names an issue and a date, at most two at once | Fowler's cap on quarantine |
| Tests own their data: a new test file seeds its own vault or unique paths, never relies on another file's side effects or order | Most of our nondeterminism risk is shared seed state across files in one suite |
| Time comes from the database (`now()`) and tests compare with margins | Clock skew between containers |

## 4. What was built

| Piece | File | Notes |
|---|---|---|
| One runner | `test.sh` | Registry check, then sql, mcp and web in parallel on distinct slots; per-suite pass and fail counts; full log of any failing suite |
| CI | `.github/workflows/test.yml` | `guard` and `test` jobs; `CONTAINER_ENGINE=docker` on the runner |
| Docker compatibility | `supabase/tests/run.sh`, `mcp/test.sh`, `web/test.sh` | `CONTAINER_ENGINE` override; `npm ci` in a container when `node_modules` is missing (fresh checkout or CI); `--network host` and `:Z` work with both engines. The MCP leak check no longer uses `tee /dev/stderr`, which truncated the log when stderr was a file |
| Registry | `tests/features.md`, `scripts/check-registry.sh` | 32 features, every test file mapped; known gaps listed at the end |
| Guard | `scripts/test-guard.sh` | As above. Run against the history before this pass, it flags the design-system change to `web.test.mjs` and the tool-list change in `e2e.test.mjs`: exactly the edits that should have carried a reason |
| MCP contract | `mcp/test/contract.test.mjs`, `mcp/test/contract.snapshot.json` | Mutation-checked: rewording one tool description fails it |
| Web routes contract | `web/test/routes.test.mjs` | 22 pages and the 404 cases |
| Gap filled: delete | `supabase/tests/delete_test.sql`, `web/test/delete.test.mjs` | Delete had only negative tests. Mutation-checked: dropping the canon check in `delete_file` fails three tests |

## 5. Junk-pattern auditing (2026-09-29)

The policy above catches missing and drifting tests, not low-value ones.
Prompted by [openclaw's test-audit
skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md)
(Vitest-specific, not directly reusable), added
[`.claude/skills/test-audit/SKILL.md`](../../.claude/skills/test-audit/SKILL.md):
an authoring gate (four questions plus a junk-pattern checklist) and an audit
workflow, reshaped around this repo's own layering — access rules owned by
SQL, MCP and web proving wiring rather than the rule again — instead of
inventing a parallel one. AGENTS.md "Testing" points to it.

Considered and rejected: an automated scanner for assertion-free tests (the
most mechanical junk pattern). A prototype flagging `test()` bodies with no
`assert.*` call, run against all 105 files and 1213 top-level tests in
`mcp/test`, `web/test` and `cli/test`, found zero real hits — the 4 flagged
cases all delegated to a well-named shared assertion helper
(`createsExactly(...)`, `noValues(...)`), which is the pattern to prefer, not
junk. Wiring that into `./test.sh` or CI would only produce false-positive
failures on legitimate shared fixtures. This suite is already disciplined
enough that the remaining value is judgment, not a grep; the skill stays
manual rather than gated.
