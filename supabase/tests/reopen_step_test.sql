-- Reopening a cancelled step (20261013130000_reopen_step): a person's own,
-- never an agent's; only a cancelled step; and the stored blocker counts
-- stay right, so the reopened step and what waits on it read as ordinary
-- open work again. The rest of work plans is work_plans_test.sql's.
--
-- Ana owns, Ben is an editor, Cal a viewer, Dee not a member.

insert into t.ids select 'ro', t.run('ana', $q$select public.create_vault('Reopen')$q$)::uuid;
select test_support.add_member(t.id('ro'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('ro'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.create_access_token('ro-read', 30, array[%L]::uuid[], 'read')$q$, t.id('ro')));
select t.run('ana', format($q$select public.create_access_token('ro-write', 30, array[%L]::uuid[], 'write')$q$, t.id('ro')));

-- a; b waits on a; c waits on b; x stands alone.
select t.run('ana', format($q$select public.write_file(%L, 'plans/p.md', 'a plan')::text$q$, t.id('ro')));
select t.run('ana', format($q$select public.register_work_plan(%L, 'plans/p.md', %L, %L::jsonb)::text$q$, t.id('ro'),
  (select current_version_id from public.files where vault_id = t.id('ro') and path = 'plans/p.md'),
  '[{"key":"a","title":"A"},{"key":"b","title":"B","blocked_by":["a"]},{"key":"c","title":"C","blocked_by":["b"]},{"key":"x","title":"X"}]'));

create function t.do(p_fn text, p_key text, p_path text default 'plans/p.md') returns text language sql as $$
  select format($q$select public.%s(%L, %L, %L)::text$q$, p_fn, t.id('ro'), p_path, p_key)
$$;
create function t.state(p_key text) returns text language sql as $$
  select o_state from public.work_plan_status(t.id('ro'), 'plans/p.md') where o_key = p_key
$$;
create function t.row(p_key text) returns public.work_plan_steps language sql as $$
  select s.* from public.work_plan_steps s join public.work_plans p on p.id = s.plan_id
   where p.vault_id = t.id('ro') and p.path = 'plans/p.md' and s.key = p_key
$$;
-- Runs complete_step on a fresh claim of p_key, as p_user.
create function t.finish(p_user text, p_key text) returns text language sql as $$
  select t.run(p_user, format($q$select public.complete_step(%L, 'plans/p.md', %L, f.o_fence, f.o_secret)::text
                               from public.claim_step(%L, 'plans/p.md', %L) f$q$, t.id('ro'), p_key, t.id('ro'), p_key))
$$;

select t.run('ana', t.do('cancel_step', 'b'));
select t.expect('reopen: before, what waited on the cancelled step reads blocked_by_cancelled', t.state('c'), 'blocked_by_cancelled');

-- ---------------------------------------------------------------------------
-- Who may

select t.expect('reopen: an owner''s agent cannot reopen a step',
  t.run('ana', t.do('reopen_step', 'b'), 'Claude Code'), 'ERR 42501');
select t.expect('reopen: a write connection cannot reopen a step',
  t.run_tok('ana', 'ro-write', t.do('reopen_step', 'b')), 'ERR 42501');
select t.expect('reopen: a read-only connection cannot reopen a step',
  t.run_tok('ana', 'ro-read', t.do('reopen_step', 'b')), 'ERR 42501');
select t.expect('reopen: a viewer cannot reopen a step',
  t.run('cal', t.do('reopen_step', 'b')), 'ERR 42501');
select t.expect('reopen: a non-member cannot reopen a step',
  t.run('dee', t.do('reopen_step', 'b')), 'ERR 42501');
select t.expect_true('reopen: none of the refused attempts reopened it or logged anything',
  (t.row('b')).status = 'cancelled'
  and not exists (select 1 from public.log where vault_id = t.id('ro') and event = 'step.reopen'));

-- ---------------------------------------------------------------------------
-- What may be reopened

select t.expect('reopen: an open step is refused', t.run('ana', t.do('reopen_step', 'a')), 'ERR RLW02');
select t.expect('reopen: an unknown step is refused', t.run('ana', t.do('reopen_step', 'zzz')), 'ERR P0002');
select t.expect('reopen: a path with no plan is refused', t.run('ana', t.do('reopen_step', 'b', 'plans/none.md')), 'ERR P0002');
select t.run('ana', t.do('skip_step', 'x'));
select t.expect('reopen: a skipped step is refused (it counts as done)', t.run('ana', t.do('reopen_step', 'x')), 'ERR RLW02');

-- ---------------------------------------------------------------------------
-- Reopening, by an editor in person

select t.expect('reopen: an editor, in person, reopens a cancelled step', t.run('ben', t.do('reopen_step', 'b')), '');
select t.expect('reopen: the step is open again, blocked on its unfinished blocker', t.state('b'), 'blocked');
select t.expect('reopen: what waited on it reads blocked by an unfinished step, not by a cancelled one', t.state('c'), 'blocked');
select t.expect_true('reopen: no stored blocker count changed', (t.row('b')).open_blockers = 1 and (t.row('c')).open_blockers = 1);
select t.expect_true('reopen: logged as step.reopen with the person, the plan and the step',
  (select array_agg(l.actor::text || ' ' || (l.detail->>'step') || ' ' || ((l.detail->>'plan') = (t.row('b')).plan_id::text)::text)
     from public.log l where l.vault_id = t.id('ro') and l.event = 'step.reopen' and l.path = 'plans/p.md')
  = array[t.id('ben')::text || ' b true']);
select t.expect('reopen: reopening it again is refused', t.run('ben', t.do('reopen_step', 'b')), 'ERR RLW02');

-- Worked through to the end: the counts it kept are the right ones.
select t.expect('reopen: a reopened step is not claimable while blocked',
  t.run('ben', format($q$select o_secret from public.claim_step(%L, 'plans/p.md', 'b')$q$, t.id('ro'))), 'ERR RLW02');
select t.finish('ben', 'a');
select t.expect('reopen: once its blocker is done, the reopened step is ready', t.state('b'), 'ready');
select t.expect('reopen: the reopened step is claimed and completed like any other', t.finish('ben', 'b'), '');
select t.expect('reopen: and what waited on it is ready', t.state('c'), 'ready');
select t.expect('reopen: a done step is refused', t.run('ana', t.do('reopen_step', 'b')), 'ERR RLW02');
