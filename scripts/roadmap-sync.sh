#!/usr/bin/env bash
# Keeps the roadmap board in step with the status labels
# (docs/ops/runbook.md, "The roadmap board"). The label is the one thing a
# person or agent sets; this copies it to the board's Status, because setting
# both by hand is how they drifted (2026-10-11: twenty issues labelled
# planned, still Considering on the board).
#
#   scripts/roadmap-sync.sh         report drift; exits 1 if there is any
#   scripts/roadmap-sync.sh --fix   also set the board from the label, and
#                                   take status labels off sub-issues
#
# Open issues only. A top-level issue needs exactly one `status:` label; one
# with none or several is reported, never guessed at, since choosing a status
# can be the owner's decision. A sub-issue carries no status label: its
# parent does. Needs gh, signed in with the project scope.
set -euo pipefail

repo=andersthemagi/reliquary
owner=andersthemagi
project=3
project_id=PVT_kwHOAbfDDM4BlHL6
field_id=PVTSSF_lAHOAbfDDM4BlHL6zhj1Rhw

fix=0
case "${1:-}" in
  --fix) fix=1 ;;
  "") ;;
  *) echo "usage: $0 [--fix]" >&2; exit 2 ;;
esac

option_for() {
  case "$1" in
    Considering) echo 4065f07e ;;
    Planned) echo fd624e83 ;;
    "In progress") echo cf4d72d0 ;;
  esac
}

set_status() { # issue number, status name
  local item
  item=$(gh project item-add "$project" --owner "$owner" \
    --url "https://github.com/$repo/issues/$1" --format json --jq .id)
  gh project item-edit --id "$item" --project-id "$project_id" \
    --field-id "$field_id" --single-select-option-id "$(option_for "$2")" >/dev/null
}

# One line per open issue: number, parent, status labels (comma-joined, with
# the "status: " prefix dropped and the first letter capitalised to match the
# board's option names), board Status ("-" when not on the board).
# shellcheck disable=SC2016 # $endCursor is GraphQL's, not the shell's
rows=$(gh api graphql --paginate -f query='
query($endCursor: String) {
  repository(owner: "andersthemagi", name: "reliquary") {
    issues(states: OPEN, first: 100, after: $endCursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        parent { number }
        labels(first: 30) { nodes { name } }
        projectItems(first: 10) {
          nodes {
            project { number }
            fieldValueByName(name: "Status") {
              ... on ProjectV2ItemFieldSingleSelectValue { name }
            }
          }
        }
      }
    }
  }
}' --jq '.data.repository.issues.nodes[] | [
  .number,
  (.parent.number // "-"),
  ([.labels.nodes[].name | select(startswith("status: ")) | ltrimstr("status: ")
    | (.[:1] | ascii_upcase) + .[1:]] | join(",")),
  ([.projectItems.nodes[] | select(.project.number == 3) | .fieldValueByName.name // "none"][0] // "-")
] | map(tostring) | join("|")')

drift=0
while IFS="|" read -r n parent labels board; do
  [ -n "$n" ] || continue
  if [ "$parent" != "-" ]; then
    [ -z "$labels" ] && continue
    drift=1
    echo "#$n is a sub-issue of #$parent but is labelled: $labels"
    if [ "$fix" = 1 ]; then
      IFS=, read -ra each <<< "$labels"
      for l in "${each[@]}"; do
        gh issue edit "$n" -R "$repo" --remove-label "status: ${l,}" >/dev/null
      done
      echo "  fixed: label removed"
    fi
    continue
  fi
  case "$labels" in
    "") drift=1; echo "#$n has no status label; set one (new work is status: considering)"; continue ;;
    *,*) drift=1; echo "#$n has several status labels ($labels); keep the one that is true"; continue ;;
  esac
  if [ -z "$(option_for "$labels")" ]; then
    drift=1; echo "#$n has an unknown status label: $labels"; continue
  fi
  [ "$board" = "$labels" ] && continue
  drift=1
  echo "#$n is labelled $labels but the board says $board"
  if [ "$fix" = 1 ]; then
    set_status "$n" "$labels"
    echo "  fixed: board set to $labels"
  fi
done <<< "$rows"

if [ "$drift" = 0 ]; then
  echo "roadmap: labels and board agree"
elif [ "$fix" = 0 ]; then
  exit 1
fi
