#!/usr/bin/env bash
# Run the gate spike in a throwaway Postgres container.
#   ./run.sh          hostile tests
#   ./run.sh bench    tests, then the latency benchmark
set -euo pipefail
cd "$(dirname "$0")"

source ../../scripts/lib/engine.sh
name=reliquary-gate-spike
image=docker.io/library/postgres:17

# -v: the postgres image keeps its data in an anonymous volume that a plain rm leaves behind.
cleanup() { "$engine" rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

"$engine" run -d --network none --name "$name" -e POSTGRES_PASSWORD=spike "$image" >/dev/null
until "$engine" exec "$name" pg_isready -U postgres -q; do sleep 0.5; done
sleep 1

psql() { "$engine" exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql -c 'create database tests' -c 'create database bench'

echo "== hostile tests"
cat schema.sql tests.sql | psql -d tests

if [[ "${1:-}" == bench ]]; then
  echo "== benchmark (seeding takes a minute)"
  cat schema.sql bench.sql | psql -d bench
fi
