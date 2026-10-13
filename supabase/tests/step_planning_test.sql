-- A step's planning fields (20261014100000_step_planning_fields, issue
-- #334): due, priority, notes and for, checked and stored at registration
-- from the registered version, refused naming the step and line, and never
-- a claim rule. The rest of registration is work_plans_test.sql's and
-- work_plan_gains_steps_test.sql's.
--
-- Ana owns, Ben is an editor, Dee is not a member.

insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'), (t.id('dee'), 'dee@example.test')
on conflict (id) do update set email = excluded.email;
insert into t.ids select 'pf', t.run('ana', $q$select public.create_vault('Planning fields')$q$)::uuid;
select test_support.add_member(t.id('pf'), t.id('ben'), 'editor', t.id('ana'));
select t.run('ben', format($q$select public.create_access_token('pf-write', 30, array[%L]::uuid[], 'write')$q$, t.id('pf')));

create function t.version(p_path text) returns uuid language sql as $$
  select current_version_id from public.files where vault_id = t.id('pf') and path = p_path
$$;
create function t.write(p_path text, p_body text) returns text language sql as $$
  select t.run('ben', format($q$select public.write_file(%L, %L, %L)::text$q$, t.id('pf'), p_path, p_body))
$$;
create function t.register(p_path text, p_steps text) returns text language sql as $$
  select t.run('ben', format($q$select public.register_work_plan(%L, %L, %L, %L::jsonb)::text$q$,
    t.id('pf'), p_path, t.version(p_path), p_steps))
$$;
create function t.step(p_path text, p_key text) returns public.work_plan_steps language sql as $$
  select s.* from public.work_plan_steps s join public.work_plans p on p.id = s.plan_id
   where p.vault_id = t.id('pf') and p.path = p_path and s.key = p_key
$$;
create function t.has_plan(p_path text) returns text language sql as $$
  select count(*)::text from public.work_plans where vault_id = t.id('pf') and path = p_path
$$;

-- ---------------------------------------------------------------------------
-- Stored from the registered version

select t.write('plans/p.md', 'v1');
select t.expect_ok('planning fields: a plan with all four registers', t.register('plans/p.md',
  '[{"key":"a","title":"A","line":2,"due":"2020-01-31","priority":1,"notes":"Keep the raw file.\tTabs are fine.","for":"agents"},
    {"key":"b","title":"B","priority":"4","for":"people"},
    {"key":"c","title":"C","for":"  ANA@Example.test "},
    {"key":"d","title":"D"}]'));
select t.expect('planning fields: a past due date, priority, notes and for are stored as given',
  (select row(s.due, s.priority, s.notes, s.for_kind, s.for_member)::text from t.step('plans/p.md', 'a') s),
  row('2020-01-31'::date, 1::smallint, E'Keep the raw file.\tTabs are fine.', 'agents', null::uuid)::text);
select t.expect('planning fields: priority given as text is stored as a number',
  (select s.priority::text from t.step('plans/p.md', 'b') s), '4');
select t.expect('planning fields: for an email stores the member''s user id, matched without case or spaces',
  (select s.for_kind || ' ' || s.for_member from t.step('plans/p.md', 'c') s), 'member ' || t.id('ana'));
select t.expect('planning fields: a step with none stores none',
  (select row(s.due, s.priority, s.notes, s.for_kind, s.for_member)::text from t.step('plans/p.md', 'd') s), '(,,,,)');
select t.expect('planning fields: work_plan_status returns them',
  t.run('ben', format($q$select string_agg(concat_ws('|', o_key, o_due, o_priority, o_notes is not null, o_for_kind, o_for_member), ';' order by o_key)
                          from public.work_plan_status(%L, 'plans/p.md')$q$, t.id('pf'))),
  'a|2020-01-31|1|t|agents;b|4|f|people;c|f|member|' || t.id('ana') || ';d|f');

-- Adding a step to the registered plan stores its fields; a registered
-- step's fields can't change, the same as its title.
select t.write('plans/p.md', 'v2');
select t.expect('planning fields: a registered step with a changed priority is refused', t.register('plans/p.md',
  '[{"key":"a","title":"A","due":"2020-01-31","priority":2,"notes":"Keep the raw file.\tTabs are fine.","for":"agents"},
    {"key":"b","title":"B","priority":"4","for":"people"},{"key":"c","title":"C","for":"ana@example.test"},{"key":"d","title":"D"}]'),
  'ERR 22023');
select t.expect('planning fields: a registered step gaining a due date is refused', t.register('plans/p.md',
  '[{"key":"a","title":"A","due":"2020-01-31","priority":1,"notes":"Keep the raw file.\tTabs are fine.","for":"agents"},
    {"key":"b","title":"B","priority":"4","for":"people"},{"key":"c","title":"C","for":"ana@example.test"},{"key":"d","title":"D","due":"2026-10-20"}]'),
  'ERR 22023');
select t.expect_ok('planning fields: a step added to a registered plan is stored with its fields', t.register('plans/p.md',
  '[{"key":"a","title":"A","due":"2020-01-31","priority":1,"notes":"Keep the raw file.\tTabs are fine.","for":"agents"},
    {"key":"b","title":"B","priority":"4","for":"people"},{"key":"c","title":"C","for":"ana@example.test"},{"key":"d","title":"D"},
    {"key":"e","title":"E","due":"2026-10-20","priority":3,"notes":"New","for":"ben@example.test"}]'));
select t.expect('planning fields: the added step''s fields are the registered version''s',
  (select row(s.due, s.priority, s.notes, s.for_kind, s.for_member)::text from t.step('plans/p.md', 'e') s),
  row('2026-10-20'::date, 3::smallint, 'New', 'member', t.id('ben'))::text);

-- ---------------------------------------------------------------------------
-- Refused at registration, registering nothing

create function t.refused(p_step text) returns text language sql as $$
  select t.write('plans/bad.md', p_step);
  select t.register('plans/bad.md', '[' || p_step || ']') || ' ' || t.has_plan('plans/bad.md')
$$;
select t.expect('planning fields: refused: due not written YYYY-MM-DD',
  t.refused('{"key":"x","title":"X","due":"today"}'), 'ERR 22023 0');
select t.expect('planning fields: refused: due not a real date',
  t.refused('{"key":"x","title":"X","due":"2026-02-30"}'), 'ERR 22023 0');
select t.expect('planning fields: refused: priority 0',
  t.refused('{"key":"x","title":"X","priority":0}'), 'ERR 22023 0');
select t.expect('planning fields: refused: priority 5',
  t.refused('{"key":"x","title":"X","priority":5}'), 'ERR 22023 0');
select t.expect('planning fields: refused: priority 1.5',
  t.refused('{"key":"x","title":"X","priority":1.5}'), 'ERR 22023 0');
select t.expect('planning fields: refused: notes over 2000 characters',
  t.refused(format('{"key":"x","title":"X","notes":"%s"}', repeat('n', 2001))), 'ERR 22023 0');
select t.expect('planning fields: refused: notes with a line break',
  t.refused('{"key":"x","title":"X","notes":"one\ntwo"}'), 'ERR 22023 0');
select t.expect('planning fields: refused: for naming someone not a member of the vault',
  t.refused('{"key":"x","title":"X","for":"dee@example.test"}'), 'ERR 22023 0');
select t.expect('planning fields: refused: for naming no account',
  t.refused('{"key":"x","title":"X","for":"nobody@example.test"}'), 'ERR 22023 0');
select t.expect('planning fields: refused: for that is neither agents, people nor an email',
  t.refused('{"key":"x","title":"X","for":"robots"}'), 'ERR 22023 0');

create function t.refusal(p_steps jsonb) returns text language plpgsql as $$
declare v_vault uuid := t.id('pf'); v_version uuid := t.version('plans/bad.md');
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.id('ben'), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform public.register_work_plan(v_vault, 'plans/bad.md', v_version, p_steps);
  perform set_config('role', 'none', true);
  return 'registered';
exception when others then
  perform set_config('role', 'none', true);
  return sqlerrm;
end $$;
select t.expect('planning fields: a refusal names the step and the line, never the value',
  t.refusal('[{"key":"x","title":"X","line":7,"for":"dee@example.test"}]'),
  'step "x" (line 7): for must be agents, people or the email of a member of this vault, and it names no member');

-- The table's own checks, for any writer that isn't register_work_plan.
select t.expect('planning fields: the table refuses priority 5',
  t.run_role('postgres', format($q$update public.work_plan_steps set priority = 5 where id = %s returning 1$q$, (t.step('plans/p.md', 'd')).id)), 'ERR 23514');
select t.expect('planning fields: the table refuses notes with a control character',
  t.run_role('postgres', format($q$update public.work_plan_steps set notes = E'a\x01b' where id = %s returning 1$q$, (t.step('plans/p.md', 'd')).id)), 'ERR 23514');
select t.expect('planning fields: the table refuses empty notes',
  t.run_role('postgres', format($q$update public.work_plan_steps set notes = '' where id = %s returning 1$q$, (t.step('plans/p.md', 'd')).id)), 'ERR 23514');
select t.expect('planning fields: the table refuses another kind of for',
  t.run_role('postgres', format($q$update public.work_plan_steps set for_kind = 'robots' where id = %s returning 1$q$, (t.step('plans/p.md', 'd')).id)), 'ERR 23514');
select t.expect('planning fields: the table refuses for a member with no member',
  t.run_role('postgres', format($q$update public.work_plan_steps set for_kind = 'member' where id = %s returning 1$q$, (t.step('plans/p.md', 'd')).id)), 'ERR 23514');
select t.expect('planning fields: the table refuses a member id with another kind of for',
  t.run_role('postgres', format($q$update public.work_plan_steps set for_kind = 'agents', for_member = %L where id = %s returning 1$q$, t.id('ana'), (t.step('plans/p.md', 'd')).id)), 'ERR 23514');

-- ---------------------------------------------------------------------------
-- Never a claim rule

select t.expect_ok('planning fields never gate a claim: a step for agents is claimed by a person in person',
  t.run('ben', format($q$select o_fence from public.claim_step(%L, 'plans/p.md', 'a')$q$, t.id('pf'))));
select t.expect_ok('planning fields never gate a claim: a step for people is claimed by an agent',
  t.run_tok('ben', 'pf-write', format($q$select o_fence from public.claim_step(%L, 'plans/p.md', 'b')$q$, t.id('pf'))));
select t.expect_ok('planning fields never gate a claim: a step for one member is claimed by another',
  t.run('ana', format($q$select o_fence from public.claim_step(%L, 'plans/p.md', 'e')$q$, t.id('pf'))));
