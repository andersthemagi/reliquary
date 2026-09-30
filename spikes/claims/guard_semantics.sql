-- Adversary suite. Everything after "set local role agent_api" runs as the
-- restricted role an agent's session would have: it can execute the agent_*
-- functions and nothing else. Each test is something a misbehaving agent would
-- try. Any failed assert aborts.
create table if not exists ticket_writes (cnt bigint not null);
delete from ticket_writes; insert into ticket_writes values (0);
create or replace function count_tw() returns trigger language plpgsql as $$
begin update ticket_writes set cnt = cnt + 1; return null; end $$;
drop trigger if exists tw on tickets;
create trigger tw after insert or update or delete on tickets for each statement execute function count_tw();

create or replace function as_agent(p uuid) returns void language plpgsql as $$
begin
  perform set_config('app.token', p::text, true);
  perform set_config('app.member', p::text, true);
end $$;

do $$
declare
  v uuid := '00000000-0000-0000-0000-000000000001';
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  p uuid := gen_random_uuid(); q uuid := gen_random_uuid(); rr uuid := gen_random_uuid();
  h uuid := gen_random_uuid(); i uuid := gen_random_uuid(); x uuid := gen_random_uuid();
  z1 uuid := gen_random_uuid(); z2 uuid := gen_random_uuid(); z3 uuid := gen_random_uuid(); z4 uuid := gen_random_uuid();
  w uuid := gen_random_uuid(); z uuid := gen_random_uuid();
  m uuid := gen_random_uuid(); m1 uuid := gen_random_uuid(); m2 uuid := gen_random_uuid(); m3 uuid := gen_random_uuid(); o1 uuid := gen_random_uuid(); o2 uuid := gen_random_uuid();
  sx uuid := gen_random_uuid(); pm uuid := gen_random_uuid(); p1 uuid := gen_random_uuid(); p2 uuid := gen_random_uuid(); z5 uuid := gen_random_uuid();
  xs record; nstr int; cool timestamptz;
  pm2 uuid := gen_random_uuid(); c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid();
  xa record; xb record; xc record; xh record; y record;
  k int; granted_n int; held int; writes0 bigint; writes1 bigint; e timestamptz; ca timestamptz;
  ok boolean; t0 timestamptz; hammer_ms numeric;
begin
  -- setup, as the owner
  insert into claim_rules (vault_id, prefix, lease, max_lease, ticket_ttl, poll_cap, min_poll, max_active, max_hold, max_tickets,
                           max_active_member, free_strikes, cooldown_cap)
  values (v, 'g/', interval '3 seconds', interval '1 hour', interval '4 seconds', interval '2 seconds',
          interval '1 second', 1, interval '6 seconds', 3, 2, 1, interval '30 seconds');
  perform register_plan(v, 'g/chain', '[{"key":"s1"},{"key":"s2","blocked_by":["s1"]},{"key":"s3","blocked_by":["s2"]}]');
  perform register_plan(v, 'g/turn',  '[{"key":"a"}]');
  perform register_plan(v, 'g/stale', '[{"key":"a"}]');
  perform register_plan(v, 'g/hoard', '[{"key":"h1"},{"key":"h2"},{"key":"h3"},{"key":"h4"},{"key":"h5"}]');
  perform register_plan(v, 'g/t1', '[{"key":"a"}]'); perform register_plan(v, 'g/t2', '[{"key":"a"}]');
  perform register_plan(v, 'g/t3', '[{"key":"a"}]'); perform register_plan(v, 'g/t4', '[{"key":"a"}]');
  perform register_plan(v, 'g/steal', '[{"key":"a"}]');
  perform register_plan(v, 'g/hold',  '[{"key":"a"}]');
  perform register_plan(v, 'g/rate',  '[{"key":"a"}]');
  perform register_plan(v, 'g/member', '[{"key":"m1"},{"key":"m2"},{"key":"m3"},{"key":"m4"},{"key":"m5"}]');
  perform register_plan(v, 'g/s1', '[{"key":"a"}]'); perform register_plan(v, 'g/s2', '[{"key":"a"}]'); perform register_plan(v, 'g/s3', '[{"key":"a"}]');
  perform register_plan(v, 'g/one', '[{"key":"a"}]');
  perform register_plan(v, 'g/steal2', '[{"key":"a"}]');

  set local role agent_api;

  -- 1. No back door: no table is readable or writable, and the unguarded functions cannot be run
  ok := false; begin update plan_steps set status = 'open'; exception when insufficient_privilege then ok := true; end;
  assert ok, '1a an agent cannot write a step directly';
  ok := false; begin insert into tickets (vault_id, plan, holder_token, expires_at) values (v, 'g/turn', a, now() + interval '1 hour'); exception when insufficient_privilege then ok := true; end;
  assert ok, '1b an agent cannot create a place in line directly';
  ok := false; begin update tickets set created_at = '2000-01-01'; exception when insufficient_privilege then ok := true; end;
  assert ok, '1c an agent cannot back-date a place in line';
  ok := false; begin perform count(*) from tickets; exception when insufficient_privilege then ok := true; end;
  assert ok, '1d an agent cannot even read the line';
  ok := false; begin perform * from claim_ready_step(v, 'g/turn', a, 'x', interval '1 hour'); exception when insufficient_privilege then ok := true; end;
  assert ok, '1e the claim function that ignores the queue is not callable';
  ok := false; begin perform * from request_work(v, 'g/turn', a, 'x'); exception when insufficient_privilege then ok := true; end;
  assert ok, '1f nor the earlier request function that takes a token as an argument';
  -- Two layers protect this, so check each on its own, not only their combined effect.
  assert not has_function_privilege('agent_api', 'claim_ready_step(uuid,text,uuid,text,interval)', 'execute')
     and not has_function_privilege('agent_api', 'request_work(uuid,text,uuid,text,interval)', 'execute')
     and not has_function_privilege('agent_api', 'request_work_core(uuid,text,uuid,text,interval)', 'execute'),
    '1g execute is revoked on every unguarded function';
  assert not (select coalesce(bool_or(has_table_privilege('agent_api', c.oid, 'select,insert,update,delete')), false)
                from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'),
    '1h the agent role holds no privilege on any table';

  -- 2. Identity is the session's, not an argument
  perform set_config('app.token', '', true);
  ok := false; begin perform * from agent_request_work(v, 'g/turn'); exception when invalid_authorization_specification then ok := true; end;
  assert ok, '2 with no signed-in connection nothing works';

  -- 3. A blocked step cannot be claimed, however hard the agent asks
  perform as_agent(a);
  select * into xa from agent_request_work(v, 'g/chain', 'A');
  assert xa.o_state = 'granted' and xa.o_key = 's1', '3a the only unblocked step is granted';
  select * into y from agent_request_work(v, 'g/chain', 'A');
  assert y.o_state = 'at_capacity', '3b holding one step, the same connection is refused a second';
  perform as_agent(b);
  select * into xb from agent_request_work(v, 'g/chain', 'B');
  assert xb.o_state = 'wait' and xb.o_ready = 0, '3c another connection waits: s2 is blocked';
  granted_n := 0;
  for k in 1..50 loop
    select * into y from agent_request_work(v, 'g/chain', 'B');
    if y.o_state = 'granted' then granted_n := granted_n + 1; end if;
  end loop;
  assert granted_n = 0, '3d fifty more requests do not get s2 while s1 is unfinished';
  perform as_agent(a);
  assert agent_complete_step(xa.o_id, xa.o_fence, xa.o_secret), '3e the holder finishes s1';
  perform as_agent(b);
  select * into y from agent_request_work(v, 'g/chain', 'B');
  assert y.o_state = 'wait', '3f s2 is now ready, but a caller cannot ask again before its time';
  assert y.o_check_ms between 1 and 1000, '3g and is told exactly how long to wait';
  perform pg_sleep(1.1);
  select * into xb from agent_request_work(v, 'g/chain', 'B');
  assert xb.o_state = 'granted' and xb.o_key = 's2', '3h at its time it gets s2';
  assert agent_complete_step(xb.o_id, xb.o_fence, xb.o_secret), '3i and finishes it';
  perform as_agent(a);
  select * into xa from agent_request_work(v, 'g/chain', 'A');
  assert xa.o_state = 'granted' and xa.o_key = 's3', '3j with nobody in line the next agent takes s3';
  assert agent_complete_step(xa.o_id, xa.o_fence, xa.o_secret), '3k and finishes it, so it holds nothing into the next test';

  -- 4. Out of turn: a younger place in line cannot take a step the older one is owed
  perform as_agent(p);
  select * into xa from agent_request_work(v, 'g/turn', 'P');
  perform as_agent(q);
  perform agent_request_work(v, 'g/turn', 'Q');
  perform as_agent(rr);
  select * into y from agent_request_work(v, 'g/turn', 'R');
  assert y.o_rank = 2, '4a R is second in line';
  perform as_agent(p);
  assert agent_release_step(xa.o_id, xa.o_fence, xa.o_secret), '4b P gives the step back';
  perform pg_sleep(1.1);
  perform as_agent(rr);
  select * into y from agent_request_work(v, 'g/turn', 'R');
  assert y.o_state = 'wait' and y.o_rank = 2 and y.o_ready = 1, '4c R, second in line, is refused a step that is ready';
  perform as_agent(q);
  select * into y from agent_request_work(v, 'g/turn', 'Q');
  assert y.o_state = 'granted', '4d Q, first in line, gets it';

  -- 5. A holder that went stale cannot cut back in ahead of those who waited
  perform as_agent(a);
  select * into xa from agent_request_work(v, 'g/stale', 'A');
  perform as_agent(b);
  perform agent_request_work(v, 'g/stale', 'B');
  perform as_agent(c);
  perform agent_request_work(v, 'g/stale', 'C');
  perform pg_sleep(3.3);
  perform as_agent(a);
  select * into y from agent_request_work(v, 'g/stale', 'A');
  assert y.o_state = 'wait' and y.o_rank = 3, '5a the stale holder goes to the back of the line';
  perform as_agent(b);
  select * into y from agent_request_work(v, 'g/stale', 'B');
  assert y.o_state = 'granted' and y.o_fence = 2, '5b the agent that was next in line gets the stale step';

  -- 6. Hoarding: one connection holds one step, however many are ready
  perform as_agent(h);
  select * into xh from agent_request_work(v, 'g/hoard', 'H');
  assert xh.o_state = 'granted', '6a first request granted';
  granted_n := 0;
  for k in 1..4 loop
    select * into y from agent_request_work(v, 'g/hoard', 'H');
    if y.o_state = 'granted' then granted_n := granted_n + 1; end if;
    assert y.o_state = 'at_capacity', '6b further requests are refused';
  end loop;
  perform as_agent(i);
  select * into y from agent_request_work(v, 'g/hoard', 'I');
  assert y.o_state = 'granted', '6c another connection still gets work';
  reset role;
  select count(*) into held from plan_steps where holder_token = h and status = 'claimed';
  assert held = 1, '6d the hoarder holds exactly one step';
  set local role agent_api;

  -- 7. Places in line per connection are capped
  perform as_agent(z1); perform agent_request_work(v, 'g/t1', 'Z1');
  perform as_agent(z2); perform agent_request_work(v, 'g/t2', 'Z2');
  perform as_agent(z3); perform agent_request_work(v, 'g/t3', 'Z3');
  perform as_agent(z4); perform agent_request_work(v, 'g/t4', 'Z4');
  perform as_agent(x);
  assert (select o_state from agent_request_work(v, 'g/t1', 'X')) = 'wait', '7a first place in line';
  assert (select o_state from agent_request_work(v, 'g/t2', 'X')) = 'wait', '7b second';
  assert (select o_state from agent_request_work(v, 'g/t3', 'X')) = 'wait', '7c third';
  assert (select o_state from agent_request_work(v, 'g/t4', 'X')) = 'refused_too_many_places', '7d a fourth is refused';
  assert agent_leave_queue(v, 'g/t1'), '7e leaving one frees a slot';
  assert (select o_state from agent_request_work(v, 'g/t4', 'X')) = 'wait', '7f and the fourth is now allowed';

  -- 8. A leaked secret is not enough
  perform as_agent(a);
  select * into xa from agent_request_work(v, 'g/steal', 'A');
  perform as_agent(b);
  assert not agent_complete_step(xa.o_id, xa.o_fence, xa.o_secret), '8a another connection with the right secret cannot finish it';
  assert agent_checkin_step(xa.o_id, xa.o_fence, xa.o_secret) is null, '8b or check in';
  assert not agent_release_step(xa.o_id, xa.o_fence, xa.o_secret), '8c or release it';
  perform as_agent(a);
  assert not agent_complete_step(xa.o_id, xa.o_fence, 'wrong-secret'), '8d the holder with a wrong secret cannot';
  assert not agent_complete_step(xa.o_id, xa.o_fence + 1, xa.o_secret), '8e nor with a wrong fence';
  assert agent_complete_step(xa.o_id, xa.o_fence, xa.o_secret), '8f the holder with both can';

  -- 8g. The same person on a different connection is not the holder either
  perform set_config('app.member', pm2::text, true);
  perform set_config('app.token', c1::text, true);
  select * into xa from agent_request_work(v, 'g/steal2', 'C1');
  assert xa.o_state = 'granted', '8g a person''s first connection claims a step';
  perform set_config('app.token', c2::text, true);
  assert not agent_complete_step(xa.o_id, xa.o_fence, xa.o_secret), '8h their other connection, with the right secret, cannot finish it';
  assert agent_checkin_step(xa.o_id, xa.o_fence, xa.o_secret) is null, '8i or check in';
  perform set_config('app.token', c1::text, true);
  assert agent_complete_step(xa.o_id, xa.o_fence, xa.o_secret), '8j only the connection that claimed it can';

  -- 9. Checking in forever does not hold a claim forever (rule: 6 seconds)
  perform as_agent(a);
  select * into xa from agent_request_work(v, 'g/hold', 'A');
  perform pg_sleep(2.5);
  assert agent_checkin_step(xa.o_id, xa.o_fence, xa.o_secret) is not null, '9a a check-in extends the lease';
  perform pg_sleep(2.5);
  e := agent_checkin_step(xa.o_id, xa.o_fence, xa.o_secret);
  reset role; select claimed_at into ca from plan_steps where id = xa.o_id; set local role agent_api;
  assert e is not null and e <= ca + interval '6 seconds' + interval '50 milliseconds', '9b a late check-in is capped at the hold limit';
  perform pg_sleep(1.2);
  perform as_agent(a);
  assert agent_checkin_step(xa.o_id, xa.o_fence, xa.o_secret) is null, '9c past the limit no check-in is accepted';
  perform as_agent(b);
  select * into y from agent_request_work(v, 'g/hold', 'B');
  assert y.o_state = 'granted', '9d and the step is open to the next agent';

  -- 10. Hammering costs one read and no writes
  perform as_agent(z);
  perform agent_request_work(v, 'g/rate', 'Z');
  perform as_agent(w);
  select * into y from agent_request_work(v, 'g/rate', 'W');
  assert y.o_state = 'wait', '10a the waiting agent takes a place in line';
  reset role; select cnt into writes0 from ticket_writes; set local role agent_api;
  t0 := clock_timestamp();
  for k in 1..1000 loop
    select * into y from agent_request_work(v, 'g/rate', 'W');
    assert y.o_state = 'wait', '10b every early call is answered wait';
  end loop;
  hammer_ms := round(1000 * extract(epoch from clock_timestamp() - t0));
  reset role; select cnt into writes1 from ticket_writes;
  assert writes1 - writes0 <= 2, format('10c 1000 back-to-back calls caused %s writes to tickets (took %s ms)',
    writes1 - writes0, hammer_ms);
  -- 12. A person's agents share one cap, however many connections they open
  perform set_config('app.member', m::text, true);
  perform set_config('app.token', m1::text, true);
  assert (select o_state from agent_request_work(v, 'g/member', 'M1')) = 'granted', '12a the first connection of a person gets a step';
  perform set_config('app.token', m2::text, true);
  assert (select o_state from agent_request_work(v, 'g/member', 'M2')) = 'granted', '12b a second connection gets one (the person may hold two)';
  perform set_config('app.token', m3::text, true);
  assert (select o_state from agent_request_work(v, 'g/member', 'M3')) = 'at_capacity', '12c a third connection of the same person is refused';
  perform as_agent(gen_random_uuid());
  assert (select o_state from agent_request_work(v, 'g/member', 'other')) = 'granted', '12d another person still gets work';

  -- 13. Claims that lapse unfinished earn a growing cooldown; the first is free; finishing clears it
  perform as_agent(sx);
  select * into xs from agent_request_work(v, 'g/s1', 'S');
  perform pg_sleep(3.3);
  perform as_agent(o1);
  assert (select o_state from agent_request_work(v, 'g/s1', 'O1')) = 'granted', '13a another person takes over the lapsed claim';
  reset role; select strikes, cooldown_until into nstr, cool from claim_strikes where member = sx; set local role agent_api;
  assert nstr = 1 and cool is null, '13b the first lapse is a strike with no cooldown';
  perform as_agent(sx);
  select * into xs from agent_request_work(v, 'g/s2', 'S');
  assert xs.o_state = 'granted', '13c so the person can claim again straight away';
  perform pg_sleep(3.3);
  perform as_agent(o2);
  assert (select o_state from agent_request_work(v, 'g/s2', 'O2')) = 'granted', '13d and the second lapse is taken over too';
  perform as_agent(sx);
  select * into y from agent_request_work(v, 'g/s3', 'S');
  assert y.o_state = 'cooling_down' and y.o_check_ms between 1 and 3100, '13e the second lapse earns a cooldown, and the answer says how long';
  perform pg_sleep(3.2);
  select * into xs from agent_request_work(v, 'g/s3', 'S');
  assert xs.o_state = 'granted', '13f after the cooldown the person is served';
  assert agent_complete_step(xs.o_id, xs.o_fence, xs.o_secret), '13g and finishing the step';
  reset role; assert not exists (select 1 from claim_strikes where member = sx), '13h clears the strikes'; set local role agent_api;

  -- 14. One place in line per person per plan, however many connections
  perform as_agent(z5);
  perform agent_request_work(v, 'g/one', 'Z5');
  perform set_config('app.member', pm::text, true);
  perform set_config('app.token', p1::text, true);
  assert (select o_state from agent_request_work(v, 'g/one', 'P1')) = 'wait', '14a the first connection takes the person''s place in line';
  perform pg_sleep(1.1);
  perform set_config('app.token', p2::text, true);
  select * into y from agent_request_work(v, 'g/one', 'P2');
  assert y.o_state = 'wait' and y.o_rank = 1, '14b a second connection of the same person shares it, even on a full evaluation';
  reset role; assert (select count(*) from tickets where plan = 'g/one') = 1, '14c there is one place in line, not two'; set local role agent_api;

  reset role;
  assert counter_drift() = 0, '15 every step''s stored count of unfinished blockers matches reality';
  raise notice 'all adversary checks passed (1000 hammering calls took % ms, % ticket writes)', hammer_ms, writes1 - writes0;
end $$;
