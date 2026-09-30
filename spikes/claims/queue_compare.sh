#!/usr/bin/env bash
# Same plan, same 30 workers, two ways of waiting. Reports calls made before the
# plan finished, time to finish, and the ordering invariants. CRASH=N (default 10)
# is the percentage of claims an agent abandons without finishing.
set -euo pipefail
cd "$(dirname "$0")"
H="-h 127.0.0.1 -p 54329 -U postgres"
run() {
  local label="$1" spin="$2"
  dropdb $H --if-exists spike; createdb $H spike
  local P="psql $H -d spike -X -q -v ON_ERROR_STOP=1"
  $P -f schema.sql -f plan.sql -f queue.sql 2>&1 | grep -v NOTICE || true
  $P -c "insert into claim_rules values ('00000000-0000-0000-0000-000000000001','hack/', interval '3 seconds', interval '1 hour', interval '4 seconds', interval '300 milliseconds')"
  $P -c "select register_plan('00000000-0000-0000-0000-000000000001', 'hack/big', (
    select jsonb_agg(jsonb_build_object('key', 'L'||l||'-'||i,
      'blocked_by', case when l = 1 then '[]'::jsonb
        else jsonb_build_array('L'||(l-1)||'-'||i, 'L'||(l-1)||'-'||((i+1)%8)) end))
    from generate_series(1,5) l, generate_series(0,7) i))" >/dev/null
  pgbench $H -n -f queue_worker.pgb -D spin=$spin -D crash=${CRASH:-10} -c 30 -j 8 -T 30 spike 2>&1 | grep -E 'failed|error' || true
  local Q="psql $H -d spike -X -At"
  echo "--- $label (crash=${CRASH:-10}%)"
  $Q -c "select 'steps done: '||count(*) filter (where status='done')||' of '||count(*) from plan_steps where plan='hack/big'"
  $Q -c "select 'calls before the plan finished: '||count(*) filter (where state in ('granted','wait'))||' (waiting: '||count(*) filter (where state='wait')||', granted: '||count(*) filter (where state='granted')||')' from calls"
  $Q -c "select 'seconds from first call to last step done: '||round(extract(epoch from (select max(done_at) from plan_steps) - (select min(at) from calls))::numeric, 1)"
  $Q -c "select 'claims made with an unfinished blocker (must be 0): '||count(*) from log l join plan_steps s on s.id=(l.detail->>'step')::bigint join plan_step_deps d on d.step_id=s.id join plan_steps b on b.id=d.blocker_id where l.event='step.claimed' and (b.done_at is null or b.done_at > l.at)"
  $Q -c "select 'grants where rank > ready (must be 0): '||count(*) from log where event='step.claimed' and (detail->>'rank')::int > (detail->>'ready')::int"
  $Q -c "select 'tickets left behind: '||count(*) from tickets"
}
run "spinning: poll every 10 ms, ignore the hint" 1
run "hinted: sleep for the server's check-again time" 0
