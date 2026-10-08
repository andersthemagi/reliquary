-- Hostile tests for compare-and-swap writes (20260930100000_compare_and_swap):
-- write_file and delete_file's optional p_expected_version. Ana owns Swap
-- (Ben edits, Cal views); Dee is an outsider. notes/ is open (the vault
-- default); canon/ is canon, quorum 1. A read-only token proves the access
-- checks still run before the version is ever compared, so a caller with no
-- write access learns nothing about a path's current version.

insert into t.ids select 'swap', t.run('ana', $q$select public.create_vault('Swap')$q$)::uuid;
select test_support.add_member(t.id('swap'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('swap'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('swap')));
select t.run('ana', format($q$select public.create_access_token('swap-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('swap')));

-- The current version at a path, in Swap.
create function t.cas_version(p_path text) returns uuid language sql as
$$ select current_version_id from public.files where vault_id = t.id('swap') and path = p_path $$;

-- p_sql's sqlstate and message, as p_user (NULL if it doesn't raise).
create function t.cas_err(p_user text, p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return null;
exception when others then
  perform set_config('role', 'none', true);
  return sqlstate || ' ' || sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- write_file: current, stale and absent expected_version

select t.expect_true('write: seed notes/plan.md with v1',
  t.run('ben', format($q$select public.write_file(%L, 'notes/plan.md', 'v1')$q$, t.id('swap'))) ~ '^[0-9a-f-]{36}$');
insert into t.ids select 'plan-v1', t.cas_version('notes/plan.md');

select t.expect_true('write: the current version succeeds',
  t.run('ben', format($q$select public.write_file(%L, 'notes/plan.md', 'v2', %L::uuid)$q$, t.id('swap'), t.id('plan-v1'))) ~ '^[0-9a-f-]{36}$');
insert into t.ids select 'plan-v2', t.cas_version('notes/plan.md');
select t.expect_true('write: the current version succeeding actually applies the new body',
  (select body from public.file_versions where id = t.id('plan-v2')) = 'v2');
select t.expect_true('write: the current version succeeding moves the file to a new version',
  t.id('plan-v2') is distinct from t.id('plan-v1'));

select t.expect('write: an older version is refused',
  t.run('ben', format($q$select public.write_file(%L, 'notes/plan.md', 'v3', %L::uuid)$q$, t.id('swap'), t.id('plan-v1'))),
  'ERR RLF01');
select t.expect_true('write: the refusal names the current version and its last writer',
  t.cas_err('ben', format($q$select public.write_file(%L, 'notes/plan.md', 'v3', %L::uuid)$q$, t.id('swap'), t.id('plan-v1')))
    like '%' || t.id('plan-v2')::text || '%' || t.id('ben')::text || '%');
select t.expect_true('write: a refused write leaves the current version unchanged',
  t.cas_version('notes/plan.md') = t.id('plan-v2'));

select t.expect_true('write: no expected_version behaves as before',
  t.run('ben', format($q$select public.write_file(%L, 'notes/plan.md', 'v4')$q$, t.id('swap'))) ~ '^[0-9a-f-]{36}$');
insert into t.ids select 'plan-v4', t.cas_version('notes/plan.md');

-- ---------------------------------------------------------------------------
-- Access still gates the write, whether or not a version is given

select t.expect('write: a canon path is still refused, with no expected version',
  t.run('ana', format($q$select public.write_file(%L, 'canon/plan.md', 'x')$q$, t.id('swap'))), 'ERR 42501');
select t.expect('write: a canon path is still refused, with an expected version',
  t.run('ana', format($q$select public.write_file(%L, 'canon/plan.md', 'x', %L::uuid)$q$, t.id('swap'), t.id('plan-v4'))),
  'ERR 42501');
select t.expect('write: a read-only connection is refused even with the current version (no RLF01 leak)',
  t.run_tok('ana', 'swap-ro', format($q$select public.write_file(%L, 'notes/plan.md', 'x', %L::uuid)$q$, t.id('swap'), t.id('plan-v4'))),
  'ERR 42501');
select t.expect('write: a viewer is refused even with the current version',
  t.run('cal', format($q$select public.write_file(%L, 'notes/plan.md', 'x', %L::uuid)$q$, t.id('swap'), t.id('plan-v4'))),
  'ERR 42501');
select t.expect('write: an outsider is refused even with the current version',
  t.run('dee', format($q$select public.write_file(%L, 'notes/plan.md', 'x', %L::uuid)$q$, t.id('swap'), t.id('plan-v4'))),
  'ERR 42501');

-- ---------------------------------------------------------------------------
-- delete_file: current, stale and absent expected_version

select t.expect_true('delete: seed notes/scratch.md',
  t.run('ben', format($q$select public.write_file(%L, 'notes/scratch.md', 'x')$q$, t.id('swap'))) ~ '^[0-9a-f-]{36}$');
insert into t.ids select 'scratch-v1', t.cas_version('notes/scratch.md');

select t.expect('delete: a stale version is refused',
  t.run('ben', format($q$select public.delete_file(%L, 'notes/scratch.md', %L::uuid)::text$q$, t.id('swap'), t.id('plan-v1'))),
  'ERR RLF01');
select t.expect_true('delete: a refused delete leaves the file in place',
  not exists (select 1 from public.files where vault_id = t.id('swap') and path = 'notes/scratch.md' and deleted_at is not null));
select t.expect('delete: a canon path is still refused, with an expected version',
  t.run('ana', format($q$select public.delete_file(%L, 'canon/plan.md', %L::uuid)::text$q$, t.id('swap'), t.id('plan-v4'))),
  'ERR 42501');
select t.expect('delete: a read-only connection is refused even with the current version',
  t.run_tok('ana', 'swap-ro', format($q$select public.delete_file(%L, 'notes/scratch.md', %L::uuid)::text$q$, t.id('swap'), t.id('scratch-v1'))),
  'ERR 42501');

select t.expect('delete: the current version succeeds',
  t.run('ben', format($q$select public.delete_file(%L, 'notes/scratch.md', %L::uuid)::text$q$, t.id('swap'), t.id('scratch-v1'))),
  '');
select t.expect_true('delete: the current version succeeding marks the file deleted',
  exists (select 1 from public.files where vault_id = t.id('swap') and path = 'notes/scratch.md' and deleted_at is not null));

select t.expect_true('delete: seed notes/scratch2.md',
  t.run('ben', format($q$select public.write_file(%L, 'notes/scratch2.md', 'x')$q$, t.id('swap'))) ~ '^[0-9a-f-]{36}$');
select t.expect('delete: no expected_version behaves as before',
  t.run('ben', format($q$select public.delete_file(%L, 'notes/scratch2.md')::text$q$, t.id('swap'))), '');
select t.expect_true('delete: no expected_version succeeding still marks the file deleted',
  exists (select 1 from public.files where vault_id = t.id('swap') and path = 'notes/scratch2.md' and deleted_at is not null));

-- ---------------------------------------------------------------------------
-- A deleted file is "no file yet": a stale save can't bring it back, and an
-- expected_version for it is stale whether or not anyone wrote there since.

select t.expect_true('deleted file: seed notes/gone.md',
  t.run('ben', format($q$select public.write_file(%L, 'notes/gone.md', 'mine')$q$, t.id('swap'))) ~ '^[0-9a-f-]{36}$');
insert into t.ids select 'gone-v1', t.cas_version('notes/gone.md');
select t.expect('deleted file: its version still deletes it',
  t.run('ana', format($q$select public.delete_file(%L, 'notes/gone.md', %L::uuid)::text$q$, t.id('swap'), t.id('gone-v1'))),
  '');

select t.expect('deleted file: a save holding the version read before the delete is refused',
  t.run('ben', format($q$select public.write_file(%L, 'notes/gone.md', 'stale', %L::uuid)$q$, t.id('swap'), t.id('gone-v1'))),
  'ERR RLF01');
select t.expect_true('deleted file: the refusal says the file no longer exists, not a current version by nobody',
  t.cas_err('ben', format($q$select public.write_file(%L, 'notes/gone.md', 'stale', %L::uuid)$q$, t.id('swap'), t.id('gone-v1')))
    like '%no longer exists%'
  and t.cas_err('ben', format($q$select public.write_file(%L, 'notes/gone.md', 'stale', %L::uuid)$q$, t.id('swap'), t.id('gone-v1')))
    not like '%nobody%');
select t.expect_true('deleted file: a refused save leaves it deleted, with no new version',
  exists (select 1 from public.files where vault_id = t.id('swap') and path = 'notes/gone.md' and deleted_at is not null)
  and (select count(*) from public.file_versions where file_id = (select id from public.files where vault_id = t.id('swap') and path = 'notes/gone.md')) = 1);
select t.expect('deleted file: a second delete holding the old version is refused as stale, not as missing',
  t.run('ben', format($q$select public.delete_file(%L, 'notes/gone.md', %L::uuid)::text$q$, t.id('swap'), t.id('gone-v1'))),
  'ERR RLF01');

select t.expect_true('deleted file: a write with no expected version creates it again',
  t.run('ben', format($q$select public.write_file(%L, 'notes/gone.md', 'again')$q$, t.id('swap'))) ~ '^[0-9a-f-]{36}$');
select t.expect_true('deleted file: creating it again brings it back, as a new version',
  exists (select 1 from public.files where vault_id = t.id('swap') and path = 'notes/gone.md' and deleted_at is null)
  and t.cas_version('notes/gone.md') <> t.id('gone-v1'));
select t.expect('deleted file: once created again, the version from before the delete is still stale',
  t.run('ben', format($q$select public.write_file(%L, 'notes/gone.md', 'stale', %L::uuid)$q$, t.id('swap'), t.id('gone-v1'))),
  'ERR RLF01');

select t.expect('deleted file: a path never written is no file yet either',
  t.run('ben', format($q$select public.write_file(%L, 'notes/never.md', 'x', %L::uuid)$q$, t.id('swap'), t.id('gone-v1'))),
  'ERR RLF01');

select t.expect('deleted file: the version check is not callable by a signed-in person',
  t.run('ana', format($q$select private.check_expected_version(%L, 'notes/gone.md', %L::uuid)::text$q$, t.id('swap'), t.id('gone-v1'))),
  'ERR 42501');
