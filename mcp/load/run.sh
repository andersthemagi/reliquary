#!/usr/bin/env bash
# Waiting in line under load, through the MCP server and a pooler, simulated
# (issue #486; the hosted run is #82). Not part of ./test.sh: it measures,
# it doesn't pass or fail. Results: docs/research/server-load.md,
# "Waiting in line through the MCP server, simulated".
#
# A throwaway Postgres with every migration, PgBouncer in transaction mode in
# front of it (standing in for Supabase's pooler, sized like Nano and Micro:
# 15 server connections, 200 clients), and LOAD_SERVERS MCP servers (standing
# in for warm function instances, DB_POOL_MAX 5 each) with production's rate
# limits and the per-vault budget as they ship. driver.mjs seeds the vaults
# and runs the agents over MCP's HTTP endpoint.
#
#   ./mcp/load/run.sh
#   LOAD_VAULTS=100,300,1000 LOAD_SECONDS=90 LOAD_HOSTILE_VAULTS=5 ./mcp/load/run.sh
#
# Settings (defaults in brackets): LOAD_VAULTS [100,300,1000] vaults per
# stage, each stage adding to the last; LOAD_SECONDS [90] per stage, of which
# LOAD_WARMUP [20] is left out of the numbers; LOAD_WORK_SECONDS [30] an
# honest agent spends on a step; LOAD_GAP [10] the vaults' minimum gap;
# LOAD_HOSTILE_VAULTS [5] vaults that also hold a hostile crowd of 5 people
# with 20 connections each; LOAD_SERVERS [4]; LOAD_POOL_SIZE [15];
# LOAD_MAX_CLIENTS [200]; LOAD_HERD [unset; 1 starts every agent in the same
# second instead of across the warm-up]; TEST_SLOT [0].
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=../../scripts/lib/engine.sh
source ../scripts/lib/engine.sh
slot=${TEST_SLOT:-0}
servers=${LOAD_SERVERS:-4}
pg=reliquary-load-pg-$slot
pb=reliquary-load-pgbouncer-$slot
drv=reliquary-load-driver-$slot
pgport=$((54330 + 10 * slot))
pbport=$((pgport + 1))
port0=$((8788 + 10 * slot))
node=docker.io/library/node:22-slim
# PgBouncer 1.26.1, pinned by digest.
pgbouncer=docker.io/edoburu/pgbouncer@sha256:b6a9f888f4a28a6c843528b8a8bafdb46ef1921efee8672138ad35731edc7da3
conf=""

srvs=()
for ((i = 0; i < servers; i++)); do srvs+=("reliquary-load-mcp-$slot-$i"); done
cleanup() { "$engine" rm -f -v "$pg" "$pb" "$drv" "${srvs[@]}" >/dev/null 2>&1 || true; [ -z "$conf" ] || rm -rf "$conf"; }
trap cleanup EXIT
cleanup
conf=$(mktemp -d)
# shellcheck source=../../scripts/lib/containers.sh
source ../scripts/lib/containers.sh

start_postgres "$pg" $pgport
psql() { "$engine" exec -i "$pg" psql -U postgres -p $pgport -v ON_ERROR_STOP=1 -q; }
../supabase/tests/schema.sh | psql >/dev/null
echo "alter role reliquary_mcp login password 'test';" | psql

# The pooler: the same limits Supabase's has on Nano and Micro. Transaction
# mode is why mcp/src/db.ts never names a prepared statement or sets a
# session setting.
cat > "$conf/pgbouncer.ini" <<EOF
[databases]
postgres = host=127.0.0.1 port=$pgport dbname=postgres
[pgbouncer]
listen_addr = 127.0.0.1
listen_port = $pbport
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
default_pool_size = ${LOAD_POOL_SIZE:-15}
max_client_conn = ${LOAD_MAX_CLIENTS:-200}
stats_users = reliquary_mcp
ignore_startup_parameters = extra_float_digits
EOF
echo '"reliquary_mcp" "test"' > "$conf/userlist.txt"
chmod 755 "$conf" && chmod 644 "$conf"/*
"$engine" run -d --name "$pb" --network host -v "$conf":/etc/pgbouncer:ro,z --entrypoint pgbouncer "$pgbouncer" /etc/pgbouncer/pgbouncer.ini >/dev/null
wait_until "$pb" "PgBouncer to accept connections on 127.0.0.1:$pbport" \
  "$engine" exec "$pg" pg_isready -h 127.0.0.1 -p "$pbport" -q

[ -x node_modules/.bin/tsc ] || "$engine" run --rm --network host -v "$PWD":/app:Z -w /app "$node" npm ci --no-audit --no-fund
"$engine" run --rm --network none -v "$PWD":/app:Z -v "$PWD/../version.txt":/version.txt:ro,z -w /app "$node" npm run -s build
content_keys="t1:$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
urls=()
for ((i = 0; i < servers; i++)); do
  p=$((port0 + i))
  "$engine" run -d --name "${srvs[$i]}" --network host -v "$PWD":/app:Z -w /app \
    -e DATABASE_URL="postgres://reliquary_mcp:test@127.0.0.1:$pbport/postgres" \
    -e MCP_RESOURCE="http://127.0.0.1:$p/mcp" -e CONTENT_KEYS="$content_keys" \
    -e PORT=$p "$node" node dist/server.js >/dev/null
  wait_until "${srvs[$i]}" "MCP server $i to answer /healthz" curl -sf "http://127.0.0.1:$p/healthz"
  urls+=("http://127.0.0.1:$p/mcp")
done

# CPU per container every 5 seconds while the driver runs: which of the
# database, the pooler or the servers a slowdown comes from.
stats=$conf/stats
( while sleep 5; do "$engine" stats --no-stream --format '{{.Name}} {{.CPUPerc}}' "$pg" "$pb" "${srvs[@]}" >> "$stats" 2>/dev/null || true; done ) &
sampler=$!
"$engine" run --rm --name "$drv" --network host -v "$PWD":/app:Z -w /app \
  -e MCP_URLS="$(IFS=,; echo "${urls[*]}")" \
  -e SUPER_URL="postgres://postgres:test@127.0.0.1:$pgport/postgres" \
  -e POOLER_URL="postgres://reliquary_mcp:test@127.0.0.1:$pbport/pgbouncer" \
  -e LOAD_VAULTS -e LOAD_SECONDS -e LOAD_WARMUP -e LOAD_WORK_SECONDS -e LOAD_GAP -e LOAD_HOSTILE_VAULTS -e LOAD_HERD \
  "$node" node load/driver.mjs

kill "$sampler" 2>/dev/null || true
echo "== CPU per container (100% is one core): median and highest of the samples"
sort -k1,1 "$stats" | awk '{ sub("%", "", $2); v[$1] = v[$1] " " $2 } END { for (c in v) print c v[c] }' |
  while read -r c rest; do
    read -ra xs <<< "$(tr ' ' '\n' <<< "$rest" | sort -n | tr '\n' ' ')"
    echo "  $c  median ${xs[$(( ${#xs[@]} / 2 ))]}%  highest ${xs[-1]}%"
  done
logs=$(for s in "${srvs[@]}"; do "$engine" logs "$s" 2>&1; done)
# The rate limits fail open when their count can't reach the database, so
# an overloaded database also lets callers past their limits.
echo "== rate limit checks that failed open: $(grep -c '^rate limit unavailable' <<< "$logs" || true)"
echo "== server logs: errors"
printf '%s\n' "$logs" | grep -E '^failure ref=' | grep -v '"status":405,"what":"mcp GET"' | sed -E 's/^failure ref=[^ ]+ //' | cut -c1-200 | sort | uniq -c | sort -rn | head -20 || true
