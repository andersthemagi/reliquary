#!/usr/bin/env bash
# usage: run.sh <script.pgb> <clients> <txns-per-client> [tasks]
set -euo pipefail
cd "$(dirname "$0")"
H="-h 127.0.0.1 -p 54329 -U postgres"
dropdb $H --if-exists spike; createdb $H spike
P="psql $H -d spike -X -q -v ON_ERROR_STOP=1"
$P -f schema.sql
if [ "${4:-}" = "tasks" ]; then
  $P -c "insert into tasks (vault_id, path, priority) select '00000000-0000-0000-0000-000000000001', 'tasks/t-'||g||'.md', g % 5 from generate_series(1,300) g"
fi
pgbench $H -n -f "$1" -c "$2" -j 8 -t "$3" spike 2>&1 | grep -E 'actually processed|latency average|tps ='
