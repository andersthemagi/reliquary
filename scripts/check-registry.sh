#!/usr/bin/env bash
# Keeps tests/features.md honest (traceability from feature to test):
#  1. every `file#prefix` it cites exists and has a test named with prefix;
#  2. every plain `file` it cites exists;
#  3. every test file in the repo is cited by at least one row;
#  4. every feature row names its public docs page (`docs/public/<page>.md`,
#     in the last column), and that page exists.
# Needs only bash, grep and sed. Runs first in ./test.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

registry=tests/features.md
status=0
fail() { echo "registry: $*"; status=1; }

refs=$(grep -oE '`(supabase|mcp|web|cli)/[^`]+`' "$registry" | tr -d '`' | sort -u)

while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  file=${ref%%#*}
  if [ ! -f "$file" ]; then fail "$ref: no such file"; continue; fi
  [ "$file" = "$ref" ] && continue
  prefix=${ref#*#}
  # The prefix must start a test name: right after the quote that opens it.
  if ! grep -qF -e "'$prefix" -e "\"$prefix" -e "\`$prefix" "$file"; then
    fail "$ref: no test in $file is named '$prefix...'"
  fi
done <<< "$refs"

for t in supabase/tests/*_test.sql mcp/test/*.test.mjs web/test/*.test.mjs cli/test/*.test.mjs; do
  grep -qxF "$t" <<< "$(sed 's/#.*//' <<< "$refs")" || fail "$t is not in $registry; add it to a feature row"
done

rows=0
while IFS= read -r row; do
  rows=$((rows + 1))
  id=$(cut -d'|' -f2 <<< "$row" | tr -d ' ')
  # The last cell: after the final " | ", before the closing "|".
  docs=$(sed -E 's/[[:space:]]*\|[[:space:]]*$//; s/.*\|//' <<< "$row" | grep -oE '`docs/public/[^`]+\.md`' | tr -d '`' || true)
  if [ -z "$docs" ]; then fail "$id names no docs page (a \`docs/public/<page>.md\` in its last column)"; continue; fi
  while IFS= read -r page; do
    [ -f "$page" ] || fail "$id: $page doesn't exist"
  done <<< "$docs"
done < <(grep -E '^\| F[0-9]+ \|' "$registry")

# Feature ids are what Changes-behaviour trailers name: each must be unique.
while IFS= read -r dup; do
  fail "$dup is used by more than one row; give one of them a new id"
done < <(grep -oE '^\| F[0-9]+ \|' "$registry" | tr -d '| ' | sort | uniq -d)

[ $status = 0 ] && echo "registry: $(wc -l <<< "$refs") references ok, every test file mapped, $rows feature rows with docs pages"
exit $status
