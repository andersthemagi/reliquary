#!/usr/bin/env bash
# Proves a backup restores: decrypts it with the age identity, loads it into a
# throwaway local Postgres (with the Supabase roles stubbed, like the test
# suites) and prints only row counts and the latest migration. The plaintext
# goes from age into the container's memory (tmpfs), never onto disk; nothing
# leaves this machine; the container is removed.
#
#   scripts/restore-test.sh [~/reliquary-backups/reliquary-<ts>.dump.age]
# Without an argument it tests the newest backup. The identity is read from
# RELIQUARY_BACKUP_IDENTITY (default ~/.config/reliquary/backup-identity.txt),
# a copy of the one in your password manager, never a file in this repo.
# A plain .dump from before encryption (issue #237) still restores when named.
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/engine.sh
source scripts/lib/containers.sh
dir=${RELIQUARY_BACKUP_DIR:-$HOME/reliquary-backups}
file=${1:-$(ls -1t "$dir"/reliquary-*.dump.age 2>/dev/null | head -1)}
[[ -n $file && -s $file ]] || { echo "No backup found (run scripts/backup.sh)."; exit 1; }
identity=${RELIQUARY_BACKUP_IDENTITY:-$HOME/.config/reliquary/backup-identity.txt}
if [[ $file == *.age && ! -s $identity ]]; then
  echo "No age identity at $identity: copy it there from your password manager, or set RELIQUARY_BACKUP_IDENTITY."; exit 1
fi

name=reliquary-restore-test
# -v: the postgres image keeps its data in an anonymous volume that a plain rm leaves behind.
cleanup() { "$engine" rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
# --shm-size: /dev/shm is where the decrypted dump sits while pg_restore reads it.
"$engine" run -d --name "$name" --network none --shm-size 2g -e POSTGRES_PASSWORD=test \
  "$PG_IMAGE" >/dev/null
until "$engine" exec "$name" pg_isready -U postgres -q; do sleep 0.5; done
sleep 1
psql() { "$engine" exec -i "$name" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

psql < supabase/tests/stub.sql >/dev/null
# The dump holds only Reliquary's schemas; the extension it uses is Supabase's.
psql -c "create extension if not exists vector with schema extensions" >/dev/null
# The dump creates schema public itself; a fresh cluster already has an empty one.
psql -c "drop schema public cascade" >/dev/null
if [[ $file == *.age ]]; then
  # The postgres image has no age; alpine installs it in a second (network for apk only).
  "$engine" run --rm -i --network host -v "$(realpath "$identity")":/identity:ro,Z \
    -v "$(realpath "$file")":/backup.dump.age:ro,Z docker.io/library/alpine:3.21 \
    sh -c 'apk add -q age && age -d -i /identity /backup.dump.age'
else
  cat "$file"
fi | "$engine" exec -i "$name" sh -c 'cat > /dev/shm/backup.dump'
# Schema first, then data with foreign-key triggers off: rows that point at
# auth.users (which the dump doesn't hold) would otherwise fail the restore.
restore() { "$engine" exec "$name" pg_restore -U postgres -d postgres --no-owner --no-privileges --exit-on-error "$@" /dev/shm/backup.dump; }
restore --schema-only
restore --data-only --disable-triggers
psql -At <<'SQL'
select 'vaults: '        || count(*) from public.vaults;
select 'files: '         || count(*) from public.files;
select 'file versions: ' || count(*) from public.file_versions;
select 'log entries: '   || count(*) from public.log;
select 'variables: '     || count(*) from public.variables;
select 'latest migration: ' || max(version) from supabase_migrations.schema_migrations;
SQL
echo "Restore OK: $(basename "$file")"
