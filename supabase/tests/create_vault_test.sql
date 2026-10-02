-- Hostile tests for agents creating vaults (20260924230000_agent_create_vault).
-- An agent may create a vault for its person only through a live token of
-- theirs that reaches all their vaults with read-write access; the person
-- owns it, the log names the agent, and rules and members stay human-only.

-- ---------------------------------------------------------------------------
-- Setup: Ana owns Team; Ben has his own all-vaults token.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;

select t.run('ana', $q$select public.create_access_token('all-rw', 30, null, 'write')$q$);
select t.run('ana', $q$select public.create_access_token('all-ro', 30, null, 'read')$q$);
select t.run('ana', format($q$select public.create_access_token('team-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_access_token('team-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('team')));
select t.run('ana', $q$select public.create_access_token('revoked-rw', 30, null, 'write')$q$);
select t.run('ana', format($q$select public.revoke_access_token(%L)$q$, t.tok('revoked-rw')));
select t.run('ana', $q$select public.create_access_token('expired-rw', 30, null, 'write')$q$);
update public.access_tokens set expires_at = now() - interval '1 second' where name = 'expired-rw';
select t.run('ben', $q$select public.create_access_token('ben-rw', 30, null, 'write')$q$);

-- OAuth grants are access_tokens rows too: one all-vaults write, one scoped.
select t.run('ana', $q$select public.create_oauth_grant('oauth-all-rw', 'https://c.example/m.json',
  'https://c.example/cb', 'https://mcp.example/mcp', repeat('a', 43), null, 'write')$q$);
select t.run('ana', format($q$select public.create_oauth_grant('oauth-team-rw', 'https://c.example/m.json',
  'https://c.example/cb', 'https://mcp.example/mcp', repeat('a', 43), array[%L]::uuid[], 'write')$q$, t.id('team')));

-- ---------------------------------------------------------------------------
-- The person

select t.expect_ok('create vault: a person creates one and owns it',
  t.run('ana', $q$select public.create_vault('Mine')$q$));
select t.expect('create vault: the person is its only member, as owner',
  (select string_agg(m.role || ':' || (m.user_id = t.id('ana'))::text, ',') from public.vault_members m
     join public.vaults v on v.id = m.vault_id where v.name = 'Mine'), 'owner:true');

-- ---------------------------------------------------------------------------
-- An agent through an all-vaults, read-write token

insert into t.ids select 'agentvault',
  t.run_tok('ana', 'all-rw', $q$select public.create_vault('Agent made', 'canon')$q$)::uuid;
select t.expect_true('create vault: an agent with an all-vaults read-write token creates one',
  t.id('agentvault') is not null);
select t.expect('create vault: its person owns it, never the agent',
  (select v.created_by::text || ' ' || m.role || ' ' || m.user_id::text
     from public.vaults v join public.vault_members m on m.vault_id = v.id where v.id = t.id('agentvault')),
  t.id('ana')::text || ' owner ' || t.id('ana')::text);
select t.expect('create vault: the log records the agent, acting for its person',
  (select actor::text || ' ' || agent || ' ' || event || ' ' || (detail ->> 'default_policy')
     from public.log where vault_id = t.id('agentvault')),
  t.id('ana')::text || ' all-rw vault.create canon');
select t.expect('create vault: the same token reaches the new vault, as owner',
  t.run_tok('ana', 'all-rw', format($q$select private.role_in(%L)$q$, t.id('agentvault'))), 'owner');
select t.expect_ok('create vault: the agent writes in it as usual (a canon default means proposals)',
  t.run_tok('ana', 'all-rw', format($q$select public.propose(%L, 'brief.md', 'Brief.', 'first')$q$, t.id('agentvault'))));
select t.expect_ok('create vault: an OAuth grant for all vaults with write creates one',
  t.run_tok('ana', 'oauth-all-rw', $q$select public.create_vault('Via OAuth')$q$));

-- ---------------------------------------------------------------------------
-- Tokens that could not reach it are refused, and nothing is created

select t.expect('create vault: an all-vaults read-only token is refused',
  t.run_tok('ana', 'all-ro', $q$select public.create_vault('Refused ro')$q$), 'ERR 42501');
select t.expect('create vault: a token scoped to chosen vaults is refused, even read-write',
  t.run_tok('ana', 'team-rw', $q$select public.create_vault('Refused scoped')$q$), 'ERR 42501');
select t.expect('create vault: a scoped read-only token is refused',
  t.run_tok('ana', 'team-ro', $q$select public.create_vault('Refused scoped ro')$q$), 'ERR 42501');
select t.expect('create vault: a scoped OAuth grant is refused',
  t.run_tok('ana', 'oauth-team-rw', $q$select public.create_vault('Refused oauth')$q$), 'ERR 42501');
select t.expect('create vault: a revoked token is refused',
  t.run_tok('ana', 'revoked-rw', $q$select public.create_vault('Refused revoked')$q$), 'ERR 42501');
select t.expect('create vault: an expired token is refused',
  t.run_tok('ana', 'expired-rw', $q$select public.create_vault('Refused expired')$q$), 'ERR 42501');
select t.expect('create vault: someone else''s token is refused',
  t.run_claims(jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated',
    'act', jsonb_build_object('sub', 'x', 'name', 'x', 'tok', t.tok('ben-rw'))),
    $q$select public.create_vault('Refused borrowed')$q$), 'ERR 42501');
select t.expect('create vault: an unknown token id is refused',
  t.run_claims(jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated',
    'act', jsonb_build_object('sub', 'x', 'name', 'x', 'tok', gen_random_uuid())),
    $q$select public.create_vault('Refused unknown')$q$), 'ERR 42501');
select t.expect_true('create vault: a malformed token id fails the request',
  t.run_claims(jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated',
    'act', jsonb_build_object('sub', 'x', 'name', 'x', 'tok', 'not-a-uuid')),
    $q$select public.create_vault('Refused malformed')$q$) like 'ERR %');
select t.expect('create vault: an agent with no token at all is refused',
  t.run('ana', $q$select public.create_vault('Refused tokenless')$q$, 'Claude Code'), 'ERR 42501');
select t.expect('create vault: an agent claim with a null tok is refused',
  t.run_claims(jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated',
    'act', jsonb_build_object('sub', 'x', 'name', 'x', 'tok', null)),
    $q$select public.create_vault('Refused null tok')$q$), 'ERR 42501');
select t.expect('create vault: anonymous is refused',
  t.run(null, $q$select public.create_vault('Refused anon')$q$), 'ERR 42501');
select t.expect('create vault: none of the refused calls left a vault behind',
  (select count(*)::int from public.vaults where name like 'Refused%')::text, '0');

-- ---------------------------------------------------------------------------
-- Rules and members stay human-only, even in a vault the agent created

select t.expect('ceiling: the agent cannot set rules in the vault it created',
  t.run_tok('ana', 'all-rw', format($q$select public.set_policy(%L, 'notes/', 'open', 1)$q$, t.id('agentvault'))), 'ERR 42501');
select t.expect('ceiling: the agent cannot add members to the vault it created',
  t.run_tok('ana', 'all-rw', format($q$select public.set_member(%L, %L, 'editor')$q$, t.id('agentvault'), t.id('dee'))), 'ERR 42501');
select t.expect('ceiling: the agent cannot erase in the vault it created',
  t.run_tok('ana', 'all-rw', format($q$select public.erase_file(%L, 'brief.md')$q$, t.id('agentvault'))), 'ERR 42501');
select t.expect('ceiling: the person sets rules in the vault their agent created',
  t.run('ana', format($q$select 'ok' from (select public.set_policy(%L, 'notes/', 'open', 1)) s$q$, t.id('agentvault'))), 'ok');

-- ---------------------------------------------------------------------------
-- Input

select t.expect('input: a blank name is refused',
  t.run('ana', $q$select public.create_vault('   ')$q$), 'ERR 22023');
select t.expect('input: a null name is refused',
  t.run('ana', $q$select public.create_vault(null)$q$), 'ERR 22023');
select t.expect('input: a name over 100 characters is refused',
  t.run('ana', format($q$select public.create_vault(%L)$q$, repeat('n', 101))), 'ERR 22023');
select t.expect('input: an unknown default policy is refused',
  t.run('ana', $q$select public.create_vault('Odd', 'secret')$q$), 'ERR 22023');
select t.expect('input: a null default policy is refused',
  t.run('ana', $q$select public.create_vault('Odd', null)$q$), 'ERR 22023');
insert into t.ids select 'padded', t.run('ana', $q$select public.create_vault('  Padded  ')$q$)::uuid;
select t.expect('input: the name is trimmed',
  (select name from public.vaults where id = t.id('padded')), 'Padded');
select t.expect('input: the default policy defaults to open',
  (select default_policy from public.vaults where name = 'Mine'), 'open');

-- ---------------------------------------------------------------------------
-- Grants

select t.expect('grants: the check itself is not callable by signed-in users',
  t.run('ana', $q$select private.may_create_vault()::text$q$), 'ERR 42501');
