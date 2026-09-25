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
#
# Creates one production deployment per project from that commit (the
# project's Git connection, so its Root Directory and settings apply), then
# waits until every one is READY; exits non-zero if any fails or times out.
# Prints project names, deployment ids, URLs and states only: never the
# token or a response body.
set -euo pipefail

: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required (owner/repo)}"
sha=${1:-}
shift || true
[[ $sha =~ ^[0-9a-f]{40}$ ]] || { echo "usage: scripts/vercel-deploy.sh <40-hex commit> <project>..." >&2; exit 2; }
[ $# -gt 0 ] || { echo "name at least one Vercel project" >&2; exit 2; }
wait_s=${VERCEL_WAIT:-900}
api_base=${VERCEL_API:-https://api.vercel.com}
team=${VERCEL_TEAM_ID:+?teamId=$VERCEL_TEAM_ID}
org=${GITHUB_REPOSITORY%%/*}
repo=${GITHUB_REPOSITORY#*/}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# api <method> <path> [json body file]: status code on stdout, body in $tmp/out.
api() {
  local args=(-sS -o "$tmp/out" -w '%{http_code}' --max-time 30 -X "$1" -H @- -H 'content-type: application/json')
  [ -z "${3:-}" ] || args+=(--data "@$3")
  local sep='?'
  [ -z "$team" ] || sep='&'
  local url="$api_base$2${team}"
  # forceNew on create: a redeploy of the same commit builds again.
  [ "$1" != POST ] || url="${url}${sep}forceNew=1"
  curl "${args[@]}" "$url" <<< "authorization: Bearer $VERCEL_TOKEN" 2>/dev/null || echo 000
}
field() { jq -r "$1 // empty" "$tmp/out" 2>/dev/null || true; }

declare -A ids
for project in "$@"; do
  jq -n --arg p "$project" --arg org "$org" --arg repo "$repo" --arg sha "$sha" \
    '{name: $p, project: $p, target: "production",
      gitSource: {type: "github", org: $org, repo: $repo, ref: "main", sha: $sha}}' > "$tmp/body"
  code=$(api POST /v13/deployments "$tmp/body")
  id=$(field .id)
  if [ "${code:0:1}" != 2 ] || [ -z "$id" ]; then
    echo "::error::$project: deployment not created (HTTP $code $(field .error.code))"
    exit 1
  fi
  ids[$project]=$id
  echo "$project: $id building ${sha:0:12} (https://$(field .url))"
done

deadline=$((SECONDS + wait_s))
pending=("$@")
while [ ${#pending[@]} -gt 0 ]; do
  left=()
  for project in "${pending[@]}"; do
    code=$(api GET "/v13/deployments/${ids[$project]}")
    state=$(field .readyState)
    case "$code:$state" in
      2??:READY) echo "$project: READY" ;;
      2??:ERROR | 2??:CANCELED) echo "::error::$project: deployment ${ids[$project]} $state"; exit 1 ;;
      *) left+=("$project") ;;
    esac
  done
  pending=(${left[@]+"${left[@]}"})
  [ ${#pending[@]} -eq 0 ] && break
  if [ $SECONDS -ge $deadline ]; then
    echo "::error::still building after ${wait_s}s: ${pending[*]}"
    exit 1
  fi
  sleep 10
done
