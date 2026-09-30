#!/usr/bin/env bash
# usage: scale_load.sh <old|new> <clients> [seconds]
# N agents ask for work as fast as they can (nothing is available), 15 s by default.
set -euo pipefail
cd "$(dirname "$0")"
H="-h 127.0.0.1 -p 54329 -U postgres"
variant="$1"; N="$2"; T="${3:-15}"
dropdb $H --if-exists spike; createdb $H spike
P="psql $H -d spike -X -q -v ON_ERROR_STOP=1"
$P -f schema.sql -f plan.sql -f queue.sql -f guard.sql -f scale_load.sql 2>&1 | grep -v NOTICE || true
if [ "$variant" = old ]; then
  # the earlier design keeps its own holder
  $P -c "select request_work_core('00000000-0000-0000-0000-000000000001','load/p','00000000-0000-0000-0000-00000000ffff','holder')" >/dev/null 2>&1 || true
fi
Q="psql $H -d spike -X -At"
l0=$($Q -c "select pg_current_wal_insert_lsn()")
out=$(pgbench $H -n -M prepared -f hammer_$variant.pgb -c "$N" -j 4 -T "$T" spike 2>&1)
l1=$($Q -c "select pg_current_wal_insert_lsn()")
sleep 1.5
tps=$(echo "$out" | sed -n 's/^tps = \([0-9.]*\).*/\1/p')
lat=$(echo "$out" | sed -n 's/^latency average = \([0-9.]*\) ms.*/\1/p')
tx=$(echo "$out" | sed -n 's/^number of transactions actually processed: \([0-9]*\).*/\1/p')
fail=$(echo "$out" | sed -n 's/^number of failed transactions: \([0-9]*\).*/\1/p')
walmb=$($Q -c "select round(pg_wal_lsn_diff('$l1','$l0')/1048576.0, 1)")
tk=$($Q -c "select n_tup_ins||' ins, '||n_tup_upd||' upd ('||n_tup_hot_upd||' in place), '||n_tup_del||' del' from pg_stat_user_tables where relname='tickets'")
printf '%-4s %4d agents | %8.0f calls/s | avg %6.2f ms | %7d calls | WAL %6s MB | tickets: %s | errors %s\n' \
  "$variant" "$N" "$tps" "$lat" "$tx" "$walmb" "$tk" "${fail:-0}"
