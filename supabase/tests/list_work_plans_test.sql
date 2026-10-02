-- Hostile tests for list_work_plans (20261003100000_list_work_plans, issue
-- #76): a vault's plans with counts of their tasks by state, and whether
-- the plan file changed since registration. The function has no access
-- check of its own (RLS does it, as for work_plan_status), so this file is
-- where "a non-member gets nothing" and "another vault's plans never
-- appear" are proved. The state rules themselves (what ready or blocked
-- means) are work_plans_test.sql's.

insert into t.ids select 'lw', t.run('ana', $q$select public.create_vault('List work plans')$q$)::uuid;
select test_support.add_member(t.id('lw'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('lw'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.create_access_token('lw-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('lw')));

-- A second vault Ana also owns, so one person belongs to both: the case RLS
-- alone cannot separate.
insert into t.ids select 'lw-other', t.run('ana', $q$select public.create_vault('List work plans (other)')$q$)::uuid;
select t.run('ana', format($q$select public.create_access_token('lw-other-tok', 30, array[%L]::uuid[], 'write')$q$, t.id('lw-other')));

create table t.vals (name text primary key, val text);
create function t.save(p_name text, p_val text) returns text language sql as $$
  insert into t.vals values (p_name, p_val) on conflict (name) do update set val = excluded.val returning val
$$;
create function t.val(p_name text) returns text language sql as $$ select val from t.vals where name = p_name $$;

-- Each plan row as "path ready/blocked/claimed/done/cancelled", in path order.
create function t.list_sql(p_vault text) returns text language sql as $$
  select format($q$select string_agg(format('%%s %%s/%%s/%%s/%%s/%%s', o_path, o_ready, o_blocked, o_claimed, o_done, o_cancelled), ', ' order by o_path)
                     from public.list_work_plans(%L)$q$, t.id(p_vault))
$$;
create function t.file_sql(p_vault text, p_path text) returns text language sql as $$
  select format($q$select o_file from public.list_work_plans(%L) where o_path = %L$q$, t.id(p_vault), p_path)
$$;
create function t.step_sql(p_fn text, p_path text, p_key text) returns text language sql as $$
  select format($q$select public.%s(%L, %L, %L)::text$q$, p_fn, t.id('lw'), p_path, p_key)
$$;

-- Plan a: a chain with a diamond, plus a side job. Plan b: one task.
select t.run('ben', format($q$select public.write_file(%L, 'plans/a.md', 'plan a')::text$q$, t.id('lw')));
select t.run('ben', format($q$select public.write_file(%L, 'plans/b.md', 'plan b')::text$q$, t.id('lw')));
select t.save('a-version', (select current_version_id::text from public.files where vault_id = t.id('lw') and path = 'plans/a.md'));
select t.save('b-version', (select current_version_id::text from public.files where vault_id = t.id('lw') and path = 'plans/b.md'));
select t.run('ben', format($q$select public.register_work_plan(%L, 'plans/a.md', %L, %L::jsonb)::text$q$, t.id('lw'), t.val('a-version'),
  '[{"key":"fetch","title":"Fetch"},
    {"key":"clean","title":"Clean","blocked_by":["fetch"]},
    {"key":"check","title":"Check","blocked_by":["fetch"]},
    {"key":"ship","title":"Ship","blocked_by":["clean","check"]},
    {"key":"side","title":"Side job"},
    {"key":"after","title":"After the side job","blocked_by":["side"]}]'));
select t.run('ben', format($q$select public.register_work_plan(%L, 'plans/b.md', %L, %L::jsonb)::text$q$, t.id('lw'), t.val('b-version'),
  '[{"key":"only","title":"Only task"}]'));

-- fetch done, clean claimed, check ready, ship blocked, side cancelled, after
-- blocked by the cancelled one.
select t.save('fetch', t.run('ben', format($q$select o_secret from public.claim_step(%L, 'plans/a.md', 'fetch')$q$, t.id('lw'))));
select t.run('ben', format($q$select public.complete_step(%L, 'plans/a.md', 'fetch', 1, %L)::text$q$, t.id('lw'), t.val('fetch')));
select t.run('ben', format($q$select o_secret from public.claim_step(%L, 'plans/a.md', 'clean')$q$, t.id('lw')));
select t.run('ana', t.step_sql('cancel_step', 'plans/a.md', 'side'));

-- ---------------------------------------------------------------------------
-- list: plans in path order, each task counted once, in its computed state

select t.expect('list: every plan, in path order, with its tasks counted by state',
  t.run('ben', t.list_sql('lw')),
  'plans/a.md 1/2/1/1/1, plans/b.md 1/0/0/0/0');
select t.expect('list: a plan''s counts add up to its tasks (a has 6, b has 1)',
  t.run('ben', format($q$select string_agg((o_ready + o_blocked + o_claimed + o_done + o_cancelled)::text, ',' order by o_path)
                           from public.list_work_plans(%L)$q$, t.id('lw'))),
  '6,1');
select t.expect('list: a task blocked by a cancelled one counts as blocked, not cancelled or ready',
  t.run('ben', format($q$select o_blocked::text from public.list_work_plans(%L) where o_path = 'plans/a.md'$q$, t.id('lw'))), '2');
select t.expect('list: the plan''s registered version, and who registered it, are returned',
  t.run('ben', format($q$select (o_registered_version = %L and o_registered_by = %L)::text from public.list_work_plans(%L) where o_path = 'plans/a.md'$q$,
    t.val('a-version')::uuid, t.id('ben'), t.id('lw'))), 'true');

-- Counts follow the rows live, nothing stored: a lapsed claim is ready again.
update public.work_plan_steps set expires_at = now() - interval '1 second'
 where status = 'claimed' and vault_id = t.id('lw');
select t.expect('list: a lapsed claim counts as ready, not claimed',
  t.run('ben', t.list_sql('lw')),
  'plans/a.md 2/2/0/1/1, plans/b.md 1/0/0/0/0');

-- ---------------------------------------------------------------------------
-- file: has the plan file moved on since the plan was registered from it

select t.expect('file: unchanged while the file is still the registered version',
  t.run('ben', t.file_sql('lw', 'plans/a.md')), 'unchanged');
select t.expect('file: the current version is the registered one',
  t.run('ben', format($q$select (o_current_version = o_registered_version)::text from public.list_work_plans(%L) where o_path = 'plans/a.md'$q$, t.id('lw'))),
  'true');

select t.run('ben', format($q$select public.write_file(%L, 'plans/a.md', 'plan a, edited')::text$q$, t.id('lw')));
select t.expect('file: changed once the file has a newer version',
  t.run('ben', t.file_sql('lw', 'plans/a.md')), 'changed');
select t.expect('file: the newer version is the current one, not the registered one',
  t.run('ben', format($q$select (o_current_version is distinct from o_registered_version and o_registered_version = %L)::text
                           from public.list_work_plans(%L) where o_path = 'plans/a.md'$q$, t.val('a-version')::uuid, t.id('lw'))),
  'true');
select t.expect('file: editing one plan''s file leaves the other plan unchanged',
  t.run('ben', t.file_sql('lw', 'plans/b.md')), 'unchanged');

select t.run('ben', format($q$select public.delete_file(%L, 'plans/b.md')::text$q$, t.id('lw')));
select t.expect('file: deleted once the file is gone',
  t.run('ben', t.file_sql('lw', 'plans/b.md')), 'deleted');
select t.expect('file: a deleted file''s plan is still listed, with its counts',
  t.run('ben', t.list_sql('lw')),
  'plans/a.md 2/2/0/1/1, plans/b.md 1/0/0/0/0');

-- ---------------------------------------------------------------------------
-- rls: who gets rows at all

select t.expect('rls: a viewer sees the plans',
  t.run('cal', t.list_sql('lw')), 'plans/a.md 2/2/0/1/1, plans/b.md 1/0/0/0/0');
select t.expect('rls: a read-only connection sees the plans',
  t.run_tok('ana', 'lw-ro', t.list_sql('lw')), 'plans/a.md 2/2/0/1/1, plans/b.md 1/0/0/0/0');
select t.expect('rls: a non-member gets no rows',
  t.run('dee', format($q$select count(*)::text from public.list_work_plans(%L)$q$, t.id('lw'))), '0');
select t.expect('rls: a connection scoped to another vault gets no rows, though its person belongs here',
  t.run_tok('ana', 'lw-other-tok', format($q$select count(*)::text from public.list_work_plans(%L)$q$, t.id('lw'))), '0');
select t.expect('rls: a vault that does not exist gets no rows',
  t.run('ana', format($q$select count(*)::text from public.list_work_plans(%L)$q$, gen_random_uuid())), '0');
select t.expect('rls: an anonymous caller is refused',
  t.run(null, format($q$select count(*)::text from public.list_work_plans(%L)$q$, t.id('lw'))), 'ERR 42501');

-- One person in both vaults: asking about one never returns the other's plans.
select t.run('ana', format($q$select public.write_file(%L, 'plans/other.md', 'other plan')::text$q$, t.id('lw-other')));
select t.run('ana', format($q$select public.register_work_plan(%L, 'plans/other.md', %L, %L::jsonb)::text$q$, t.id('lw-other'),
  (select current_version_id::text from public.files where vault_id = t.id('lw-other') and path = 'plans/other.md'),
  '[{"key":"x","title":"Other vault''s task"}]'));
select t.expect('rls: a member of two vaults asking for one gets only that vault''s plans',
  t.run('ana', t.list_sql('lw')), 'plans/a.md 2/2/0/1/1, plans/b.md 1/0/0/0/0');
select t.expect('rls: and the other vault lists only its own',
  t.run('ana', t.list_sql('lw-other')), 'plans/other.md 1/0/0/0/0');

-- Nothing a viewer shouldn't see: no holder, token, secret or file text
-- column, so adding one is a deliberate change to this list.
select t.expect('rls: the function returns only plan facts, counts and the file''s state, never a holder, secret or file text',
  (select array_to_string(proargnames, ',') from pg_proc where oid = 'public.list_work_plans(uuid)'::regprocedure),
  'p_vault,o_path,o_registered_version,o_registered_at,o_registered_by,o_file,o_current_version,o_ready,o_blocked,o_claimed,o_done,o_cancelled');
