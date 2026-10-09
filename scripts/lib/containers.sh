# Waiting for the containers a test suite starts: supabase/tests/run.sh and
# the mcp, web and cli test.sh. Sourced, not run; needs $engine set.
#
# A bare `until probe; do sleep; done` waits forever on a container that
# already exited (Postgres couldn't bind its port, and the suite sat behind
# the shared lock queue for 50 minutes), so every wait here checks that the
# container is still running and gives up at a deadline.

# wait_until <container> <what> <probe command...>
# Returns when the probe succeeds. When the container has exited, or the
# probe still fails after WAIT_TIMEOUT seconds (default 300, enough for a
# cold `npm ci`), says what was being waited for and why it stopped, prints
# the container's last log lines, and exits 1.
wait_until() {
  local c=$1 what=$2 limit=${WAIT_TIMEOUT:-300} why
  local deadline=$((SECONDS + limit))
  shift 2
  until "$@" >/dev/null 2>&1; do
    if [ "$("$engine" inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" != true ]; then
      why="$c exited first"
    elif [ $SECONDS -ge $deadline ]; then
      why="$c is still running but gave no answer in ${limit}s"
    else
      sleep 0.3
      continue
    fi
    echo "harness: waiting for $what, and $why. Last log lines of $c:" >&2
    "$engine" logs --tail 20 "$c" 2>&1 | sed 's/^/  /' >&2
    exit 1
  done
}
