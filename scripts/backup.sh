#!/usr/bin/env bash
# Off-site logical backup of the hosted database's Reliquary schemas (public,
# private, supabase_migrations), independent of Supabase's own daily backups.
# Writes ~/reliquary-backups/reliquary-<UTC timestamp>.dump.age (pg_dump
# custom format, encrypted with age, mode 600) and keeps the newest 14.
#
# pg_dump is piped straight into age, so nothing unencrypted ever touches
# disk: a laptop is the weakest place the whole database lives (issue #237).
# The dump is sealed to the public key in scripts/backup.recipient; only the
# matching identity (your password manager, never this repo) opens it, with
# scripts/restore-test.sh. Lose the identity and every dump is unreadable.
# Variable values are, on top of that, ciphertext under VARIABLES_KEY.
#
# Uses supabase/.db-password (never printed).
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/supabase-env.sh
source scripts/lib/engine.sh
dir=${RELIQUARY_BACKUP_DIR:-$HOME/reliquary-backups}
[[ -s supabase/.db-password ]] || { echo "Missing supabase/.db-password."; exit 1; }
recipient=$(grep -m1 '^age1' scripts/backup.recipient 2>/dev/null || true)
[[ -n $recipient ]] || { echo "scripts/backup.recipient has no age public key (a line starting age1). Make one with age-keygen; keep the identity it prints in your password manager."; exit 1; }

mkdir -p "$dir" && chmod 700 "$dir"
out="reliquary-$(date -u +%Y%m%dT%H%M%SZ).dump.age"
# No image ships both pg_dump and age; alpine installs them in a second.
( umask 077
  "$engine" run --rm --network host -v "$PWD/supabase":/s:ro,Z -v "$dir":/out:Z \
    -e REF="$ref" -e HOST="$host" -e OUT="$out" -e RECIPIENT="$recipient" \
    docker.io/library/alpine:3.21 sh -c '
      apk add -q age postgresql17-client
      export PGPASSWORD=$(tr -d "[:space:]" < /s/.db-password)
      pg_dump "host=$HOST port=5432 dbname=postgres user=postgres.$REF sslmode=require" \
        --format=custom --no-owner --no-privileges \
        --schema=public --schema=private --schema=supabase_migrations \
        | age -r "$RECIPIENT" -o "/out/$OUT"' )
chmod 600 "$dir/$out"
echo "Wrote $dir/$out ($(du -h "$dir/$out" | cut -f1))"
# Keep the newest 14.
ls -1t "$dir"/reliquary-*.dump.age 2>/dev/null | tail -n +15 | xargs -r rm -f
