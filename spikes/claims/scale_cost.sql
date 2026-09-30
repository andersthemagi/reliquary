-- Per-call cost of a waiting agent that hammers: one connection, no network, direct
-- calls with the session token set once. Plans: one root, N-1 steps blocked on it,
-- the root held by someone else so nothing is ready, and 100 other agents in line.
-- Reports microseconds and write-ahead-log bytes per call.
insert into claim_rules (vault_id, prefix, lease, max_lease, ticket_ttl, poll_cap, min_poll, max_active, max_hold, max_tickets)
values ('00000000-0000-0000-0000-000000000001', 'old/',  interval '48 hours', interval '30 days', interval '6 hours', interval '1 hour', interval '0', 1, interval '7 days', 10),
       ('00000000-0000-0000-0000-000000000001', 'full/', interval '48 hours', interval '30 days', interval '6 hours', interval '1 hour', interval '0', 1, interval '7 days', 10),
       ('00000000-0000-0000-0000-000000000001', 'fast/', interval '48 hours', interval '30 days', interval '6 hours', interval '1 hour', interval '15 minutes', 1, interval '7 days', 10);

do $$
declare
  v uuid := '00000000-0000-0000-0000-000000000001';
  pl text; sz int; k int;
begin
  foreach sz in array array[100, 1000] loop
    foreach pl in array array['old/p'||sz, 'full/p'||sz, 'fast/p'||sz] loop
      perform register_plan(v, pl, (select jsonb_agg(jsonb_build_object('key', 's'||i,
          'blocked_by', case when i = 0 then '[]'::jsonb else '["s0"]'::jsonb end) order by i)
          from generate_series(0, sz - 1) i));
      -- someone else holds the root for 48 hours, then 100 agents queue behind it
      if pl like 'old/%' then
        perform request_work_core(v, pl, '00000000-0000-0000-0000-00000000ffff'::uuid, 'holder');
        for k in 1..100 loop
          perform request_work_core(v, pl, ('00000000-0000-0000-0000-' || lpad(k::text, 12, '0'))::uuid, 'a');
        end loop;
      else
        perform set_config('app.token', '00000000-0000-0000-0000-00000000ffff', true);
        perform set_config('app.member', '00000000-0000-0000-0000-00000000ffff', true);
        perform agent_request_work(v, pl, 'holder');
        for k in 1..100 loop
          perform set_config('app.token', '00000000-0000-0000-0000-' || lpad(k::text, 12, '0'), true);
        perform set_config('app.member', '00000000-0000-0000-0000-' || lpad(k::text, 12, '0'), true);
          perform agent_request_work(v, pl, 'a');
        end loop;
      end if;
    end loop;
  end loop;
end $$;

-- Autovacuum would do this in a live database; a fresh scratch table has no statistics.
analyze plan_steps; analyze plan_step_deps; analyze tickets; analyze claim_rules;

do $$
declare
  v uuid := '00000000-0000-0000-0000-000000000001';
  sz int; k int; s text; me uuid := '00000000-0000-0000-0000-000000000500';
  calls int := 2000; t0 timestamptz; l0 pg_lsn; l1 pg_lsn;
begin
  foreach sz in array array[100, 1000] loop
    perform set_config('app.token', me::text, true);
        perform set_config('app.member', me::text, true);
    -- earlier design
    perform request_work_core(v, 'old/p'||sz, me, 'a');
    t0 := clock_timestamp(); l0 := pg_current_wal_insert_lsn();
    for k in 1..calls loop select o_state into s from request_work_core(v, 'old/p'||sz, me, 'a'); end loop;
    l1 := pg_current_wal_insert_lsn();
    raise notice '% steps | earlier design (every call writes):          % us/call, % WAL bytes/call', lpad(sz::text, 4),
      lpad(round(1e6 * extract(epoch from clock_timestamp() - t0) / calls)::text, 5), lpad(round(pg_wal_lsn_diff(l1, l0) / calls)::text, 4);
    -- guarded, full path forced
    perform agent_request_work(v, 'full/p'||sz, 'a');
    t0 := clock_timestamp(); l0 := pg_current_wal_insert_lsn();
    for k in 1..calls loop select o_state into s from agent_request_work(v, 'full/p'||sz, 'a'); end loop;
    l1 := pg_current_wal_insert_lsn();
    raise notice '% steps | guarded, full evaluation (min_poll = 0):    % us/call, % WAL bytes/call', lpad(sz::text, 4),
      lpad(round(1e6 * extract(epoch from clock_timestamp() - t0) / calls)::text, 5), lpad(round(pg_wal_lsn_diff(l1, l0) / calls)::text, 4);
    -- guarded, fast path
    perform agent_request_work(v, 'fast/p'||sz, 'a');
    t0 := clock_timestamp(); l0 := pg_current_wal_insert_lsn();
    for k in 1..calls loop select o_state into s from agent_request_work(v, 'fast/p'||sz, 'a'); end loop;
    l1 := pg_current_wal_insert_lsn();
    raise notice '% steps | guarded, caller came back early (fast path): % us/call, % WAL bytes/call', lpad(sz::text, 4),
      lpad(round(1e6 * extract(epoch from clock_timestamp() - t0) / calls)::text, 5), lpad(round(pg_wal_lsn_diff(l1, l0) / calls)::text, 4);
  end loop;
end $$;
