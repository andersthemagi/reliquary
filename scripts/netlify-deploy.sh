#!/usr/bin/env bash
# Draft deploys of one exact, already built commit to Netlify sites, with the
# Netlify CLI (.github/workflows/deploy.yml). A draft is a complete deploy
# with an address of its own that production does not serve yet: the
# workflow smoke-checks each draft (scripts/deploy-check.sh), then
# scripts/netlify-publish.sh makes it the published deploy, so production
# never serves a deploy nothing has checked, and there is nothing to roll
# back when a check fails.
#
# The sites are not connected to the repository on purpose: Netlify's own
# builds and build hooks build a branch's latest commit, never a pinned one,
# so the workflow builds the tagged checkout itself and this uploads it.
#
#   NETLIFY_AUTH_TOKEN=... scripts/netlify-deploy.sh <tag> <commit sha> <app>=<site id>...
#
# <app> is a directory of this repository (web, mcp) holding a netlify.toml
# and a finished `npm run build`; <site id> is that app's Netlify site (its
# API ID). Env:
#   NETLIFY_AUTH_TOKEN  a Netlify personal access token that can deploy
#                       these sites (required; the CLI reads it from the
#                       environment, never from an argument)
#   NETLIFY_CLI         the CLI to run (default `npx --yes netlify-cli@27.12.0`;
#                       tests point it at a stand-in)
#   DEPLOYS_FILE        when set, one `<site id>=<deploy id>` line per app is
#                       written to it: scripts/netlify-publish.sh's own
#                       argument format, so `cat` it into that script to
#                       publish what this uploaded
#   GITHUB_OUTPUT       when set (GitHub Actions), `<app>_url=<draft address>`
#                       is appended for each app, for the smoke checks
#
# Exits non-zero if any upload fails. Prints app names, site ids, deploy ids
# and draft addresses only: never the token or a response body.
set -euo pipefail

tag=${1:-}
sha=${2:-}
shift 2 || true
usage() { echo "usage: scripts/netlify-deploy.sh <tag> <40-hex commit> <app>=<site id>..." >&2; exit 2; }
[[ $tag =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && $sha =~ ^[0-9a-f]{40}$ ]] || usage
[ $# -gt 0 ] || usage
: "${NETLIFY_AUTH_TOKEN:?NETLIFY_AUTH_TOKEN is required}"
cli=${NETLIFY_CLI:-npx --yes netlify-cli@27.12.0}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

declare -A sites
for pair in "$@"; do
  app=${pair%%=*}
  site=${pair#*=}
  [ -n "$app" ] && [ -n "$site" ] && [ "$app" != "$pair" ] || usage
  [ -f "$app/netlify.toml" ] || { echo "::error::$app: no netlify.toml (not an app of this repository?)"; exit 1; }
  [ -f "$app/dist/version.json" ] || { echo "::error::$app: not built (no dist/version.json); run npm run build in $app first"; exit 1; }
  sites[$app]=$site
done

deploys_file=${DEPLOYS_FILE:-}
[ -z "$deploys_file" ] || : > "$deploys_file"
for pair in "$@"; do
  app=${pair%%=*}
  site=${sites[$app]}
  # shellcheck disable=SC2086 # $cli is a command line, split on purpose
  if ! (cd "$app" && $cli deploy --no-build --site "$site" --message "$tag ${sha:0:12}" --json > "$tmp/$app.json" 2> "$tmp/$app.err"); then
    echo "::error::$app: netlify deploy failed"
    # The CLI's stderr: progress and the failure, no token.
    sed 's/^/  /' "$tmp/$app.err" | tail -n 20
    exit 1
  fi
  id=$(jq -r '.deploy_id // empty' "$tmp/$app.json" 2>/dev/null || true)
  url=$(jq -r '.deploy_url // empty' "$tmp/$app.json" 2>/dev/null || true)
  if [ -z "$id" ] || [[ ! $url =~ ^https://[A-Za-z0-9.-]+$ ]]; then
    echo "::error::$app: netlify deploy gave no deploy id and draft address"
    exit 1
  fi
  echo "$app: draft $id of ${sha:0:12} at $url"
  [ -z "$deploys_file" ] || echo "$site=$id" >> "$deploys_file"
  [ -z "${GITHUB_OUTPUT:-}" ] || echo "${app}_url=$url" >> "$GITHUB_OUTPUT"
done
