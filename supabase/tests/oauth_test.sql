-- Hostile tests for MCP OAuth (20260924220000_oauth). A grant is an
-- access_tokens row; consent is a person's act; only the web app's role
-- redeems and refreshes; only the MCP role resolves, and only for the
-- resource the grant was made for.

-- ---------------------------------------------------------------------------
-- Setup: Ana owns Team (Ben edits) and Side; Dee owns Private.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
insert into t.ids select 'priv', t.run('dee', $q$select public.create_vault('Private')$q$)::uuid;
select t.run('ana', format($q$select public.set_member(%L, %L, 'editor')$q$, t.id('team'), t.id('ben')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/alpha.md', 'Alpha plan')$q$, t.id('team')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/bravo.md', 'Bravo plan')$q$, t.id('side')));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('team')));

create function t.sha(p text) returns text language sql as
$$ select encode(extensions.digest(p, 'sha256'), 'hex') $$;
-- PKCE S256: base64url(sha256(verifier)), unpadded.
create function t.s256(p text) returns text language sql as
$$ select translate(rtrim(encode(extensions.digest(p, 'sha256'), 'base64'), '='), '+/', '-_') $$;

-- Constants for the fake client.
create function t.c(p text) returns text language sql as $$
  select case p
    when 'client' then 'https://client.example/meta.json'
    when 'redirect' then 'https://client.example/callback'
    when 'resource' then 'https://mcp.example/mcp'
    when 'verifier' then repeat('v', 43) || 'erifier-for-tests'
  end
$$;

-- Consent as p_user: returns the code (or ERR).
create function t.consent(p_user text, p_vaults text, p_access text, p_agent text default null,
                          p_resource text default null, p_verifier text default null)
returns text language sql as $$
  select t.run(p_user, format($q$select public.create_oauth_grant('Test client (client.example)', %L, %L, %L, %L, %s, %L)$q$,
    t.c('client'), t.c('redirect'), coalesce(p_resource, t.c('resource')), t.s256(coalesce(p_verifier, t.c('verifier'))),
    p_vaults, p_access), p_agent)
$$;

-- The token endpoint's call, as reliquary_web. Tokens are named; t.raw keeps them.
create table t.raw (name text primary key, token text);
create function t.mint(p_name text) returns text language sql as $$
  insert into t.raw values (p_name, p_name || '-' || encode(extensions.gen_random_bytes(16), 'hex'))
  on conflict (name) do update set token = excluded.token returning token
$$;
create function t.tk(p_name text) returns text language sql as $$ select token from t.raw where name = p_name $$;

create function t.redeem(p_code text, p_access text, p_refresh text, p_verifier text default null,
                         p_redirect text default null, p_resource text default null, p_client text default null)
returns text language sql as $$
  select t.run_role('reliquary_web', format($q$select private.oauth_redeem_code(%L, %L, %L, %L, %L, %L, %L)$q$,
    t.sha(p_code), coalesce(p_client, t.c('client')), coalesce(p_redirect, t.c('redirect')),
    coalesce(p_resource, t.c('resource')), coalesce(p_verifier, t.c('verifier')),
    t.sha(t.mint(p_access)), t.sha(t.mint(p_refresh))))
$$;

create function t.refresh(p_old text, p_access text, p_refresh text, p_resource text default null, p_client text default null)
returns text language sql as $$
  select t.run_role('reliquary_web', format($q$select private.oauth_refresh(%L, %L, %L, %L, %L)$q$,
    t.sha(t.tk(p_old)), coalesce(p_client, t.c('client')), coalesce(p_resource, t.c('resource')),
    t.sha(t.mint(p_access)), t.sha(t.mint(p_refresh))))
$$;

-- What the MCP server gets for an access token.
create function t.resolve(p_access text, p_resource text default null) returns text language sql as $$
  select t.run_role('reliquary_mcp', format($q$select coalesce(string_agg(user_id::text, ','), 'none') from private.resolve_oauth_token(%L, %L)$q$,
    t.sha(t.tk(p_access)), coalesce(p_resource, t.c('resource'))))
$$;

create function t.grant_of(p_access text) returns uuid language sql as $$
  select o.grant_id from private.oauth_tokens o where o.token_hash = t.sha(t.tk(p_access))
$$;

-- Acts through a grant exactly as the MCP server does (act.tok = grant id).
create function t.run_grant(p_user text, p_access text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.grant_of(p_access), 'name', 'Test client', 'tok', t.grant_of(p_access))), p_sql)
$$;

-- ---------------------------------------------------------------------------
-- Consent

create table t.codes (name text primary key, code text);
insert into t.codes select 'team-rw', t.consent('ana', format('array[%L]::uuid[]', t.id('team')), 'write');

select t.expect_true('consent: a person gets a one-time rlc_ code',
  (select code ~ '^rlc_[0-9a-f]{64}$' from t.codes where name = 'team-rw'));
select t.expect_true('consent: only the code''s hash is stored',
  not exists (select 1 from private.oauth_codes c join t.codes k on c.code_hash = k.code));
select t.expect_true('consent: the grant is an access_tokens row of kind oauth with the chosen scope',
  (select kind = 'oauth' and not all_vaults and vault_ids = array[t.id('team')] and access = 'write'
          and client_id = t.c('client') and resource = t.c('resource') and token_hash is null
          and client_name = 'client.example'
     from public.access_tokens where user_id = t.id('ana') and kind = 'oauth'));
select t.expect_true('consent: an unredeemed grant lives a minute, not a month',
  (select expires_at <= now() + interval '61 seconds' from public.access_tokens where kind = 'oauth'));
select t.expect('consent: an agent cannot consent',
  t.consent('ana', 'null', 'read', 'Claude Code'), 'ERR 42501');
select t.expect('consent: anonymous cannot consent',
  t.run(null, format($q$select public.create_oauth_grant('x', %L, %L, %L, %L, null, 'read')$q$,
    t.c('client'), t.c('redirect'), t.c('resource'), t.s256(t.c('verifier')))), 'ERR 42501');
select t.expect('consent: a grant cannot reach a vault its person is not in',
  t.consent('ana', format('array[%L]::uuid[]', t.id('priv')), 'read'), 'ERR 22023');
select t.expect('consent: an empty vault list is refused, not read as "all"',
  t.consent('ana', '''{}''::uuid[]', 'read'), 'ERR 22023');
select t.expect('consent: an unknown access level is refused',
  t.consent('ana', 'null', 'admin'), 'ERR 22023');
select t.expect('consent: a missing or malformed code challenge is refused',
  t.run('ana', format($q$select public.create_oauth_grant('x', %L, %L, %L, 'plain-challenge', null, 'read')$q$,
    t.c('client'), t.c('redirect'), t.c('resource'))), 'ERR 22023');
select t.expect('consent: authenticated cannot touch codes or tokens directly',
  t.run('ana', $q$select count(*) from private.oauth_codes$q$), 'ERR 42501');
select t.expect('consent: nor insert a code',
  t.run('ana', format($q$insert into private.oauth_codes values (%L, %L, 'c', 'r', 'x', %L, now() + interval '1 day') returning 1$q$,
    repeat('a', 64), (select id from public.access_tokens where kind = 'oauth' limit 1), repeat('b', 43))), 'ERR 42501');
select t.expect('consent: nobody forges an oauth row by editing access_tokens',
  t.run('ana', $q$update public.access_tokens set resource = 'https://evil.example/mcp' returning 1$q$), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- Redeeming a code (the token endpoint)

select t.expect('redeem: authenticated cannot redeem',
  t.run('ana', format($q$select private.oauth_redeem_code(%L, 'c', 'r', 'x', 'v', %L, %L)$q$,
    t.sha((select code from t.codes where name = 'team-rw')), repeat('a', 64), repeat('b', 64))), 'ERR 42501');
select t.expect('redeem: the MCP role cannot redeem',
  t.run_role('reliquary_mcp', format($q$select private.oauth_redeem_code(%L, 'c', 'r', 'x', 'v', %L, %L)$q$,
    t.sha((select code from t.codes where name = 'team-rw')), repeat('a', 64), repeat('b', 64))), 'ERR 42501');
select t.expect('redeem: anonymous cannot redeem',
  t.run(null, $q$select private.oauth_redeem_code('x', 'c', 'r', 'x', 'v', 'a', 'b')$q$), 'ERR 42501');
select t.expect('redeem: an unknown code is invalid_grant',
  t.redeem('rlc_nope', 'a0', 'r0'), 'invalid_grant');
select t.expect('redeem: the right code, verifier, redirect, client and resource give tokens',
  t.redeem((select code from t.codes where name = 'team-rw'), 'a1', 'r1'), 'ok');
select t.expect_true('redeem: tokens are stored as hashes only',
  not exists (select 1 from private.oauth_tokens o join t.raw r on o.token_hash = r.token));
select t.expect_true('redeem: the grant now lives 30 days',
  (select expires_at > now() + interval '29 days' from public.access_tokens where id = t.grant_of('a1')));
select t.expect('redeem: the access token resolves for its resource, to its person',
  t.resolve('a1'), t.id('ana')::text);
select t.expect('redeem: a reused code is refused',
  t.redeem((select code from t.codes where name = 'team-rw'), 'a1b', 'r1b'), 'invalid_grant');
select t.expect_true('redeem: reusing a code revokes the grant it created',
  (select revoked_at is not null from public.access_tokens where id = t.grant_of('a1')));
select t.expect('redeem: after reuse, the first access token is dead too',
  t.resolve('a1'), 'none');

-- Each refusal on a fresh code; every one burns the code.
insert into t.codes select 'wrong-verifier', t.consent('ana', 'null', 'write');
select t.expect('redeem: a wrong verifier is refused',
  t.redeem((select code from t.codes where name = 'wrong-verifier'), 'a2', 'r2', repeat('w', 43)), 'invalid_grant');
select t.expect('redeem: after a wrong verifier the code is burned, even with the right one',
  t.redeem((select code from t.codes where name = 'wrong-verifier'), 'a2', 'r2'), 'invalid_grant');
insert into t.codes select 'plain', t.consent('ana', 'null', 'write');
select t.expect('redeem: a "plain" verifier (the challenge itself) is refused',
  t.redeem((select code from t.codes where name = 'plain'), 'a3', 'r3', t.s256(t.c('verifier'))), 'invalid_grant');
insert into t.codes select 'short', t.consent('ana', 'null', 'write', null, null, 'short');
select t.expect('redeem: a verifier under 43 characters is refused',
  t.redeem((select code from t.codes where name = 'short'), 'a3s', 'r3s', 'short'), 'invalid_grant');
insert into t.codes select 'redirect', t.consent('ana', 'null', 'write');
select t.expect('redeem: a different redirect_uri is refused',
  t.redeem((select code from t.codes where name = 'redirect'), 'a4', 'r4', null, 'https://client.example/other'), 'invalid_grant');
insert into t.codes select 'resource', t.consent('ana', 'null', 'write');
select t.expect('redeem: a different resource is refused',
  t.redeem((select code from t.codes where name = 'resource'), 'a5', 'r5', null, null, 'https://evil.example/mcp'), 'invalid_grant');
insert into t.codes select 'no-resource', t.consent('ana', 'null', 'write');
select t.expect('redeem: a missing resource is refused',
  t.run_role('reliquary_web', format($q$select private.oauth_redeem_code(%L, %L, %L, null, %L, %L, %L)$q$,
    t.sha((select code from t.codes where name = 'no-resource')), t.c('client'), t.c('redirect'), t.c('verifier'),
    t.sha(t.mint('a5n')), t.sha(t.mint('r5n')))), 'invalid_grant');
insert into t.codes select 'client', t.consent('ana', 'null', 'write');
select t.expect('redeem: another client presenting the code is refused',
  t.redeem((select code from t.codes where name = 'client'), 'a6', 'r6', null, null, null, 'https://evil.example/meta.json'), 'invalid_grant');
insert into t.codes select 'expired', t.consent('ana', 'null', 'write');
update private.oauth_codes set expires_at = now() - interval '1 second'
 where code_hash = t.sha((select code from t.codes where name = 'expired'));
select t.expect('redeem: an expired code is refused',
  t.redeem((select code from t.codes where name = 'expired'), 'a7', 'r7'), 'invalid_grant');
select t.expect_true('redeem: none of the refused codes produced a token',
  not exists (select 1 from private.oauth_tokens o join t.raw r on o.token_hash = t.sha(r.token)
               where r.name in ('a0', 'a2', 'a3', 'a3s', 'a4', 'a5', 'a5n', 'a6', 'a7', 'a1b')));

-- ---------------------------------------------------------------------------
-- Resolving (the MCP server)

insert into t.codes select 'live', t.consent('ana', format('array[%L]::uuid[]', t.id('team')), 'write');
select t.redeem((select code from t.codes where name = 'live'), 'live-a', 'live-r');
insert into t.codes select 'ro', t.consent('ana', format('array[%L]::uuid[]', t.id('team')), 'read');
select t.redeem((select code from t.codes where name = 'ro'), 'ro-a', 'ro-r');

select t.expect('resolve: a live access token resolves', t.resolve('live-a'), t.id('ana')::text);
select t.expect('resolve: not for another resource (audience binding)',
  t.resolve('live-a', 'https://other.example/mcp'), 'none');
select t.expect('resolve: not for a resource that differs by a trailing slash',
  t.resolve('live-a', t.c('resource') || '/'), 'none');
select t.expect('resolve: a refresh token is not an access token',
  t.run_role('reliquary_mcp', format($q$select count(*) from private.resolve_oauth_token(%L, %L)$q$,
    t.sha(t.tk('live-r')), t.c('resource'))), '0');
select t.expect('resolve: the personal-token resolver never resolves an OAuth token',
  t.run_role('reliquary_mcp', format($q$select count(*) from private.resolve_access_token(%L)$q$, t.sha(t.tk('live-a')))), '0');
select t.expect('resolve: authenticated cannot resolve',
  t.run('ana', format($q$select count(*) from private.resolve_oauth_token(%L, %L)$q$, t.sha(t.tk('live-a')), t.c('resource'))), 'ERR 42501');
select t.expect('resolve: the web role cannot resolve',
  t.run_role('reliquary_web', format($q$select count(*) from private.resolve_oauth_token(%L, %L)$q$, t.sha(t.tk('live-a')), t.c('resource'))), 'ERR 42501');
select t.expect('resolve: the MCP role cannot read the token table',
  t.run_role('reliquary_mcp', $q$select count(*) from private.oauth_tokens$q$), 'ERR 42501');
select t.expect('resolve: the web role cannot read the token table',
  t.run_role('reliquary_web', $q$select count(*) from private.oauth_tokens$q$), 'ERR 42501');
update private.oauth_tokens set expires_at = now() - interval '1 second' where token_hash = t.sha(t.tk('ro-a'));
select t.expect('resolve: an expired access token resolves to nobody', t.resolve('ro-a'), 'none');

-- ---------------------------------------------------------------------------
-- The ceiling and the scope chosen at consent (role_in via act.tok)

select t.expect('ceiling: an OAuth client sees only the vaults chosen at consent',
  t.run_grant('ana', 'live-a', $q$select string_agg(name, ',' order by name) from public.vaults$q$), 'Team');
select t.expect('ceiling: the other vault''s files are invisible',
  t.run_grant('ana', 'live-a', format($q$select count(*) from public.files where vault_id = %L$q$, t.id('side'))), '0');
select t.expect('ceiling: writing to the other vault is refused',
  t.run_grant('ana', 'live-a', format($q$select public.write_file(%L, 'notes/x.md', 'x')$q$, t.id('side'))), 'ERR 42501');
select t.expect_ok('ceiling: writing an open file in scope works',
  t.run_grant('ana', 'live-a', format($q$select public.write_file(%L, 'notes/oauth.md', 'via OAuth')$q$, t.id('team'))));
insert into t.ids select 'prop', t.run_grant('ana', 'live-a',
  format($q$select public.propose(%L, 'canon/rates.md', 'Day rate 800', 'rates')$q$, t.id('team')))::uuid;
select t.expect('ceiling: an OAuth client cannot approve',
  t.run_grant('ana', 'live-a', format($q$select public.decide(%L, 'approve')$q$, t.id('prop'))), 'ERR 42501');
select t.expect('ceiling: an OAuth client cannot set rules',
  t.run_grant('ana', 'live-a', format($q$select public.set_policy(%L, 'x/', 'canon', 1)$q$, t.id('team'))), 'ERR 42501');
select t.expect('ceiling: an OAuth client cannot manage members',
  t.run_grant('ana', 'live-a', format($q$select public.set_member(%L, %L, 'editor')$q$, t.id('team'), t.id('cal'))), 'ERR 42501');
select t.expect('ceiling: an OAuth client cannot erase',
  t.run_grant('ana', 'live-a', format($q$select public.erase_file(%L, 'notes/alpha.md')$q$, t.id('team'))), 'ERR 42501');
select t.expect('ceiling: an OAuth client cannot mint a token',
  t.run_grant('ana', 'live-a', $q$select public.create_access_token('x', 30)$q$), 'ERR 42501');
select t.expect('ceiling: an OAuth client cannot consent to another client',
  t.run_grant('ana', 'live-a', format($q$select public.create_oauth_grant('x', %L, %L, %L, %L, null, 'write')$q$,
    t.c('client'), t.c('redirect'), t.c('resource'), t.s256(t.c('verifier')))), 'ERR 42501');
insert into t.codes select 'ro2', t.consent('ana', format('array[%L]::uuid[]', t.id('team')), 'read');
select t.redeem((select code from t.codes where name = 'ro2'), 'ro2-a', 'ro2-r');
select t.expect('ceiling: a read-only grant reads',
  t.run_grant('ana', 'ro2-a', format($q$select count(*) from public.files where vault_id = %L$q$, t.id('team'))), '2');
select t.expect('ceiling: a read-only grant cannot write',
  t.run_grant('ana', 'ro2-a', format($q$select public.write_file(%L, 'notes/y.md', 'y')$q$, t.id('team'))), 'ERR 42501');
select t.expect('ceiling: a read-only grant cannot propose',
  t.run_grant('ana', 'ro2-a', format($q$select public.propose(%L, 'canon/y.md', 'y')$q$, t.id('team'))), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- Refresh: rotation, and reuse revokes the grant

select t.expect('refresh: authenticated cannot refresh',
  t.run('ana', format($q$select private.oauth_refresh(%L, 'c', 'x', %L, %L)$q$, t.sha(t.tk('live-r')), repeat('a', 64), repeat('b', 64))), 'ERR 42501');
select t.expect('refresh: another resource is refused without burning the token',
  t.refresh('live-r', 'x1', 'x1r', 'https://evil.example/mcp'), 'invalid_grant');
select t.expect('refresh: another client is refused without burning the token',
  t.refresh('live-r', 'x2', 'x2r', null, 'https://evil.example/meta.json'), 'invalid_grant');
select t.expect('refresh: an access token is not a refresh token',
  t.refresh('live-a', 'x3', 'x3r'), 'invalid_grant');
select t.expect('refresh: the refresh token rotates',
  t.refresh('live-r', 'live-a2', 'live-r2'), 'ok');
select t.expect('refresh: the new access token resolves', t.resolve('live-a2'), t.id('ana')::text);
select t.expect('refresh: the rotated refresh token works once more',
  t.refresh('live-r2', 'live-a3', 'live-r3'), 'ok');
select t.expect('refresh: presenting an already-rotated refresh token is refused',
  t.refresh('live-r', 'evil-a', 'evil-r'), 'invalid_grant');
select t.expect_true('refresh: and it revokes the grant',
  (select revoked_at is not null from public.access_tokens where id = t.grant_of('live-a3')));
select t.expect('refresh: after reuse, the newest access token is dead', t.resolve('live-a3'), 'none');
select t.expect('refresh: after reuse, the newest refresh token is dead',
  t.refresh('live-r3', 'live-a4', 'live-r4'), 'invalid_grant');
select t.expect('refresh: after reuse, the grant reaches nothing',
  t.run_grant('ana', 'live-a3', $q$select count(*) from public.vaults$q$), '0');

-- ---------------------------------------------------------------------------
-- Revoking: on the Tokens page, and at the revocation endpoint

insert into t.codes select 'page', t.consent('ben', 'null', 'write');
select t.redeem((select code from t.codes where name = 'page'), 'page-a', 'page-r');
select t.expect('revoke: Ben sees his grant on his tokens list, with the client',
  t.run('ben', $q$select kind || ' ' || client_id || ' ' || client_name from public.access_tokens$q$),
  'oauth https://client.example/meta.json client.example');
select t.expect('revoke: Ana cannot revoke Ben''s grant',
  t.run('ana', format($q$select public.revoke_access_token(%L)$q$, t.grant_of('page-a'))), 'ERR P0002');
select t.expect_ok('revoke: Ben revokes it like any token',
  t.run('ben', format($q$select public.revoke_access_token(%L)$q$, t.grant_of('page-a'))));
select t.expect('revoke: the access token stops resolving at once', t.resolve('page-a'), 'none');
select t.expect('revoke: the grant reaches no vault at once',
  t.run_grant('ben', 'page-a', $q$select count(*) from public.vaults$q$), '0');
select t.expect('revoke: its refresh token is refused', t.refresh('page-r', 'page-a2', 'page-r2'), 'invalid_grant');

insert into t.codes select 'endpoint', t.consent('ben', 'null', 'read');
select t.redeem((select code from t.codes where name = 'endpoint'), 'ep-a', 'ep-r');
select t.run_role('reliquary_web', format($q$select private.oauth_revoke(%L, 'https://evil.example/meta.json')$q$, t.sha(t.tk('ep-r'))));
select t.expect('revoke: another client cannot revoke it at the endpoint', t.resolve('ep-a'), t.id('ben')::text);
select t.run_role('reliquary_web', format($q$select private.oauth_revoke(%L, %L)$q$, t.sha(t.tk('ep-r')), t.c('client')));
select t.expect('revoke: its own client revokes the grant with the refresh token', t.resolve('ep-a'), 'none');
select t.expect('revoke: authenticated cannot call the endpoint function',
  t.run('ben', format($q$select private.oauth_revoke(%L, %L)$q$, t.sha(t.tk('ep-r')), t.c('client'))), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- Personal tokens are unchanged

insert into t.raw select 'pat', t.run('ana', $q$select public.create_access_token('pat', 30)$q$);
select t.expect_true('pat: a personal token still has kind pat and its hash',
  (select kind = 'pat' and token_hash = t.sha(t.tk('pat')) and client_id is null
     from public.access_tokens where name = 'pat'));
select t.expect('pat: it still resolves for the MCP role',
  t.run_role('reliquary_mcp', format($q$select user_id from private.resolve_access_token(%L)$q$, t.sha(t.tk('pat')))),
  t.id('ana')::text);
select t.expect('pat: a personal token cannot carry a resource',
  t.run_role('postgres', $q$update public.access_tokens set resource = 'https://mcp.example/mcp' where kind = 'pat' returning 1$q$),
  'ERR 23514');
