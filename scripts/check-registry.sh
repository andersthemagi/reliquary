#!/usr/bin/env bash
# Keeps tests/features.md honest (traceability from feature to test):
#  1. every `file#prefix` it cites exists and has a test named with prefix;
#  2. every plain `file` it cites exists;
#  3. every test file in the repo is cited by at least one row.
# Needs only bash, grep and sed. Runs first in ./test.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

registry=tests/features.md
status=0
fail() { echo "registry: $*"; status=1; }

refs=$(grep -oE '`(supabase|mcp|web)/[^`]+`' "$registry" | tr -d '`' | sort -u)

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

for t in supabase/tests/*_test.sql mcp/test/*.test.mjs web/test/*.test.mjs; do
  grep -qxF "$t" <<< "$(sed 's/#.*//' <<< "$refs")" || fail "$t is not in $registry; add it to a feature row"
done

[ $status = 0 ] && echo "registry: $(wc -l <<< "$refs") references ok, every test file mapped"
exit $status
