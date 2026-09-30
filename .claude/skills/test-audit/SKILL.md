---
name: test-audit
description: "Invoke whenever writing, changing, reviewing, or sweeping tests in supabase/tests, mcp/test, web/test or cli/test. Authoring gate for new tests plus an audit workflow for low-value, duplicate, or implementation-coupled tests."
---

# Test audit

Adapted for Reliquary from
[openclaw's test-audit skill](https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md).
That skill assumes Vitest and its own tooling; this one is reshaped around
`./test.sh`, `tests/features.md` and the layering in
[docs/research/testing-strategy.md](../../../docs/research/testing-strategy.md).
Read that doc and [AGENTS.md](../../../AGENTS.md) "Testing" first — they cover
traceability, the existing-tests guard and mutation-checking access rules.
This skill covers what they don't: whether a test is worth keeping at all.

Two modes, one value bar: **authoring** gates every new or changed test at
write time. **Audit** sweeps existing tests for ones that re-assert a rule
another layer already proves, duplicate stronger proof, or keep a test-only
seam alive. Prefer a few high-confidence candidates over a speculative
inventory; optimize for confidence, not deletion count.

## Authoring gate

Before adding any test, answer all four; a missing answer means don't add it
yet:

1. **What observable behavior does it protect?** Point at the
   `tests/features.md` row (its acceptance-criteria sentence) it proves, or
   state the new row you're adding in the same commit.
2. **What credible regression makes it fail?**
3. **Why doesn't existing coverage already catch that failure?** Reliquary's
   pyramid gives each contract one owning boundary (testing-strategy.md
   "Test pyramid"): access rules are proved once in SQL against a real
   Postgres, and never again as a rule; MCP and web tests check the wiring —
   what an agent or a person actually sees — not the rule itself. A new web
   or MCP test that re-derives an access decision the SQL hostile test
   already proves is a duplicate unless it's proving something the SQL layer
   can't: that a refusal surfaces as the right HTTP status, the right MCP
   error text, or the right redirect. Name which one.
4. **Does it need a seam no real caller needs?** `test_support.*` functions
   in `supabase/tests/support.sql` are sanctioned test setup (minting
   synthetic users), not a leak into production code, and are fine. A new
   export, flag or wrapper added to `web/src`, `mcp/src` or `cli/src` purely
   so a test can reach around the public boundary (HTTP, the MCP client, the
   built CLI) is not — move the test to the real boundary instead.

Then check the test against every [junk pattern](#junk-patterns); a match
fails the gate unless the [retention bar](#retention-bar) names the contract
it independently guards.

A bug-fix test must fail on the pre-fix code for the intended reason and pass
after the fix at the owning boundary (AGENTS.md: "A bug fix adds a test that
fails without the fix"). One regression at the owning layer covers the bug;
don't replay the same scenario in sql, mcp and web alike.

## Junk patterns

- assertion-free tests: a `test()` body with no `assert.*` call and no call
  to a helper that itself asserts;
- self-comparisons: expected values produced by the same renderer or helper
  under test (e.g. computing "expected HTML" by calling the render function
  again);
- the same access rule proved again in mcp or web with no new wiring claim
  (see gate question 3);
- a capability or flag test that restates a declared flag (a tool is absent
  from the list) without also exercising what happens if it's attempted
  anyway — Reliquary usually wants both (F09 does: the MCP surface has no
  `approve` tool, *and* the SQL hostile test proves an agent that tries
  anyway is refused; that's two different claims, not a duplicate);
- fixtures or mocked rows asserted against a table or path the production
  code never actually writes;
- a test that exists only to keep a test-only export, global or wrapper
  alive, with no production caller;
- dead production code whose only callers are tests;
- a name or fixture that promises more than the input exercises (a
  `"revokes access"` test that never removes the member, a `"retires the
  window"` test that never lets it expire).

## Retention bar

Keep a test when it independently enforces:

- an access rule (SQL, the owning boundary);
- wiring: what an agent or a person actually sees (MCP contract snapshot,
  the web routes table, a specific HTTP status or redirect);
- observable ordering: `log`, `env_access_log`, `routine_runs` and feed
  cursor order are append-only and ordered on purpose — call ordering here is
  behavior, not implementation;
- a banned-phrase or source-pattern check where that *is* the cheapest
  independent guard for a real contract — `web/test/errors_unit.test.mjs`
  (no "something went wrong") and `web/test/docs.test.mjs` (docs stay
  honest) are the existing examples, not junk;
- a regression with a credible failure mode.

A retained test that fails on the current baseline is a possible product
bug: reproduce it and fix the owner, don't delete the test. A test that
resembles implementation may still be the independent contract for that
layer; prove otherwise (per gate question 3) before flagging it.

## Candidate evidence (audit mode)

Record before editing anything; a missing field means the candidate isn't
ready:

- exact test name (the `tests/features.md` prefix) and file;
- what failure it can actually detect;
- non-test callers of any production seam it alone keeps alive;
- the stronger remaining proof at the owning boundary, or why none is needed;
- risk, and the focused command to validate the removal.

## Edit shape

One coherent commit per batch. Delete the test-only export or wrapper it
was propping up in the same change, not an aliased no-op. Update the
`tests/features.md` row: remove the citation, or if the row's whole claim
goes, remove the row and say so in the commit body. This is a behavior
change to the test suite, not new product behavior, so it doesn't need a
`docs/public` page of its own — but if a row's acceptance criteria actually
narrows, its docs page may need a matching edit.

## Validation

1. `./test.sh <suite>` for the smallest affected suite (`sql`, `mcp`, `web`,
   or `cli`) while iterating; `./test.sh` before committing.
2. `./scripts/check-registry.sh` after touching `tests/features.md` or any
   test file.
3. `./scripts/test-guard.sh` before merging — removing or editing existing
   test lines needs a `Changes-behaviour:` or `Test-refactor:` trailer
   (AGENTS.md "Testing"; the commit convention is in AGENTS.md
   "Conventions").
4. For a removed access-rule test, mutation-check the rule once by hand:
   confirm the rule still fails closed some other way, or that no rule was
   silently dropped alongside the "duplicate" test. Say so in the commit
   body, same as adding one (AGENTS.md: "Mutation-check every new access
   rule once").

## Landing

Commit and open a PR only when authorized, following AGENTS.md
"Conventions" (conventional commits, trailers together in the last
paragraph, a conventional-commit-shaped PR title since that's what gets
squash-merged as the changelog line). No separate audit tooling or
bot is wired up for this — CI already runs `guard` (registry + test-guard)
and `test` (`./test.sh`) on every push and PR.

## Why there's no automated junk-pattern scanner here

A prototype flagging `test()` bodies with no `assert.*` call, run against
all 105 files and 1213 top-level tests in `mcp/test`, `web/test` and
`cli/test` (2026-09-29), found zero real hits: every flagged case delegated
to a well-named shared assertion helper (`createsExactly(...)`,
`noValues(...)`), which is the pattern to prefer, not junk. Wiring that
heuristic into `./test.sh` or CI would only produce false-positive failures
on legitimate shared fixtures, which is the kind of untrustworthy check
AGENTS.md's error-message guardrail argues against by the same logic. Junk
detection here stays a judgment call at authoring and audit time, not a
script.
