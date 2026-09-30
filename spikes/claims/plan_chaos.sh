#!/usr/bin/env bash
# A 120-step plan in 12 layers of 10: step i of a layer needs steps i and i+1 (mod 10)
# of the layer before. 30 workers for 30 s, 1 s leases, 25% of claims never finish.
set -euo pipefail
cd "$(dirname "$0")"
H="-h 127.0.0.1 -p 54329 -U postgres"
dropdb $H --if-exists spike; createdb $H spike
P="psql $H -d spike -X -q -v ON_ERROR_STOP=1"
$P -f schema.sql -f "${PLAN_SQL:-plan.sql}" 2>&1 | grep -v NOTICE || true
if [ -z "${SKIP_SEMANTICS:-}" ]; then $P -f plan_semantics.sql 2>&1; fi
$P -c "create table outcomes (kind text, ok int)"
$P -c "select register_plan('00000000-0000-0000-0000-000000000001', 'big', (
  select jsonb_agg(jsonb_build_object('key', 'L'||l||'-'||i,
    'blocked_by', case when l = 1 then '[]'::jsonb
      else jsonb_build_array('L'||(l-1)||'-'||i, 'L'||(l-1)||'-'||((i+1)%10)) end))
  from generate_series(1,12) l, generate_series(0,9) i)) as steps_registered"
pgbench $H -n -f plan_chaos.pgb -c 30 -j 8 -T 40 spike 2>&1 | grep -E 'actually processed|failed|error'
Q="psql $H -d spike -X -At"
$Q -c "select 'steps: '||count(*)||' | done: '||count(*) filter (where status='done')||' | claimed: '||count(*) filter (where status='claimed')||' | open: '||count(*) filter (where status='open') from plan_steps where plan='big'"
$Q -c "select 'reclaimed after a crash (fence>1): '||count(*) filter (where fence>1)||' | max fence: '||max(fence) from plan_steps where plan='big'"
$Q -c "select kind||': attempted='||count(*)||' accepted='||sum(ok) from outcomes group by kind order by kind"
$Q -c "select 'CLAIMS MADE WITH AN UNFINISHED BLOCKER (must be 0): '||count(*) from log l
  join plan_steps s on s.id = (l.detail->>'step')::bigint
  join plan_step_deps d on d.step_id = s.id join plan_steps b on b.id = d.blocker_id
  where l.path = 'big' and l.event='step.claimed' and (b.done_at is null or b.done_at > l.at)"
$Q -c "select 'steps done before a blocker (must be 0): '||count(*) from plan_step_deps d
  join plan_steps s on s.id = d.step_id join plan_steps b on b.id = d.blocker_id
  where s.plan = 'big' and (s.done_at is null or s.done_at < b.done_at)"
$Q -c "select 'claim events: '||count(*)||' for '||count(distinct detail->>'step')||' distinct steps' from log where path='big' and event='step.claimed'"
