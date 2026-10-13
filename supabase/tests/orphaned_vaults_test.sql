-- Hostile tests for 20261014170000_orphaned_vaults: deleting an account
-- while owning vaults (each vault deleted with it, left, or left without an
-- owner), what an orphaned vault still allows, and taking one: members only,
-- in person, within their plan, the first one only.
--
-- Ana owns Shared alone (Ben edits, Cal views; Ben invited Zed as an owner
-- back when he was one), owns Solo alone with nobody else in it, is Ben's
-- second owner in BenV, and owns Pair alone with Cal in it. She is on the
-- Alpha tester plan. Then she deletes her account.

insert into t.ids values ('eve', '00000000-0000-0000-0000-00000000000e');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'),
  (t.id('cal'), 'cal@example.test'), (t.id('dee'), 'dee@example.test'), (t.id('eve'), 'eve@example.test');
insert into private.account_plans (user_id, plan_id) values (t.id('ana'), 'alpha_tester');
insert into private.plans (id, name, max_vaults, max_members, max_storage_bytes) values ('one', 'One', 1, 10, 1000000);

insert into t.ids select 'shared', t.run('ana', $q$select public.create_vault('Shared')$q$)::uuid;
insert into t.ids select 'solo', t.run('ana', $q$select public.create_vault('Solo')$q$)::uuid;
insert into t.ids select 'pair', t.run('ana', $q$select public.create_vault('Pair')$q$)::uuid;
insert into t.ids select 'benv', t.run('ben', $q$select public.create_vault('BenV')$q$)::uuid;
select test_support.add_member(t.id('shared'), t.id('ben'), 'owner', t.id('ana'));
select test_support.add_member(t.id('shared'), t.id('cal'), 'viewer', t.id('ana'));
select test_support.add_member(t.id('pair'), t.id('cal'), 'viewer', t.id('ana'));
select test_support.add_member(t.id('benv'), t.id('ana'), 'owner', t.id('ben'));
select t.run('ben', format($q$select public.create_invite(%L, 'zed@example.test', 'owner')$q$, t.id('shared')));
select t.run('ana', format($q$select public.set_member(%L, %L, 'editor')::text$q$, t.id('shared'), t.id('ben')));
select t.run('ana', format($q$select public.create_invite(%L, 'eve@example.test', 'viewer')$q$, t.id('benv')));
select t.run('ben', $q$select public.create_access_token('ben-laptop', 30)$q$);

-- ---------------------------------------------------------------------------
-- Deleting the account

select t.expect('orphaned: the summary says, for each vault, whether it is left, deleted with the account or left without an owner',
  t.run('ana', $q$select string_agg(v ->> 'name' || ':' || (v ->> 'role') || ':' || (v ->> 'fate'), ',')
                    from public.account_deletion_summary() s, jsonb_array_elements(s -> 'vaults') v$q$),
  'BenV:owner:leave,Pair:owner:orphan,Shared:owner:orphan,Solo:owner:delete');

select t.expect('orphaned: owning vaults alone never stops an account being deleted, and it counts what went',
  t.run('ana', $q$select public.delete_account('ana@example.test')::text$q$),
  '{"vaults": 3, "deleted": 1, "invites": 1, "orphaned": 2, "connections": 0}');

select t.expect('orphaned: a vault nobody else was in is deleted with the account, leaving its record as delete_vault does',
  (select count(*) from public.vaults where id = t.id('solo')) || ' '
  || (select count(*) from public.log where vault_id = t.id('solo')) || ' '
  || (select (deleted_by = t.id('ana'))::text || ':' || (counts ->> 'members') from private.vault_deletions where vault_id = t.id('solo')),
  '0 0 true:1');

select t.expect('orphaned: a vault with another owner just loses this one',
  t.run('ben', format($q$select string_agg(role, ',') from public.vault_members where vault_id = %L$q$, t.id('benv')))
  || ' ' || t.run('ben', format($q$select public.vault_orphaned(%L)::text$q$, t.id('benv'))),
  'owner false');

select t.expect('orphaned: a vault with members and no other owner keeps its members, has no owner, and the leave is marked',
  t.run('ben', format($q$select string_agg(role, ',' order by role) from public.vault_members where vault_id = %L$q$, t.id('shared')))
  || ' ' || t.run('cal', format($q$select public.vault_orphaned(%L)::text$q$, t.id('shared')))
  || ' ' || (select detail ->> 'orphaned' from public.log
              where vault_id = t.id('shared') and event = 'member.leave' and actor = t.id('ana')),
  'editor,viewer true true');

select t.expect('orphaned: a non-member can''t tell the vault is orphaned',
  t.run('dee', format($q$select public.vault_orphaned(%L)::text$q$, t.id('shared'))), 'false');

select t.expect('orphaned: its waiting invites are withdrawn, an owner invite someone else made included',
  (select string_agg(email || ':' || private.invite_state(accepted_at, revoked_at, expires_at), ',' order by email)
     from private.vault_invites where vault_id = t.id('shared')),
  'zed@example.test:revoked');

select t.expect('orphaned: until someone takes it, it has the Free plan''s limits, not the deleted account''s plan',
  t.run('ben', format($q$select plan from public.vault_usage(%L)$q$, t.id('shared'))), 'free');

-- ---------------------------------------------------------------------------
-- While orphaned

select t.expect('orphaned: members keep writing and reading as their roles allow',
  t.run('ben', format($q$select (public.write_file(%L, 'notes/ben.md', 'still here') is not null)::text$q$, t.id('shared')))
  || ' ' || t.run('cal', format($q$select v.body from public.file_versions v join public.files f on f.current_version_id = v.id
                                    where f.vault_id = %L and f.path = 'notes/ben.md'$q$, t.id('shared'))),
  'true still here');

select t.expect('orphaned: nobody can do what only an owner may',
  t.run('ben', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)::text$q$, t.id('shared'))) || ' '
  || t.run('ben', format($q$select public.create_invite(%L, 'new@example.test', 'viewer')$q$, t.id('shared'))) || ' '
  || t.run('ben', format($q$select public.delete_vault(%L, 'Shared')::text$q$, t.id('shared'))),
  'ERR 42501 ERR 42501 ERR 42501');

select t.expect('orphaned: the last member of a vault with no owner can''t leave it',
  t.run('cal', format($q$select public.leave_vault(%L)::text$q$, t.id('pair'))) || ' '
  || t.run('cal', format($q$select count(*)::text from public.vault_members where vault_id = %L$q$, t.id('pair'))),
  'ERR 55000 1');

-- ---------------------------------------------------------------------------
-- Taking it

select t.expect('take: a non-member can''t take an orphaned vault, and it stays orphaned',
  t.run('dee', format($q$select public.take_vault(%L)$q$, t.id('shared'))) || ' '
  || t.run('ben', format($q$select public.vault_orphaned(%L)::text$q$, t.id('shared'))),
  'ERR P0002 true');

select t.expect('take: an agent can''t take one, nor a personal token',
  t.run('ben', format($q$select public.take_vault(%L)$q$, t.id('shared')), 'Claude Code') || ' '
  || t.run_tok('ben', 'ben-laptop', format($q$select public.take_vault(%L)$q$, t.id('shared'))) || ' '
  || t.run('ben', format($q$select public.vault_orphaned(%L)::text$q$, t.id('shared'))),
  'ERR 42501 ERR 42501 true');

select t.expect('take: a vault that has an owner can''t be taken, by a member who isn''t its owner either',
  t.run('ben', format($q$select public.take_vault(%L)$q$, t.id('benv'))) || ' '
  || t.run('cal', format($q$select public.take_vault(%L)$q$, t.id('benv'))),
  'ERR 55000 ERR P0002');

-- The message of what p_sql raised as p_user, or 'no error'.
create function t.err(p_user text, p_sql text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql;
  perform set_config('role', 'none', true);
  return 'no error';
exception when others then
  perform set_config('role', 'none', true);
  return sqlstate || ' ' || sqlerrm;
end $$;

select private.set_account_plan(t.id('ben'), 'one');
select t.expect('take: a member at their vault limit is refused, in words, and nothing changes',
  t.err('ben', format($q$select public.take_vault(%L)$q$, t.id('shared'))) || ' | '
  || t.run('ben', format($q$select public.vault_orphaned(%L)::text$q$, t.id('shared'))),
  'RLP01 you''re at your 1-vault limit on the One plan (you own 1), and becoming the owner of Shared would count it against your plan: delete a vault you no longer need, or ask for a bigger plan | true');
select private.set_account_plan(t.id('ben'), 'alpha_tester');

select t.expect('take: the first member to take it becomes its owner, and it counts against and takes its limits from their plan',
  t.run('ben', format($q$select public.take_vault(%L)$q$, t.id('shared'))) || ' '
  || t.run('ben', format($q$select role from public.vault_members where vault_id = %L and user_id = private.uid()$q$, t.id('shared'))) || ' '
  || t.run('ben', format($q$select (created_by = private.uid())::text from public.vaults where id = %L$q$, t.id('shared'))) || ' '
  || t.run('ben', $q$select vaults_owned::text from public.my_plan()$q$) || ' '
  || t.run('ben', format($q$select plan from public.vault_usage(%L)$q$, t.id('shared'))) || ' '
  || t.run('ben', format($q$select event || ':' || (detail ->> 'role') from public.log where vault_id = %L and event = 'vault.take'$q$, t.id('shared'))),
  'Shared owner true 2 alpha_tester vault.take:editor');

select t.expect('take: once it has an owner, nobody else can take it',
  t.run('cal', format($q$select public.take_vault(%L)$q$, t.id('shared'))) || ' '
  || t.run('cal', format($q$select role from public.vault_members where vault_id = %L and user_id = private.uid()$q$, t.id('shared'))),
  'ERR 55000 viewer');
