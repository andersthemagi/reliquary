#!/usr/bin/env bash
# Proves a backup restores: loads it into a throwaway local Postgres (with the
# Supabase roles stubbed, like the test suites) and prints only row counts and
# the latest migration. Nothing leaves this machine; the container is removed.
#
#   scripts/restore-test.sh [~/reliquary-backups/reliquary-<ts>.dump]
# Without an argument it tests the newest backup.
set -euo pipefail
cd "$(dirname "$0")/.."

engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}
dir=${RELIQUARY_BACKUP_DIR:-$HOME/reliquary-backups}
file=${1:-$(ls -1t "$dir"/reliquary-*.dump 2>/dev/null | head -1)}
[[ -n $file && -s $file ]] || { echo "No backup found (run scripts/backup.sh)."; exit 1; }

name=reliquary-restore-test
cleanup() { "$engine" rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
"$engine" run -d --name "$name" --network none -e POSTGRES_PASSWORD=test \
  -v "$(realpath "$file")":/backup.dump:ro,Z docker.io/library/postgres:17 >/dev/null
until "$engine" exec "$name" pg_isready -U postgres -q; do sleep 0.5; done
sleep 1
psql() { "$engine" exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql < supabase/tests/stub.sql >/dev/null
# The dump creates schema public itself; a fresh cluster already has an empty one.
psql -c "drop schema public cascade" >/dev/null
"$engine" exec "$name" pg_restore -U postgres -d postgres --no-owner --no-privileges /backup.dump
psql -At <<'SQL'
select 'vaults: '        || count(*) from public.vaults;
select 'files: '         || count(*) from public.files;
select 'file versions: ' || count(*) from public.file_versions;
select 'log entries: '   || count(*) from public.log;
select 'variables: '     || count(*) from public.variables;
select 'latest migration: ' || max(version) from supabase_migrations.schema_migrations;
SQL
echo "Restore OK: $(basename "$file")"
