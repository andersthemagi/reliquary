-- A registered plan gains new steps when its file changes
-- (20261013160000_work_plan_gains_steps, issue #262): registering the path
-- again from a newer version adds the new keys, keeps every registered
-- step and its state, and refuses anything else, changing nothing. The
-- first registration's own checks are work_plans_test.sql's; the race
-- with a blocker finishing is web/test/races.test.mjs's.
--
-- Ana owns, Ben (editor) registers and works the plan, Cal is a viewer.

insert into t.ids select 'gs', t.run('ana', $q$select public.create_vault('Plan gains steps')$q$)::uuid;
select test_support.add_member(t.id('gs'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('gs'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.create_access_token('gs-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('gs')));

create table t.vals (name text primary key, val text);
create function t.save(p_name text, p_val text) returns text language sql as $$
  insert into t.vals values (p_name, p_val) on conflict (name) do update set val = excluded.val returning val
$$;
create function t.val(p_name text) returns text language sql as $$ select val from t.vals where name = p_name $$;

create function t.write(p_body text) returns text language plpgsql as $$
begin
  perform t.run('ben', format($q$select public.write_file(%L, 'plans/p.md', %L)::text$q$, t.id('gs'), p_body));
  return t.save('v', (select current_version_id::text from public.files where vault_id = t.id('gs') and path = 'plans/p.md'));
end $$;
create function t.register_sql(p_version text, p_steps jsonb) returns text language sql as $$
  select format($q$select public.register_work_plan(%L, 'plans/p.md', %L, %L::jsonb)::text$q$, t.id('gs'), p_version, p_steps::text)
$$;
create function t.step(p_key text) returns public.work_plan_steps language sql as $$
  select s.* from public.work_plan_steps s join public.work_plans p on p.id = s.plan_id
   where p.vault_id = t.id('gs') and p.path = 'plans/p.md' and s.key = p_key
$$;
create function t.status(p_key text) returns text language sql as $$
  select o_state from public.work_plan_status(t.id('gs'), 'plans/p.md') where o_key = p_key
$$;
create function t.plan() returns public.work_plans language sql as $$
  select * from public.work_plans where vault_id = t.id('gs') and path = 'plans/p.md'
$$;
-- Every step's stored count of unfinished blockers against a recount.
create function t.counts_true() returns boolean language sql as $$
  select bool_and(s.open_blockers = (select count(*) from public.work_plan_step_blockers d
                                       join public.work_plan_steps b on b.id = d.blocker_id
                                      where d.step_id = s.id and b.status <> 'done'))
    from public.work_plan_steps s where s.plan_id = (t.plan()).id
$$;

-- The registered plan: a, then b, then c (citing a file), and d alone.
-- a is done, b is claimed, c waits on b, d is cancelled.
create function t.v1() returns jsonb language sql as $$ select
  '[{"key":"a","title":"Fetch"},
    {"key":"b","title":"Clean","blocked_by":["a"]},
    {"key":"c","title":"Report","blocked_by":["b"],"cites":[{"path":"docs/x.md","version":"3fa85f64-5717-4562-b3fc-2c963f66afa6"}]},
    {"key":"d","title":"Extra","gate":"review"}]'::jsonb $$;
select t.write('plan one');
select t.save('v1', t.val('v'));
select t.run('ben', t.register_sql(t.val('v1'), t.v1()));
select t.save('a', t.run('ben', format($q$select o_secret from public.claim_step(%L, 'plans/p.md', 'a')$q$, t.id('gs'))));
select t.run('ben', format($q$select public.complete_step(%L, 'plans/p.md', 'a', %L, %L)::text$q$, t.id('gs'), (t.step('a')).fence, t.val('a')));
select t.save('b', t.run('ben', format($q$select o_secret from public.claim_step(%L, 'plans/p.md', 'b', 'Ben''s agent')$q$, t.id('gs'))));
select t.run('ana', format($q$select public.cancel_step(%L, 'plans/p.md', 'd')::text$q$, t.id('gs')));
select t.save('a-done-at', (t.step('a')).done_at::text);
select t.save('b-expires', (t.step('b')).expires_at::text);

select t.write('plan two');
select t.save('v2', t.val('v'));

-- ---------------------------------------------------------------------------
-- Refused, and nothing changes

select t.expect('gains steps: a registered step missing from the file is refused',
  t.run('ben', t.register_sql(t.val('v2'), t.v1() - 2)), 'ERR 22023');
select t.expect('gains steps: a registered step with a new title is refused',
  t.run('ben', t.register_sql(t.val('v2'), jsonb_set(t.v1(), '{1,title}', '"Scrub"'))), 'ERR 22023');
select t.expect('gains steps: a done step waiting on a new step is refused',
  t.run('ben', t.register_sql(t.val('v2'),
    jsonb_set(t.v1(), '{0,blocked_by}', '["e"]') || '[{"key":"e","title":"New"}]'::jsonb)), 'ERR 22023');
select t.expect('gains steps: a claimed step losing a blocker is refused',
  t.run('ben', t.register_sql(t.val('v2'), jsonb_set(t.v1(), '{1,blocked_by}', '[]'))), 'ERR 22023');
select t.expect('gains steps: a registered step citing another version is refused',
  t.run('ben', t.register_sql(t.val('v2'),
    jsonb_set(t.v1(), '{2,cites,0,version}', '"00000000-0000-4000-8000-000000000001"'))), 'ERR 22023');
select t.expect('gains steps: a registered step with a new gate is refused',
  t.run('ben', t.register_sql(t.val('v2'), jsonb_set(t.v1(), '{3,gate}', 'null'))), 'ERR 22023');
select t.expect('gains steps: a cycle among the new steps is refused',
  t.run('ben', t.register_sql(t.val('v2'),
    t.v1() || '[{"key":"e","title":"E","blocked_by":["f"]},{"key":"f","title":"F","blocked_by":["e","a"]}]'::jsonb)), 'ERR 22023');
select t.expect('gains steps: a stale version is refused',
  t.run('ben', t.register_sql(gen_random_uuid()::text, t.v1() || '[{"key":"e","title":"E"}]'::jsonb)), 'ERR RLF01');
select t.expect('gains steps: a viewer is refused',
  t.run('cal', t.register_sql(t.val('v2'), t.v1() || '[{"key":"e","title":"E"}]'::jsonb)), 'ERR 42501');
select t.expect('gains steps: a read-only connection is refused',
  t.run_tok('ana', 'gs-ro', t.register_sql(t.val('v2'), t.v1() || '[{"key":"e","title":"E"}]'::jsonb)), 'ERR 42501');
select t.expect_true('gains steps: none of the refused attempts added a step, moved the version or logged',
  (select count(*) from public.work_plan_steps where plan_id = (t.plan()).id) = 4
    and (t.plan()).version_id = t.val('v1')::uuid and (t.plan()).updated_by is null
    and not exists (select 1 from public.log where vault_id = t.id('gs') and event = 'work_plan.update'));

-- ---------------------------------------------------------------------------
-- New steps added, old ones kept: e waits on a (done), f on b (claimed) and
-- e, g on d (cancelled), h on nothing. An agent adds them, as Ana's.

select t.expect_ok('gains steps: an agent adds new steps from a newer version',
  t.run('ana', t.register_sql(t.val('v2'), t.v1() || '[
    {"key":"e","title":"Chart","blocked_by":["a"]},
    {"key":"f","title":"Publish","blocked_by":["b","e"],"cites":[{"path":"docs/y.md","version":"3fa85f64-5717-4562-b3fc-2c963f66afa6"}]},
    {"key":"g","title":"Follow up","blocked_by":["d"]},
    {"key":"h","title":"Tidy","gate":"review"}]'::jsonb), 'Claude Code'));

select t.expect_true('gains steps: registered steps keep their state, holder and times',
  (t.step('a')).status = 'done' and (t.step('a')).done_at = t.val('a-done-at')::timestamptz
    and (t.step('b')).status = 'claimed' and (t.step('b')).holder = t.id('ben') and (t.step('b')).holder_label = 'Ben''s agent'
    and (t.step('b')).expires_at = t.val('b-expires')::timestamptz
    and (t.step('c')).open_blockers = 1 and (t.step('d')).status = 'cancelled');
select t.expect('gains steps: a new step waiting only on a done step is ready', t.status('e'), 'ready');
select t.expect_true('gains steps: a new step counts only its unfinished blockers', (t.step('f')).open_blockers = 2);
select t.expect('gains steps: a new step waiting on a cancelled step is blocked by it', t.status('g'), 'blocked_by_cancelled');
select t.expect_true('gains steps: a new step keeps its gate and cites',
  (t.step('h')).gate = 'review'
    and exists (select 1 from public.work_plan_step_cites where step_id = (t.step('f')).id and path = 'docs/y.md'));
select t.expect_true('gains steps: new steps come after the registered ones, in file order',
  (select array_agg(o_key) from public.work_plan_status(t.id('gs'), 'plans/p.md')) = array['a','b','c','d','e','f','g','h']);
select t.expect_true('gains steps: every stored blocker count matches a recount', t.counts_true());
select t.expect_true('gains steps: the plan now reads from the new version, and says who added steps; who registered it stays',
  (t.plan()).version_id = t.val('v2')::uuid and (t.plan()).updated_by = t.id('ana') and (t.plan()).updated_at is not null
    and (t.plan()).registered_by = t.id('ben'));
select t.expect_true('gains steps: the change is logged once, with what was added and the version it came from',
  (select count(*) = 1 and bool_and(l.version_id = t.val('v2')::uuid and l.detail ->> 'added' = '4'
                                     and l.detail ->> 'from' = t.val('v1') and l.agent is not null)
     from public.log l where l.vault_id = t.id('gs') and l.event = 'work_plan.update'));
select t.expect('gains steps: list_work_plans no longer calls the file changed',
  t.run('ben', format($q$select o_file from public.list_work_plans(%L)$q$, t.id('gs'))), 'unchanged');

-- Finishing an old blocker frees a new step waiting on it.
select t.run('ben', format($q$select public.complete_step(%L, 'plans/p.md', 'b', %L, %L)::text$q$, t.id('gs'), (t.step('b')).fence, t.val('b')));
select t.expect_true('gains steps: completing a registered step unblocks a new one waiting on it',
  (t.step('f')).open_blockers = 1 and (t.step('c')).open_blockers = 0 and t.counts_true());

-- A newer version with nothing new is recorded; registering it twice isn't.
select t.write('plan three, prose only');
select t.save('v3', t.val('v'));
create function t.v2() returns jsonb language sql as $$
  select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('key', s.key, 'title', s.title, 'gate', s.gate,
           'blocked_by', (select jsonb_agg(b.key order by b.key) from public.work_plan_step_blockers d
                            join public.work_plan_steps b on b.id = d.blocker_id where d.step_id = s.id),
           'cites', (select jsonb_agg(jsonb_build_object('path', c.path, 'version', c.version))
                       from public.work_plan_step_cites c where c.step_id = s.id))) order by s.id)
    from public.work_plan_steps s where s.plan_id = (t.plan()).id
$$;
select t.expect_ok('gains steps: a newer version with no new steps is let through',
  t.run('ben', t.register_sql(t.val('v3'), t.v2())));
select t.expect_true('gains steps: and it records the version, adding nothing',
  (t.plan()).version_id = t.val('v3')::uuid
    and (select count(*) from public.work_plan_steps where plan_id = (t.plan()).id) = 8
    and (select l.detail ->> 'added' from public.log l where l.vault_id = t.id('gs') and l.event = 'work_plan.update'
          order by l.seq desc limit 1) = '0');
select t.expect('gains steps: registering from the version already registered is refused',
  t.run('ben', t.register_sql(t.val('v3'), t.v2())), 'ERR 23505');
