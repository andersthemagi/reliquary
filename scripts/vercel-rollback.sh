#!/usr/bin/env bash
# Points a Vercel project's production traffic back at a previous
# deployment, through the Vercel REST API. Used by
# .github/workflows/deploy.yml right after scripts/vercel-deploy.sh, when
# the post-deploy smoke checks fail: production is already serving the new,
# broken deployment (Vercel aliases a production deployment the moment it's
# READY, before anything checks that it actually boots), so this undoes
# that instead of leaving it live until a person notices.
#
#   VERCEL_TOKEN=... scripts/vercel-rollback.sh <project>=<deployment id>...
#
# Each pair is a project name (or id) and the deployment id production
# should point at again — scripts/vercel-deploy.sh writes exactly this
# format to ROLLBACK_TARGETS_FILE before it deploys, one pair per line.
#
# Env:
#   VERCEL_TOKEN    a Vercel access token that can roll back these projects
#                   (required; sent on stdin to curl, never an argument)
#   VERCEL_TEAM_ID  the team that owns the projects (unset for a personal
#                   account)
#   VERCEL_WAIT     seconds to wait for every rollback to take effect
#                   (default 300)
#   VERCEL_API      API origin (default https://api.vercel.com; tests)
#
# Requests every rollback, then polls until each project's current
# production deployment is the one asked for; exits non-zero if any isn't
# confirmed in time (production may still be on the broken deployment, and
# needs a person). Prints project names, deployment ids and states only:
# never the token or a response body.
set -euo pipefail

[ $# -gt 0 ] || { echo "usage: scripts/vercel-rollback.sh <project>=<deployment id>..." >&2; exit 2; }
wait_s=${VERCEL_WAIT:-300}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
source "$(dirname "$0")/lib/vercel-api.sh"

declare -A targets
for pair in "$@"; do
  project=${pair%%=*}
  dep=${pair#*=}
  if [ -z "$project" ] || [ -z "$dep" ] || [ "$project" = "$pair" ]; then
    echo "usage: scripts/vercel-rollback.sh <project>=<deployment id>..." >&2
    exit 2
  fi
  targets[$project]=$dep
  code=$(vercel_api POST "/v1/projects/$project/rollback/$dep")
  if [ "${code:0:1}" != 2 ]; then
    echo "::error::$project: rollback to $dep not accepted (HTTP $code $(vercel_field .error.code))"
    exit 1
  fi
  echo "$project: rollback to $dep requested"
done

check_rollback() {
  local project=$1 code current
  code=$(vercel_api GET "/v6/deployments?projectId=$project&target=production&limit=1")
  current=$(vercel_field '.deployments[0].uid')
  if [ "${code:0:1}" = 2 ] && [ "$current" = "${targets[$project]}" ]; then
    echo "$project: production is back on ${targets[$project]}"
  else
    return 1
  fi
}
vercel_poll_until "$wait_s" 5 "rolling back" " (production may still be on the broken deployment)" \
  check_rollback "${!targets[@]}"
