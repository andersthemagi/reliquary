#!/usr/bin/env bash
# Run the pilot schema's hostile tests in a throwaway Postgres container:
# the spike's gate and minting tests (regression), then the pilot's own.
set -euo pipefail
cd "$(dirname "$0")"

engine=$(command -v podman || command -v docker)
name=reliquary-pilot-test
image=docker.io/library/postgres:17

# -v: the postgres image keeps its data in an anonymous volume that a plain rm leaves behind.
cleanup() { "$engine" rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

"$engine" run -d --network none --name "$name" -e POSTGRES_PASSWORD=test "$image" >/dev/null
until "$engine" exec "$name" pg_isready -U postgres -q; do sleep 0.5; done
sleep 1

psql() { "$engine" exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql -c 'create database spike' -c 'create database pilot'

echo "== spike tests against the pilot schema"
cat schema.sql ../spikes/gate/tests.sql | psql -d spike | grep -E '^ (PASS|FAIL)' \
  | awk '{print $1}' | sort | uniq -c

echo "== pilot tests"
cat schema.sql tests.sql | psql -d pilot | grep -E '^ (PASS|FAIL)|FAIL'
