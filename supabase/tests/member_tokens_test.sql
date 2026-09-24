-- Leaving or being removed ends that person's tokens for the vault for good
-- (20260925180000_member_tokens.sql), so a re-invite can't revive them.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('side'), t.id('ben'), 'editor', t.id('ana'));
select t.run('ben', format($q$select public.create_access_token('team-only', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('ben', format($q$select public.create_access_token('both', 30, array[%L, %L]::uuid[], 'write')$q$, t.id('team'), t.id('side')));
select t.run('ben', $q$select public.create_access_token('everything', 30)$q$);

select t.run('ben', format($q$select public.leave_vault(%L)$q$, t.id('team')));

select t.expect_true('member tokens: a token scoped only to the vault left is revoked',
  (select revoked_at is not null from public.access_tokens where name = 'team-only'));
select t.expect_true('member tokens: a multi-vault token loses only that vault',
  (select revoked_at is null and vault_ids = array[t.id('side')] from public.access_tokens where name = 'both'));
select t.expect_true('member tokens: an all-vaults token is untouched',
  (select revoked_at is null and all_vaults from public.access_tokens where name = 'everything'));

-- Re-invited later: the old scoped tokens still don't reach Team.
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select t.expect_true('member tokens: after a re-invite the narrowed token still lacks the vault',
  (select not (t.id('team') = any(vault_ids)) from public.access_tokens where name = 'both'));
select t.expect_true('member tokens: after a re-invite the revoked token stays revoked',
  (select revoked_at is not null from public.access_tokens where name = 'team-only'));

-- Removal by an owner does the same.
select t.run('ben', format($q$select public.create_access_token('team-again', 30, array[%L]::uuid[], 'read')$q$, t.id('team')));
select t.run('ana', format($q$select public.set_member(%L, %L, null)$q$, t.id('team'), t.id('ben')));
select t.expect_true('member tokens: removal by an owner revokes the scoped token too',
  (select revoked_at is not null from public.access_tokens where name = 'team-again'));
select t.expect('member tokens: nobody signed in can call the trigger function',
  t.run('ben', $q$select private.drop_member_tokens()$q$), 'ERR 42501');
