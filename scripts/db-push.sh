#!/usr/bin/env bash
# Applies supabase/migrations to the hosted project from this machine, the
# same way deploy.yml does in CI (supabase db push), through the session
# pooler. The database password is read from supabase/.db-password (mode 600,
# gitignored) and never printed.
#
#   scripts/db-push.sh            dry run: list what would be applied
#   scripts/db-push.sh --apply    apply
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/supabase-env.sh
pwfile=supabase/.db-password
source scripts/lib/engine.sh

[[ -s $pwfile ]] || { echo "Missing $pwfile (the project's database password, mode 600)."; exit 1; }
[[ $(stat -c %a "$pwfile") == 600 ]] || { echo "$pwfile must be mode 600."; exit 1; }

mode=(--dry-run)
[[ ${1:-} == --apply ]] && mode=(--yes)

# The URL is built inside the container from the password file, so it never
# appears in this machine's process list or in the output.
"$engine" run --rm --network host -v "$PWD":/app:Z -w /app \
  -e REF="$ref" -e HOST="$host" docker.io/library/node:22-slim bash -c '
    set -euo pipefail
    pw=$(node -e "process.stdout.write(encodeURIComponent(require(\"fs\").readFileSync(\"supabase/.db-password\",\"utf8\").trim()))")
    npx -y supabase@2.117.0 db push --db-url "postgresql://postgres.$REF:$pw@$HOST:5432/postgres" '"${mode[*]}"' 2>&1 \
      | sed -e "s#$pw#***#g"
  '
