#!/usr/bin/env bash
# Production deploys of one exact commit to Vercel projects, through the
# Vercel REST API (.github/workflows/deploy.yml). Deploy Hooks can't do this:
# they build the latest commit on a branch, not a pinned SHA.
#
#   VERCEL_TOKEN=... GITHUB_REPOSITORY=owner/repo \
#     scripts/vercel-deploy.sh <commit sha> <project>...
#
# Env:
#   VERCEL_TOKEN        a Vercel access token that can deploy these projects
#                       (required; sent on stdin to curl, never an argument)
#   VERCEL_TEAM_ID      the team that owns the projects (unset for a personal
#                       account)
#   GITHUB_REPOSITORY   owner/repo the projects are connected to
#   VERCEL_WAIT         seconds to wait for all builds (default 900)
#   VERCEL_API          API origin (default https://api.vercel.com; tests)
#   ROLLBACK_TARGETS_FILE  when set, each project's current production
#                       deployment id is written to it first, one
#                       `project=deployment id` line per project that has
#                       one, in scripts/vercel-rollback.sh's own argument
#                       format: cat it into that script's arguments to
#                       undo this deploy (.github/workflows/deploy.yml does
#                       this when the post-deploy smoke checks fail).
#
# Creates one production deployment per project from that commit (the
# project's Git connection, so its Root Directory and settings apply), then
# waits until every one is READY; exits non-zero if any fails or times out.
# Prints project names, deployment ids, URLs and states only: never the
# token or a response body.
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/repo)}"
sha=${1:-}
shift || true
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "usage: scripts/vercel-deploy.sh <40-hex commit> <project>..." >&2; exit 2; }
[ $# -gt 0 ] || { echo "name at least one Vercel project" >&2; exit 2; }
wait_s=${VERCEL_WAIT:-900}
org=${GITHUB_REPOSITORY%%/*}
repo=${GITHUB_REPOSITORY#*/}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
source "$(dirname "$0")/lib/vercel-api.sh"

# api <method> <path> [json body file]: like vercel_api, but a POST's <path>
# also gets forceNew=1 (a redeploy of the same commit builds again), joined
# with & rather than a second leading ? if <path> already has a query.
api() {
  local path=$2
  if [ "$1" = POST ]; then
    [[ $path == *'?'* ]] && path="${path}&forceNew=1" || path="${path}?forceNew=1"
  fi
  vercel_api "$1" "$path" "${3:-}"
}

# Each project's current production deployment, before this deploy touches
# it: scripts/vercel-rollback.sh's undo target if the new one turns out
# broken (a build succeeding says nothing about whether the app boots).
rollback_file=${ROLLBACK_TARGETS_FILE:-}
[ -z "$rollback_file" ] || : > "$rollback_file"
for project in "$@"; do
  code=$(api GET "/v6/deployments?projectId=$project&target=production&limit=1")
  prev=$(vercel_field '.deployments[0].uid')
  if [ "${code:0:1}" != 2 ]; then
    echo "::error::$project: couldn't read the current production deployment (HTTP $code $(vercel_field .error.code))"
    exit 1
  elif [ -n "$prev" ]; then
    echo "$project: current production $prev"
    [ -z "$rollback_file" ] || echo "$project=$prev" >> "$rollback_file"
  else
    echo "$project: no current production deployment (first deploy)"
  fi
done

declare -A ids
for project in "$@"; do
  jq -n --arg p "$project" --arg org "$org" --arg repo "$repo" --arg sha "$sha" \
    '{name: $p, project: $p, target: "production",
      gitSource: {type: "github", org: $org, repo: $repo, ref: "main", sha: $sha}}' > "$tmp/body"
  code=$(api POST /v13/deployments "$tmp/body")
  id=$(vercel_field .id)
  if [ "${code:0:1}" != 2 ] || [ -z "$id" ]; then
    echo "::error::$project: deployment not created (HTTP $code $(vercel_field .error.code))"
    exit 1
  fi
  ids[$project]=$id
  echo "$project: $id building ${sha:0:12} (https://$(vercel_field .url))"
done

check_deploy() {
  local project=$1 code state
  code=$(api GET "/v13/deployments/${ids[$project]}")
  state=$(vercel_field .readyState)
  case "$code:$state" in
    2??:READY) echo "$project: READY" ;;
    2??:ERROR | 2??:CANCELED) echo "::error::$project: deployment ${ids[$project]} $state"; exit 1 ;;
    *) return 1 ;;
  esac
}
vercel_poll_until "$wait_s" 10 building "" check_deploy "$@"
