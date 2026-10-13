-- The adversary suite for waiting in line (CL-3.10, issue #77; docs/design.md
-- "Claims and work plans" item 12), ported from spikes/claims/guard_semantics.sql
-- onto request_work, leave_queue and the step functions. Each test is
-- something a misbehaving agent would try. waiting_test.sql proves the
-- rules as designed; this file proves they hold against someone trying to
-- get around them. Crowds and load are web/test/races.test.mjs's.
--
-- The spike ran its agent as a restricted database role that could execute
-- the agent functions and nothing else. Here agents and people share the
-- `authenticated` role (an agent is its person, through a connection: an
-- access token), so "one way in" is: no API role can write places, strikes
-- or steps, read a strike or a place's clock, or run the private functions
-- request_work is built from; request_work, leave_queue and the step
-- functions are the only way in, and each takes its identity from the
-- session. Checked both ways: as an agent through its connection trying it,
-- and from the catalog, so each layer is proved on its own.
--
-- Time is moved as the table owner on the one row a test is about, as in
-- waiting_test.sql.
--
-- Ana owns; Ben (four connections), Eva, Fay, Gus, Hal and Ivy are editors.
-- Claim rule on g/: lease 10 minutes, hold limit 15, one step per
-- connection, two per person, a place lives 30 minutes, longest hint 5
-- minutes, minimum gap 10 seconds, 1 free lapse, cooldown at most 25 minutes.

insert into t.ids values
  ('eva', '00000000-0000-0000-0000-0000000000e1'), ('fay', '00000000-0000-0000-0000-0000000000e2'),
  ('gus', '00000000-0000-0000-0000-0000000000e3'), ('hal', '00000000-0000-0000-0000-0000000000e4'),
  ('ivy', '00000000-0000-0000-0000-0000000000e5');
insert into t.ids select 'adv', t.run('ana', $q$select public.create_vault('Adversary')$q$)::uuid;
select test_support.add_member(t.id('adv'), t.id(p), 'editor', t.id('ana'))
  from unnest(array['ben', 'eva', 'fay', 'gus', 'hal', 'ivy']) p;
select t.run('ben', format($q$select public.create_access_token(%L, 30, array[%L]::uuid[], 'write')$q$, n, t.id('adv')))
  from unnest(array['ben-1', 'ben-2', 'ben-3', 'ben-4']) n;
select t.run('ana', format($q$select public.set_claim_rule(%L, 'g/', 10, 15, null, 1, 2, 30, 5, 10, 1, 25)::text$q$, t.id('adv')));

create table t.vals (name text primary key, val text);
create function t.save(p_name text, p_val text) returns text language sql as $$
  insert into t.vals values (p_name, p_val) on conflict (name) do update set val = excluded.val returning val
$$;
create function t.j(p_name text) returns jsonb language sql as $$ select val::jsonb from t.vals where name = p_name $$;

create function t.plan(p_path text, p_steps jsonb) returns text language sql as $$
  select t.run('ana', format($q$select public.write_file(%L, %L, 'a plan')::text$q$, t.id('adv'), p_path));
  select t.run('ana', format($q$select public.register_work_plan(%L, %L, %L, %L::jsonb)::text$q$, t.id('adv'), p_path,
    (select current_version_id from public.files where vault_id = t.id('adv') and path = p_path), p_steps::text));
$$;
create function t.plan_id(p_path text) returns uuid language sql as $$
  select id from public.work_plans where vault_id = t.id('adv') and path = p_path
$$;
create function t.rw_sql(p_path text) returns text language sql as $$
  select format($q$select to_jsonb(r)::text from public.request_work(%L, %L) r$q$, t.id('adv'), p_path)
$$;
create function t.answer(p_got text) returns jsonb language sql as $$
  select case when p_got like 'ERR %' then jsonb_build_object('o_state', p_got) else p_got::jsonb end
$$;
create function t.rw(p_user text, p_path text) returns jsonb language sql as $$
  select t.answer(t.run(p_user, t.rw_sql(p_path)))
$$;
create function t.rw_tok(p_user text, p_tok text, p_path text) returns jsonb language sql as $$
  select t.answer(t.run_tok(p_user, p_tok, t.rw_sql(p_path)))
$$;
-- complete_step, checkin_step or release_step on a saved grant, as p_user
-- through p_tok (null: their web session), with the fence and secret given.
create function t.step_call(p_fn text, p_user text, p_tok text, p_path text, p_grant text,
  p_fence int default null, p_secret text default null) returns text language sql as $$
  select case when p_tok is null then t.run(p_user, q) else t.run_tok(p_user, p_tok, q) end
    from (select format($q$select public.%s(%L, %L, %L, %L, %L)::text$q$, p_fn, t.id('adv'), p_path, t.j(p_grant)->>'o_key',
            coalesce(p_fence, (t.j(p_grant)->>'o_fence')::int), coalesce(p_secret, t.j(p_grant)->>'o_secret')) as q) x
$$;
create function t.later(p_user text, p_path text) returns void language sql as $$
  update public.work_plan_places set next_allowed_at = clock_timestamp() - interval '1 second'
   where plan_id = t.plan_id(p_path) and holder = t.id(p_user)
$$;
create function t.lapse_step(p_path text, p_key text) returns void language sql as $$
  update public.work_plan_steps set expires_at = clock_timestamp() - interval '1 second'
   where plan_id = t.plan_id(p_path) and key = p_key
$$;
-- Someone outside the line is working p_key: Ana's claim, written as the
-- table owner, since claim_step keeps the caps (20261013220000) and the
-- g/ rule lets her hold only two.
create function t.occupy(p_path text, p_key text) returns void language sql as $$
  update public.work_plan_steps set status = 'claimed', fence = fence + 1, holder = t.id('ana'),
         claimed_at = clock_timestamp(), expires_at = clock_timestamp() + interval '10 minutes'
   where plan_id = t.plan_id(p_path) and key = p_key
$$;
-- p_user asks p_n times, each a full evaluation (its gap passed), and
-- gives the distinct answers, as "state place ready".
create function t.ask_again(p_user text, p_path text, p_n int) returns text language plpgsql as $$
declare a jsonb; seen text[] := '{}'; k int;
begin
  for k in 1..p_n loop
    perform t.later(p_user, p_path);
    a := t.rw(p_user, p_path);
    seen := array(select distinct unnest(seen || format('%s %s %s', a->>'o_state', a->>'o_place', a->>'o_ready')) order by 1);
  end loop;
  return array_to_string(seen, ', ');
end $$;

-- ---------------------------------------------------------------------------
-- One way in

select t.plan('g/door.md', '[{"key":"a","title":"A"}]');
select t.save('eva-door', t.rw('eva', 'g/door.md')::text);
select t.rw_tok('ben', 'ben-1', 'g/door.md');
insert into private.work_plan_strikes (vault_id, person, strikes, last_at) values (t.id('adv'), t.id('ben'), 1, now());

select t.expect('adversary: an agent through its connection can''t write, read or back-date a place, a step or a strike directly',
  (select string_agg(t.run_tok('ben', 'ben-1', q), ',' order by n) from unnest(array[
    format($q$insert into public.work_plan_places (plan_id, vault_id, holder, expires_at, next_allowed_at, last_place, last_ready)
              values (%L, %L, %L, now() + interval '1 hour', now(), 1, 0) returning 'took'$q$, t.plan_id('g/door.md'), t.id('adv'), t.id('ben')),
    $q$update public.work_plan_places set created_at = '2000-01-01' returning 'moved up'$q$,
    $q$update public.work_plan_places set next_allowed_at = now(), expires_at = now() + interval '1 year' returning 'kept'$q$,
    $q$select next_allowed_at::text from public.work_plan_places$q$,
    $q$delete from public.work_plan_places returning 'removed'$q$,
    $q$update public.work_plan_steps set open_blockers = 0 returning 'unblocked'$q$,
    $q$update public.work_plan_steps set status = 'open', holder = null returning 'freed'$q$,
    $q$update public.work_plan_steps set claimed_at = now() returning 'held longer'$q$,
    $q$select secret_hash from public.work_plan_steps$q$,
    $q$select count(*)::text from private.work_plan_strikes$q$,
    $q$delete from private.work_plan_strikes returning 'cleared'$q$,
    $q$update private.work_plan_strikes set cooldown_until = null returning 'cooled'$q$]) with ordinality u(q, n)),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501');
select t.expect_true('adversary: none of those attempts changed a place, a step or a strike',
  (select count(*) from public.work_plan_places where plan_id = t.plan_id('g/door.md')) = 1
  and (select bool_and(created_at > now() - interval '1 minute') from public.work_plan_places where plan_id = t.plan_id('g/door.md'))
  and (select status = 'claimed' and holder = t.id('eva') from public.work_plan_steps where plan_id = t.plan_id('g/door.md'))
  and (select strikes = 1 from private.work_plan_strikes where vault_id = t.id('adv') and person = t.id('ben')));
delete from private.work_plan_strikes where vault_id = t.id('adv');

select t.expect('adversary: no API role holds a write on places, steps or strikes, or reads a strike, a place''s clock or a step''s secret',
  (select coalesce(string_agg(format('%s %s', r, what), ', ' order by r, what), '')
     from unnest(array['anon', 'authenticated', 'reliquary_web', 'reliquary_mcp']) r,
     lateral (values
       ('writes places', has_table_privilege(r, 'public.work_plan_places', 'insert,update,delete,truncate')),
       ('reads a place''s clock', has_column_privilege(r, 'public.work_plan_places', 'next_allowed_at', 'select')
                                  or has_column_privilege(r, 'public.work_plan_places', 'last_place', 'select')),
       ('writes steps', has_table_privilege(r, 'public.work_plan_steps', 'insert,update,delete,truncate')),
       ('reads a step''s secret', has_column_privilege(r, 'public.work_plan_steps', 'secret_hash', 'select')),
       ('touches strikes', has_table_privilege(r, 'private.work_plan_strikes', 'select,insert,update,delete,truncate'))
     ) v(what, held)
    where held), '');

select t.expect('adversary: no API role can run the functions request_work is built from',
  (select coalesce(string_agg(format('%s %s', r, f), ', ' order by r, f), '')
     from unnest(array['anon', 'authenticated', 'reliquary_web', 'reliquary_mcp']) r,
          unnest(array['private.queue_rule_for(uuid,text)', 'private.place_ended(uuid,uuid,text,text,uuid,text)',
                       'private.give_up_places(uuid,uuid,text)', 'private.strike(uuid,uuid,int,int,int)',
                       'private.unblock_dependents(bigint)']) f
    where has_function_privilege(r, f, 'execute')), '');
select t.expect('adversary: an agent calling them anyway is refused: striking someone, ending their places, unblocking a step',
  (select string_agg(t.run_tok('ben', 'ben-1', q), ',' order by n) from unnest(array[
    format($q$select private.strike(%L, %L, 10, 0, 25)::text$q$, t.id('adv'), t.id('eva')),
    format($q$select private.give_up_places(%L, %L, 'cooling_down')::text$q$, t.id('adv'), t.id('eva')),
    format($q$select private.unblock_dependents(%s)::text$q$, (select min(id) from public.work_plan_steps where vault_id = t.id('adv'))),
    format($q$select (private.queue_rule_for(%L, 'g/door.md')).min_gap_seconds::text$q$, t.id('adv'))]) with ordinality u(q, n)),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501');

select t.expect('adversary: with no one signed in, nothing answers and no one is seen waiting',
  t.run(null, t.rw_sql('g/door.md'))
  || ',' || t.run(null, format($q$select public.leave_queue(%L, 'g/door.md')::text$q$, t.id('adv')))
  || ',' || t.run(null, $q$select count(*)::text from public.work_plan_places$q$)
  || ',' || t.run_claims('{"role": "authenticated"}', t.rw_sql('g/door.md'))
  || ',' || t.run_claims('{"role": "authenticated"}', format($q$select public.leave_queue(%L, 'g/door.md')::text$q$, t.id('adv')))
  || ',' || t.run_claims('{"role": "authenticated"}', $q$select count(*)::text from public.work_plan_places$q$),
  'ERR 42501,ERR 42501,ERR 42501,ERR 28000,ERR 28000,0');
select t.step_call('complete_step', 'eva', null, 'g/door.md', 'eva-door');
select t.run_tok('ben', 'ben-1', format($q$select public.leave_queue(%L, 'g/door.md')::text$q$, t.id('adv')));

-- ---------------------------------------------------------------------------
-- A blocked step is never granted

select t.plan('g/chain.md', '[{"key":"s1","title":"S1"},{"key":"s2","title":"S2","blocked_by":["s1"]},{"key":"s3","title":"S3","blocked_by":["s2"]}]');
select t.save('eva-s1', t.rw('eva', 'g/chain.md')::text);
select t.expect('adversary: the only unblocked step is granted', (t.j('eva-s1')->>'o_state') || ' ' || (t.j('eva-s1')->>'o_key'), 'granted s1');
select t.rw('fay', 'g/chain.md');
select t.expect('adversary: a blocked step is never granted, however many times it is asked for (50 full evaluations)',
  t.ask_again('fay', 'g/chain.md', 50), 'wait 1 0');
select t.expect('adversary: nor through the person''s other connections',
  (select string_agg(t.rw_tok('ben', tok, 'g/chain.md')->>'o_state', ' ' order by tok) from unnest(array['ben-2', 'ben-3']) tok)
  || ' ' || (select count(*) from public.work_plan_steps where plan_id = t.plan_id('g/chain.md') and status = 'claimed'),
  'wait wait 1');
select t.step_call('complete_step', 'eva', null, 'g/chain.md', 'eva-s1');
select t.later('fay', 'g/chain.md');
select t.save('fay-s2', t.rw('fay', 'g/chain.md')::text);
select t.expect('adversary: once its blocker is done, the step goes to the first in line',
  (t.j('fay-s2')->>'o_state') || ' ' || (t.j('fay-s2')->>'o_key'), 'granted s2');
select t.step_call('complete_step', 'fay', null, 'g/chain.md', 'fay-s2');
select t.run('ben', format($q$select public.leave_queue(%L, 'g/chain.md')::text$q$, t.id('adv')));

-- ---------------------------------------------------------------------------
-- Asking too soon costs nothing

create table t.writes (n bigint not null);
insert into t.writes values (0);
create function t.count_write() returns trigger language plpgsql as $$
begin update t.writes set n = n + 1; return null; end $$;
create trigger zz_count after insert or update or delete on public.work_plan_places for each statement execute function t.count_write();
create trigger zz_count after insert or update or delete on public.work_plan_steps for each statement execute function t.count_write();
create trigger zz_count after insert or update or delete on private.work_plan_strikes for each statement execute function t.count_write();
create trigger zz_count after insert on public.log for each statement execute function t.count_write();

select t.plan('g/rate.md', '[{"key":"a","title":"A"}]');
select t.save('hal-rate', t.rw('hal', 'g/rate.md')::text);
select t.expect('adversary: the caller takes a place in line', t.rw('gus', 'g/rate.md')->>'o_state', 'wait');
select t.save('writes-before', (select n::text from t.writes));
select t.expect('adversary: a caller back before its gap is answered wait every time',
  t.run('gus', format($q$select string_agg(distinct r.o_state, ',') from generate_series(1, 1000) n, lateral public.request_work(%L, 'g/rate.md') r$q$,
    t.id('adv')), 'Claude Code'), 'wait');
select t.expect_true('adversary: 1,000 back-to-back calls cause at most 2 writes',
  (select n from t.writes) - (select val::bigint from t.vals where name = 'writes-before') <= 2,
  format('%s writes', (select n from t.writes) - (select val::bigint from t.vals where name = 'writes-before')));
drop trigger zz_count on public.work_plan_places;
drop trigger zz_count on public.work_plan_steps;
drop trigger zz_count on private.work_plan_strikes;
drop trigger zz_count on public.log;
select t.step_call('complete_step', 'hal', null, 'g/rate.md', 'hal-rate');

-- ---------------------------------------------------------------------------
-- Out of turn

select t.plan('g/stale.md', '[{"key":"a","title":"A"}]');
select t.save('hal-stale', t.rw('hal', 'g/stale.md')::text);
select t.rw('ivy', 'g/stale.md');
select t.rw('gus', 'g/stale.md');
select t.lapse_step('g/stale.md', 'a');
select t.expect('adversary: a younger place asking again and again never takes the step the oldest is owed',
  t.ask_again('gus', 'g/stale.md', 20), 'wait 2 1');
select t.save('hal-back', t.rw('hal', 'g/stale.md')::text);
select t.expect('adversary: a stale holder goes to the back of the line',
  (t.j('hal-back')->>'o_state') || ' ' || (t.j('hal-back')->>'o_place'), 'wait 3');
select t.later('ivy', 'g/stale.md');
select t.save('ivy-stale', t.rw('ivy', 'g/stale.md')::text);
select t.expect('adversary: and the first in line gets the stale step',
  (t.j('ivy-stale')->>'o_state') || ' ' || (t.j('ivy-stale')->>'o_fence'), 'granted 2');
select t.step_call('complete_step', 'ivy', null, 'g/stale.md', 'ivy-stale');

-- ---------------------------------------------------------------------------
-- Caps

select t.plan('g/hoard.md', '[{"key":"h1","title":"H1"},{"key":"h2","title":"H2"},{"key":"h3","title":"H3"},{"key":"h4","title":"H4"},{"key":"h5","title":"H5"}]');
select t.save('ben1-hoard', t.rw_tok('ben', 'ben-1', 'g/hoard.md')::text);
select t.expect('adversary: a connection holding its one step is refused every further step, with four more ready',
  (t.j('ben1-hoard')->>'o_state') || ' ' || (select string_agg(t.rw_tok('ben', 'ben-1', 'g/hoard.md')->>'o_state', ' ') from generate_series(1, 4)),
  'granted at_capacity at_capacity at_capacity at_capacity');
select t.save('ben2-hoard', t.rw_tok('ben', 'ben-2', 'g/hoard.md')::text);
select t.expect('adversary: a person''s third connection is refused at the person''s cap of two',
  (t.j('ben2-hoard')->>'o_state') || ' ' || (t.rw_tok('ben', 'ben-3', 'g/hoard.md')->>'o_state') || ' ' || (t.rw('ben', 'g/hoard.md')->>'o_state'),
  'granted at_capacity at_capacity');
select t.expect('adversary: another person still gets work', t.rw('fay', 'g/hoard.md')->>'o_state', 'granted');
select t.expect('adversary: the hoarder holds exactly one step per connection, two in all',
  (select string_agg(coalesce(tk.name, 'web'), ' ' order by tk.name) from public.work_plan_steps st
     left join public.access_tokens tk on tk.id = st.holder_token
    where st.plan_id = t.plan_id('g/hoard.md') and st.holder = t.id('ben') and st.status = 'claimed'), 'ben-1 ben-2');
select t.step_call('complete_step', 'ben', 'ben-1', 'g/hoard.md', 'ben1-hoard');
select t.step_call('complete_step', 'ben', 'ben-2', 'g/hoard.md', 'ben2-hoard');

select t.plan(p, '[{"key":"a","title":"A"}]') from unnest(array['g/t1.md', 'g/t2.md', 'g/t3.md', 'g/t4.md']) p;
select t.occupy(p, 'a') from unnest(array['g/t1.md', 'g/t2.md', 'g/t3.md', 'g/t4.md']) p;
select t.expect('adversary: a person takes three places in line, each from a different connection',
  (select string_agg(t.rw_tok('ben', tok, p)->>'o_state', ' ' order by tok)
     from (values ('ben-1', 'g/t1.md'), ('ben-2', 'g/t2.md'), ('ben-3', 'g/t3.md')) x(tok, p)), 'wait wait wait');
select t.expect('adversary: a fourth place in line is refused, asked from a fourth connection',
  t.rw_tok('ben', 'ben-4', 'g/t4.md')->>'o_state', 'refused');
select t.run_tok('ben', 'ben-1', format($q$select public.leave_queue(%L, 'g/t1.md')::text$q$, t.id('adv')));
select t.expect('adversary: once the person leaves one line, the fourth is allowed', t.rw_tok('ben', 'ben-4', 'g/t4.md')->>'o_state', 'wait');

-- ---------------------------------------------------------------------------
-- A leaked secret

select t.plan('g/steal.md', '[{"key":"a","title":"A"}]');
select t.save('ben-steal', t.rw_tok('ben', 'ben-1', 'g/steal.md')::text);
select t.expect('adversary: a leaked secret is useless to another person''s connection: it can''t finish, check in or give back the step',
  t.step_call('complete_step', 'eva', null, 'g/steal.md', 'ben-steal')
  || ',' || t.step_call('checkin_step', 'eva', null, 'g/steal.md', 'ben-steal')
  || ',' || t.step_call('release_step', 'eva', null, 'g/steal.md', 'ben-steal'),
  'ERR RLW03,ERR RLW03,ERR RLW03');
select t.expect('adversary: and useless to the same person''s other connection',
  t.step_call('complete_step', 'ben', 'ben-2', 'g/steal.md', 'ben-steal')
  || ',' || t.step_call('checkin_step', 'ben', 'ben-2', 'g/steal.md', 'ben-steal')
  || ',' || t.step_call('release_step', 'ben', 'ben-2', 'g/steal.md', 'ben-steal')
  || ',' || t.step_call('complete_step', 'ben', null, 'g/steal.md', 'ben-steal'),
  'ERR RLW03,ERR RLW03,ERR RLW03,ERR RLW03');
select t.expect('adversary: the holding connection with a wrong secret or fence is refused too',
  t.step_call('complete_step', 'ben', 'ben-1', 'g/steal.md', 'ben-steal', null, repeat('0', 64))
  || ',' || t.step_call('complete_step', 'ben', 'ben-1', 'g/steal.md', 'ben-steal', 2),
  'ERR RLW03,ERR RLW03');
select t.save('ben-steal-done', t.step_call('complete_step', 'ben', 'ben-1', 'g/steal.md', 'ben-steal'));
select t.expect('adversary: only the connection granted the step, with its fence and secret, finishes it',
  (select val from t.vals where name = 'ben-steal-done') || ' ' || (select status from public.work_plan_steps where plan_id = t.plan_id('g/steal.md')), ' done');

-- ---------------------------------------------------------------------------
-- The hold limit

select t.plan('g/hold.md', '[{"key":"a","title":"A"}]');
select t.save('ben-hold', t.rw_tok('ben', 'ben-1', 'g/hold.md')::text);
update public.work_plan_steps set claimed_at = claimed_at - interval '10 minutes' where plan_id = t.plan_id('g/hold.md');
select t.save('ben-hold-in', t.step_call('checkin_step', 'ben', 'ben-1', 'g/hold.md', 'ben-hold'));
select t.expect_true('adversary: a check-in never extends a claim past the hold limit (15 minutes from the grant, not a 10 minute lease from now)',
  (select val::timestamptz from t.vals where name = 'ben-hold-in')
    between (select claimed_at + interval '15 minutes' - interval '1 second' from public.work_plan_steps where plan_id = t.plan_id('g/hold.md'))
        and (select claimed_at + interval '15 minutes' from public.work_plan_steps where plan_id = t.plan_id('g/hold.md')),
  (select val from t.vals where name = 'ben-hold-in'));
update public.work_plan_steps set claimed_at = claimed_at - interval '6 minutes' where plan_id = t.plan_id('g/hold.md');
select t.expect('adversary: past the hold limit no check-in is accepted',
  t.step_call('checkin_step', 'ben', 'ben-1', 'g/hold.md', 'ben-hold'), 'ERR RLW04');
select t.lapse_step('g/hold.md', 'a');
select t.save('eva-hold', t.rw('eva', 'g/hold.md')::text);
select t.expect('adversary: and once its lease lapses, the step goes to the next caller',
  (t.j('eva-hold')->>'o_state') || ' ' || (t.j('eva-hold')->>'o_fence'), 'granted 2');
select t.step_call('complete_step', 'eva', null, 'g/hold.md', 'eva-hold');

-- ---------------------------------------------------------------------------
-- After every scenario

select t.expect('adversary: every step''s stored count of unfinished blockers matches the plan after all of it',
  (select coalesce(string_agg(s.key, ' '), '') from public.work_plan_steps s
    where s.vault_id = t.id('adv')
      and s.open_blockers <> (select count(*) from public.work_plan_step_blockers d join public.work_plan_steps b on b.id = d.blocker_id
                               where d.step_id = s.id and b.status <> 'done')), '');
