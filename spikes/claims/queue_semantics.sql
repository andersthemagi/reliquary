-- 26 checks for claim rules, tickets and hints. Any failed assert aborts.
do $$
declare
  v uuid := '00000000-0000-0000-0000-000000000001';
  t1 uuid := gen_random_uuid(); t2 uuid := gen_random_uuid(); t3 uuid := gen_random_uuid(); t4 uuid := gen_random_uuid();
  x record; x1 record; x2 record; x3 record; e timestamptz;
begin
  -- rules: the org default, a per-prefix override, and the caller's request clamped
  insert into claim_rules values (v, 'hack/', interval '2 seconds', interval '1 hour', interval '3 seconds', interval '1 second');
  perform register_plan(v, 'org/p',  '[{"key":"a"}]');
  perform register_plan(v, 'org/p2', '[{"key":"a"}]');
  perform register_plan(v, 'org/p3', '[{"key":"a"}]');
  select * into x from request_work(v, 'org/p', t1, 'A');
  assert x.o_state = 'granted' and x.o_expires between now() + interval '47 hours 59 minutes' and now() + interval '48 hours 1 minute',
    '1 with no rule set, a claim lasts 48 hours';
  select * into x from request_work(v, 'org/p2', t1, 'A', interval '1 hour');
  assert x.o_expires between now() + interval '59 minutes' and now() + interval '61 minutes', '2 a shorter request is honoured';
  select * into x from request_work(v, 'org/p3', t1, 'A', interval '60 days');
  assert x.o_expires between now() + interval '29 days 23 hours' and now() + interval '30 days 1 hour', '3 a longer request is clamped to the maximum';
  perform register_plan(v, 'hack/a', '[{"key":"a"}]');
  select * into x from request_work(v, 'hack/a', t1, 'A');
  assert x.o_expires between now() + interval '1 second' and now() + interval '3 seconds', '4 a prefix rule overrides the default';

  -- a queue: first come, first served, no queue jumping
  perform register_plan(v, 'hack/q', '[{"key":"a"}]');
  select * into x1 from request_work(v, 'hack/q', t1, 'A1');
  assert x1.o_state = 'granted' and x1.o_fence = 1, '5 the first agent gets the step';
  select * into x2 from request_work(v, 'hack/q', t2, 'A2');
  assert x2.o_state = 'wait' and x2.o_rank = 1 and x2.o_ready = 0, '6 the second agent takes a ticket, rank 1';
  assert x2.o_check_ms between 50 and 1000, '7 and is told when to check again, within the cap';
  select * into x3 from request_work(v, 'hack/q', t3, 'A3');
  assert x3.o_state = 'wait' and x3.o_rank = 2, '8 the third is rank 2';
  select * into x3 from request_work(v, 'hack/q', t3, 'A3');
  assert x3.o_rank = 2, '9 checking again keeps its place';
  assert release_step(x1.o_id, x1.o_fence, x1.o_secret), '10 the first agent gives the step back';
  select * into x3 from request_work(v, 'hack/q', t3, 'A3');
  assert x3.o_state = 'wait' and x3.o_rank = 2 and x3.o_ready = 1, '11 rank 2 cannot jump ahead when one step is ready';
  select * into x2 from request_work(v, 'hack/q', t2, 'A2');
  assert x2.o_state = 'granted' and x2.o_fence = 2, '12 rank 1 gets it';
  assert complete_step(x2.o_id, x2.o_fence, x2.o_secret), '13 and finishes';
  select * into x3 from request_work(v, 'hack/q', t3, 'A3');
  assert x3.o_state = 'plan_complete', '14 the waiting agent is told the plan is finished, so it stops';
  assert not exists (select 1 from tickets where plan = 'hack/q'), '15 and no ticket is left behind';

  -- an agent that stops checking drops out of line
  perform register_plan(v, 'hack/r', '[{"key":"a"}]');
  select * into x1 from request_work(v, 'hack/r', t1, 'A1');
  perform request_work(v, 'hack/r', t2, 'A2');
  perform request_work(v, 'hack/r', t3, 'A3');
  assert release_step(x1.o_id, x1.o_fence, x1.o_secret);
  perform pg_sleep(1.5);
  select * into x3 from request_work(v, 'hack/r', t3, 'A3');
  assert x3.o_state = 'wait' and x3.o_rank = 2, '16 while the head is still live the next in line waits';
  perform pg_sleep(1.8);
  select * into x3 from request_work(v, 'hack/r', t3, 'A3');
  assert x3.o_state = 'granted', '17 once the head stopped checking in, the next in line gets it';
  select * into x2 from request_work(v, 'hack/r', t2, 'A2');
  assert x2.o_state = 'wait' and x2.o_rank = 1, '18 the agent that came back late starts at the back';

  -- a plan only a person can move
  perform register_plan(v, 'hack/c', '[{"key":"a"},{"key":"b","blocked_by":["a"]}]');
  perform cancel_step((select id from plan_steps where plan = 'hack/c' and key = 'a'));
  select * into x from request_work(v, 'hack/c', t1, 'A1');
  assert x.o_state = 'blocked_by_cancelled', '19 an agent is told the plan needs a person, not to keep polling';

  -- leaving the queue
  perform register_plan(v, 'hack/e', '[{"key":"a"}]');
  perform request_work(v, 'hack/e', t1, 'A1');
  perform request_work(v, 'hack/e', t2, 'A2');
  perform request_work(v, 'hack/e', t3, 'A3');
  assert leave_queue(v, 'hack/e', t2), '20 an agent can leave the queue';
  select * into x3 from request_work(v, 'hack/e', t3, 'A3');
  assert x3.o_rank = 1, '21 and those behind it move up';

  -- check-ins restart the lease
  perform register_plan(v, 'hack/d', '[{"key":"a"}]');
  select * into x1 from request_work(v, 'hack/d', t1, 'A1');
  perform pg_sleep(1.5);
  e := checkin_step(x1.o_id, x1.o_fence, x1.o_secret);
  assert e is not null and e > x1.o_expires, '22 a check-in extends the lease';
  perform pg_sleep(1.0);
  select * into x2 from request_work(v, 'hack/d', t2, 'A2');
  assert x2.o_state = 'wait', '23 past the original expiry, the claim still holds because of the check-in';
  perform pg_sleep(1.2);
  select * into x2 from request_work(v, 'hack/d', t2, 'A2');
  assert x2.o_state = 'granted', '24 after a silent lease the step can be taken';
  assert checkin_step(x1.o_id, x1.o_fence, x1.o_secret) is null, '25 the silent agent can no longer check in';
  assert complete_step(x2.o_id, x2.o_fence, x2.o_secret), '26 the new holder finishes';
  raise notice 'all 26 queue checks passed';
end $$;
