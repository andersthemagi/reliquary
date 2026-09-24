-- Hostile tests for access tokens, search, and the MCP server role.

insert into t.ids select 'v1', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
select t.run('ana', format($q$select public.set_member(%L, %L, 'editor')$q$, t.id('v1'), t.id('ben')));
select t.run('ana', format($q$select public.write_file(%L, 'clients/acme.md', 'Acme pays net 30. Contact is Rosa.')$q$, t.id('v1')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/offsite.md', 'Offsite in Lisbon in May.')$q$, t.id('v1')));
insert into t.ids select 'v2', t.run('dee', $q$select public.create_vault('Private')$q$)::uuid;
select t.run('dee', format($q$select public.write_file(%L, 'secret.md', 'Acme acquisition talks')$q$, t.id('v2')));

-- Creating tokens

create table t.tokens (name text primary key, token text);
insert into t.tokens select 'ana', t.run('ana', $q$select public.create_access_token('Claude Code on MacBook', 30)$q$);
insert into t.tokens select 'ben', t.run('ben', $q$select public.create_access_token('Hermes on Linux')$q$);

select t.expect_true('create: a person gets a token',
  (select token like 'rlq_%' and length(token) = 68 from t.tokens where name = 'ana'));
select t.expect('create: an agent cannot mint a token',
  t.run('ana', $q$select public.create_access_token('sneaky')$q$, 'Claude Code'), 'ERR 42501');
select t.expect('create: anonymous cannot mint a token',
  t.run(null, $q$select public.create_access_token('x')$q$), 'ERR 42501');
select t.expect('create: lifetime is bounded',
  t.run('ana', $q$select public.create_access_token('forever', 5000)$q$), 'ERR 22023');
select t.expect_true('create: only the hash is stored',
  not exists (select 1 from public.access_tokens a join t.tokens k on a.token_hash = k.token));

-- Reading tokens

select t.expect('read: a person cannot read token hashes, even their own',
  t.run('ana', $q$select token_hash from public.access_tokens limit 1$q$), 'ERR 42501');
select t.expect('read: a person sees their own tokens'' names',
  t.run('ana', $q$select string_agg(name, ',') from public.access_tokens$q$), 'Claude Code on MacBook');
select t.expect('read: nobody sees another person''s tokens',
  t.run('dee', $q$select count(*) from public.access_tokens$q$), '0');
select t.expect('read: anonymous sees nothing',
  t.run(null, $q$select count(*) from public.access_tokens$q$), 'ERR 42501');

-- Resolving (the MCP server's job only)

select t.expect('resolve: the MCP role resolves a live token to its person',
  t.run_role('reliquary_mcp', format($q$select user_id from private.resolve_access_token(%L)$q$,
    (select encode(extensions.digest(token, 'sha256'), 'hex') from t.tokens where name = 'ana'))),
  t.id('ana')::text);
select t.expect('resolve: a wrong token resolves to nobody',
  t.run_role('reliquary_mcp', $q$select count(*) from private.resolve_access_token('nope')$q$), '0');
select t.expect('resolve: authenticated users cannot resolve tokens',
  t.run('ana', $q$select count(*) from private.resolve_access_token('x')$q$), 'ERR 42501');
select t.expect('resolve: anonymous cannot resolve tokens',
  t.run(null, $q$select count(*) from private.resolve_access_token('x')$q$), 'ERR 42501');
select t.expect('mcp role: cannot read tables as itself',
  t.run_role('reliquary_mcp', $q$select count(*) from public.files$q$), 'ERR 42501');
select t.expect('mcp role: cannot call the unchecked write helper',
  t.run_role('reliquary_mcp', format($q$select private.apply_write(%L, 'x.md', 'x', %L, null, null)$q$, t.id('v1'), t.id('ana'))),
  'ERR 42501');

-- Revoking and expiry

select t.expect('revoke: another person cannot revoke Ana''s token',
  t.run('dee', format($q$select public.revoke_access_token(%L)$q$,
    (select id from public.access_tokens where name = 'Claude Code on MacBook'))), 'ERR P0002');
select t.expect('revoke: a person''s agent cannot revoke their token',
  t.run('ana', format($q$select public.revoke_access_token(%L)$q$,
    (select id from public.access_tokens where name = 'Claude Code on MacBook')), 'Claude Code'), 'ERR 42501');
select t.run('ana', format($q$select public.revoke_access_token(%L)$q$,
  (select id from public.access_tokens where name = 'Claude Code on MacBook')));
select t.expect('revoke: a person revokes their token, and it stops resolving',
  t.run_role('reliquary_mcp', format($q$select count(*) from private.resolve_access_token(%L)$q$,
    (select encode(extensions.digest(token, 'sha256'), 'hex') from t.tokens where name = 'ana'))), '0');
update public.access_tokens set expires_at = now() - interval '1 second' where name = 'Hermes on Linux';
select t.expect('expiry: an expired token stops resolving',
  t.run_role('reliquary_mcp', format($q$select count(*) from private.resolve_access_token(%L)$q$,
    (select encode(extensions.digest(token, 'sha256'), 'hex') from t.tokens where name = 'ben'))), '0');

-- Search

select t.expect('search: finds a file by a word in it',
  t.run('ben', format($q$select string_agg(path, ',') from public.search(%L, 'Acme')$q$, t.id('v1')), 'Claude Code'),
  'clients/acme.md');
select t.expect('search: reports the file''s policy',
  t.run('ben', format($q$select policy from public.search(%L, 'Lisbon')$q$, t.id('v1'))), 'open');
select t.expect('search: finds by path',
  t.run('ben', format($q$select string_agg(path, ',') from public.search(%L, 'offsite')$q$, t.id('v1'))),
  'notes/offsite.md');
select t.expect('search: an outsider finds nothing in someone else''s vault',
  t.run('ben', format($q$select count(*) from public.search(%L, 'Acme')$q$, t.id('v2'))), '0');
select t.expect('search: wildcards in the query match nothing extra',
  t.run('ben', format($q$select count(*) from public.search(%L, '%%')$q$, t.id('v1'))), '0');
select t.run('ana', format($q$select public.erase_file(%L, 'clients/acme.md')$q$, t.id('v1')));
select t.expect('search: erased text is never found',
  t.run('ben', format($q$select count(*) from public.search(%L, 'Rosa')$q$, t.id('v1'))), '0');
