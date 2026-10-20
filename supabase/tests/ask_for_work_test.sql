-- Asking for work, saying when the answer only repeats the last
-- (20261020130000_ask_for_work.sql, issue #488): ask_for_work answers as
-- request_work does, and o_repeat is true only for a wait whose place the
-- call didn't write (an agent back before its own gap). The line, the gap
-- and who may ask are waiting_test.sql's and waiting_adversary_test.sql's.
--
-- Ana owns the vault; Ben and Eva are editors. Eva holds the plan's one
-- ready step, so Ben waits.

insert into t.ids values ('eva', '00000000-0000-0000-0000-0000000000e3');
insert into t.ids select 'v', t.run('ana', $q$select public.create_vault('Ask for work')$q$)::uuid;
select test_support.add_member(t.id('v'), t.id(p), 'editor', t.id('ana')) from unnest(array['ben', 'eva']) p;
select t.run('ana', format($q$select public.write_file(%L, 'p.md', 'a plan')::text$q$, t.id('v')));
select t.run('ana', format($q$select public.register_work_plan(%L, 'p.md', %L, %L::jsonb)::text$q$, t.id('v'),
  (select current_version_id from public.files where vault_id = t.id('v') and path = 'p.md'),
  '[{"key":"x","title":"X"},{"key":"y","title":"Y","blocked_by":["x"]}]'));

create function t.ask(p_user text) returns jsonb language sql as $$
  select t.run(p_user, format($q$select to_jsonb(r)::text from public.ask_for_work(%L, 'p.md') r$q$, t.id('v')))::jsonb
$$;
create function t.answer(a jsonb) returns text language sql as $$
  select concat_ws(' ', a->>'o_state', a->>'o_place', a->>'o_ready', 'repeat=' || (a->>'o_repeat'))
$$;

-- ---------------------------------------------------------------------------

select t.expect('ask for work: a grant is not a repeat',
  (select concat_ws(' ', a->>'o_state', a->>'o_key', 'repeat=' || (a->>'o_repeat')) from (select t.ask('eva') a) x), 'granted x repeat=false');

select t.expect('ask for work: the first wait, which takes a place, is not a repeat',
  t.answer(t.ask('ben')), 'wait 1 0 repeat=false');

select t.expect('ask for work: asked again before the gap, the wait repeats the last answer and says so',
  t.answer(t.ask('ben')), 'wait 1 0 repeat=true');

select t.expect('ask for work: a repeat writes nothing to the place',
  (select count(*)::text from public.work_plan_places pl join public.work_plans wp on wp.id = pl.plan_id
    where wp.vault_id = t.id('v') and pl.holder = t.id('ben') and pl.next_allowed_at > clock_timestamp()), '1');

-- The gap over: the place is due, so the next ask is a full evaluation.
update public.work_plan_places pl set next_allowed_at = clock_timestamp() - interval '1 second'
  from public.work_plans wp where wp.id = pl.plan_id and wp.vault_id = t.id('v') and pl.holder = t.id('ben');
select t.expect('ask for work: back at or after the gap, the wait is evaluated again, not a repeat',
  t.answer(t.ask('ben')), 'wait 1 0 repeat=false');

select t.expect('ask for work: request_work gives the same answer without the column',
  (select t.run('ben', format($q$select concat_ws(' ', o_state, o_place, o_ready) from public.request_work(%L, 'p.md')$q$, t.id('v')))),
  'wait 1 0');

select t.expect('ask for work: with no one signed in it is refused',
  (select t.run(null, format($q$select o_state from public.ask_for_work(%L, 'p.md')$q$, t.id('v')))), 'ERR 42501');
