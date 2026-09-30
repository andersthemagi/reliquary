#!/usr/bin/env bash
# 30 workers, 25 s, 1 s leases: 30% crash (never finish), 20% stall past the
# lease then try to complete, 50% finish. Then a drain phase and invariant checks.
set -euo pipefail
cd "$(dirname "$0")"
H="-h 127.0.0.1 -p 54329 -U postgres"
dropdb $H --if-exists spike; createdb $H spike
P="psql $H -d spike -X -q -v ON_ERROR_STOP=1"
$P -f schema.sql 2>&1 | grep -v NOTICE || true
$P -c "create table outcomes (kind text, ok int)"
$P -c "insert into tasks (vault_id, path, priority) select '00000000-0000-0000-0000-000000000001', 'tasks/t-'||g||'.md', g % 5 from generate_series(1,300) g"
pgbench $H -n -f chaos.pgb -c 30 -j 8 -T 25 spike 2>&1 | grep -E 'failed|error'
sleep 2
pgbench $H -n -f drain.pgb -c 5 -j 5 -T 20 spike 2>&1 | grep -E 'failed|error'
Q="psql $H -d spike -X -At"
$Q -c "select 'tasks: '||count(*)||' | done: '||count(*) filter (where status='done')||' | still claimed: '||count(*) filter (where status='claimed')||' | open: '||count(*) filter (where status='open') from tasks"
$Q -c "select 'reclaimed after a crash or stall (fence>1): '||count(*) filter (where fence>1)||' | max fence: '||max(fence) from tasks"
$Q -c "select kind||': attempted='||count(*)||' accepted='||sum(ok) from outcomes group by kind order by kind"
$Q -c "select 'STALE COMPLETIONS ACCEPTED (must be 0): '||coalesce(sum(ok),0) from outcomes where kind='stall'"
$Q -c "select 'done tasks: '||count(*) filter (where status='done')||' vs accepted completions: '||(select sum(ok) from outcomes)||' (must match)' from tasks"
