-- my_places (20261013230000_my_places.sql, CL-3.12, issue #79): one read
-- of where the caller's person stands in every line. Places are taken
-- through request_work; time is moved, and a step occupied, as the table
-- owner on the one row a test is about, as waiting_test.sql does.
--
-- Ana owns, Cal is a viewer, Dee not a member; Ben and the rest are editors.

insert into t.ids values
  ('eva', '00000000-0000-0000-0000-0000000000e1'), ('fay', '00000000-0000-0000-0000-0000000000e2'),
  ('gus', '00000000-0000-0000-0000-0000000000e3'),
  ('ivy', '00000000-0000-0000-0000-0000000000e5'), ('jon', '00000000-0000-0000-0000-0000000000e6');
insert into t.ids select 'mp', t.run('ana', $q$select public.create_vault('My places')$q$)::uuid;
select test_support.add_member(t.id('mp'), t.id(p), 'editor', t.id('ana'))
  from unnest(array['ben', 'eva', 'fay', 'gus', 'ivy', 'jon']) p;
select test_support.add_member(t.id('mp'), t.id('cal'), 'viewer', t.id('ana'));

create table t.vals (name text primary key, val text);
create function t.save(p_name text, p_val text) returns text language sql as $$
  insert into t.vals values (p_name, p_val) on conflict (name) do update set val = excluded.val returning val
$$;
create function t.val(p_name text) returns text language sql as $$ select val from t.vals where name = p_name $$;

create function t.plan(p_vault text, p_path text, p_steps jsonb) returns text language sql as $$
  select t.run('ana', format($q$select public.write_file(%L, %L, 'a plan')::text$q$, t.id(p_vault), p_path));
  select t.run('ana', format($q$select public.register_work_plan(%L, %L, %L, %L::jsonb)::text$q$, t.id(p_vault), p_path,
    (select current_version_id from public.files where vault_id = t.id(p_vault) and path = p_path), p_steps::text));
$$;
create function t.plan_id(p_vault text, p_path text) returns uuid language sql as $$
  select id from public.work_plans where vault_id = t.id(p_vault) and path = p_path
$$;
create function t.rw_sql(p_vault text, p_path text) returns text language sql as $$
  select format($q$select o_state from public.request_work(%L, %L)$q$, t.id(p_vault), p_path)
$$;
-- Ana works p_key for p_minutes, written as the table owner so setup isn't held to her caps.
create function t.occupy(p_vault text, p_path text, p_key text, p_minutes int) returns void language sql as $$
  update public.work_plan_steps set status = 'claimed', fence = fence + 1, holder = t.id('ana'),
         claimed_at = clock_timestamp(), expires_at = clock_timestamp() + p_minutes * interval '1 minute'
   where plan_id = t.plan_id(p_vault, p_path) and key = p_key
$$;
-- What my_places says, one row per item: path, state, place, step.
create function t.mine_sql() returns text language sql as $$
  select $q$select coalesce(string_agg(format('%s %s %s %s', coalesce(o_path, '-'), o_state, coalesce(o_place::text, '-'), coalesce(o_step, '-')), '; ' order by o_path nulls first, o_state), '')
           from public.my_places()$q$
$$;
create function t.mine(p_user text) returns text language sql as $$ select t.run(p_user, t.mine_sql()) $$;
create function t.mine_at(p_user text, p_path text, p_state text) returns timestamptz language sql as $$
  select t.run(p_user, format($q$select o_at::text from public.my_places() where o_path = %L and o_state = %L$q$, p_path, p_state))::timestamptz
$$;

-- p/wait.md: one step, Ana's for 30 minutes; Eva, then Ben, wait for it.
select t.plan('mp', 'p/wait.md', '[{"key":"a","title":"A"}]');
select t.occupy('mp', 'p/wait.md', 'a', 30);
select t.run('eva', t.rw_sql('mp', 'p/wait.md'));
select t.run('ben', t.rw_sql('mp', 'p/wait.md'));

select t.expect('my places: waiting shows the caller''s place in line', t.mine('ben'), 'p/wait.md waiting 2 -');
select t.expect('my places: the first in line is number 1', t.mine('eva'), 'p/wait.md waiting 1 -');
select t.expect_true('my places: waiting suggests the earliest lease end, as request_work would',
  t.mine_at('ben', 'p/wait.md', 'waiting')
    = (select expires_at from public.work_plan_steps where plan_id = t.plan_id('mp', 'p/wait.md') and key = 'a'));
-- Set the place's gap past the lease end: asking before it only repeats the answer.
update public.work_plan_places set next_allowed_at = clock_timestamp() + interval '40 minutes'
 where plan_id = t.plan_id('mp', 'p/wait.md') and holder = t.id('ben');
select t.expect_true('my places: the suggested time is never before the place may ask again',
  t.mine_at('ben', 'p/wait.md', 'waiting') = (select next_allowed_at from public.work_plan_places
                                                where plan_id = t.plan_id('mp', 'p/wait.md') and holder = t.id('ben')));

-- Holding, and at capacity: Fay waits on p/wait.md, then is granted p/hold.md;
-- one step per connection (the Org preset) puts her place at capacity.
select t.plan('mp', 'p/hold.md', '[{"key":"h","title":"H"}]');
select t.run('fay', t.rw_sql('mp', 'p/wait.md'));
select t.expect('my places: setup, Fay is granted p/hold.md', t.run('fay', t.rw_sql('mp', 'p/hold.md')), 'granted');
select t.expect('my places: a held step is holding, and a place while at the cap is at_capacity',
  t.mine('fay'), 'p/hold.md holding - h; p/wait.md at_capacity - -');
select t.expect_true('my places: holding says when the lease ends',
  t.mine_at('fay', 'p/hold.md', 'holding')
    = (select expires_at from public.work_plan_steps where plan_id = t.plan_id('mp', 'p/hold.md') and key = 'h'));

-- Plan complete: Gus waits on p/done.md, whose one step then finishes.
select t.plan('mp', 'p/done.md', '[{"key":"d","title":"D"}]');
select t.occupy('mp', 'p/done.md', 'd', 30);
select t.run('gus', t.rw_sql('mp', 'p/done.md'));
update public.work_plan_steps set status = 'done', done_at = clock_timestamp() where plan_id = t.plan_id('mp', 'p/done.md');
select t.expect('my places: a place on a finished plan is plan_complete', t.mine('gus'), 'p/done.md plan_complete - -');

-- Lapsed: Eva, first in line, stopped checking in.
update public.work_plan_places set expires_at = clock_timestamp() - interval '1 second', next_allowed_at = clock_timestamp() - interval '1 second'
 where plan_id = t.plan_id('mp', 'p/wait.md') and holder = t.id('eva');
select t.expect('my places: a place that ran out is lapsed, with no rank', t.mine('eva'), 'p/wait.md lapsed - -');
select t.expect('my places: a lapsed place ahead doesn''t count in the rank of those behind', t.mine('ben'), 'p/wait.md waiting 1 -');

-- Cooling down: Ivy's strike, and a place she still has.
select t.run('ivy', t.rw_sql('mp', 'p/wait.md'));
insert into private.work_plan_strikes (vault_id, person, strikes, cooldown_until, last_at)
values (t.id('mp'), t.id('ivy'), 2, clock_timestamp() + interval '2 hours', clock_timestamp());
select t.expect('my places: cooling down is said for the vault, and for each place in it',
  t.mine('ivy'), '- cooling_down - -; p/wait.md cooling_down - -');
select t.expect_true('my places: cooling down says until when',
  t.run('ivy', $q$select o_at::text from public.my_places() where o_path is null$q$)::timestamptz
    = (select cooldown_until from private.work_plan_strikes where vault_id = t.id('mp') and person = t.id('ivy')));

-- It writes nothing.
select t.save('before', (select md5(string_agg(pl::text, ',' order by pl.id)) || (select max(seq)::text from public.log)
  from public.work_plan_places pl));
select t.run('ben', format('select count(*)::text from generate_series(1, 20), lateral (%s) x', t.mine_sql()));
select t.expect('my places: asking writes nothing: no place changes and nothing is logged',
  (select md5(string_agg(pl::text, ',' order by pl.id)) || (select max(seq)::text from public.log) from public.work_plan_places pl),
  t.val('before'));

-- Ten plans across four vaults, in one call.
insert into t.ids select 'mp' || n, t.run('ana', format($q$select public.create_vault('My places %s')$q$, n))::uuid from generate_series(1, 4) n;
select test_support.add_member(t.id('mp' || n), t.id('jon'), 'editor', t.id('ana')) from generate_series(1, 4) n;
select t.plan('mp' || (1 + n / 3), 'ten/' || n || '.md', '[{"key":"a","title":"A"}]'),
       t.occupy('mp' || (1 + n / 3), 'ten/' || n || '.md', 'a', 30)
  from generate_series(0, 9) n;
select t.run('jon', t.rw_sql('mp' || (1 + n / 3), 'ten/' || n || '.md')) from generate_series(0, 9) n;
select t.expect('my places: one call answers for places on ten plans in four vaults',
  t.run('jon', $q$select count(*) filter (where o_state = 'waiting' and o_place = 1)::text from public.my_places()$q$), '10');

-- Hostile: nobody learns about anyone else's places or claims.
select t.expect('my places: Ana sees her own claims, never the places of those waiting on them',
  t.mine('ana'), 'p/wait.md holding - a; ten/0.md holding - a; ten/1.md holding - a; ten/2.md holding - a; ten/3.md holding - a; ten/4.md holding - a; ten/5.md holding - a; ten/6.md holding - a; ten/7.md holding - a; ten/8.md holding - a; ten/9.md holding - a');
select t.expect('my places: a viewer with no place is told nothing about anyone''s', t.mine('cal'), '');
select t.expect('my places: an outsider is told nothing', t.mine('dee'), '');
select t.run('jon', format($q$select public.create_access_token('jon-mp1', 30, array[%L]::uuid[], 'read')$q$, t.id('mp1')));
select t.expect('my places: a connection scoped to one vault sees only that vault''s places',
  t.run_tok('jon', 'jon-mp1', t.mine_sql()), 'ten/0.md waiting 1 -; ten/1.md waiting 1 -; ten/2.md waiting 1 -');
select t.run('ana', format($q$select public.create_access_token('ana-mp2', 30, array[%L]::uuid[], 'read')$q$, t.id('mp2')));
select t.expect('my places: a connection scoped to another vault sees none of this one''s claims',
  t.run_tok('ana', 'ana-mp2', t.mine_sql()), 'ten/3.md holding - a; ten/4.md holding - a; ten/5.md holding - a');
select t.expect('my places: anonymous callers can''t ask', t.run(null, t.mine_sql()), 'ERR 42501');

-- Ben is first in line now (Eva's place lapsed); Ana's lease on the step runs out.
update public.work_plan_places set next_allowed_at = clock_timestamp() - interval '1 second'
 where plan_id = t.plan_id('mp', 'p/wait.md') and holder = t.id('ben');
update public.work_plan_steps set expires_at = clock_timestamp() - interval '1 second'
 where plan_id = t.plan_id('mp', 'p/wait.md') and key = 'a';
select t.expect_true('my places: with a step free for the caller''s place, it suggests asking now',
  t.mine_at('ben', 'p/wait.md', 'waiting') <= clock_timestamp());
