#!/usr/bin/env bash
# Each *_test.sql gets a fresh database with the Supabase roles stubbed and
# every migration applied, then runs between harness.sql and report.sql.
# Exits non-zero on any failure.
set -euo pipefail
cd "$(dirname "$0")/.."

# CONTAINER_ENGINE picks one explicitly (CI uses docker).
engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}
# TEST_SLOT lets parallel runs (e.g. separate worktrees) avoid each other.
slot=${TEST_SLOT:-0}
name=reliquary-migrations-test-$slot

# -v: the postgres image keeps its data in an anonymous volume that a plain rm leaves behind.
cleanup() { "$engine" rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# Data on tmpfs: this suite builds 49 databases from every migration, 90 s of
# fsyncs on disk and 32 s in memory (900 MB at peak), and a tmpfs leaves no
# volume behind even when a cleanup is skipped. Nothing here needs durability.
"$engine" run -d --network none --tmpfs /var/lib/postgresql/data --name "$name" -e POSTGRES_PASSWORD=test \
  docker.io/library/postgres:17 >/dev/null
# Ask over TCP: the image's init-time server listens on the socket only, so a
# socket check can pass before the real server is up (a flaky race).
until "$engine" exec "$name" pg_isready -h 127.0.0.1 -U postgres -q 2>/dev/null; do sleep 0.5; done
sleep 1

psql() { "$engine" exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

status=0
for t in tests/*_test.sql; do
  db=$(basename "$t" .sql)
  echo "== $t"
  psql -c "create database $db"
  cat tests/stub.sql migrations/*.sql tests/support.sql | psql -d "$db"
  cat tests/harness.sql "$t" tests/report.sql | psql -d "$db" | grep -E '^ (PASS|FAIL)' || status=1
done
exit $status
