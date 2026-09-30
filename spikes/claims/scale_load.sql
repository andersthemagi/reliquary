-- Load setup: one wrapper per design so a benchmark client makes one call per
-- transaction. bench_new sets the session token the way Reliquary's request
-- setup sets the verified token in the request's claims, in the same transaction.
create function bench_new(p_client int, p_plan text) returns table (o_state text)
language plpgsql as $$
begin
  perform set_config('app.token', '00000000-0000-0000-0000-' || lpad(p_client::text, 12, '0'), true);
  perform set_config('app.member', '00000000-0000-0000-0000-' || lpad(p_client::text, 12, '0'), true);
  return query select r.o_state from agent_request_work('00000000-0000-0000-0000-000000000001'::uuid, p_plan, 'a') r;
end $$;
create function bench_old(p_client int, p_plan text) returns table (o_state text)
language plpgsql as $$
begin
  return query select r.o_state from request_work_core('00000000-0000-0000-0000-000000000001'::uuid, p_plan,
    ('00000000-0000-0000-0000-' || lpad(p_client::text, 12, '0'))::uuid, 'a') r;
end $$;
insert into claim_rules (vault_id, prefix, lease, max_lease, ticket_ttl, poll_cap, min_poll, max_active, max_hold, max_tickets)
values ('00000000-0000-0000-0000-000000000001', 'load/', interval '48 hours', interval '30 days', interval '6 hours',
        interval '1 hour', interval '5 seconds', 1, interval '7 days', 10);
-- A 200-step plan whose only ready step is held by someone else for 48 hours.
select register_plan('00000000-0000-0000-0000-000000000001', 'load/p', (select jsonb_agg(jsonb_build_object('key', 's'||i,
  'blocked_by', case when i = 0 then '[]'::jsonb else '["s0"]'::jsonb end) order by i) from generate_series(0, 199) i)) >= 0;
do $$ begin
  perform set_config('app.token', '00000000-0000-0000-0000-00000000ffff', true);
  perform set_config('app.member', '00000000-0000-0000-0000-00000000ffff', true);
  perform agent_request_work('00000000-0000-0000-0000-000000000001'::uuid, 'load/p', 'holder');
end $$;
analyze plan_steps; analyze plan_step_deps; analyze tickets; analyze claim_rules;
