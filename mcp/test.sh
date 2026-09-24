#!/usr/bin/env bash
# End-to-end test: Postgres with every migration, the MCP server, and the
# official MCP client, all in containers on the host network (127.0.0.1).
set -euo pipefail
cd "$(dirname "$0")"

engine=$(command -v podman || command -v docker)
# TEST_SLOT lets parallel runs (e.g. separate worktrees) avoid each other.
slot=${TEST_SLOT:-0}
pg=reliquary-mcp-test-pg-$slot
srv=reliquary-mcp-test-server-$slot
pgport=$((54330 + 10 * slot))
port=$((8788 + 10 * slot))
node=docker.io/library/node:22-slim

cleanup() { "$engine" rm -f "$pg" "$srv" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

"$engine" run -d --name "$pg" --network host -e POSTGRES_PASSWORD=test \
  docker.io/library/postgres:17 -c listen_addresses=127.0.0.1 -c port=$pgport >/dev/null
until "$engine" exec "$pg" pg_isready -U postgres -p $pgport -q 2>/dev/null; do sleep 0.5; done
sleep 1
psql() { "$engine" exec -i "$pg" psql -U postgres -p $pgport -v ON_ERROR_STOP=1 -q "$@"; }

cat ../supabase/tests/stub.sql ../supabase/migrations/*.sql | psql >/dev/null
echo "alter role reliquary_mcp login password 'test';" | psql
seed=$(psql -A -t < test/seed.sql | grep '=' )

"$engine" run --rm --network none -v "$PWD":/app:Z -w /app "$node" npx tsc
"$engine" run -d --name "$srv" --network host -v "$PWD":/app:Z -w /app \
  -e DATABASE_URL="postgres://reliquary_mcp:test@127.0.0.1:$pgport/postgres" \
  -e PORT=$port "$node" node dist/server.js >/dev/null
until curl -sf "http://127.0.0.1:$port/healthz" >/dev/null; do sleep 0.3; done

env_args=()
while IFS= read -r line; do env_args+=(-e "$line"); done <<< "$seed"
"$engine" run --rm --network host -v "$PWD":/app:Z -w /app "${env_args[@]}" \
  -e MCP_URL="http://127.0.0.1:$port/mcp" "$node" node --test --test-concurrency=1 test/*.test.mjs

echo "== server log (must contain no tokens or file text)"
"$engine" logs "$srv" 2>&1 | tee /dev/stderr | grep -E 'rlq_|800 EUR|Hermes|Falcon' && { echo "LEAK in server log"; exit 1; } || echo "clean"
