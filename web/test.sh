#!/usr/bin/env bash
# End-to-end test for the web UI: Postgres with every migration, the web
# server signed in as Ana, and node:test driving it over HTTP.
set -euo pipefail
cd "$(dirname "$0")"

engine=$(command -v podman || command -v docker)
# TEST_SLOT lets parallel runs (e.g. separate worktrees) avoid each other.
slot=${TEST_SLOT:-0}
pg=reliquary-web-test-pg-$slot
srv=reliquary-web-test-server-$slot
pgport=$((54332 + 10 * slot))
port=$((8791 + 10 * slot))
node=docker.io/library/node:22-slim

cleanup() { "$engine" rm -f "$pg" "$srv" >/dev/null 2>&1 || true; rm -f .login-test-$slot; }
trap cleanup EXIT
cleanup

"$engine" run -d --name "$pg" --network host -e POSTGRES_PASSWORD=test \
  docker.io/library/postgres:17 -c listen_addresses=127.0.0.1 -c port=$pgport >/dev/null
until "$engine" exec "$pg" pg_isready -U postgres -p $pgport -q 2>/dev/null; do sleep 0.5; done
sleep 1
psql() { "$engine" exec -i "$pg" psql -U postgres -p $pgport -v ON_ERROR_STOP=1 -q "$@"; }

cat ../supabase/tests/stub.sql ../supabase/migrations/*.sql | psql >/dev/null
echo "alter role reliquary_web login password 'test';" | psql
seed=$(psql -A -t < test/seed.sql | grep '=')

"$engine" run --rm --network none -v "$PWD":/app:Z -w /app "$node" npx tsc
"$engine" run -d --name "$srv" --network host -v "$PWD":/app:Z -w /app \
  -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e LOCAL_USER_ID=00000000-0000-0000-0000-00000000000a -e LOGIN_FILE=/app/.login-test-$slot \
  -e PORT=$port "$node" node dist/server.js >/dev/null
until curl -sf "http://127.0.0.1:$port/healthz" >/dev/null; do sleep 0.3; done

env_args=()
while IFS= read -r line; do env_args+=(-e "$line"); done <<< "$seed"
"$engine" run --rm --network host -v "$PWD":/app:Z -w /app "${env_args[@]}" \
  -e WEB_URL="http://127.0.0.1:$port" -e LOGIN_FILE=/app/.login-test-$slot "$node" node --test test/web.test.mjs

echo "== server log (must contain no tokens, codes or file text)"
"$engine" logs "$srv" 2>&1 | grep -E 'rlq_|code=|EUR|script' && { echo "LEAK in server log"; exit 1; } || echo "clean"
