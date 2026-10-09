#!/usr/bin/env bash
# End-to-end test for the CLI: Postgres with every migration, the web app
# (authorization server and env API, with a VARIABLES_KEY made for this run,
# signed in as Cara), the MCP server (to show a CLI token is useless there),
# and node:test driving the built CLI as a person would, in a container
# with git. Afterwards no value, token or code may be in either server's log.
#
# The web app and the MCP server are built in their own containers from
# read-only views of web/ and mcp/, into cli/.test-<slot>/, so this never
# races web/test.sh or mcp/test.sh over their dist/ or node_modules.
set -euo pipefail
cd "$(dirname "$0")"

# CONTAINER_ENGINE picks one explicitly (CI uses docker).
engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}
# TEST_SLOT lets parallel runs (e.g. separate worktrees) avoid each other.
slot=${TEST_SLOT:-0}
pg=reliquary-cli-test-pg-$slot
web=reliquary-cli-test-web-$slot
mcp=reliquary-cli-test-mcp-$slot
pgport=$((54334 + 10 * slot))
webport=$((8796 + 10 * slot))
mcpport=$((webport + 1))
node=docker.io/library/node:22-slim
# The test runner needs git (env pull asks git whether a file is ignored).
node_git=docker.io/library/node:22
work=.test-$slot
cara=00000000-0000-0000-0000-0000000000c1

cleanup() {
  # -v: the postgres image keeps its data in an anonymous volume that a plain rm leaves behind.
  "$engine" rm -f -v "$pg" "$web" "$mcp" >/dev/null 2>&1 || true
  # Files the containers wrote may be root's (docker): remove them from one.
  rm -rf "$work" 2>/dev/null || "$engine" run --rm -v "$PWD":/cli:z "$node" rm -rf "/cli/$work"
}
trap cleanup EXIT
cleanup
mkdir -p "$work/state"
source ../scripts/lib/containers.sh

# Data on tmpfs: nothing in a test needs it to survive, and a tmpfs leaves no
# volume behind even when a cleanup is skipped.
"$engine" run -d --name "$pg" --network host --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=test \
  docker.io/library/postgres:17 -c listen_addresses=127.0.0.1 -c port=$pgport >/dev/null
# Ask over TCP: the image's init-time server listens on the socket only, so a
# socket check can pass before the real server is up (a flaky race).
wait_until "$pg" "Postgres to accept connections on 127.0.0.1:$pgport" "$engine" exec "$pg" pg_isready -h 127.0.0.1 -U postgres -p $pgport -q
sleep 1
psql() { "$engine" exec -i "$pg" psql -U postgres -p $pgport -v ON_ERROR_STOP=1 -q "$@"; }
cat ../supabase/tests/stub.sql ../supabase/migrations/*.sql ../supabase/tests/support.sql | psql >/dev/null
# Many test files, the same few people: room past Free's limits (plans are
# tested with plans of their own: web/test/plans.test.mjs).
echo "select test_support.roomy_free();" | psql >/dev/null
echo "alter role reliquary_web login password 'test';" | psql
echo "alter role reliquary_mcp login password 'test';" | psql

# Build the web app and the MCP server from read-only copies. node_modules
# is linked from the source when it's there (it resolves inside containers
# that mount the source at /src), else installed into the copy.
build() { # name, source dir
  mkdir -p "$work/$1"
  "$engine" run --rm --network host -v "$PWD/$2":/src:ro,z -v "$PWD/$work/$1":/app:z "$node" sh -c \
    'cd /src && cp -r src package.json package-lock.json tsconfig.json /app/ && { [ ! -d public ] || cp -r public /app/; } && cd /app &&
     if [ -x /src/node_modules/.bin/tsc ]; then ln -s /src/node_modules node_modules; else npm ci --no-audit --no-fund --silent; fi &&
     npx tsc'
}
build web ../web
build mcp ../mcp
# The CLI itself. A fresh checkout (CI, a new worktree) has no node_modules yet.
[ -x node_modules/.bin/tsc ] || "$engine" run --rm --network host -v "$PWD":/app:Z -w /app "$node" npm ci --no-audit --no-fund
"$engine" run --rm --network none -v "$PWD":/app:Z -w /app "$node" npx tsc

# A key for this run only, never printed.
key=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')

# No PUBLIC_URL: the issuer is http://127.0.0.1:<webport>, so the CLI's
# client id is <issuer>/cli/oauth-client.json and its resource <issuer>/api/env.
"$engine" run -d --name "$web" --network host -v "$PWD/../web":/src:ro,z -v "$PWD/$work":/work:z -w /work/web \
  -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e LOCAL_USER_ID=$cara -e LOGIN_FILE=/work/state/login -e HOST=127.0.0.1 -e PORT=$webport \
  -e MCP_RESOURCE="http://127.0.0.1:$mcpport/mcp" -e VARIABLES_KEY="$key" "$node" node dist/server.js >/dev/null
"$engine" run -d --name "$mcp" --network host -v "$PWD/../mcp":/src:ro,z -v "$PWD/$work":/work:z -w /work/mcp \
  -e DATABASE_URL="postgres://reliquary_mcp:test@127.0.0.1:$pgport/postgres" \
  -e MCP_RESOURCE="http://127.0.0.1:$mcpport/mcp" -e AUTH_ISSUER="http://127.0.0.1:$webport" \
  -e PORT=$mcpport "$node" node dist/server.js >/dev/null
for c in "$web:$webport" "$mcp:$mcpport"; do
  wait_until "${c%%:*}" "${c%%:*} to answer /healthz" curl -sf "http://127.0.0.1:${c##*:}/healthz"
done

# The tests record every value, token and code they see in state/secrets.
"$engine" run --rm --network host -v "$PWD":/cli:Z -v "$PWD/../web":/src:ro,z -v "$PWD/$work":/work:z -w /cli \
  -e WEB_URL="http://127.0.0.1:$webport" -e MCP_URL="http://127.0.0.1:$mcpport/mcp" \
  -e PG_URL="postgres://postgres:test@127.0.0.1:$pgport/postgres" \
  -e WEB_DB_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e WEB_BUILD=/work/web -e LOGIN_FILE=/work/state/login -e SECRETS_FILE=/work/state/secrets \
  -e CARA=$cara -e VARIABLES_KEY="$key" \
  "$node_git" node --test --test-concurrency=1 test/*.test.mjs

echo "== server logs (must contain no value, token, code or the key)"
{ "$engine" logs "$web"; "$engine" logs "$mcp"; } > "$work/logs" 2>&1
[ -s "$work/state/secrets" ] || { echo "the tests recorded no secrets to look for"; exit 1; }
leak=0
grep -E 'SEKRIT|PUSHVAL|rl[qecr]_[0-9a-f]' "$work/logs" && leak=1
grep -F -f "$work/state/secrets" "$work/logs" && leak=1
grep -qF "$key" "$work/logs" && { echo "(the key)"; leak=1; }
[ $leak = 0 ] || { echo "LEAK in a server log"; exit 1; }
echo "clean"
