-- Hostile tests for 20260924190000_rule_for: a vault's rules are visible
-- only to those who can read the vault, and only through rule_for.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 2)$q$, t.id('team')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/a.md', 'Alpha')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_access_token('side-only', 30, array[%L]::uuid[], 'read')$q$, t.id('side')));

select t.expect('rules: a member reads a path''s rule',
  t.run('ana', format($q$select (private.rule_for(%L, 'canon/x.md')).policy$q$, t.id('team'))), 'canon');
select t.expect('rules: a non-member gets nothing for another vault''s path',
  t.run('dee', format($q$select (private.rule_for(%L, 'canon/x.md')).policy$q$, t.id('team'))), null);
select t.expect('rules: a non-member can''t learn the quorum either',
  t.run('dee', format($q$select (private.rule_for(%L, 'canon/x.md')).quorum$q$, t.id('team'))), null);
select t.expect('rules: policy_for is no longer callable by signed-in users',
  t.run('dee', format($q$select (private.policy_for(%L, 'canon/x.md')).policy$q$, t.id('team'))), 'ERR 42501');
select t.expect('rules: a token scoped to another vault gets nothing',
  t.run_claims(jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated',
    'act', jsonb_build_object('name', 'side-only', 'tok',
      (select id from public.access_tokens where name = 'side-only'))),
    format($q$select (private.rule_for(%L, 'canon/x.md')).policy$q$, t.id('team'))), null);
select t.expect('rules: search still reports the policy for members',
  t.run('ana', format($q$select policy from public.search(%L, 'Alpha')$q$, t.id('team'))), 'open');
select t.expect('rules: canon writes are still refused (the API still sees policy_for)',
  t.run('ana', format($q$select public.write_file(%L, 'canon/x.md', 'x')$q$, t.id('team'))), 'ERR 42501');
