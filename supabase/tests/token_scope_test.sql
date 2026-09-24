-- Hostile tests for scoped, expiring agent tokens (20260924160000_token_scope).
-- A token reaches all of its person's vaults or a chosen set, read-only or
-- read-write, and the database enforces it through private.role_in().

-- ---------------------------------------------------------------------------
-- Setup: Ana owns Team (Ben edits) and Side; Dee owns Private.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
insert into t.ids select 'priv', t.run('dee', $q$select public.create_vault('Private')$q$)::uuid;
select t.run('ana', format($q$select public.set_member(%L, %L, 'editor')$q$, t.id('team'), t.id('ben')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/alpha.md', 'Alpha plan for Team')$q$, t.id('team')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/bravo.md', 'Bravo plan for Side')$q$, t.id('side')));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('team')));
select t.run('ana', format($q$select public.set_policy(%L, 'side/', 'canon', 1)$q$, t.id('side')));

-- Tokens are referred to by name; t.tok finds the id, t.run_tok acts
-- through one exactly as the MCP server does (act.tok = the token id).
create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;

create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;

select t.run('ana', $q$select public.create_access_token('legacy')$q$);
create table t.raw (name text primary key, token text);
insert into t.raw select 'team-rw',
  t.run('ana', format($q$select public.create_access_token('team-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_access_token('team-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('team')));
select t.run('ana', $q$select public.create_access_token('all-ro', 30, null, 'read')$q$);
insert into t.raw select 'to-revoke',
  t.run('ana', format($q$select public.create_access_token('to-revoke', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_access_token('to-expire', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('ben', $q$select public.create_access_token('ben-all', 30)$q$);

-- ---------------------------------------------------------------------------
-- Creating

select t.expect_true('create: the old two-argument call still makes an all-vaults read-write token',
  (select all_vaults and access = 'write' and cardinality(vault_ids) = 0 from public.access_tokens where name = 'legacy'));
select t.expect_true('create: a scoped token stores its vaults and access',
  (select not all_vaults and vault_ids = array[t.id('team')] and access = 'read'
     from public.access_tokens where name = 'team-ro'));
select t.expect_true('create: every token has an expiry',
  not exists (select 1 from public.access_tokens where expires_at is null));
select t.expect('create: no expiry is refused',
  t.run('ana', $q$select public.create_access_token('forever', null)$q$), 'ERR 22023');
select t.expect('create: an unknown access level is refused',
  t.run('ana', $q$select public.create_access_token('x', 30, null, 'admin')$q$), 'ERR 22023');
select t.expect('create: a null access level is refused',
  t.run('ana', $q$select public.create_access_token('x', 30, null, null)$q$), 'ERR 22023');
select t.expect('create: an empty vault list is refused, not read as "all"',
  t.run('ana', $q$select public.create_access_token('x', 30, '{}'::uuid[], 'read')$q$), 'ERR 22023');
select t.expect('create: a vault list with a null is refused',
  t.run('ana', $q$select public.create_access_token('x', 30, array[null]::uuid[], 'read')$q$), 'ERR 22023');
select t.expect('create: a token cannot reach a vault its person is not in',
  t.run('ana', format($q$select public.create_access_token('x', 30, array[%L]::uuid[], 'read')$q$, t.id('priv'))), 'ERR 22023');
select t.expect('create: an agent cannot mint a scoped token',
  t.run('ana', format($q$select public.create_access_token('x', 30, array[%L]::uuid[], 'read')$q$, t.id('team')), 'Claude Code'), 'ERR 42501');
select t.expect('create: a token cannot mint a token',
  t.run_tok('ana', 'legacy', $q$select public.create_access_token('x', 30)$q$), 'ERR 42501');
select t.expect('create: anonymous cannot call it',
  t.run(null, $q$select public.create_access_token('x', 30, null, 'read')$q$), 'ERR 42501');
select t.expect('create: scope cannot be edited afterwards, even by the person',
  t.run('ana', format($q$update public.access_tokens set all_vaults = true, access = 'write' where id = %L returning 1$q$, t.tok('team-ro'))),
  'ERR 42501');
select t.expect('read: a person sees their tokens'' scope, access and client columns',
  t.run('ana', format($q$select access || ' ' || all_vaults || ' ' || coalesce(client_name, '-') from public.access_tokens where id = %L$q$, t.tok('team-ro'))),
  'read false -');

-- ---------------------------------------------------------------------------
-- A scoped token never sees another vault

select t.expect('scope: a token scoped to Team lists only Team',
  t.run_tok('ana', 'team-rw', $q$select string_agg(name, ',' order by name) from public.vaults$q$), 'Team');
select t.expect('scope: an all-vaults token lists all of its person''s vaults',
  t.run_tok('ana', 'legacy', $q$select string_agg(name, ',' order by name) from public.vaults$q$), 'Side,Team');
select t.expect('scope: no file of the other vault is visible',
  t.run_tok('ana', 'team-rw', format($q$select count(*) from public.files where vault_id = %L$q$, t.id('side'))), '0');
select t.expect('scope: no version text of the other vault is visible',
  t.run_tok('ana', 'team-rw', format($q$select count(*) from public.file_versions where vault_id = %L$q$, t.id('side'))), '0');
select t.expect('scope: search in the other vault finds nothing',
  t.run_tok('ana', 'team-rw', format($q$select count(*) from public.search(%L, 'Bravo')$q$, t.id('side'))), '0');
select t.expect('scope: search in its own vault still works',
  t.run_tok('ana', 'team-rw', format($q$select string_agg(path, ',') from public.search(%L, 'Alpha')$q$, t.id('team'))), 'notes/alpha.md');
select t.expect('scope: the other vault''s feed is empty',
  t.run_tok('ana', 'team-rw', format($q$select count(*) from public.changes_since(%L, 0)$q$, t.id('side'))), '0');
select t.expect('scope: the other vault''s log is invisible',
  t.run_tok('ana', 'team-rw', format($q$select count(*) from public.log where vault_id = %L$q$, t.id('side'))), '0');
select t.expect('scope: the other vault''s members are invisible',
  t.run_tok('ana', 'team-rw', format($q$select count(*) from public.vault_members where vault_id = %L$q$, t.id('side'))), '0');
select t.expect('scope: the other vault''s rules are invisible',
  t.run_tok('ana', 'team-rw', $q$select count(*) from public.path_policies$q$), '1');
select t.expect('scope: the person has no role there through this token',
  t.run_tok('ana', 'team-rw', format($q$select coalesce(private.role_in(%L), 'none')$q$, t.id('side'))), 'none');
select t.expect('scope: writing to the other vault is refused',
  t.run_tok('ana', 'team-rw', format($q$select public.write_file(%L, 'notes/x.md', 'x')$q$, t.id('side'))), 'ERR 42501');
select t.expect('scope: proposing to the other vault is refused',
  t.run_tok('ana', 'team-rw', format($q$select public.propose(%L, 'notes/x.md', 'x')$q$, t.id('side'))), 'ERR 42501');
select t.expect('scope: deleting in the other vault is refused',
  t.run_tok('ana', 'team-rw', format($q$select public.delete_file(%L, 'notes/bravo.md')$q$, t.id('side'))), 'ERR 42501');
select t.expect_ok('scope: writing to its own vault works',
  t.run_tok('ana', 'team-rw', format($q$select public.write_file(%L, 'notes/agent.md', 'from the agent')$q$, t.id('team'))));
select t.expect('scope: the write is attributed to the token''s agent',
  (select agent from public.file_versions v join public.files f on f.current_version_id = v.id
    where f.path = 'notes/agent.md'), 'team-rw');
select t.expect_ok('scope: an all-vaults read-write token writes anywhere its person can',
  t.run_tok('ana', 'legacy', format($q$select public.write_file(%L, 'notes/legacy.md', 'x')$q$, t.id('side'))));
select t.expect('scope: the web UI (no token) still sees every vault',
  t.run('ana', $q$select count(*) from public.vaults$q$), '2');

-- ---------------------------------------------------------------------------
-- A read-only token reads and nothing else

insert into t.ids select 'prop', t.run_tok('ana', 'team-rw',
  format($q$select public.propose(%L, 'canon/rates.md', 'Day rate 800', 'rates')$q$, t.id('team')))::uuid;

select t.expect('read-only: reads files in scope',
  t.run_tok('ana', 'team-ro', format($q$select count(*) from public.files where vault_id = %L$q$, t.id('team'))), '2');
select t.expect('read-only: its person counts as a viewer',
  t.run_tok('ana', 'team-ro', format($q$select private.role_in(%L)$q$, t.id('team'))), 'viewer');
select t.expect('read-only: cannot write an open file',
  t.run_tok('ana', 'team-ro', format($q$select public.write_file(%L, 'notes/x.md', 'x')$q$, t.id('team'))), 'ERR 42501');
select t.expect('read-only: cannot delete a file',
  t.run_tok('ana', 'team-ro', format($q$select public.delete_file(%L, 'notes/alpha.md')$q$, t.id('team'))), 'ERR 42501');
select t.expect('read-only: cannot propose',
  t.run_tok('ana', 'team-ro', format($q$select public.propose(%L, 'canon/x.md', 'x')$q$, t.id('team'))), 'ERR 42501');
select t.expect('read-only: cannot revise its person''s proposal',
  t.run_tok('ana', 'team-ro', format($q$select public.revise_proposal(%L, 'Day rate 900', 'cheaper')$q$, t.id('prop'))), 'ERR P0002');
select t.expect('read-only: an all-vaults read-only token cannot write either',
  t.run_tok('ana', 'all-ro', format($q$select public.write_file(%L, 'notes/x.md', 'x')$q$, t.id('side'))), 'ERR 42501');
select t.expect('read-only: nothing was written',
  (select count(*)::text from public.files where path = 'notes/x.md'), '0');
select t.expect_ok('read-write: the same person''s read-write token can revise',
  t.run_tok('ana', 'team-rw', format($q$select public.revise_proposal(%L, 'Day rate 850', 'middle')$q$, t.id('prop'))));

-- ---------------------------------------------------------------------------
-- The delegation ceiling still holds for every token

select t.expect('ceiling: a read-write token cannot approve',
  t.run_tok('ana', 'team-rw', format($q$select public.decide(%L, 'approve')$q$, t.id('prop'))), 'ERR 42501');
select t.expect('ceiling: a read-write token cannot set rules',
  t.run_tok('ana', 'legacy', format($q$select public.set_policy(%L, 'x/', 'open')$q$, t.id('team'))), 'ERR 42501');
select t.expect('ceiling: a read-write token cannot manage members',
  t.run_tok('ana', 'legacy', format($q$select public.set_member(%L, %L, 'owner')$q$, t.id('team'), t.id('ben'))), 'ERR 42501');
select t.expect('ceiling: a token id alone, with no agent name, still counts as an agent',
  t.run_claims(jsonb_build_object('sub', t.id('ana'), 'act', jsonb_build_object('tok', t.tok('legacy'))),
    format($q$select public.decide(%L, 'approve')$q$, t.id('prop'))), 'ERR 42501');
select t.expect('ceiling: an empty act object still counts as an agent',
  t.run_claims(jsonb_build_object('sub', t.id('ana'), 'act', '{}'::jsonb),
    format($q$select public.decide(%L, 'approve')$q$, t.id('prop'))), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- Forged claims: a token id must be a live token of the claimed person

select t.expect('forged: Ben with Ana''s token id sees nothing, though he is a Team editor',
  t.run_claims(jsonb_build_object('sub', t.id('ben'), 'act', jsonb_build_object('name', 'x', 'tok', t.tok('team-rw'))),
    $q$select count(*) from public.files$q$), '0');
select t.expect('forged: Ben with Ana''s token id cannot write',
  t.run_claims(jsonb_build_object('sub', t.id('ben'), 'act', jsonb_build_object('name', 'x', 'tok', t.tok('team-rw'))),
    format($q$select public.write_file(%L, 'notes/x.md', 'x')$q$, t.id('team'))), 'ERR 42501');
select t.expect('forged: an unknown token id sees nothing',
  t.run_claims(jsonb_build_object('sub', t.id('ana'), 'act', jsonb_build_object('name', 'x', 'tok', gen_random_uuid())),
    $q$select count(*) from public.vaults$q$), '0');
select t.expect('forged: a malformed token id is an error, not a pass',
  t.run_claims(jsonb_build_object('sub', t.id('ana'), 'act', jsonb_build_object('name', 'x', 'tok', 'all')),
    $q$select count(*) from public.vaults$q$), 'ERR 22P02');
select t.expect('forged: Ben''s own all-vaults token cannot reach Ana''s Side vault',
  t.run_tok('ben', 'ben-all', format($q$select count(*) from public.files where vault_id = %L$q$, t.id('side'))), '0');

-- ---------------------------------------------------------------------------
-- Revoked and expired tokens stop working at once, even mid-session

select t.expect('revoke: works before revoking',
  t.run_tok('ana', 'to-revoke', $q$select count(*) from public.vaults$q$), '1');
select t.run('ana', format($q$select public.revoke_access_token(%L)$q$, t.tok('to-revoke')));
select t.expect('revoke: a revoked token sees nothing on its next call',
  t.run_tok('ana', 'to-revoke', $q$select count(*) from public.files$q$), '0');
select t.expect('revoke: a revoked token cannot write',
  t.run_tok('ana', 'to-revoke', format($q$select public.write_file(%L, 'notes/x.md', 'x')$q$, t.id('team'))), 'ERR 42501');
update public.access_tokens set expires_at = now() - interval '1 second' where name = 'to-expire';
select t.expect('expiry: an expired token sees nothing',
  t.run_tok('ana', 'to-expire', $q$select count(*) from public.file_versions$q$), '0');
select t.expect('expiry: an expired token cannot propose',
  t.run_tok('ana', 'to-expire', format($q$select public.propose(%L, 'canon/x.md', 'x')$q$, t.id('team'))), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- Client name: recorded by the MCP server's role only, by token hash

create function t.hash(p_name text) returns text language sql as
$$ select encode(extensions.digest(token, 'sha256'), 'hex') from t.raw where name = p_name $$;

select t.run_role('reliquary_mcp', format($q$select private.record_token_client(%L, %L)$q$,
  t.hash('team-rw'), E'  Claude\tCode\n' || repeat('x', 200)));
select t.expect_true('client: the MCP role records the client name, cleaned and capped',
  (select client_name like 'Claude Code %' and length(client_name) = 100 and client_name !~ '[[:cntrl:]]'
     from public.access_tokens where name = 'team-rw'));
select t.expect('client: the MCP role resolves a scoped token',
  t.run_role('reliquary_mcp', format($q$select name from private.resolve_access_token(%L)$q$, t.hash('team-rw'))), 'team-rw');
select t.expect_true('client: resolving records when the token was last used',
  (select last_used_at > now() - interval '1 minute' from public.access_tokens where name = 'team-rw'));
select t.run_role('reliquary_mcp', format($q$select private.record_token_client(%L, 'Evil')$q$, t.hash('to-revoke')));
select t.expect('client: a revoked token''s client name is not updated',
  (select coalesce(client_name, 'none') from public.access_tokens where name = 'to-revoke'), 'none');
select t.expect('client: a person cannot set a client name',
  t.run('ana', format($q$select private.record_token_client(%L, 'Fake')$q$, t.hash('team-rw'))), 'ERR 42501');
select t.expect('client: a token cannot set a client name',
  t.run_tok('ana', 'team-rw', format($q$select private.record_token_client(%L, 'Fake')$q$, t.hash('team-rw'))), 'ERR 42501');
select t.expect('client: anonymous cannot set a client name',
  t.run(null, format($q$select private.record_token_client(%L, 'Fake')$q$, t.hash('team-rw'))), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- Grants: nothing in public or private is callable by anonymous

select t.expect('grants: no public or private function is executable by anon',
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ','), 'none')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and has_function_privilege('anon', p.oid, 'execute')),
  'none');

-- Membership changes last: they change what the tests above rely on.

select t.expect('leaving: once its person leaves a vault, their all-vaults token reaches nothing there',
  (select t.run('ana', format($q$select public.set_member(%L, %L, null)$q$, t.id('team'), t.id('ben'))) is not null
          and t.run_tok('ben', 'ben-all', format($q$select count(*) from public.files where vault_id = %L$q$, t.id('team'))) = '0')::text,
  'true');
