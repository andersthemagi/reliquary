#!/usr/bin/env bash
# usage: multi_vault.sh <vaults> [clients] [seconds]
# V vaults x 5 people x 2 agents ask for work as fast as they can, spread across all vaults.
set -euo pipefail
cd "$(dirname "$0")"
H="-h 127.0.0.1 -p 54329 -U postgres"
V="$1"; C="${2:-200}"; T="${3:-15}"
dropdb $H --if-exists spike; createdb $H spike
P="psql $H -d spike -X -q -v ON_ERROR_STOP=1"
$P -f schema.sql -f plan.sql -f queue.sql -f guard.sql -f multi_vault.sql 2>&1 | grep -v NOTICE || true
s0=$(date +%s.%N); $P -c "call setup_vaults($V)"; s1=$(date +%s.%N)
$P -c "analyze"
Q="psql $H -d spike -X -At"
l0=$($Q -c "select pg_current_wal_insert_lsn()")
out=$(pgbench $H -n -M prepared -f multi.pgb -D vaults="$V" -c "$C" -j 4 -T "$T" spike 2>&1)
l1=$($Q -c "select pg_current_wal_insert_lsn()")
tps=$(echo "$out" | sed -n 's/^tps = \([0-9.]*\).*/\1/p'); lat=$(echo "$out" | sed -n 's/^latency average = \([0-9.]*\) ms.*/\1/p')
fail=$(echo "$out" | sed -n 's/^number of failed transactions: \([0-9]*\).*/\1/p')
tk=$($Q -c "select count(*) from tickets"); st=$($Q -c "select count(*) from plan_steps")
mb=$($Q -c "select round((pg_total_relation_size('tickets')+pg_total_relation_size('plan_steps')+pg_total_relation_size('plan_step_deps')+pg_total_relation_size('claim_rules'))/1048576.0)")
wal=$($Q -c "select round(pg_wal_lsn_diff('$l1','$l0')/1048576.0, 1)")
printf '%5d vaults (%6d agents) | setup %4.1fs | %8.0f calls/s | avg %6.2f ms | %6d places in line, %7d steps, %4s MB of tables | WAL %s MB | errors %s\n' \
  "$V" "$((V * 10))" "$(echo "$s1 - $s0" | bc)" "$tps" "$lat" "$tk" "$st" "$mb" "$wal" "${fail:-0}"
