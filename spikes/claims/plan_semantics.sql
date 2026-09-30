-- 17 checks for dependency-gated claims. Any failed assert aborts.
do $$
declare
  v uuid := '00000000-0000-0000-0000-000000000001';
  a record; b record; c record; d record; x record;
  st text;
begin
  -- registration refusals
  begin perform register_plan(v, 'bad1', '[{"key":"a","blocked_by":["b"]},{"key":"b","blocked_by":["c"]},{"key":"c","blocked_by":["a"]}]');
    assert false, '1 a three-step cycle must be refused';
  exception when sqlstate '22023' then null; end;
  begin perform register_plan(v, 'bad2', '[{"key":"a","blocked_by":["a"]}]');
    assert false, '2 a self-dependency must be refused';
  exception when sqlstate '22023' then null; end;
  begin perform register_plan(v, 'bad3', '[{"key":"a","blocked_by":["zzz"]}]');
    assert false, '3 an unknown blocker must be refused';
  exception when sqlstate '22023' then null; end;
  begin perform register_plan(v, 'bad4', '[{"key":"a"},{"key":"a"}]');
    assert false, '4 a duplicate key must be refused';
  exception when sqlstate '22023' then null; end;
  assert not exists (select 1 from plan_steps where plan like 'bad%'), '5 a refused plan leaves nothing behind';

  -- chain a -> b -> c, and a diamond d needs b and c
  perform register_plan(v, 'p', '[{"key":"a"},{"key":"b","blocked_by":["a"]},{"key":"c","blocked_by":["a"]},{"key":"d","blocked_by":["b","c"]}]');
  select * into a from claim_ready_step(v, 'p', gen_random_uuid(), 'w1', interval '1 second');
  assert a.o_key = 'a', '6 only the step with no blockers is claimable first';
  assert not exists (select 1 from claim_ready_step(v, 'p', gen_random_uuid(), 'w2', interval '1 second')),
    '7 while a is claimed, nothing else is ready';
  assert complete_step(a.o_id, a.o_fence, a.o_secret), '8 the holder completes a';
  select * into b from claim_ready_step(v, 'p', gen_random_uuid(), 'w1', interval '5 seconds');
  select * into c from claim_ready_step(v, 'p', gen_random_uuid(), 'w2', interval '5 seconds');
  assert b.o_key <> c.o_key and b.o_key in ('b','c') and c.o_key in ('b','c'),
    '9 b and c become ready together and go to different workers';
  assert not exists (select 1 from claim_ready_step(v, 'p', gen_random_uuid(), 'w3', interval '1 second')),
    '10 d stays blocked while b and c are unfinished';
  assert complete_step(b.o_id, b.o_fence, b.o_secret), 'b completes';
  assert not exists (select 1 from claim_ready_step(v, 'p', gen_random_uuid(), 'w3', interval '1 second')),
    '11 d stays blocked until BOTH b and c are done';
  assert complete_step(c.o_id, c.o_fence, c.o_secret), 'c completes';
  select * into d from claim_ready_step(v, 'p', gen_random_uuid(), 'w3', interval '1 second');
  assert d.o_key = 'd', '12 d is claimable once both are done';

  -- an expired claim on a blocker does not unblock, and a stale completion is refused
  perform register_plan(v, 'q', '[{"key":"a"},{"key":"b","blocked_by":["a"]}]');
  select * into x from claim_ready_step(v, 'q', gen_random_uuid(), 'slow', interval '1 second');
  perform pg_sleep(1.2);
  select * into a from claim_ready_step(v, 'q', gen_random_uuid(), 'fast', interval '5 seconds');
  assert a.o_key = 'a' and a.o_fence = 2, '13 the expired step a is reclaimed with fence 2, and b was not offered';
  assert not complete_step(x.o_id, x.o_fence, x.o_secret), '14 the slow holder cannot complete after its lease lapsed';
  assert not exists (select 1 from claim_ready_step(v, 'q', gen_random_uuid(), 'w', interval '1 second')),
    '15 b stays blocked while a is held by its new owner';

  -- a cancelled blocker keeps its dependents blocked, and says so
  perform register_plan(v, 'r', '[{"key":"a"},{"key":"b","blocked_by":["a"]}]');
  perform cancel_step((select id from plan_steps where plan = 'r' and key = 'a'));
  assert (select o_state from plan_status(v, 'r') where o_key = 'b') = 'blocked_by_cancelled',
    '16 a cancelled blocker leaves b blocked_by_cancelled';
  assert not exists (select 1 from claim_ready_step(v, 'r', gen_random_uuid(), 'w', interval '1 second')),
    '17 and nothing in that plan can be claimed';
  raise notice 'all 17 dependency checks passed';
end $$;
