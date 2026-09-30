-- 11 edge-case checks for claim / renew / release. Any failed assert aborts.
do $$
declare
  v uuid := '00000000-0000-0000-0000-000000000001';
  a record; b record; c record;
  p text := 'canon/brief.md';
begin
  select * into a from claim(v, p, gen_random_uuid(), 'agent-A', interval '1 second');
  assert a.o_granted and a.o_fence = 1,                     '1 first claim granted, fence 1';
  select * into b from claim(v, p, gen_random_uuid(), 'agent-B', interval '1 second');
  assert not b.o_granted and b.o_holder = 'agent-A',        '2 second claim refused and names the holder';
  assert renew(v, p, a.o_fence, a.o_secret, interval '1 second'), '3 holder can renew';
  assert not renew(v, p, a.o_fence, 'wrong-secret', interval '1 second'), '4 wrong secret cannot renew';
  assert not renew(v, p, a.o_fence + 1, a.o_secret, interval '1 second'), '5 wrong fence cannot renew';
  perform pg_sleep(1.2);
  assert not renew(v, p, a.o_fence, a.o_secret, interval '1 second'), '6 renew after expiry refused even before anyone reclaims';
  select * into b from claim(v, p, gen_random_uuid(), 'agent-B', interval '1 second');
  assert b.o_granted and b.o_fence = 2,                     '7 reclaim after expiry, fence bumped to 2';
  assert not release(v, p, a.o_fence, a.o_secret),          '8 stale holder cannot release the new lease';
  assert not renew(v, p, a.o_fence, a.o_secret, interval '1 second'), '9 stale holder cannot renew the new lease';
  assert release(v, p, b.o_fence, b.o_secret),              '10 current holder releases';
  select * into c from claim(v, p, gen_random_uuid(), 'agent-C', interval '1 second');
  assert c.o_granted and c.o_fence = 3,                     '11 claim after release, fence 3';
  raise notice 'all 11 semantic checks passed';
end $$;
