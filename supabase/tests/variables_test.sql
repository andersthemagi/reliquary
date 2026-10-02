-- Hostile tests for environment variables (20260925090000_variables).
-- Spec: docs/variables.md. Values are encrypted by the web app; here the
-- "ciphertext" is a fixed marker, so a test can prove it never leaves
-- through anything but reveal_variable and read_variables.

-- ---------------------------------------------------------------------------
-- Setup: Ana owns Team (Ben edits, Cal views) and Side; Dee owns Private.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
insert into t.ids select 'priv', t.run('dee', $q$select public.create_vault('Private')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.write_file(%L, 'notes/alpha.md', 'Alpha plan')$q$, t.id('team')));

-- A fake sealed value: 12-byte nonce, and a "ciphertext" that is a marker
-- (hex of 'CIPHERTEXT-MARKER-' || p_tag), so no read path can hide it.
create function t.ct(p_tag text) returns text language sql as
$$ select encode(convert_to('CIPHERTEXT-MARKER-' || p_tag, 'utf8'), 'hex') $$;
create function t.setv_sql(p_vault text, p_name text, p_env text, p_tag text default 'x') returns text language sql as $$
  select format($q$select public.set_variable(%L, %L, %L, 'k1', decode(%L, 'hex'), decode(%L, 'hex'))$q$,
    t.id(p_vault), p_name, p_env, repeat('00', 12), t.ct(p_tag))
$$;
create function t.setv(p_user text, p_vault text, p_name text, p_env text, p_tag text default 'x',
                       p_agent text default null) returns text language sql as $$
  select t.run(p_user, t.setv_sql(p_vault, p_name, p_env, p_tag), p_agent)
$$;

-- OAuth plumbing, as the web app's token endpoint does it.
create function t.c(p text) returns text language sql as $$
  select case p
    when 'cli' then 'https://app.example/cli/oauth-client.json'
    when 'env' then 'https://app.example/api/env'
    when 'loopback' then 'http://127.0.0.1:53682/callback'
    when 'mcp-client' then 'https://client.example/meta.json'
    when 'mcp-redirect' then 'https://client.example/callback'
    when 'mcp' then 'https://mcp.example/mcp'
    when 'verifier' then repeat('v', 43) || 'erifier-for-tests'
  end
$$;

-- Grants by name: t.grants maps a name to the grant id and its access token.
create table t.grants (name text primary key, id uuid, access text);

-- Consent (as the person), then redeem (as reliquary_web). p_vaults is SQL.
create function t.cli_grant(p_name text, p_user text, p_vaults text) returns text language plpgsql as $$
declare
  v_code text;
  v_access text := 'rle_' || p_name || encode(extensions.gen_random_bytes(8), 'hex');
  v_out text;
begin
  v_code := t.run(p_user, format($q$select public.create_cli_grant(%L, %L, %L, %L, %s)$q$,
    t.c('cli'), t.c('loopback'), t.c('env'), t.s256(t.c('verifier')), p_vaults));
  if v_code like 'ERR %' then return v_code; end if;
  v_out := t.run_role('reliquary_web', format($q$select private.oauth_redeem_code(%L, %L, %L, %L, %L, %L, %L)$q$,
    t.sha(v_code), t.c('cli'), t.c('loopback'), t.c('env'), t.c('verifier'), t.sha(v_access), t.sha(v_access || '-r')));
  insert into t.grants select p_name, o.grant_id, v_access from private.oauth_tokens o where o.token_hash = t.sha(v_access);
  return v_out;
end $$;

create function t.mcp_grant(p_name text, p_user text) returns text language plpgsql as $$
declare
  v_code text;
  v_access text := 'rlo_' || p_name || encode(extensions.gen_random_bytes(8), 'hex');
  v_out text;
begin
  v_code := t.run(p_user, format($q$select public.create_oauth_grant('Chat', %L, %L, %L, %L, null, 'write')$q$,
    t.c('mcp-client'), t.c('mcp-redirect'), t.c('mcp'), t.s256(t.c('verifier'))));
  v_out := t.run_role('reliquary_web', format($q$select private.oauth_redeem_code(%L, %L, %L, %L, %L, %L, %L)$q$,
    t.sha(v_code), t.c('mcp-client'), t.c('mcp-redirect'), t.c('mcp'), t.c('verifier'), t.sha(v_access), t.sha(v_access || '-r')));
  insert into t.grants select p_name, o.grant_id, v_access from private.oauth_tokens o where o.token_hash = t.sha(v_access);
  return v_out;
end $$;

create function t.g(p_name text) returns uuid language sql as $$ select id from t.grants where name = p_name $$;

-- Acts through a grant or token exactly as the web app (CLI) or MCP server does.
create function t.run_via(p_user text, p_grant uuid, p_sql text, p_label text default 'Reliquary CLI') returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', p_grant, 'name', p_label, 'tok', p_grant)), p_sql)
$$;
create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name and kind = 'pat' $$;

-- Runs p_sql with the session logged in as p_login (e.g. reliquary_mcp),
-- then as authenticated with p_claims, the way the apps do.
create function t.run_session(p_login text, p_claims jsonb, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute format('set session authorization %I', p_login);
  perform set_config('request.jwt.claims', p_claims::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  reset session authorization;
  return v;
exception when others then
  perform set_config('role', 'none', true);
  reset session authorization;
  return 'ERR ' || sqlstate;
end $$;

-- Values: Team has API_KEY in development (Ben) and production (Ana), and
-- DB_URL in development; Side has SIDE_KEY in development.
select t.setv('ana', 'team', 'API_KEY', 'production', 'team-prod');
select t.setv('ben', 'team', 'API_KEY', 'development', 'team-dev');
select t.setv('ben', 'team', 'DB_URL', 'development', 'team-db');
select t.setv('ana', 'side', 'SIDE_KEY', 'development', 'side-dev');

-- Grants: CLI sign-ins and MCP connections.
select t.cli_grant('ana-cli', 'ana', 'null');
select t.cli_grant('ana-cli-side', 'ana', format('array[%L]::uuid[]', t.id('side')));
select t.cli_grant('ben-cli', 'ben', 'null');
select t.cli_grant('cal-cli', 'cal', 'null');
select t.cli_grant('ana-cli-revoked', 'ana', 'null');
select t.cli_grant('ana-cli-expired', 'ana', 'null');
update public.access_tokens set revoked_at = now() where id = t.g('ana-cli-revoked');
update public.access_tokens set expires_at = now() - interval '1 minute' where id = t.g('ana-cli-expired');
select t.mcp_grant('ana-mcp', 'ana');
select t.run('ana', $q$select public.create_access_token('ana-pat', 30)$q$);
select t.run('ana', $q$select public.create_access_token('ana-pat-ro', 30, null, 'read')$q$);
select t.run('ana', format($q$select public.create_access_token('ana-pat-side', 30, array[%L]::uuid[], 'write')$q$, t.id('side')));

create function t.read_sql(p_vault text, p_env text) returns text language sql as
$$ select format($q$select public.read_variables(%L, %L)::text$q$, t.id(p_vault), p_env) $$;
create function t.reveal_sql(p_vault text, p_name text, p_env text) returns text language sql as
$$ select format($q$select public.reveal_variable(%L, %L, %L)::text$q$, t.id(p_vault), p_name, p_env) $$;
create function t.err(p_json text) returns text language sql as
$$ select case when p_json like 'ERR %' then p_json else coalesce(p_json::jsonb ->> 'error', 'ok') end $$;
create function t.refusals(p_vault text) returns bigint language sql as
$$ select count(*) from public.env_access_log where vault_id = t.id(p_vault) and action = 'refused' $$;

-- ---------------------------------------------------------------------------
-- Environments

select t.expect('environments: a new vault has development, preview and production',
  t.run('ana', format($q$select string_agg(name || ':' || owners_only, ',' order by name) from public.environments where vault_id = %L$q$, t.id('team'))),
  'development:false,preview:false,production:true');
select t.expect('environments: an outsider sees none of a vault''s',
  t.run('dee', format($q$select count(*) from public.environments where vault_id = %L$q$, t.id('team'))), '0');
select t.expect('environments: nobody adds or changes one directly',
  t.run('ana', format($q$update public.environments set owners_only = false where vault_id = %L returning 1$q$, t.id('team'))), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- Setting, rotating, deleting: people in person, within their role

select t.expect('set: the owner sets a production value', t.setv('ana', 'side', 'PROD_ONLY', 'production'), 'set');
select t.expect('set: setting it again is a rotation', t.setv('ana', 'side', 'PROD_ONLY', 'production', 'y'), 'rotate');
select t.expect_true('set: a rotation bumps the version and keeps one ciphertext',
  (select vv.version = 2 and (select count(*) from private.variable_secrets s where s.variable_id = v.id) = 1
     from public.variables v join public.variable_values vv on vv.variable_id = v.id
    where v.vault_id = t.id('side') and v.name = 'PROD_ONLY'));
select t.expect('set: an editor sets a development value', t.setv('ben', 'team', 'EDITOR_KEY', 'development'), 'set');
select t.expect('set: an editor sets a preview value', t.setv('ben', 'team', 'EDITOR_KEY', 'preview'), 'set');
select t.expect('set: an editor cannot set a production value', t.setv('ben', 'team', 'EDITOR_KEY', 'production'), 'ERR 42501');
select t.expect('set: an editor cannot rotate the owner''s production value', t.setv('ben', 'team', 'API_KEY', 'production'), 'ERR 42501');
select t.expect('set: a viewer cannot set a value', t.setv('cal', 'team', 'CAL_KEY', 'development'), 'ERR 42501');
select t.expect('set: an outsider cannot set a value', t.setv('dee', 'team', 'DEE_KEY', 'development'), 'ERR P0002');
select t.expect('set: anonymous cannot set a value', t.setv(null, 'team', 'ANON_KEY', 'development'), 'ERR 42501');
select t.expect('set: the owner''s agent cannot set a value', t.setv('ana', 'team', 'AGENT_KEY', 'development', 'x', 'Claude Code'), 'ERR 42501');
select t.expect('set: an MCP token cannot set a value',
  t.run_via('ana', t.tok('ana-pat'), t.setv_sql('team', 'PAT_KEY', 'development'), 'ana-pat'), 'ERR 42501');
select t.expect('set: an OAuth grant cannot set a value',
  t.run_via('ana', t.g('ana-mcp'), t.setv_sql('team', 'MCP_KEY', 'development'), 'Chat'), 'ERR 42501');
select t.expect('set: a CLI grant cannot set a value',
  t.run_via('ana', t.g('ana-cli'), t.setv_sql('team', 'CLI_KEY', 'development')), 'ERR 42501');
select t.expect('set: an unknown environment is refused', t.setv('ana', 'team', 'X_KEY', 'staging'), 'ERR P0002');
select t.expect('set: a name that isn''t a variable name is refused', t.setv('ana', 'team', '1BAD', 'development'), 'ERR 22023');
select t.expect('set: a name with a dash or space is refused', t.setv('ana', 'team', 'BAD-NAME', 'development'), 'ERR 22023');
select t.expect('set: LD_PRELOAD is refused (it runs code in every process)', t.setv('ana', 'team', 'LD_PRELOAD', 'development'), 'ERR 22023');
select t.expect('set: NODE_OPTIONS is refused', t.setv('ana', 'team', 'NODE_OPTIONS', 'development'), 'ERR 22023');
select t.expect('set: PATH is refused in any case', t.setv('ana', 'team', 'path', 'development'), 'ERR 22023');
select t.expect('set: a malformed nonce is refused',
  t.run('ana', format($q$select public.set_variable(%L, 'N_KEY', 'development', 'k1', decode('00', 'hex'), decode(%L, 'hex'))$q$, t.id('team'), t.ct('n'))), 'ERR 22023');
select t.expect('set: a malformed key id is refused',
  t.run('ana', format($q$select public.set_variable(%L, 'N_KEY', 'development', 'k 1', decode(%L, 'hex'), decode(%L, 'hex'))$q$, t.id('team'), repeat('00', 12), t.ct('n'))), 'ERR 22023');
select t.expect('set: nobody writes the metadata tables directly',
  t.run('ana', format($q$insert into public.variables (vault_id, name, created_by) values (%L, 'DIRECT', %L) returning 1$q$, t.id('team'), t.id('ana'))), 'ERR 42501');
select t.expect('set: nobody writes ciphertext directly',
  t.run('ana', $q$update private.variable_secrets set key_id = 'k2' returning 1$q$), 'ERR 42501');

select t.expect('delete: an editor cannot delete a production value',
  t.run('ben', format($q$select public.delete_variable(%L, 'API_KEY', 'production')$q$, t.id('team'))), 'ERR 42501');
select t.expect('delete: a viewer cannot delete a value',
  t.run('cal', format($q$select public.delete_variable(%L, 'DB_URL', 'development')$q$, t.id('team'))), 'ERR 42501');
select t.expect('delete: an agent cannot delete a value',
  t.run('ana', format($q$select public.delete_variable(%L, 'DB_URL', 'development')$q$, t.id('team')), 'Claude Code'), 'ERR 42501');
select t.expect('delete: a missing value is not found',
  t.run('ana', format($q$select public.delete_variable(%L, 'NOPE', 'development')$q$, t.id('team'))), 'ERR P0002');
select t.expect_ok('delete: an editor deletes a preview value',
  t.run('ben', format($q$select public.delete_variable(%L, 'EDITOR_KEY', 'preview')::text || 'ok'$q$, t.id('team'))));
select t.expect('delete: the variable stays while it has a value somewhere',
  (select count(*)::text from public.variables where vault_id = t.id('team') and name = 'EDITOR_KEY'), '1');
select t.expect_ok('delete: the last value',
  t.run('ben', format($q$select public.delete_variable(%L, 'EDITOR_KEY', 'development')::text || 'ok'$q$, t.id('team'))));
select t.expect_true('delete: the variable and its ciphertext go with its last value',
  not exists (select 1 from public.variables where vault_id = t.id('team') and name = 'EDITOR_KEY')
  and (select count(*) from private.variable_secrets) = (select count(*) from public.variable_values));

-- ---------------------------------------------------------------------------
-- Names are visible to members and their agents; nothing else is

select t.expect('names: the owner lists names and environments',
  t.run('ana', format($q$select string_agg(v.name || '@' || vv.environment, ',' order by v.name, vv.environment)
    from public.variables v join public.variable_values vv on vv.variable_id = v.id where v.vault_id = %L$q$, t.id('team'))),
  'API_KEY@development,API_KEY@production,DB_URL@development');
select t.expect('names: a viewer sees the names too',
  t.run('cal', format($q$select count(*) from public.variables where vault_id = %L$q$, t.id('team'))), '2');
select t.expect('names: an MCP agent sees names and environments (read-only token too)',
  t.run_via('ana', t.tok('ana-pat-ro'), format($q$select count(*) from public.variable_values where vault_id = %L$q$, t.id('team')), 'ana-pat-ro'), '3');
select t.expect('names: an outsider sees no names',
  t.run('dee', format($q$select count(*) from public.variables where vault_id = %L$q$, t.id('team'))), '0');
select t.expect('names: a token scoped to Side sees none of Team''s names',
  t.run_via('ana', t.tok('ana-pat-side'), format($q$select count(*) from public.variables where vault_id = %L$q$, t.id('team')), 'ana-pat-side'), '0');
select t.expect('names: a CLI grant sees nothing through RLS',
  t.run_via('ana', t.g('ana-cli'), $q$select count(*) from public.variables$q$), '0');

-- ---------------------------------------------------------------------------
-- Ciphertext: never selectable

select t.expect('ciphertext: the owner cannot select it',
  t.run('ana', $q$select count(*) from private.variable_secrets$q$), 'ERR 42501');
select t.expect('ciphertext: an MCP agent cannot select it',
  t.run_via('ana', t.tok('ana-pat'), $q$select count(*) from private.variable_secrets$q$, 'ana-pat'), 'ERR 42501');
select t.expect('ciphertext: a CLI grant cannot select it',
  t.run_via('ana', t.g('ana-cli'), $q$select count(*) from private.variable_secrets$q$), 'ERR 42501');
select t.expect('ciphertext: the MCP server''s role cannot select it',
  t.run_role('reliquary_mcp', $q$select count(*) from private.variable_secrets$q$), 'ERR 42501');
select t.expect('ciphertext: the web app''s role cannot select it',
  t.run_role('reliquary_web', $q$select count(*) from private.variable_secrets$q$), 'ERR 42501');
select t.expect('ciphertext: no table or view an API role can read has a ciphertext or nonce column',
  (select coalesce(string_agg(table_schema || '.' || table_name || '.' || column_name, ','), 'none')
     from information_schema.column_privileges
    where grantee in ('authenticated', 'anon', 'reliquary_web', 'reliquary_mcp', 'PUBLIC')
      and privilege_type = 'SELECT' and column_name in ('ciphertext', 'nonce')), 'none');
select t.expect('ciphertext: no function an API role or the web app''s role can call returns it except reveal and read',
  (select coalesce(string_agg(p.proname, ',' order by p.proname), 'none')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosrc ~ 'variable_secrets'
      and (has_function_privilege('authenticated', p.oid, 'execute')
           or has_function_privilege('reliquary_mcp', p.oid, 'execute')
           or has_function_privilege('reliquary_web', p.oid, 'execute')
           or has_function_privilege('anon', p.oid, 'execute'))
      and p.proname not in ('reveal_variable', 'read_variables', 'set_variable')), 'renamed_rows');
select t.expect('ciphertext: the web app''s own role reaches it beyond reveal and read only for a rename in progress; the re-encryption functions are the operator''s',
  (select coalesce(string_agg(p.proname, ',' order by p.proname), 'none')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname in ('variable_key_ids', 'rekey_vaults', 'sealed_rows', 'reseal', 'renamed_rows', 'reseal_renamed', 'stored_key_ids')
      and has_function_privilege('reliquary_web', p.oid, 'execute'))
  || ' / ' || (select coalesce(string_agg(p.proname, ',' order by p.proname), 'none')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosrc ~ 'variable_secrets'
      and has_function_privilege('reliquary_ops', p.oid, 'execute')),
  'renamed_rows,reseal_renamed,stored_key_ids / rekey_vaults,reseal,sealed_rows,variable_key_ids');

-- ---------------------------------------------------------------------------
-- Reveal: one value, a person in person

select t.expect('reveal: the owner reveals a production value',
  t.run('ana', format($q$select convert_from(decode(public.reveal_variable(%L, 'API_KEY', 'production') ->> 'ciphertext', 'base64'), 'utf8')$q$, t.id('team'))),
  'CIPHERTEXT-MARKER-team-prod');
select t.expect_true('reveal: it is logged with the name and environment',
  exists (select 1 from public.env_access_log where vault_id = t.id('team') and action = 'reveal'
            and names = array['API_KEY'] and environment = 'production' and actor = t.id('ana') and agent is null));
select t.expect('reveal: an editor reveals a development value',
  t.err(t.run('ben', t.reveal_sql('team', 'API_KEY', 'development'))), 'ok');
select t.expect('reveal: an editor cannot reveal a production value',
  t.err(t.run('ben', t.reveal_sql('team', 'API_KEY', 'production'))), 'forbidden');
select t.expect_true('reveal: the editor''s refusal is logged',
  exists (select 1 from public.env_access_log where vault_id = t.id('team') and action = 'refused'
            and actor = t.id('ben') and environment = 'production' and detail ->> 'attempt' = 'reveal'));
select t.expect('reveal: a viewer cannot reveal', t.err(t.run('cal', t.reveal_sql('team', 'API_KEY', 'development'))), 'forbidden');
select t.expect('reveal: an outsider gets not found', t.err(t.run('dee', t.reveal_sql('team', 'API_KEY', 'development'))), 'not_found');
select t.expect_true('reveal: the outsider''s attempt is logged in the vault',
  exists (select 1 from public.env_access_log where vault_id = t.id('team') and action = 'refused' and actor = t.id('dee')));
select t.expect('reveal: anonymous is unauthorized', t.err(t.run(null, t.reveal_sql('team', 'API_KEY', 'development'))), 'ERR 42501');
select t.expect('reveal: the owner''s agent cannot reveal',
  t.err(t.run('ana', t.reveal_sql('team', 'API_KEY', 'development'), 'Claude Code')), 'forbidden');
select t.expect('reveal: an MCP token cannot reveal',
  t.err(t.run_via('ana', t.tok('ana-pat'), t.reveal_sql('team', 'API_KEY', 'development'), 'ana-pat')), 'forbidden');
select t.expect('reveal: an OAuth grant cannot reveal',
  t.err(t.run_via('ana', t.g('ana-mcp'), t.reveal_sql('team', 'API_KEY', 'development'), 'Chat')), 'forbidden');
select t.expect('reveal: a CLI grant cannot reveal (it reads whole environments, logged as read)',
  t.err(t.run_via('ana', t.g('ana-cli'), t.reveal_sql('team', 'API_KEY', 'development'))), 'forbidden');
select t.expect('reveal: a session logged in as the MCP role cannot reveal, even with a person''s claims',
  t.err(t.run_session('reliquary_mcp', jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated'), t.reveal_sql('team', 'API_KEY', 'production'))),
  'forbidden');
select t.expect_true('reveal: every agent''s attempt is logged as refused, with the agent',
  (select count(*) = 5 from public.env_access_log where vault_id = t.id('team') and action = 'refused'
      and detail ->> 'attempt' = 'reveal' and actor = t.id('ana')
      and (agent is not null or detail ->> 'reason' like 'an agent%')));
select t.expect('reveal: a value that isn''t there is not found', t.err(t.run('ana', t.reveal_sql('team', 'NOPE', 'development'))), 'not_found');

-- ---------------------------------------------------------------------------
-- Read: whole environments, through a CLI grant only

select t.expect('read: the owner''s CLI reads production',
  t.run_via('ana', t.g('ana-cli'), format($q$select string_agg(x ->> 'name' || '=' || convert_from(decode(x ->> 'ciphertext', 'base64'), 'utf8'), ',')
    from jsonb_array_elements(public.read_variables(%L, 'production') -> 'variables') x$q$, t.id('team'))),
  'API_KEY=CIPHERTEXT-MARKER-team-prod');
select t.expect_true('read: it is logged as read with the environment, the names, the grant and its client',
  exists (select 1 from public.env_access_log where vault_id = t.id('team') and action = 'read'
            and environment = 'production' and names = array['API_KEY'] and actor = t.id('ana')
            and agent = 'Reliquary CLI' and token_id = t.g('ana-cli') and client_id = t.c('cli')));
select t.expect('read: an editor''s CLI reads development, names in order',
  t.run_via('ben', t.g('ben-cli'), format($q$select string_agg(x ->> 'name', ',') from jsonb_array_elements(public.read_variables(%L, 'development') -> 'variables') x$q$, t.id('team'))),
  'API_KEY,DB_URL');
select t.expect('read: an editor''s CLI cannot read production',
  t.err(t.run_via('ben', t.g('ben-cli'), t.read_sql('team', 'production'))), 'forbidden');
select t.expect_true('read: the editor''s refused read is logged',
  exists (select 1 from public.env_access_log where vault_id = t.id('team') and action = 'refused'
            and actor = t.id('ben') and environment = 'production' and detail ->> 'attempt' = 'read'
            and token_id = t.g('ben-cli')));
select t.expect('read: a viewer''s CLI cannot read', t.err(t.run_via('cal', t.g('cal-cli'), t.read_sql('team', 'development'))), 'forbidden');
select t.expect('read: a CLI grant scoped to Side cannot read Team',
  t.err(t.run_via('ana', t.g('ana-cli-side'), t.read_sql('team', 'development'))), 'not_found');
select t.expect('read: a CLI grant scoped to Side reads Side',
  t.err(t.run_via('ana', t.g('ana-cli-side'), t.read_sql('side', 'development'))), 'ok');
select t.expect('read: a revoked CLI grant is refused', t.err(t.run_via('ana', t.g('ana-cli-revoked'), t.read_sql('team', 'development'))), 'not_found');
select t.expect('read: an expired CLI grant is refused', t.err(t.run_via('ana', t.g('ana-cli-expired'), t.read_sql('team', 'development'))), 'not_found');
select t.expect('read: someone else''s CLI grant is refused',
  t.err(t.run_via('dee', t.g('ana-cli'), t.read_sql('team', 'development'))), 'forbidden');
select t.expect('read: an outsider''s own CLI grant cannot read the vault',
  t.err(t.run_via('ben', t.g('ben-cli'), t.read_sql('side', 'development'))), 'not_found');
select t.expect('read: an unknown environment is not found',
  t.err(t.run_via('ana', t.g('ana-cli'), t.read_sql('team', 'staging'))), 'not_found');
select t.expect('read: a person in person reads one value at a time, not whole environments',
  t.err(t.run('ana', t.read_sql('team', 'development'))), 'forbidden');
select t.expect('read: an agent without a token cannot read',
  t.err(t.run('ana', t.read_sql('team', 'development'), 'Claude Code')), 'forbidden');
select t.expect('read: an MCP token cannot read',
  t.err(t.run_via('ana', t.tok('ana-pat'), t.read_sql('team', 'development'), 'ana-pat')), 'forbidden');
select t.expect('read: an OAuth grant cannot read',
  t.err(t.run_via('ana', t.g('ana-mcp'), t.read_sql('team', 'development'), 'Chat')), 'forbidden');
select t.expect('read: a session logged in as the MCP role cannot read, even with a CLI grant''s claims',
  t.err(t.run_session('reliquary_mcp', jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.g('ana-cli'), 'name', 'x', 'tok', t.g('ana-cli'))), t.read_sql('team', 'production'))),
  'forbidden');
select t.expect_true('read: every agent''s attempt is logged as refused',
  (select count(*) >= 4 from public.env_access_log where vault_id = t.id('team') and action = 'refused'
      and detail ->> 'attempt' = 'read' and actor = t.id('ana') and agent is not null));
select t.expect('read: anonymous is unauthorized', t.err(t.run(null, t.read_sql('team', 'development'))), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- A CLI grant: consent, its tokens, and nothing else

select t.expect_true('cli grant: consent makes a read-only cli row for the env API',
  (select kind = 'cli' and access = 'read' and all_vaults and resource = t.c('env') and client_id = t.c('cli')
     from public.access_tokens where id = t.g('ana-cli')));
select t.expect('cli grant: it stores no client name, never "this computer"',
  (select coalesce(client_name, 'none') from public.access_tokens where id = t.g('ana-cli')), 'none');
select t.expect('cli grant: an agent cannot consent',
  t.run('ana', format($q$select public.create_cli_grant(%L, %L, %L, %L, null)$q$,
    t.c('cli'), t.c('loopback'), t.c('env'), t.s256('x' || t.c('verifier'))), 'Claude Code'), 'ERR 42501');
select t.expect('cli grant: another client cannot get one',
  t.run('ana', format($q$select public.create_cli_grant('https://evil.example/cli/oauth-client.json', %L, %L, %L, null)$q$,
    t.c('loopback'), t.c('env'), t.s256(t.c('verifier')))), 'ERR 22023');
select t.expect('cli grant: it must come back to this computer',
  t.run('ana', format($q$select public.create_cli_grant(%L, 'https://evil.example/cb', %L, %L, null)$q$,
    t.c('cli'), t.c('env'), t.s256(t.c('verifier')))), 'ERR 22023');
select t.expect('cli grant: it is only for the env API',
  t.run('ana', format($q$select public.create_cli_grant(%L, %L, 'https://app.example/mcp', %L, null)$q$,
    t.c('cli'), t.c('loopback'), t.s256(t.c('verifier')))), 'ERR 22023');
select t.expect('cli grant: a vault its person isn''t in is refused',
  t.run('ana', format($q$select public.create_cli_grant(%L, %L, %L, %L, array[%L]::uuid[])$q$,
    t.c('cli'), t.c('loopback'), t.c('env'), t.s256(t.c('verifier')), t.id('priv'))), 'ERR 22023');
select t.expect('cli grant: an MCP grant can never be for the env API',
  t.run('ana', format($q$select public.create_oauth_grant('x', %L, %L, %L, %L, null, 'read')$q$,
    t.c('mcp-client'), t.c('mcp-redirect'), t.c('env'), t.s256(t.c('verifier')))), 'ERR 23514');
select t.expect('cli grant: its access token resolves for the env API, as the web app',
  t.run_role('reliquary_web', format($q$select user_id::text from private.resolve_cli_token(%L, %L)$q$,
    t.sha((select access from t.grants where name = 'ana-cli')), t.c('env'))), t.id('ana')::text);
select t.expect('cli grant: not for another resource',
  t.run_role('reliquary_web', format($q$select count(*) from private.resolve_cli_token(%L, %L)$q$,
    t.sha((select access from t.grants where name = 'ana-cli')), t.c('mcp'))), '0');
select t.expect('cli grant: its token is useless at the MCP endpoint',
  t.run_role('reliquary_mcp', format($q$select count(*) from private.resolve_oauth_token(%L, %L)$q$,
    t.sha((select access from t.grants where name = 'ana-cli')), t.c('env'))), '0');
select t.expect('cli grant: an MCP token is useless at the env API',
  t.run_role('reliquary_web', format($q$select count(*) from private.resolve_cli_token(%L, %L)$q$,
    t.sha((select access from t.grants where name = 'ana-mcp')), t.c('env'))), '0');
select t.expect('cli grant: a revoked grant''s token doesn''t resolve',
  t.run_role('reliquary_web', format($q$select count(*) from private.resolve_cli_token(%L, %L)$q$,
    t.sha((select access from t.grants where name = 'ana-cli-revoked')), t.c('env'))), '0');
select t.expect('cli grant: only the web app''s role resolves CLI tokens',
  t.run('ana', format($q$select count(*) from private.resolve_cli_token(%L, %L)$q$,
    t.sha((select access from t.grants where name = 'ana-cli')), t.c('env'))), 'ERR 42501');
select t.expect('cli grant: the MCP server''s role cannot resolve them either',
  t.run_role('reliquary_mcp', format($q$select count(*) from private.resolve_cli_token(%L, %L)$q$,
    t.sha((select access from t.grants where name = 'ana-cli')), t.c('env'))), 'ERR 42501');
select t.expect('cli grant: sees no vault', t.run_via('ana', t.g('ana-cli'), $q$select count(*) from public.vaults$q$), '0');
select t.expect('cli grant: reads no file', t.run_via('ana', t.g('ana-cli'), $q$select count(*) from public.files$q$), '0');
select t.expect('cli grant: follows no feed',
  t.run_via('ana', t.g('ana-cli'), format($q$select count(*) from public.changes_since(%L, 0)$q$, t.id('team'))), '0');
select t.expect('cli grant: writes no file',
  t.run_via('ana', t.g('ana-cli'), format($q$select public.write_file(%L, 'notes/cli.md', 'x')$q$, t.id('team'))), 'ERR 42501');
select t.expect('cli grant: proposes nothing',
  t.run_via('ana', t.g('ana-cli'), format($q$select public.propose(%L, 'notes/cli.md', 'x', 'r')$q$, t.id('team'))), 'ERR 42501');
select t.expect('cli grant: deletes no file',
  t.run_via('ana', t.g('ana-cli'), format($q$select public.delete_file(%L, 'notes/alpha.md')$q$, t.id('team'))), 'ERR 42501');
select t.expect('cli grant: creates no vault',
  t.run_via('ana', t.g('ana-cli'), $q$select public.create_vault('From CLI')$q$), 'ERR 42501');
select t.expect('cli grant: revokes no token',
  t.run_via('ana', t.g('ana-cli'), format($q$select public.revoke_access_token(%L)$q$, t.tok('ana-pat'))), 'ERR 42501');
select t.expect('cli grant: mints no token',
  t.run_via('ana', t.g('ana-cli'), $q$select public.create_access_token('x', 30)$q$), 'ERR 42501');
select t.expect('cli grant: reads no access log',
  t.run_via('ana', t.g('ana-cli'), $q$select count(*) from public.env_access_log$q$), '0');

-- ---------------------------------------------------------------------------
-- env_vaults: what the CLI offers to pull

select t.expect('vaults: the owner''s CLI lists every vault with every environment',
  t.run_via('ana', t.g('ana-cli'), $q$select string_agg(vault_name || ':' || role || ':' || array_to_string(environments, '/'), ',') from public.env_vaults()$q$),
  'Side:owner:development/preview/production,Team:owner:development/preview/production');
select t.expect('vaults: a scoped CLI grant lists only its vaults',
  t.run_via('ana', t.g('ana-cli-side'), $q$select string_agg(vault_name, ',') from public.env_vaults()$q$), 'Side');
select t.expect('vaults: an editor''s CLI lists development and preview',
  t.run_via('ben', t.g('ben-cli'), $q$select string_agg(vault_name || ':' || array_to_string(environments, '/'), ',') from public.env_vaults()$q$),
  'Team:development/preview');
select t.expect('vaults: a viewer''s CLI lists the vault with no environments',
  t.run_via('cal', t.g('cal-cli'), $q$select string_agg(vault_name || ':' || role || ':' || cardinality(environments), ',') from public.env_vaults()$q$),
  'Team:viewer:0');
select t.expect('vaults: an MCP token lists none',
  t.run_via('ana', t.tok('ana-pat'), $q$select count(*) from public.env_vaults()$q$, 'ana-pat'), '0');
select t.expect('vaults: a revoked CLI grant lists none',
  t.run_via('ana', t.g('ana-cli-revoked'), $q$select count(*) from public.env_vaults()$q$), '0');

-- ---------------------------------------------------------------------------
-- The access log: append-only, readable by owners and editors, no values

select t.owner_error('log: env_access_log rows cannot be updated, even by the table owner',
  $q$update public.env_access_log set action = 'read'$q$);
select t.owner_error('log: env_access_log rows cannot be deleted, even by the table owner',
  $q$delete from public.env_access_log$q$);
select t.owner_error('log: env_access_log cannot be truncated, even by the table owner',
  $q$truncate public.env_access_log$q$);
select t.expect('log: a person cannot insert a row',
  t.run('ana', format($q$insert into public.env_access_log (vault_id, action) values (%L, 'read') returning 1$q$, t.id('team'))), 'ERR 42501');
select t.expect('log: a person cannot update a row',
  t.run('ana', $q$update public.env_access_log set names = '{}' returning 1$q$), 'ERR 42501');
select t.expect('log: the helper that writes it is not callable',
  t.run('ana', format($q$select private.env_log(%L, 'read', 'development', '{}')$q$, t.id('team'))), 'ERR 42501');
select t.expect_true('log: set, rotate, delete, read, reveal and refused are all recorded',
  (select array_agg(distinct action order by action) from public.env_access_log)
    = array['delete', 'read', 'refused', 'reveal', 'rotate', 'set']);
select t.expect_true('log: the owner reads the vault''s log',
  t.run('ana', format($q$select count(*) from public.env_access_log where vault_id = %L$q$, t.id('team')))::int > 0);
select t.expect_true('log: an editor reads it',
  t.run('ben', format($q$select count(*) from public.env_access_log where vault_id = %L$q$, t.id('team')))::int > 0);
select t.expect('log: a viewer does not',
  t.run('cal', format($q$select count(*) from public.env_access_log where vault_id = %L$q$, t.id('team'))), '0');
select t.expect('log: an outsider does not',
  t.run('dee', format($q$select count(*) from public.env_access_log where vault_id = %L$q$, t.id('team'))), '0');
select t.expect('log: the owner''s read-only agent does not',
  t.run_via('ana', t.tok('ana-pat-ro'), format($q$select count(*) from public.env_access_log where vault_id = %L$q$, t.id('team')), 'ana-pat-ro'), '0');
select t.expect_true('log: no row of the access log or the feed contains a value',
  not exists (select 1 from public.env_access_log l where l::text ~ 'CIPHERTEXT-MARKER|434950484552')
  and not exists (select 1 from public.log l where l::text ~ 'CIPHERTEXT-MARKER|434950484552'));
select t.expect_true('log: the feed records set, rotate and delete with name and environment',
  (select count(*) = 3 from (select distinct event from public.log
     where event in ('variable.set', 'variable.rotate', 'variable.delete')
       and detail ? 'name' and detail ? 'environment') e));
