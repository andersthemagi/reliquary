#!/usr/bin/env bash
# The regression suite: every test in the repo, in one command. Run it before
# committing; CI runs it on every push and pull request.
#
#   ./test.sh              all suites, in parallel
#   ./test.sh sql web      only these (sql, mcp, web, cli)
#   TEST_SLOT=5 ./test.sh  suites use slots 5, 6, 7 and 8 (default 0 to 3)
#
# Each suite gets its own TEST_SLOT, so containers and ports never collide,
# and its own log. Failing suites print their full log; passing ones print a
# one-line count. Exits non-zero if the registry check or any suite fails.
set -uo pipefail
cd "$(dirname "$0")"

base=${TEST_SLOT:-0}
suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=(sql mcp web cli)

declare -A cmd=([sql]=./supabase/tests/run.sh [mcp]=./mcp/test.sh [web]=./web/test.sh [cli]=./cli/test.sh)
declare -A slot=([sql]=$base [mcp]=$((base + 1)) [web]=$((base + 2)) [cli]=$((base + 3)))
for s in "${suites[@]}"; do
  [ -n "${cmd[$s]:-}" ] || { echo "unknown suite: $s (sql, mcp, web, cli)"; exit 2; }
done

logs=$(mktemp -d)
trap 'rm -rf "$logs"' EXIT

echo "== registry"
./scripts/check-registry.sh || { echo "registry check failed"; exit 1; }

# Pull images once, so parallel suites don't race to fetch the same layers.
engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}
# node:22 (it has git) runs the CLI's tests.
for img in docker.io/library/postgres:17 docker.io/library/node:22-slim docker.io/library/node:22; do
  "$engine" image inspect "$img" >/dev/null 2>&1 || "$engine" pull -q "$img" >/dev/null
done

start=$SECONDS
declare -A pid
for s in "${suites[@]}"; do
  echo "== $s: ${cmd[$s]} (TEST_SLOT=${slot[$s]})"
  ( t0=$SECONDS
    TEST_SLOT=${slot[$s]} "${cmd[$s]}" >"$logs/$s.log" 2>&1
    echo "$? $((SECONDS - t0))" >"$logs/$s.status" ) &
  pid[$s]=$!
done
for s in "${suites[@]}"; do wait "${pid[$s]}"; done

# Counts: SQL prints PASS/FAIL rows; node:test (TAP, no TTY) prints # pass/# fail.
count() {
  local log=$1 pass fail
  if grep -q '^# pass' "$log"; then
    pass=$(grep -h '^# pass' "$log" | awk '{s += $3} END {print s + 0}')
    fail=$(grep -h '^# fail' "$log" | awk '{s += $3} END {print s + 0}')
  else
    pass=$(grep -c '^ PASS' "$log"); fail=$(grep -c '^ FAIL' "$log")
  fi
  echo "$pass passed, $fail failed"
}

status=0
echo
echo "== summary ($((SECONDS - start))s)"
for s in "${suites[@]}"; do
  read -r code secs <"$logs/$s.status" || { code=1; secs=?; }
  if [ "$code" = 0 ]; then
    printf '  PASS  %-4s %s (%ss)\n' "$s" "$(count "$logs/$s.log")" "$secs"
  else
    printf '  FAIL  %-4s %s (%ss, exit %s)\n' "$s" "$(count "$logs/$s.log")" "$secs" "$code"
    status=1
  fi
done
for s in "${suites[@]}"; do
  read -r code _ <"$logs/$s.status" 2>/dev/null || code=1
  [ "$code" = 0 ] && continue
  echo
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::group::$s log"
  echo "== $s log"
  cat "$logs/$s.log"
  [ -n "${GITHUB_ACTIONS:-}" ] && echo "::endgroup::"
  grep -hE '^ FAIL|^not ok' "$logs/$s.log" | sed "s/^/  $s: /"
done
exit $status
