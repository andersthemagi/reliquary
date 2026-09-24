#!/usr/bin/env bash
# shellcheck disable=SC2329 # checks are called through check()
# Smoke checks after a deploy (.github/workflows/deploy.yml). Retries each
# check until it passes or the deadline runs out, so it can be started right
# after the Vercel Deploy Hooks fire.
#
#   WEB_URL=https://app.example.com MCP_URL=https://mcp.example.com \
#     scripts/deploy-check.sh
#
# Env:
#   WEB_URL, MCP_URL   origins of the two apps (required; a trailing /mcp or /
#                      on MCP_URL is dropped)
#   KEEPALIVE_TOKEN    sent as x-keepalive to /healthz?db=1 when set
#   CHECK_OAUTH=1      also check that the MCP 401 names resource_metadata
#                      (after the OAuth chunk ships)
#   DEPLOY_WAIT        seconds to keep retrying each check (default 300)
#
# Prints only check names and HTTP status codes: never bodies, headers or
# the token. Exits non-zero if any check never passes.
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

oauth_401() {
  local code
  code=$(fetch "$mcp/mcp" -X POST -H 'content-type: application/json' --data '{}')
  last="HTTP $code"
  [ "$code" = 401 ] && grep -qi '^www-authenticate:.*resource_metadata=' "$tmp/headers"
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
if [ "${CHECK_OAUTH:-}" = 1 ]; then
  check "mcp 401 names resource_metadata" oauth_401
else
  echo "SKIP  mcp 401 names resource_metadata (set CHECK_OAUTH=1 once MCP OAuth ships)"
fi
exit $status
