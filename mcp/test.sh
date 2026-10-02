#!/usr/bin/env bash
# End-to-end test: Postgres with every migration, the MCP server, and the
# official MCP client, all in containers on the host network (127.0.0.1).
# For OAuth (test/oauth.test.mjs) the web app runs too, as the authorization
# server. A second MCP server has small rate limits and trusts x-real-ip
# (test/rate_limits.test.mjs); the others multiply every limit by 1000
# (RATE_LIMIT_SCALE), so they count as in production but never reach one.
#
#   MCP_TESTS="test/token_load.test.mjs" ./mcp/test.sh   only these test files
#   TOKEN_LOAD_MEASURE_ONLY=1                            print token load, don't fail on budgets
set -euo pipefail
cd "$(dirname "$0")"

# CONTAINER_ENGINE picks one explicitly (CI uses docker).
engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}
# TEST_SLOT lets parallel runs (e.g. separate worktrees) avoid each other.
slot=${TEST_SLOT:-0}
pg=reliquary-mcp-test-pg-$slot
srv=reliquary-mcp-test-server-$slot
web=reliquary-mcp-test-web-$slot
rl=reliquary-mcp-test-rl-$slot
pgport=$((54330 + 10 * slot))
port=$((8788 + 10 * slot))
webport=$((port + 1))
# Off the 87xx range, where every last digit is taken by some suite and slot.
rlport=$((18788 + 10 * slot))
node=docker.io/library/node:22-slim

cleanup() { "$engine" rm -f "$pg" "$srv" "$web" "$rl" >/dev/null 2>&1 || true; rm -f ".login-oauth-$slot" ".error-refs-$slot"; }
trap cleanup EXIT
cleanup

"$engine" run -d --name "$pg" --network host -e POSTGRES_PASSWORD=test \
  docker.io/library/postgres:17 -c listen_addresses=127.0.0.1 -c port=$pgport >/dev/null
# Ask over TCP: the image's init-time server listens on the socket only, so a
# socket check can pass before the real server is up (a flaky race).
until "$engine" exec "$pg" pg_isready -h 127.0.0.1 -U postgres -p $pgport -q 2>/dev/null; do sleep 0.5; done
sleep 1
psql() { "$engine" exec -i "$pg" psql -U postgres -p $pgport -v ON_ERROR_STOP=1 -q "$@"; }

cat ../supabase/tests/stub.sql ../supabase/migrations/*.sql ../supabase/tests/support.sql | psql >/dev/null
echo "alter role reliquary_mcp login password 'test';" | psql
echo "alter role reliquary_web login password 'test';" | psql
seed=$(psql -A -t < test/seed.sql | grep '=' )

# Link credential encryption (secrets.ts: only the web container holds this)
# and the shared secret authenticating mcp/'s own calls to its internal
# link-call endpoint (linkproxy.ts). Test files seal a link's credential
# with the same key directly (LINK_TEST_KEY), matching web/test.sh's own
# session-secret pattern.
link_test_key=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')
link_proxy_secret=$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')

# The web app as the OAuth authorization server, signed in as Ben. It is
# built inside its own container from a read-only view of web/, so it never
# races web/test.sh over web/dist or web/node_modules. CIMD_ALLOW_LOOPBACK
# lets the test serve client metadata on loopback. `npm run compile` is the
# build without the docs (gen-docs reads the whole checkout; OAuth needs none).
"$engine" run -d --name "$web" --network host -v "$PWD/../web":/src:ro,z -v "$PWD":/mcp:z -v "$PWD/../version.txt":/version.txt:ro,z \
  -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e LOCAL_USER_ID=00000000-0000-0000-0000-00000000000b -e LOGIN_FILE="/mcp/.login-oauth-$slot" \
  -e MCP_RESOURCE="http://127.0.0.1:$port/mcp" -e CIMD_ALLOW_LOOPBACK=1 -e LINK_DISCOVERY_ALLOW_LOOPBACK=1 -e RATE_LIMIT_SCALE=1000 -e PORT=$webport \
  -e VARIABLES_KEY="$link_test_key" -e LINK_PROXY_SECRET="$link_proxy_secret" "$node" sh -c \
  'mkdir -p /app && cd /src && cp -r src public package.json package-lock.json tsconfig.json stamp-version.mjs /app/ && cd /app &&
   if [ -x /src/node_modules/.bin/tsc ]; then ln -s /src/node_modules node_modules; else npm ci --no-audit --no-fund --silent; fi &&
   npm run -s compile && exec node dist/server.js' >/dev/null

# A fresh checkout (CI, a new worktree) has no node_modules yet.
[ -x node_modules/.bin/tsc ] || "$engine" run --rm --network host -v "$PWD":/app:Z -w /app "$node" npm ci --no-audit --no-fund
# npm run build: tsc, then stamp-version.mjs writes dist/version.json from
# ../version.txt (mounted where the build looks for it).
"$engine" run --rm --network none -v "$PWD":/app:Z -v "$PWD/../version.txt":/version.txt:ro,z -w /app "$node" npm run -s build
"$engine" run -d --name "$srv" --network host -v "$PWD":/app:Z -w /app \
  -e DATABASE_URL="postgres://reliquary_mcp:test@127.0.0.1:$pgport/postgres" \
  -e MCP_RESOURCE="http://127.0.0.1:$port/mcp" -e AUTH_ISSUER="http://127.0.0.1:$webport" \
  -e LINK_PROXY_SECRET="$link_proxy_secret" \
  -e RATE_LIMIT_SCALE=1000 -e PORT=$port "$node" node dist/server.js >/dev/null
until curl -sf "http://127.0.0.1:$port/healthz" >/dev/null; do sleep 0.3; done
# Tool calls: 3 per 2-second window (so a test can wait one out) and 5 a
# day per token, 1 of them a thread write; 3 401s a minute per address.
"$engine" run -d --name "$rl" --network host -v "$PWD":/app:Z -w /app \
  -e DATABASE_URL="postgres://reliquary_mcp:test@127.0.0.1:$pgport/postgres" \
  -e MCP_RESOURCE="http://127.0.0.1:$rlport/mcp" -e AUTH_ISSUER="http://127.0.0.1:$webport" \
  -e TRUST_PROXY_IP=1 -e RATE_LIMITS="mcp_token_minute=3/2,mcp_token_day=5/86400,mcp_unauth_ip=3/60,mcp_thread_post_minute=1/2" \
  -e PORT=$rlport "$node" node dist/server.js >/dev/null
until curl -sf "http://127.0.0.1:$rlport/healthz" >/dev/null; do
  [ "$("$engine" inspect -f '{{.State.Running}}' "$rl")" = true ] || { "$engine" logs "$rl"; echo "rate-limit server exited"; exit 1; }
  sleep 0.3
done
until curl -sf "http://127.0.0.1:$webport/healthz" >/dev/null; do
  [ "$("$engine" inspect -f '{{.State.Running}}' "$web")" = true ] || { "$engine" logs "$web"; echo "web (authorization server) exited"; exit 1; }
  sleep 0.5
done

env_args=()
while IFS= read -r line; do env_args+=(-e "$line"); done <<< "$seed"
# docs/ read-only, for test/parity.test.mjs (every tool is in docs/parity.md).
"$engine" run --rm --network host -v "$PWD":/app:Z -v "$PWD/../docs":/docs:ro,z -w /app "${env_args[@]}" \
  -e MCP_URL="http://127.0.0.1:$port/mcp" -e TEST_DATABASE_URL="postgres://reliquary_mcp:test@127.0.0.1:$pgport/postgres" \
  -e MCP_ERROR_REFS_FILE="/app/.error-refs-$slot" -e MCP_RL_URL="http://127.0.0.1:$rlport/mcp" -e TEST_SUPER_URL="postgres://postgres:test@127.0.0.1:$pgport/postgres" \
  -e UPDATE_SNAPSHOTS="${UPDATE_SNAPSHOTS:-}" -e PARITY_FILE=/docs/parity.md \
  -e WEB_AS_URL="http://127.0.0.1:$webport" -e WEB_AS_LOGIN_FILE="/app/.login-oauth-$slot" \
  -e LINK_TEST_KEY="$link_test_key" \
  -e TOKEN_LOAD_MEASURE_ONLY="${TOKEN_LOAD_MEASURE_ONLY:-}" \
  -e EXPECT_VERSION="$(tr -d '[:space:]' < ../version.txt)" \
  "$node" node --test --test-concurrency=1 ${MCP_TESTS:-test/*.test.mjs}

echo "== server log (must contain no tokens or file text)"
# Not `tee /dev/stderr`: when stderr is a file (./test.sh logs) that reopens
# and truncates it, losing the test output.
server_log=$("$engine" logs "$srv" 2>&1; "$engine" logs "$rl" 2>&1)
web_log=$("$engine" logs "$web" 2>&1)
printf '%s\n' "$server_log" >&2
grep -E 'rlq_|800 EUR|Hermes|Falcon|CIPHERTEXT-MARKER|SEKRIT' <<< "$server_log" && { echo "LEAK in server log"; exit 1; } || echo "clean"
# LINKVAL- is link_proxy.test.mjs's real (working) credential marker; the
# web app is the one that ever holds it in plaintext (linkcall.ts).
grep -E 'LINKVAL-' <<< "$web_log" && { echo "LEAK: a link credential in the web app's log"; exit 1; } || echo "clean (link credential)"
# The addresses test/rate_limits.test.mjs sends from.
grep -E '198\.51\.100\.|2001:db8' <<< "$server_log" && { echo "LEAK: a client address in the server log"; exit 1; } || echo "clean (addresses)"
# OAuth: no personal token, access (MCP or CLI) or refresh token, or code in either app's log.
grep -E 'rl[qorce]_[0-9a-f]' <<< "$server_log
$web_log" && { echo "LEAK: a token or code in a server log"; exit 1; } || echo "clean (oauth)"
# Every reference test/errors.test.mjs saw is in the server log, with its detail.
if [ -z "${MCP_TESTS:-}" ] || [[ "$MCP_TESTS" == *errors* ]]; then
  echo "== error references"
  [ -s ".error-refs-$slot" ] || { echo "test/errors.test.mjs recorded no references"; exit 1; }
  while read -r ref; do
    grep -q "^failure ref=$ref {" <<< "$server_log" || { echo "reference $ref is not in the server log"; exit 1; }
  done < ".error-refs-$slot"
  echo "found $(wc -l < ".error-refs-$slot") references"
fi
