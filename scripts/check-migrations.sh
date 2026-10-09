#!/usr/bin/env bash
# Migrations are history: once one is on main it is never edited, deleted or
# renamed (fix forward with a new file), and a new one sorts after all of
# them. Supabase applies them in timestamp order, and where two files
# redefine a function the later one wins, so a stamp that sorts early
# changes behaviour on a database that already ran the later file.
#
#   scripts/check-migrations.sh [base]     # default base: origin/main
#
# Compares the commits since the merge base of <base> and HEAD and fails if
#   1. a migration that was already at the merge base is modified, deleted
#      or renamed;
#   2. a new migration's timestamp is not later than the newest on <base>;
#   3. a file in supabase/migrations is not named
#      <14 digits>_<snake_case>.sql.
# Only committed changes are checked, so commit first. Needs only bash and
# git. CI: the guard job in .github/workflows/test.yml.
set -euo pipefail
cd "$(dirname "$0")/.."

dir=supabase/migrations
base=${1:-origin/main}
if ! git rev-parse -q --verify "$base^{commit}" >/dev/null; then
  echo "check-migrations: base '$base' not found. Fetch it ('git fetch origin main') or pass a base." >&2
  exit 2
fi
mb=$(git merge-base "$base" HEAD) || { echo "check-migrations: no merge base with $base (a shallow clone? fetch the full history)" >&2; exit 2; }

problems=()

# 1. History. --no-renames so that a rename reads as a deletion plus an
# addition: the old name is gone either way.
while IFS=$'\t' read -r status path; do
  case $status in
    M) what="is edited" ;;
    D) what="is deleted or renamed" ;;
    *) what="changed type" ;;
  esac
  problems+=("$path $what, but it is already on $base. Shipped migrations are never touched: put it back with 'git checkout $base -- $path' and make the change as a new migration.")
done < <(git diff --no-renames --name-status --diff-filter=DMT "$mb" HEAD -- "$dir")

# 2. Order. Compared as text: the stamps are all 14 digits (checked in 3).
newest=$(git ls-tree --name-only "$base" "$dir/" | sed -E 's#.*/##; s#_.*##' | sort | tail -1)
added=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  added=$((added + 1))
  stamp=$(basename "$path"); stamp=${stamp%%_*}
  if [[ $stamp =~ ^[0-9]{14}$ && -n $newest && ! $stamp > $newest ]]; then
    problems+=("$path: its timestamp $stamp is not later than $newest, the newest migration on $base. A new migration has to sort last: rebase on $base, then 'git mv' it to a stamp after $newest (the current UTC time, from 'date -u +%Y%m%d%H%M%S', unless the head was stamped ahead of the clock; then the next second after $newest).")
  fi
done < <(git diff --no-renames --name-only --diff-filter=A "$mb" HEAD -- "$dir")

# 3. Names, for every file, so a stray one can't reach 'supabase db push'.
while IFS= read -r path; do
  name=$(basename "$path")
  [[ $name =~ ^[0-9]{14}_[a-z0-9]+(_[a-z0-9]+)*\.sql$ ]] ||
    problems+=("$path: a migration is named <14-digit UTC timestamp>_<snake_case>.sql, like 20261009153417_cas_deleted_files.sql (lowercase letters, digits and single underscores). Rename it with 'git mv'.")
done < <(git ls-tree --name-only HEAD "$dir/")

if [ ${#problems[@]} -eq 0 ]; then
  echo "check-migrations: ok, $added new migration(s) since $(git rev-parse --short "$mb"); newest on $base is ${newest:-none}"
  exit 0
fi

echo "check-migrations: FAIL, ${#problems[@]} problem(s) in $dir since $(git rev-parse --short "$mb") ($base):" >&2
printf '\n  %s\n' "${problems[@]}" >&2
exit 1
