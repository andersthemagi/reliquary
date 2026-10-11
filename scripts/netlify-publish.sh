#!/usr/bin/env bash
# Makes an existing deploy a Netlify site's published (production) deploy,
# through the Netlify REST API ("Publish deploy" in the UI; a restore).
# .github/workflows/deploy.yml uses it to publish the draft deploys that
# scripts/netlify-deploy.sh uploaded once scripts/deploy-check.sh has passed
# against them, so production never serves a deploy nothing has checked.
# By hand it is the rollback: name the previous deploy (the site's Deploys
# list, or the id a deploy run printed) and production serves it again.
#
#   NETLIFY_AUTH_TOKEN=... scripts/netlify-publish.sh <site id>=<deploy id>...
#
# Each pair is a site (its API ID) and the deploy production should serve;
# scripts/netlify-deploy.sh writes exactly this format to DEPLOYS_FILE, one
# pair per line.
#
# Env:
#   NETLIFY_AUTH_TOKEN  a Netlify personal access token that can publish
#                       deploys of these sites (required; sent on stdin to
#                       curl, never an argument)
#   NETLIFY_WAIT        seconds to wait for every publish to take effect
#                       (default 300)
#   NETLIFY_API         API origin (default https://api.netlify.com/api/v1; tests)
#
# Requests every publish, then polls until each site's published deploy is
# the one asked for; exits non-zero if any isn't confirmed in time (production
# is still on whatever it served before, and needs a person). Prints site
# ids, deploy ids and states only: never the token or a response body.
set -euo pipefail

usage() { echo "usage: scripts/netlify-publish.sh <site id>=<deploy id>..." >&2; exit 2; }
[ $# -gt 0 ] || usage
wait_s=${NETLIFY_WAIT:-300}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
source "$(dirname "$0")/lib/netlify-api.sh"

declare -A targets
for pair in "$@"; do
  site=${pair%%=*}
  dep=${pair#*=}
  [ -n "$site" ] && [ -n "$dep" ] && [ "$site" != "$pair" ] || usage
  targets[$site]=$dep
  code=$(netlify_api POST "/sites/$site/deploys/$dep/restore")
  if [ "${code:0:1}" != 2 ]; then
    echo "::error::$site: publishing $dep not accepted (HTTP $code $(netlify_field .message))"
    exit 1
  fi
  echo "$site: publishing $dep requested"
done

check_published() {
  local site=$1 code current
  code=$(netlify_api GET "/sites/$site")
  current=$(netlify_field '.published_deploy.id')
  if [ "${code:0:1}" = 2 ] && [ "$current" = "${targets[$site]}" ]; then
    echo "$site: production is on ${targets[$site]}"
  else
    return 1
  fi
}
netlify_poll_until "$wait_s" 5 publishing " (production is still on the deploy it served before)" \
  check_published "${!targets[@]}"
