#!/usr/bin/env bash
# Off-site logical backup of the hosted database's Reliquary schemas (public,
# private, supabase_migrations), independent of Supabase's own daily backups.
# Writes ~/reliquary-backups/reliquary-<UTC timestamp>.dump (pg_dump custom
# format, mode 600) and keeps the newest 14.
#
# Variable values are in the dump only as ciphertext; the key (VARIABLES_KEY)
# lives in Netlify and your password manager, never here, so a stolen backup
# can't reveal secrets. File contents are plaintext: keep the folder private.
#
# Uses supabase/.db-password (never printed). Verify a backup restores with
# scripts/restore-test.sh <file>.
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/supabase-env.sh
source scripts/lib/engine.sh
dir=${RELIQUARY_BACKUP_DIR:-$HOME/reliquary-backups}
[[ -s supabase/.db-password ]] || { echo "Missing supabase/.db-password."; exit 1; }

mkdir -p "$dir" && chmod 700 "$dir"
out="reliquary-$(date -u +%Y%m%dT%H%M%SZ).dump"
( umask 077
  "$engine" run --rm --network host -v "$PWD/supabase":/s:ro,Z -v "$dir":/out:Z \
    -e REF="$ref" -e HOST="$host" -e OUT="$out" docker.io/library/postgres:17 bash -c '
      export PGPASSWORD=$(tr -d "[:space:]" < /s/.db-password)
      pg_dump "host=$HOST port=5432 dbname=postgres user=postgres.$REF sslmode=require" \
        --format=custom --no-owner --no-privileges \
        --schema=public --schema=private --schema=supabase_migrations \
        --file="/out/$OUT"' )
chmod 600 "$dir/$out"
echo "Wrote $dir/$out ($(du -h "$dir/$out" | cut -f1))"
# Keep the newest 14.
ls -1t "$dir"/reliquary-*.dump 2>/dev/null | tail -n +15 | xargs -r rm -f
