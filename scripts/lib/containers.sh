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

# start_postgres <container> <port>
# Postgres 17 on 127.0.0.1:<port> (host network), ready for connections.
#
# The port follows from the slot (54330 + 10 * slot and its neighbours), and
# the tests work it out again the same way, so it can't move. It sits inside
# the kernel's range for outgoing connections (net.ipv4.ip_local_port_range,
# 32768-60999 by default), and a connection another process happens to hold
# on it when Postgres binds fails the start. Those end within seconds, so try
# again before giving up, and then say who has the port.
start_postgres() {
  local name=$1 port=$2 try
  for try in 1 2 3 4 5 6 7 8 9 10; do
    # Data on tmpfs: nothing in a test needs it to survive, and a tmpfs leaves
    # no volume behind even when a cleanup is skipped.
    "$engine" run -d --name "$name" --network host --tmpfs /var/lib/postgresql/data -e POSTGRES_PASSWORD=test \
      docker.io/library/postgres:17 -c listen_addresses=127.0.0.1 -c port="$port" >/dev/null
    # Ask over TCP: the image's init-time server listens on the socket only, so
    # a socket check can pass before the real server is up (a flaky race).
    # In a subshell, because wait_until exits and only a taken port is worth
    # another try.
    if (wait_until "$name" "Postgres to accept connections on 127.0.0.1:$port" \
        "$engine" exec "$name" pg_isready -h 127.0.0.1 -U postgres -p "$port" -q); then
      sleep 1
      return
    fi
    [[ $("$engine" logs "$name" 2>&1) == *"Address already in use"* ]] || exit 1
    echo "harness: port $port is taken; starting $name again in 3s (try $try of 10)" >&2
    "$engine" rm -f -v "$name" >/dev/null 2>&1 || true
    sleep 3
  done
  echo "harness: port $port stayed taken for 30s, so $name can't start. Another TEST_SLOT, or waiting out" >&2
  echo "the connection that holds it, will do. Sockets on that port:" >&2
  if command -v ss >/dev/null; then ss -tanp "sport = :$port" >&2; else echo "  (ss isn't installed)" >&2; fi
  exit 1
}
