#!/usr/bin/env bash
# One line per disagreement between docs/public/roadmap.yml and the issues it
# names; nothing when they agree. The docs build already refuses an
# in-progress or planned item with no issue; this checks that the issue still
# says what the roadmap says. Run weekly by .github/workflows/tracker-drift.yml.
#
#   scripts/tracker-drift.sh [roadmap.yml]    # needs gh, signed in or GH_TOKEN
set -euo pipefail
cd "$(dirname "$0")/.."

roadmap=${1:-docs/public/roadmap.yml}

awk '
  /^- title:/ { if (t) print i "\t" s "\t" t; t = substr($0, 10); s = ""; i = "-" }
  /^  status:/ { s = $0; sub(/^  status: */, "", s) }
  /^  issue:/ { i = $0; sub(/^  issue: */, "", i) }
  END { if (t) print i "\t" s "\t" t }
' "$roadmap" |
  while IFS=$'\t' read -r issue status title; do
    [ "$issue" != "-" ] || continue
    state=$(gh issue view "$issue" --json state -q .state)
    if [ "$status" = shipped ] && [ "$state" = OPEN ]; then
      echo "- #$issue ($title): the roadmap says shipped, but the issue is open. Close it with a comment saying what shipped, or the item is not shipped."
    elif [ "$status" != shipped ] && [ "$state" = CLOSED ]; then
      echo "- #$issue ($title): the roadmap says $status, but the issue is closed. Reopen it, or move the item."
    fi
  done
