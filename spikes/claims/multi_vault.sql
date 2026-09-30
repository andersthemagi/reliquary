-- Many vaults at once. V vaults, each with one plan (a root held by someone, 19
-- steps waiting on it), 5 people per vault and 2 agent connections per person,
-- so 10 agents a vault. Every vault has its own claim rule. Setup only; the load
-- comes from multi.pgb via multi_vault.sh.
create function vault_uuid(v int) returns uuid language sql immutable as
  $$ select ('00000000-0000-0000-0001-' || lpad(v::text, 12, '0'))::uuid $$;
create function person_uuid(v int, p int) returns uuid language sql immutable as
  $$ select ('00000000-0000-0000-' || lpad(v::text, 4, '0') || '-' || lpad((p * 10)::text, 12, '0'))::uuid $$;
create function agent_uuid(v int, p int, a int) returns uuid language sql immutable as
  $$ select ('00000000-0000-0000-' || lpad(v::text, 4, '0') || '-' || lpad((p * 10 + a)::text, 12, '0'))::uuid $$;

-- One call per benchmark transaction: set who is asking, as the request setup would.
create function bench_multi(v int, p int, a int) returns table (o_state text)
language plpgsql as $$
begin
  perform set_config('app.token', agent_uuid(v, p, a)::text, true);
  perform set_config('app.member', person_uuid(v, p)::text, true);
  return query select r.o_state from agent_request_work(vault_uuid(v), 'load/p', 'a') r;
end $$;

create procedure setup_vaults(n int) language plpgsql as $$
declare v int;
begin
  for v in 1..n loop
    insert into claim_rules (vault_id, prefix, lease, max_lease, ticket_ttl, poll_cap, min_poll, max_active, max_hold,
                             max_tickets, max_active_member, free_strikes, cooldown_cap)
    values (vault_uuid(v), 'load/', interval '48 hours', interval '30 days', interval '6 hours', interval '1 hour',
            interval '5 seconds', 1, interval '7 days', 10, 5, 1, interval '48 hours');
    perform register_plan(vault_uuid(v), 'load/p', (select jsonb_agg(jsonb_build_object('key', 's'||i,
      'blocked_by', case when i = 0 then '[]'::jsonb else '["s0"]'::jsonb end) order by i) from generate_series(0, 19) i));
    -- the root is held by a sixth person, so nothing is ready for the five
    perform set_config('app.token', agent_uuid(v, 9, 1)::text, true);
    perform set_config('app.member', person_uuid(v, 9)::text, true);
    perform agent_request_work(vault_uuid(v), 'load/p', 'holder');
  end loop;
end $$;
