-- Waiting in line (20261013170000_waiting_in_line onwards, CL-3.9, issue
-- #74): places in line, request_work's answers, the rule "the k-th oldest
-- live place may claim only if at least k steps are ready", strikes and
-- the cooldown, and leave_queue. The crowd and lock-order races are
-- web/test/races.test.mjs's.
--
-- Time is moved the way work_plans_test.sql moves it: as the table owner,
-- on the one row a test is about (a place's next_allowed_at or expires_at,
-- a step's expires_at, a strike's cooldown_until).
--
-- Ana owns, Cal is a viewer, Dee not a member; Ben and eight more people
-- are editors, each working as themselves (one connection: the web
-- session) unless a test names a token.

insert into t.ids values
  ('eva', '00000000-0000-0000-0000-0000000000e1'), ('fay', '00000000-0000-0000-0000-0000000000e2'),
  ('gus', '00000000-0000-0000-0000-0000000000e3'), ('hal', '00000000-0000-0000-0000-0000000000e4'),
  ('ivy', '00000000-0000-0000-0000-0000000000e5'), ('jon', '00000000-0000-0000-0000-0000000000e6'),
  ('kim', '00000000-0000-0000-0000-0000000000e7'), ('lee', '00000000-0000-0000-0000-0000000000e8');
insert into t.ids select 'wq', t.run('ana', $q$select public.create_vault('Waiting')$q$)::uuid;
select test_support.add_member(t.id('wq'), t.id(p), 'editor', t.id('ana'))
  from unnest(array['ben', 'eva', 'fay', 'gus', 'hal', 'ivy', 'jon', 'kim', 'lee']) p;
select test_support.add_member(t.id('wq'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.create_access_token('wq-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('wq')));
select t.run('ben', format($q$select public.create_access_token('ben-a', 30, array[%L]::uuid[], 'write')$q$, t.id('wq')));
select t.run('ben', format($q$select public.create_access_token('ben-b', 30, array[%L]::uuid[], 'write')$q$, t.id('wq')));
insert into t.ids select 'wq-other', t.run('ana', $q$select public.create_vault('Waiting (other)')$q$)::uuid;
select t.run('ana', format($q$select public.create_access_token('wq-other-tok', 30, array[%L]::uuid[], 'write')$q$, t.id('wq-other')));

create table t.vals (name text primary key, val text);
create function t.save(p_name text, p_val text) returns text language sql as $$
  insert into t.vals values (p_name, p_val) on conflict (name) do update set val = excluded.val returning val
$$;
create function t.val(p_name text) returns text language sql as $$ select val from t.vals where name = p_name $$;
create function t.j(p_name text) returns jsonb language sql as $$ select val::jsonb from t.vals where name = p_name $$;

-- Writes p_path as Ana and registers its plan from that version.
create function t.plan(p_path text, p_steps jsonb) returns text language sql as $$
  select t.run('ana', format($q$select public.write_file(%L, %L, 'a plan')::text$q$, t.id('wq'), p_path));
  select t.run('ana', format($q$select public.register_work_plan(%L, %L, %L, %L::jsonb)::text$q$, t.id('wq'), p_path,
    (select current_version_id from public.files where vault_id = t.id('wq') and path = p_path), p_steps::text));
$$;
create function t.plan_id(p_path text) returns uuid language sql as $$
  select id from public.work_plans where vault_id = t.id('wq') and path = p_path
$$;
create function t.rw_sql(p_path text, p_label text default null, p_ttl int default null) returns text language sql as $$
  select format($q$select to_jsonb(r)::text from public.request_work(%L, %L, %L, %L) r$q$, t.id('wq'), p_path, p_label, p_ttl)
$$;
-- request_work's answer as jsonb, or {"o_state": "ERR <sqlstate>"}.
create function t.answer(p_got text) returns jsonb language sql as $$
  select case when p_got like 'ERR %' then jsonb_build_object('o_state', p_got) else p_got::jsonb end
$$;
create function t.rw(p_user text, p_path text, p_ttl int default null) returns jsonb language sql as $$
  select t.answer(t.run(p_user, t.rw_sql(p_path, null, p_ttl)))
$$;
create function t.rw_tok(p_user text, p_tok text, p_path text) returns jsonb language sql as $$
  select t.answer(t.run_tok(p_user, p_tok, t.rw_sql(p_path)))
$$;
-- Completes, or gives back, the step a saved answer granted.
create function t.finish(p_user text, p_path text, p_grant text) returns text language sql as $$
  select t.run(p_user, format($q$select public.complete_step(%L, %L, %L, %L, %L)::text$q$, t.id('wq'), p_path,
    t.j(p_grant)->>'o_key', (t.j(p_grant)->>'o_fence')::int, t.j(p_grant)->>'o_secret'))
$$;
create function t.give_back(p_user text, p_path text, p_grant text) returns text language sql as $$
  select t.run(p_user, format($q$select public.release_step(%L, %L, %L, %L, %L)::text$q$, t.id('wq'), p_path,
    t.j(p_grant)->>'o_key', (t.j(p_grant)->>'o_fence')::int, t.j(p_grant)->>'o_secret'))
$$;
create function t.place(p_user text, p_path text) returns public.work_plan_places language sql as $$
  select * from public.work_plan_places where plan_id = t.plan_id(p_path) and holder = t.id(p_user)
$$;
-- Who is in line for a plan, oldest first.
create function t.line(p_path text) returns text language sql as $$
  select coalesce(string_agg(i.name, ' ' order by pl.created_at, pl.id), '')
    from public.work_plan_places pl join t.ids i on i.id = pl.holder
   where pl.plan_id = t.plan_id(p_path)
$$;
-- The caller's gap has passed: its next call is a full evaluation.
create function t.later(p_user text, p_path text) returns void language sql as $$
  update public.work_plan_places set next_allowed_at = clock_timestamp() - interval '1 second'
   where plan_id = t.plan_id(p_path) and holder = t.id(p_user)
$$;
-- The holder stopped checking in: the place lapsed.
create function t.lapse_place(p_user text, p_path text) returns void language sql as $$
  update public.work_plan_places set expires_at = clock_timestamp() - interval '1 second', next_allowed_at = clock_timestamp() - interval '1 second'
   where plan_id = t.plan_id(p_path) and holder = t.id(p_user)
$$;
create function t.lapse_step(p_path text, p_key text) returns void language sql as $$
  update public.work_plan_steps set expires_at = clock_timestamp() - interval '1 second'
   where plan_id = t.plan_id(p_path) and key = p_key
$$;
create function t.events(p_event text, p_path text) returns text language sql as $$
  select coalesce(string_agg(coalesce(i.name, '?') || coalesce(' ' || (l.detail->>'reason'), '') || coalesce(' ' || (l.detail->>'place'), ''), ', ' order by l.seq), '')
    from public.log l left join t.ids i on i.id = l.actor
   where l.vault_id = t.id('wq') and l.event = p_event and l.path = p_path
$$;

-- ---------------------------------------------------------------------------
-- The tables: one way in

select t.plan('q/tables.md', '[{"key":"a","title":"A"}]');
insert into public.work_plan_places (plan_id, vault_id, holder, expires_at, next_allowed_at, last_place, last_ready)
values (t.plan_id('q/tables.md'), t.id('wq'), t.id('hal'), now() + interval '1 hour', now(), 1, 0);
insert into private.work_plan_strikes (vault_id, person, strikes, last_at) values (t.id('wq'), t.id('hal'), 1, now());

select t.expect('places: a person cannot take a place in line directly',
  t.run('ben', format($q$insert into public.work_plan_places (plan_id, vault_id, holder, expires_at, next_allowed_at, last_place, last_ready)
                        values (%L, %L, %L, now() + interval '1 hour', now(), 1, 0) returning 'took'$q$,
                      t.plan_id('q/tables.md'), t.id('wq'), t.id('ben'))), 'ERR 42501');
select t.expect('places: an agent cannot move a place up the line',
  t.run('ben', $q$update public.work_plan_places set created_at = '2000-01-01' returning 'moved'$q$, 'Claude Code'), 'ERR 42501');
select t.expect('places: an owner cannot remove someone else''s place directly',
  t.run('ana', $q$delete from public.work_plan_places returning 'removed'$q$), 'ERR 42501');
select t.expect('places: nobody reads strikes',
  t.run('ana', $q$select count(*)::text from private.work_plan_strikes$q$), 'ERR 42501');
select t.expect('places: nobody clears their own strikes',
  t.run('hal', $q$delete from private.work_plan_strikes returning 'cleared'$q$), 'ERR 42501');
select t.expect('places: nobody reads when a place may ask again',
  t.run('hal', $q$select next_allowed_at::text from public.work_plan_places$q$), 'ERR 42501');
select t.expect('places: a viewer sees who is waiting',
  t.run('cal', format($q$select string_agg(holder::text, ',') from public.work_plan_places where vault_id = %L$q$, t.id('wq'))),
  t.id('hal')::text);
select t.expect('places: an outsider sees no one waiting',
  t.run('dee', $q$select count(*)::text from public.work_plan_places$q$), '0');
select t.expect('places: a connection scoped to another vault sees no one waiting',
  t.run_tok('ana', 'wq-other-tok', $q$select count(*)::text from public.work_plan_places$q$), '0');
select t.expect_true('places: none of the refused attempts changed a place or a strike',
  (select count(*) from public.work_plan_places) = 1
  and (t.place('hal', 'q/tables.md')).created_at > '2000-01-02'
  and (select count(*) from private.work_plan_strikes) = 1);
select t.run('ana', format($q$select public.set_member(%L, %L, null)$q$, t.id('wq'), t.id('hal')));
select t.expect_true('places: a member who leaves the vault gives up their places and strikes',
  not exists (select 1 from public.work_plan_places where holder = t.id('hal'))
  and not exists (select 1 from private.work_plan_strikes where person = t.id('hal')));
select test_support.add_member(t.id('wq'), t.id('hal'), 'editor', t.id('ana'));

-- Deleting a vault takes its places and strikes with it.
insert into t.ids select 'wq-del', t.run('ana', $q$select public.create_vault('Waiting (deleted)')$q$)::uuid;
select test_support.add_member(t.id('wq-del'), t.id('ben'), 'editor', t.id('ana'));
select t.run('ana', format($q$select public.write_file(%L, 'p.md', 'a plan')::text$q$, t.id('wq-del')));
select t.run('ana', format($q$select public.register_work_plan(%L, 'p.md', %L, '[{"key":"a","title":"A"}]'::jsonb)::text$q$, t.id('wq-del'),
  (select current_version_id from public.files where vault_id = t.id('wq-del') and path = 'p.md')));
insert into public.work_plan_places (plan_id, vault_id, holder, expires_at, next_allowed_at, last_place, last_ready)
select id, vault_id, t.id('ben'), now() + interval '1 hour', now(), 1, 0 from public.work_plans where vault_id = t.id('wq-del');
insert into private.work_plan_strikes (vault_id, person, strikes, last_at) values (t.id('wq-del'), t.id('ben'), 1, now());
select t.run('ana', format($q$select public.delete_vault(%L, 'Waiting (deleted)')::text$q$, t.id('wq-del')));
select t.expect_true('places: deleting a vault deletes its places in line and its strikes',
  not exists (select 1 from public.vaults where id = t.id('wq-del'))
  and not exists (select 1 from public.work_plan_places where vault_id = t.id('wq-del'))
  and not exists (select 1 from private.work_plan_strikes where vault_id = t.id('wq-del')));
