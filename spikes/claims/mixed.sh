#!/usr/bin/env bash
# usage: mixed.sh <hostile-agents>   (20 honest agents, one 40-step plan, 3 s leases)
set -euo pipefail
cd "$(dirname "$0")"
H="-h 127.0.0.1 -p 54329 -U postgres"
HOSTILE="${1:-0}"; T="${2:-60}"; OUT="$(mktemp)"
dropdb $H --if-exists spike; createdb $H spike
P="psql $H -d spike -X -q -v ON_ERROR_STOP=1"
$P -f schema.sql -f plan.sql -f queue.sql -f guard.sql 2>&1 | grep -v NOTICE || true
$P -c "insert into claim_rules (vault_id, prefix, lease, max_lease, ticket_ttl, poll_cap, min_poll, max_active, max_hold, max_tickets, max_active_member, free_strikes, cooldown_cap)
       values ('00000000-0000-0000-0000-000000000001','mix/', interval '3 seconds', interval '1 hour', interval '4 seconds', interval '300 milliseconds', interval '100 milliseconds', 1, interval '1 hour', 10, 1, 1, interval '30 seconds')"
$P -c "select register_plan('00000000-0000-0000-0000-000000000001', 'mix/p', (
  select jsonb_agg(jsonb_build_object('key', 'L'||l||'-'||i,
    'blocked_by', case when l = 1 then '[]'::jsonb
      else jsonb_build_array('L'||(l-1)||'-'||i, 'L'||(l-1)||'-'||((i+1)%8)) end))
  from generate_series(1,5) l, generate_series(0,7) i)) >= 0" >/dev/null
$P -c "analyze"
if [ "$HOSTILE" -gt 0 ]; then
  pgbench $H -n -M prepared -f mixed_hostile.pgb -c "$HOSTILE" -j 2 -T "$T" spike >"$OUT" 2>&1 &
  HPID=$!
fi
pgbench $H -n -f mixed_worker.pgb -c 20 -j 2 -T "$T" spike 2>&1 | grep -E 'failed|error' || true
[ "$HOSTILE" -gt 0 ] && wait $HPID || true
Q="psql $H -d spike -X -At"
echo "--- 20 honest agents + $HOSTILE hostile agents"
$Q -c "select 'steps done: '||count(*) filter (where status='done')||' of '||count(*) from plan_steps where plan='mix/p'"
$Q -c "select 'seconds from the first claim to the last step done: '||round(extract(epoch from (select max(done_at) from plan_steps where plan='mix/p') - (select min(at) from log where event='step.claimed'))::numeric, 1)"
$Q -c "select 'grants to honest agents: '||count(*) filter (where right(actor::text, 12)::bigint < 1000)||', to hostile agents: '||count(*) filter (where right(actor::text, 12)::bigint >= 1000) from log where event='step.claimed'"
$Q -c "select 'claims made with an unfinished blocker (must be 0): '||count(*) from log l join plan_steps s on s.id=(l.detail->>'step')::bigint join plan_step_deps d on d.step_id=s.id join plan_steps b on b.id=d.blocker_id where l.event='step.claimed' and (b.done_at is null or b.done_at > l.at)"
$Q -c "select 'stored blocker counts that disagree with reality (must be 0): '||counter_drift()"
$Q -c "select 'live places in line: '||count(*) from tickets"
if [ "$HOSTILE" -gt 0 ]; then grep -E 'failed|tps' "$OUT" | head -2 | sed 's/^/hostile pgbench: /'; fi
