#!/usr/bin/env bash
# Tests for scripts/check-migrations.sh, against throwaway repositories:
# "origin/main" holds two shipped migrations, and a branch keeps or breaks
# the rules. Needs only bash and git; no containers. Run it by hand, or as
# CI's guard job does:
#
#   scripts/check-migrations.test.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
repo=$tmp/repo
# Nothing from the machine's git configuration (signing, hooks, templates).
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.test
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.test

fails=0
g() { git -C "$repo" "$@"; }
sql() { echo "select 1; -- $2" > "$repo/supabase/migrations/$1"; }
commit() { g add -A && g commit -q -m "$1"; }

# A repository whose main has shipped two migrations, checked out on a
# branch called work.
fresh() {
  rm -rf "$repo"
  mkdir -p "$repo/scripts" "$repo/supabase/migrations"
  cp "$here/check-migrations.sh" "$repo/scripts/"
  g init -q -b main
  sql 20260101000000_core.sql core
  sql 20260102000000_more.sql more
  commit "shipped"
  g update-ref refs/remotes/origin/main HEAD
  g switch -q -c work
}

# check <name> <wanted exit code> <text the output must contain>...
check() {
  local name=$1 want=$2 out code=0
  shift 2
  out=$(cd "$repo" && ./scripts/check-migrations.sh 2>&1) || code=$?
  local ok=1
  [ "$code" = "$want" ] || ok=0
  for text in "$@"; do grep -qF -- "$text" <<< "$out" || ok=0; done
  if [ $ok = 1 ]; then
    echo "  ok    $name"
  else
    echo "  FAIL  $name (exit $code, wanted $want; wanted the output to contain: $*)"
    printf '%s\n' "$out" | sed 's/^/        /'
    fails=$((fails + 1))
  fi
}

fresh
check "a branch that touches no migration passes" 0 "0 new migration(s)"

fresh
sql 20260103000000_third.sql third
commit "new migration"
check "a new migration later than main's newest passes" 0 "1 new migration(s)" "newest on origin/main is 20260102000000"

fresh
sql 20260103000000_third.sql third
commit "new migration"
sql 20260103000000_third.sql "third, edited"
commit "edit my own new migration"
check "a migration the branch added itself can still be edited" 0

fresh
sql 20260101000000_core.sql "edited"
commit "edit"
check "editing a migration that is on main fails and says how to restore it" 1 \
  "20260101000000_core.sql is edited" "git checkout origin/main -- supabase/migrations/20260101000000_core.sql" "new migration"

fresh
g rm -q supabase/migrations/20260101000000_core.sql
commit "delete"
check "deleting a migration that is on main fails" 1 "20260101000000_core.sql is deleted or renamed"

fresh
g mv supabase/migrations/20260102000000_more.sql supabase/migrations/20260102000000_much_more.sql
commit "rename"
check "renaming a migration that is on main fails" 1 "20260102000000_more.sql is deleted or renamed"

fresh
sql 20260101120000_early.sql early
commit "early"
check "a new migration that sorts before main's newest fails and names the newest" 1 \
  "its timestamp 20260101120000 is not later than 20260102000000" "git mv" "date -u +%Y%m%d%H%M%S"

fresh
sql 20260102000000_same_stamp.sql same
commit "same stamp"
check "a new migration with main's newest timestamp fails" 1 "not later than 20260102000000"

# One bad name each: the wrong number of digits, capitals, a hyphen or a
# space for the underscore, no description, a double underscore, another
# extension.
for bad in 2026010300000_short.sql 20260103000000_Capital.sql 20260103000000-dash.sql \
           "20260103000000_has space.sql" 20260103000000.sql 20260103000000_a__b.sql 20260103000000_note.txt; do
  fresh
  sql "$bad" bad
  commit "bad name"
  check "a file named '$bad' fails and says what a name looks like" 1 "supabase/migrations/$bad" "<14-digit UTC timestamp>_<snake_case>.sql"
done

# main moved on after the branch was cut: its new migration is not the
# branch deleting it.
fresh
g switch -q main
sql 20260105000000_landed_later.sql landed
commit "landed on main since"
g update-ref refs/remotes/origin/main HEAD
g switch -q work
sql 20260106000000_mine.sql mine
commit "mine, later than what landed"
check "a branch behind main is not told main's newer migrations were deleted" 0 "1 new migration(s)" "newest on origin/main is 20260105000000"

fresh
g switch -q main
sql 20260105000000_landed_later.sql landed
commit "landed on main since"
g update-ref refs/remotes/origin/main HEAD
g switch -q work
sql 20260104000000_mine.sql mine
commit "mine, but main got a later one first"
check "a new migration older than one that landed on main since the branch was cut fails" 1 \
  "20260104000000_mine.sql: its timestamp 20260104000000 is not later than 20260105000000"

fresh
code=0
out=$(cd "$repo" && ./scripts/check-migrations.sh no-such-ref 2>&1) || code=$?
if [ "$code" = 2 ] && grep -qF "git fetch origin main" <<< "$out"; then
  echo "  ok    a base that does not exist exits 2 and says how to fetch it"
else
  echo "  FAIL  a base that does not exist exits 2 and says how to fetch it (exit $code)"; echo "$out"; fails=$((fails + 1))
fi

if [ $fails = 0 ]; then
  echo "check-migrations.test: all passed"
else
  echo "check-migrations.test: $fails failed"
  exit 1
fi
