#!/usr/bin/env bash
# Regression guard: existing tests change only on purpose.
#
#   scripts/test-guard.sh [base]     # default base: main (or origin/main)
#
# Compares the commits since the merge base of <base> and HEAD. Adding tests
# always passes. If any line of an existing test file is removed or changed
# (an assertion, a test case, a seed row, a snapshot entry, or a whole
# file), the guard fails unless a commit message in the range carries one of
# these trailers:
#
#   Changes-behaviour: <feature id or name> <why the old behaviour goes>
#   Test-refactor: <why; the tests still check the same things>
#
# as git trailers: in the last paragraph of the message, next to
# Co-Authored-By, not followed by another paragraph.
#
# Blank lines, comment-only lines and whitespace-only changes don't count.
# Renames don't count as deletions. Only committed changes are checked, so
# commit first (the trailer lives in the commit message).
# Policy: docs/research/testing-strategy.md.
set -euo pipefail
cd "$(dirname "$0")/.."

base=${1:-}
if [ -z "$base" ]; then
  if git rev-parse -q --verify main >/dev/null; then base=main; else base=origin/main; fi
fi
if ! git rev-parse -q --verify "$base^{commit}" >/dev/null; then
  echo "test-guard: base '$base' not found (fetch it, or pass a base)"; exit 2
fi
mb=$(git merge-base "$base" HEAD) || { echo "test-guard: no merge base with $base"; exit 2; }
if [ "$mb" = "$(git rev-parse HEAD)" ]; then echo "test-guard: nothing to check since $base"; exit 0; fi

paths=(supabase/tests mcp/test web/test cli/test)

# Removed lines per file, ignoring blanks and comment-only lines.
removed=$(git diff -U0 -w -M "$mb" HEAD -- "${paths[@]}" | awk '
  /^--- / { file = substr($0, 5); sub(/^a\//, "", file); next }
  /^\+\+\+ / { next }
  /^-/ {
    line = substr($0, 2)
    if (line ~ /^[[:space:]]*$/) next
    if (line ~ /^[[:space:]]*(\/\/|--|#)/) next
    printf "%s: %s\n", file, line
  }')

if [ -z "$removed" ]; then
  added=$(git diff --numstat -M "$mb" HEAD -- "${paths[@]}" | awk '{s += $1} END {print s + 0}')
  echo "test-guard: ok, existing tests untouched ($added test lines added since $(git rev-parse --short "$mb"))"
  exit 0
fi

n=$(wc -l <<< "$removed")
# Real trailers only (git parses the message's last paragraph), so prose
# that happens to start with "Test-refactor:" doesn't count.
trailers=$(git log --format='%(trailers:key=Changes-behaviour,key=Changes-behavior,key=Test-refactor)' "$mb..HEAD" \
  | grep -iE '^(Changes-behaviou?r|Test-refactor):[[:space:]]*[^[:space:]]' || true)

if [ -n "$trailers" ]; then
  echo "test-guard: ok, $n existing test line(s) changed, declared by:"
  sed 's/^/  /' <<< "$trailers"
  echo "Files:"
  cut -d: -f1 <<< "$removed" | sort | uniq -c | sed 's/^/ /'
  exit 0
fi

cat <<EOF
test-guard: FAIL. $n line(s) of existing tests were removed or changed since
$(git rev-parse --short "$mb") ($base), and no commit in the range declares why.

$(head -40 <<< "$removed" | sed 's/^/  /')
$([ "$n" -gt 40 ] && echo "  ... and $((n - 40)) more")

If this is a regression (a new feature broke an old one), fix the code and
keep the test. If the goal of this change is to change that behaviour, or
to restructure tests that still check the same things, say so in a commit
message trailer, e.g.:

  Changes-behaviour: F16 controls at the top; the snooze form moves to the header
  Test-refactor: shared login helper; same assertions

and update the feature's row in tests/features.md.
EOF
exit 1
