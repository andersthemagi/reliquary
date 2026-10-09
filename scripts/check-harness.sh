#!/usr/bin/env bash
# Checks scripts/lib/containers.sh: a service that dies while a suite waits
# for it, or never answers, must fail the wait within seconds and show the
# service's log, not hang. (A Postgres that couldn't bind its port once held
# the shared test queue for 50 minutes.) Runs in ./test.sh once the images
# are pulled; needs only the postgres image, as a process that can be told
# what to do.
set -uo pipefail
cd "$(dirname "$0")/.."

engine=${CONTAINER_ENGINE:-$(command -v podman || command -v docker)}
name=reliquary-harness-check-${TEST_SLOT:-0}
image=docker.io/library/postgres:17
status=0

cleanup() { "$engine" rm -f -v "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# check <label> <timeout> <max seconds> <expected text> <container command...>
check() {
  local label=$1 timeout=$2 max=$3 expect=$4 out code t0
  shift 4
  cleanup
  "$engine" run -d --network none --name "$name" "$image" "$@" >/dev/null
  t0=$SECONDS
  out=$( (source scripts/lib/containers.sh; WAIT_TIMEOUT=$timeout wait_until "$name" "the check" false) 2>&1 )
  code=$?
  if [ $code = 1 ] && [ $((SECONDS - t0)) -le "$max" ] && grep -qF "$expect" <<<"$out" && grep -qF "boom" <<<"$out"; then
    echo "  ok    $label"
  else
    echo "  FAIL  $label: exit $code after $((SECONDS - t0))s (wanted 1 within ${max}s, with '$expect' and the log line):" >&2
    sed 's/^/        /' <<<"$out" >&2
    status=1
  fi
}

check "a service that exits stops the wait and shows its log" 60 10 "exited first" \
  sh -c 'echo boom >&2; exit 1'
check "a service that never answers stops the wait at the deadline" 2 10 "gave no answer in 2s" \
  sh -c 'trap "exit 0" TERM; echo boom >&2; sleep 60 & wait'
exit $status
