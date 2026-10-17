#!/usr/bin/env bash
# How fast public.search is at 1k, 10k and 50k files (issue #397): a fresh
# Postgres 17 with every migration, synthetic vaults, timings as a member
# under RLS, and the plan for the largest. Not a test: it passes or fails
# nothing, it prints numbers. docs/ops/runbook.md, "Search benchmark".
#
#   ./supabase/bench/search.sh              slot 32
#   TEST_SLOT=40 ./supabase/bench/search.sh
#   BENCH_RUNS=50 ./supabase/bench/search.sh   timed calls per query and size
#   BENCH_KEEP=1 ./supabase/bench/search.sh    leave the container up to try a fix
#     (podman exec -it reliquary-search-bench-32 psql -U postgres -d bench)
set -euo pipefail
cd "$(dirname "$0")/.."

source ../scripts/lib/engine.sh
slot=${TEST_SLOT:-32}
name=reliquary-search-bench-$slot

cleanup() { "$engine" rm -f -v "$name" >/dev/null 2>&1 || true; }
[ -n "${BENCH_KEEP:-}" ] || trap cleanup EXIT
cleanup
source ../scripts/lib/containers.sh

# Data on tmpfs, as supabase/tests/run.sh: nothing needs to survive. Default
# settings otherwise (shared_buffers 128MB), near a small hosted instance.
"$engine" run -d --network none --tmpfs /var/lib/postgresql/data --name "$name" -e POSTGRES_PASSWORD=test \
  docker.io/library/postgres:17 >/dev/null
wait_until "$name" "Postgres to accept connections" "$engine" exec "$name" pg_isready -h 127.0.0.1 -U postgres -q
sleep 1

psql() { "$engine" exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql -c "create database bench"
cat tests/stub.sql migrations/*.sql tests/support.sql | psql -d bench >/dev/null
psql -d bench -v runs="${BENCH_RUNS:-30}" <bench/search.sql
