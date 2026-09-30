#!/usr/bin/env bash
# A throwaway PostgreSQL 16 server for the spike: port 54329, trust auth, fsync off, so it
# is never a place for real data. usage: scratch-server.sh start | stop
# Needs the server binaries (PGBIN, default /usr/lib/postgresql/16/bin) and pgbench.
# Run as root it uses the postgres user, because the server refuses to run as root.
set -euo pipefail
BIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DIR="${SPIKE_PGDIR:-/var/lib/postgresql/claim-spike}"
as() { if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else sh -c "$*"; fi; }
case "${1:-}" in
  start)
    mkdir -p "$DIR"; [ "$(id -u)" = 0 ] && chown postgres:postgres "$DIR"
    as "$BIN/initdb -D $DIR/data -A trust -U postgres >/dev/null"
    as "$BIN/pg_ctl -D $DIR/data -o '-p 54329 -c listen_addresses=127.0.0.1 -c max_connections=700 -c fsync=off' -l $DIR/log -w start" | tail -1 ;;
  stop)
    as "$BIN/pg_ctl -D $DIR/data -m fast -w stop" | tail -1; rm -rf "$DIR" ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
