#!/usr/bin/env bash
# End-to-end test for the web UI: Postgres with every migration, the web
# server signed in as Ana, and node:test driving it over HTTP.
set -euo pipefail
cd "$(dirname "$0")"

# CONTAINER_ENGINE picks one explicitly (CI uses docker).
engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}
# TEST_SLOT lets parallel runs (e.g. separate worktrees) avoid each other.
slot=${TEST_SLOT:-0}
pg=reliquary-web-test-pg-$slot
srv=reliquary-web-test-server-$slot
# A second server as hosted: PUBLIC_URL=https://..., no public/ (the CDN's).
hosted=reliquary-web-test-hosted-$slot
hosted_url=https://app.reliquary.test
pgport=$((54332 + 10 * slot))
port=$((8791 + 10 * slot))
hosted_port=$((port + 1))
node=docker.io/library/node:22-slim

cleanup() { "$engine" rm -f "$pg" "$srv" "$hosted" >/dev/null 2>&1 || true; rm -f .login-test-$slot .login-test-hosted-$slot; }
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

# A fresh checkout (CI, a new worktree) has no node_modules yet.
[ -x node_modules/.bin/tsc ] || "$engine" run --rm --network host -v "$PWD":/app:Z -w /app "$node" npm ci --no-audit --no-fund
"$engine" run --rm --network none -v "$PWD":/app:Z -w /app "$node" npx tsc
"$engine" run -d --name "$srv" --network host -v "$PWD":/app:Z -w /app \
  -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e LOCAL_USER_ID=00000000-0000-0000-0000-00000000000a -e LOGIN_FILE=/app/.login-test-$slot \
  -e PORT=$port "$node" node dist/server.js >/dev/null
until curl -sf "http://127.0.0.1:$port/healthz" >/dev/null; do sleep 0.3; done
# The hosted instance runs a copy of dist/ in /app, so /app/public doesn't
# exist; node_modules is linked, not copied.
"$engine" run -d --name "$hosted" --network host -v "$PWD":/src:Z \
  -e DATABASE_URL="postgres://reliquary_web:test@127.0.0.1:$pgport/postgres" \
  -e LOCAL_USER_ID=00000000-0000-0000-0000-00000000000a -e LOGIN_FILE=/src/.login-test-hosted-$slot \
  -e PUBLIC_URL="$hosted_url" -e PORT=$hosted_port "$node" sh -c \
  'mkdir -p /app && cp -r /src/dist /src/package.json /app/ && ln -s /src/node_modules /app/node_modules && cd /app && exec node dist/server.js' >/dev/null
until curl -sf "http://127.0.0.1:$hosted_port/healthz" >/dev/null; do
  [ "$("$engine" inspect -f '{{.State.Running}}' "$hosted")" = true ] || { "$engine" logs "$hosted"; echo "hosted server exited"; exit 1; }
  sleep 0.3
done

env_args=()
while IFS= read -r line; do env_args+=(-e "$line"); done <<< "$seed"
"$engine" run --rm --network host -v "$PWD":/app:Z -w /app "${env_args[@]}" \
  -e WEB_URL="http://127.0.0.1:$port" -e LOGIN_FILE=/app/.login-test-$slot \
  -e WEB_HOSTED_URL="http://127.0.0.1:$hosted_port" -e WEB_HOSTED_PUBLIC_URL="$hosted_url" \
  -e HOSTED_LOGIN_FILE=/app/.login-test-hosted-$slot "$node" node --test --test-concurrency=1 test/*.test.mjs

echo "== server log (must contain no tokens, codes or file text)"
{ "$engine" logs "$srv"; "$engine" logs "$hosted"; } 2>&1 | grep -E 'rlq_|code=|EUR|script' && { echo "LEAK in server log"; exit 1; } || echo "clean"
