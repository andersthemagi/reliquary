#!/usr/bin/env bash
# shellcheck disable=SC2329 # checks are called through check()
# Smoke checks after a deploy (.github/workflows/deploy.yml). Retries each
# check until it passes or the deadline runs out, so it can be started right
# after a deploy is published.
#
#   WEB_URL=https://app.example.com MCP_URL=https://mcp.example.com \
#     scripts/deploy-check.sh
#
# Env:
#   WEB_URL, MCP_URL   origins of the two apps (required; a trailing /mcp or /
#                      on MCP_URL is dropped)
#   KEEPALIVE_TOKEN    sent as x-keepalive to /healthz?db=1 and ?embed=1 when set
#   DEPLOY_WAIT        seconds to keep retrying each check (default 300)
#   EMBED_WAIT         seconds to retry the search-by-meaning probe (default 60)
#   EXPECT_VERSION     the release deployed (e.g. 0.2.0): both apps' /version
#                      must answer it (needs jq)
#   EXPECT_COMMIT      its commit: /version's commit must be it, or "unknown"
#                      (a build that wasn't told its commit)
#
# Prints only check names, HTTP status codes, /version's fields and the
# embed probe's answer (words the server wrote, never a secret): no other
# bodies, headers or the token. Exits non-zero if any check never passes.
# Search by meaning only warns (a GitHub warning in Actions): search still
# answers by words without it, and an outage of the function shouldn't stop
# a release, but a secret set in one place only must not go unnoticed.
set -euo pipefail

: "${WEB_URL:?WEB_URL is required}"
: "${MCP_URL:?MCP_URL is required}"
web=${WEB_URL%/}
mcp=${MCP_URL%/}
mcp=${mcp%/mcp}
wait_s=${DEPLOY_WAIT:-300}
token=${KEEPALIVE_TOKEN:-}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# fetch <url> [curl args...]: status code on stdout, body and headers in $tmp.
fetch() {
  local url=$1
  shift
  curl -sS -o "$tmp/body" -D "$tmp/headers" -w '%{http_code}' --max-time 20 "$@" "$url" 2>/dev/null || echo 000
}

healthz() { # <url> [curl args...]
  local code
  code=$(fetch "$@")
  last="HTTP $code"
  [ "$code" = 200 ] && [ "$(cat "$tmp/body")" = ok ]
}

keepalive() {
  if [ -n "$token" ]; then
    # The header comes from stdin, so the token is not in the process list.
    healthz "$mcp/healthz?db=1" -H @- <<< "x-keepalive: $token"
  else
    healthz "$mcp/healthz?db=1"
  fi
}

embed_probe() {
  local code
  if [ -n "$token" ]; then
    code=$(fetch "$mcp/healthz?embed=1" -H @- <<< "x-keepalive: $token")
  else
    code=$(fetch "$mcp/healthz?embed=1")
  fi
  embed_state=$(head -c 200 "$tmp/body" | tr -d '\r\n')
  last="HTTP $code: $embed_state"
  [ "$code" = 200 ]
}

oauth_401() {
  local code
  code=$(fetch "$mcp/mcp" -X POST -H 'content-type: application/json' --data '{}')
  last="HTTP $code"
  [ "$code" = 401 ] && grep -qi '^www-authenticate:.*resource_metadata=' "$tmp/headers"
}

# version <origin>: /version names the release (and commit) just deployed.
version() {
  local code v c
  code=$(fetch "$1/version")
  v=$(jq -r '.version // empty' "$tmp/body" 2>/dev/null || true)
  c=$(jq -r '.commit // empty' "$tmp/body" 2>/dev/null || true)
  last="HTTP $code, version ${v:-none}, commit ${c:-none}"
  [ "$code" = 200 ] && [ "$v" = "$EXPECT_VERSION" ] &&
    { [ -z "${EXPECT_COMMIT:-}" ] || [ "$c" = "$EXPECT_COMMIT" ] || [ "$c" = unknown ]; }
}

status=0
check() { # <name> <function> [args...]
  local name=$1 deadline=$((SECONDS + wait_s)) last=""
  shift
  until "$@"; do
    if [ $SECONDS -ge $deadline ]; then
      echo "FAIL  $name ($last after ${wait_s}s)"
      status=1
      return
    fi
    sleep 5
  done
  echo "PASS  $name"
}

check "web /healthz" healthz "$web/healthz"
check "mcp /healthz" healthz "$mcp/healthz"
check "mcp /healthz?db=1" keepalive
if [ -n "${EXPECT_VERSION:-}" ]; then
  check "web /version is $EXPECT_VERSION" version "$web"
  check "mcp /version is $EXPECT_VERSION" version "$mcp"
else
  echo "SKIP  /version (set EXPECT_VERSION to the release deployed)"
fi
check "mcp 401 names resource_metadata" oauth_401

# Search by meaning: a minute of retries (the function's first call loads
# the model), then a warning, never a failure.
embed_state=""
deadline=$((SECONDS + ${EMBED_WAIT:-60}))
until embed_probe; do
  if [ $SECONDS -ge $deadline ]; then
    echo "WARN  mcp search by meaning ($last)"
    [ -z "${GITHUB_ACTIONS:-}" ] || echo "::warning title=Search by meaning is unavailable::$last (docs/ops/runbook.md, \"Search by meaning\")"
    exit $status
  fi
  sleep 5
done
echo "PASS  mcp search by meaning ($embed_state)"
exit $status
