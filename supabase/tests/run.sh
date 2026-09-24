#!/usr/bin/env bash
# Apply every migration to a throwaway Postgres (with the Supabase roles
# stubbed) and run the hostile tests. Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

engine=$(command -v podman || command -v docker)
name=reliquary-migrations-test

cleanup() { "$engine" rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

"$engine" run -d --network none --name "$name" -e POSTGRES_PASSWORD=test \
  docker.io/library/postgres:17 >/dev/null
until "$engine" exec "$name" pg_isready -U postgres -q; do sleep 0.5; done
sleep 1

psql() { "$engine" exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

cat tests/stub.sql migrations/*.sql | psql
for t in tests/*_test.sql; do
  echo "== $t"
  psql < "$t" | grep -E '^ (PASS|FAIL)'
done
