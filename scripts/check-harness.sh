#!/usr/bin/env bash
# Checks the harness's own helpers in scripts/lib. Runs in ./test.sh once the
# images are pulled (a few seconds); needs only the postgres image, as a
# process that can be told what to do.
#
# containers.sh: a service that dies while a suite waits for it, or never
# answers, must fail the wait within seconds and show the service's log, not
# hang. (A Postgres that couldn't bind its port once held the shared test
# queue for 50 minutes.)
#
# engine.sh: with no usable container engine every script must say what is
# missing, not run its suites into empty logs.
set -uo pipefail
cd "$(dirname "$0")/.."

source scripts/lib/engine.sh
name=reliquary-harness-check-${TEST_SLOT:-0}
image=docker.io/library/postgres:17
status=0
fakes=$(mktemp -d)

cleanup() { "$engine" rm -f -v "$name" >/dev/null 2>&1 || true; rm -rf "$fakes"; }
trap cleanup EXIT

# check <label> <timeout> <max seconds> <expected text> <container command...>
check() {
  local label=$1 timeout=$2 max=$3 expect=$4 out code t0
  shift 4
  "$engine" rm -f -v "$name" >/dev/null 2>&1 || true
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

# Stand-in engines: a podman that can't reach its service, and a docker that works.
mkdir "$fakes/down" "$fakes/up" "$fakes/both"
printf '#!/bin/sh\necho "cannot connect to the container service" >&2\nexit 1\n' > "$fakes/down/podman"
printf '#!/bin/sh\nexit 0\n' > "$fakes/up/docker"
cp "$fakes/down/podman" "$fakes/both/podman"
cp "$fakes/up/docker" "$fakes/both/docker"
chmod +x "$fakes"/*/*

# engine_case <label> <expected exit> <expected text> <env assignments...>
# Sources engine.sh in a fresh shell whose PATH holds only the stand-ins, and
# whose CONTAINER_ENGINE is unset unless a case sets it (CI exports it).
engine_case() {
  local label=$1 want=$2 expect=$3 out code
  shift 3
  out=$(env -u CONTAINER_ENGINE "$@" /bin/bash -c 'source scripts/lib/engine.sh; echo "engine=$engine"' 2>&1)
  code=$?
  if [ $code = "$want" ] && grep -qF -- "$expect" <<<"$out"; then
    echo "  ok    $label"
  else
    echo "  FAIL  $label: exit $code (wanted $want, with '$expect'):" >&2
    sed 's/^/        /' <<<"$out" >&2
    status=1
  fi
}

engine_case "neither podman nor docker: says to install one" 1 "needs podman or docker" PATH=/nonexistent
engine_case "an engine that can't run containers: says why" 1 "cannot connect to the container service" PATH="$fakes/down"
engine_case "CONTAINER_ENGINE that isn't installed: names it" 1 "CONTAINER_ENGINE=nonesuch" PATH="$fakes/up" CONTAINER_ENGINE=nonesuch
engine_case "docker alone is used" 0 "engine=$fakes/up/docker" PATH="$fakes/up"
engine_case "CONTAINER_ENGINE wins over podman" 0 "engine=$fakes/both/docker" PATH="$fakes/both" CONTAINER_ENGINE=docker
exit $status
