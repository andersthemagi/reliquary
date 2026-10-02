-- Hostile tests for key rotation, custom environments and limits
-- (20260925170000_variables_keys). Spec: docs/variables.md. A "ciphertext"
-- here is a marker, so a test can see exactly where it goes.

-- ---------------------------------------------------------------------------
-- Setup: Ana owns Team (Ben edits, Cal views) and Side; Dee owns Private.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
insert into t.ids select 'priv', t.run('dee', $q$select public.create_vault('Private')$q$)::uuid;
insert into t.ids select 'solo', t.run('dee', $q$select public.create_vault('Solo')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));

create function t.q(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return v;
end $$;

create function t.b64(p bytea) returns text language sql as $$ select encode(p, 'base64') $$;
create function t.ct(p_tag text) returns bytea language sql as
$$ select convert_to('CT-MARKER-' || p_tag || repeat('.', greatest(0, 8 - length(p_tag))), 'utf8') $$;
create function t.nonce(p int) returns bytea language sql as
$$ select decode(lpad(to_hex(p), 24, '0'), 'hex') $$;

-- Sets a value as p_user under key p_key with nonce number p_nonce.
create function t.setv(p_user text, p_vault text, p_name text, p_env text, p_key text, p_nonce int,
                       p_agent text default null) returns text language sql as $$
  select t.run(p_user, format($q$select public.set_variable(%L, %L, %L, %L, %L::bytea, %L::bytea)$q$,
    t.id(p_vault), p_name, p_env, p_key, t.nonce(p_nonce), t.ct(p_name || '-' || p_env || '-' || p_key)), p_agent)
$$;

create function t.secret(p_vault text, p_name text, p_env text) returns private.variable_secrets language sql as $$
  select s.* from private.variable_secrets s join public.variables v on v.id = s.variable_id
   where v.vault_id = t.id(p_vault) and v.name = p_name and s.environment = p_env
$$;
create function t.value_row(p_vault text, p_name text, p_env text) returns text language sql as $$
  select vv.version || '|' || vv.updated_by || '|' || vv.updated_at from public.variable_values vv
    join public.variables v on v.id = vv.variable_id
   where v.vault_id = t.id(p_vault) and v.name = p_name and vv.environment = p_env
$$;

-- A reseal item for one stored value: the same slot under p_key, nonce p_nonce.
create function t.item(p_vault text, p_name text, p_env text, p_key text, p_nonce int) returns jsonb language sql as $$
  select jsonb_build_object('kind', 'value', 'ref', s.variable_id, 'name', p_name, 'environment', p_env,
    'old_nonce', t.b64(s.nonce), 'key_id', p_key, 'nonce', t.b64(t.nonce(p_nonce)),
    'ciphertext', t.b64(t.ct(p_name || '-' || p_env || '-' || p_key)))
  from t.secret(p_vault, p_name, p_env) s
$$;

create function t.reseal_sql(p_vault text, p_reason text, p_items jsonb) returns text language sql as
$$ select format($q$select private.reseal(%L, %L, %L::jsonb)$q$, t.id(p_vault), p_reason, p_items) $$;

create function t.log_count(p_vault text, p_action text) returns bigint language sql as
$$ select count(*) from public.env_access_log where vault_id = t.id(p_vault) and action = p_action $$;
create function t.feed_count(p_vault text) returns bigint language sql as
$$ select count(*) from public.log where vault_id = t.id(p_vault) $$;
create function t.envs(p_vault text) returns text language sql as $$
  select string_agg(name || case when owners_only then '*' else '' end, ',' order by name)
    from public.environments where vault_id = t.id(p_vault)
$$;

-- Grants: a CLI sign-in (with push) and an MCP connection, as the token
-- endpoint makes them.
create table t.grants (name text primary key, id uuid);
create function t.cli_grant(p_name text, p_user text) returns void language plpgsql as $$
declare
  v_code text;
  v_access text := 'rle_' || p_name || encode(extensions.gen_random_bytes(8), 'hex');
  v text := repeat('v', 43) || 'erifier-for-tests';
begin
  v_code := t.run(p_user, format($q$select public.create_cli_grant(%L, %L, %L, %L, null, true)$q$,
    'https://app.example/cli/oauth-client.json', 'http://127.0.0.1:53682/callback', 'https://app.example/api/env', t.s256(v)));
  perform t.run_role('reliquary_web', format($q$select private.oauth_redeem_code(%L, %L, %L, %L, %L, %L, %L)$q$,
    t.sha(v_code), 'https://app.example/cli/oauth-client.json', 'http://127.0.0.1:53682/callback',
    'https://app.example/api/env', v, t.sha(v_access), t.sha(v_access || '-r')));
  insert into t.grants select p_name, o.grant_id from private.oauth_tokens o where o.token_hash = t.sha(v_access);
end $$;
create function t.g(p_name text) returns uuid language sql as $$ select id from t.grants where name = p_name $$;
create function t.via(p_user text, p_grant uuid, p_sql text, p_label text default 'Reliquary CLI') returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', p_grant, 'name', p_label, 'tok', p_grant)), p_sql)
$$;
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
select t.cli_grant('ana-cli', 'ana');

-- A pending push (a CLI import) of NEW_KEY for Team's development.
create function t.push_sql(p_vault text, p_env text, p_name text) returns text language sql as $$
  select format($q$select public.create_env_import(%L, array[%L], %L::jsonb)::text$q$, t.id(p_vault), p_env,
    jsonb_build_array(jsonb_build_object('name', p_name, 'environment', p_env, 'key_id', 'k1',
      'nonce', t.b64(t.nonce(900)), 'ciphertext', t.b64(t.ct('push-' || p_name)))))
$$;

-- Values: Team has API_KEY in development (Ben) and production (Ana), and
-- DB_URL in development; Side has SIDE_KEY; Private has PRIV_KEY. All k1.
select t.setv('ben', 'team', 'API_KEY', 'development', 'k1', 1);
select t.setv('ana', 'team', 'API_KEY', 'production', 'k1', 2);
select t.setv('ben', 'team', 'DB_URL', 'development', 'k1', 3);
select t.setv('ana', 'side', 'SIDE_KEY', 'development', 'k1', 4);
select t.setv('dee', 'priv', 'PRIV_KEY', 'development', 'k1', 5);
insert into t.ids select 'push1', (t.via('ana', t.g('ana-cli'), t.push_sql('team', 'development', 'NEW_KEY'))::jsonb ->> 'id')::uuid;

-- ---------------------------------------------------------------------------
-- Key ids and who may rekey

select t.expect('key ids: variable_key_ids counts stored values and pending imports by key id',
  t.run_role('reliquary_ops', $q$select string_agg(key_id || ':' || "values" || '+' || imports, ',') from private.variable_key_ids()$q$),
  'k1:5+1');

select t.expect('key ids: only the operator''s role lists key ids, rekeys or reseals; people, agents, the CLI, the MCP role and the web app''s role are refused',
  t.run('ana', 'select count(*) from private.variable_key_ids()')
  || ',' || t.run('ana', format('select count(*) from private.sealed_rows(%L)', t.id('team')))
  || ',' || t.run('ana', t.reseal_sql('team', 'rotate_key', '[]'))
  || ',' || t.run('ana', $q$select count(*) from private.rekey_vaults('k2')$q$)
  || ',' || t.run('ana', format('select count(*) from private.sealed_rows(%L)', t.id('team')), 'Claude')
  || ',' || t.via('ana', t.g('ana-cli'), format('select count(*) from private.sealed_rows(%L)', t.id('team')))
  || ',' || t.run(null, 'select count(*) from private.variable_key_ids()')
  || ',' || t.run_role('reliquary_mcp', format('select count(*) from private.sealed_rows(%L)', t.id('team')))
  || ',' || t.run_role('reliquary_mcp', t.reseal_sql('team', 'rotate_key', '[]'))
  || ',' || t.run_session('reliquary_web', jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated'),
              t.reseal_sql('team', 'rotate_key', '[]'))
  || ',' || t.run_role('reliquary_web', 'select count(*) from private.variable_key_ids()')
  || ',' || t.run_role('reliquary_web', $q$select count(*) from private.rekey_vaults('k2')$q$)
  || ',' || t.run_role('reliquary_web', format('select count(*) from private.sealed_rows(%L)', t.id('team')))
  || ',' || t.run_role('reliquary_web', t.reseal_sql('team', 'rotate_key', '[]')),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501');

select t.expect('key ids: rekey_vaults names the vaults with anything on another key',
  t.run_role('reliquary_ops', $q$select count(*) from private.rekey_vaults('k2')$q$)
  || ',' || t.run_role('reliquary_ops', $q$select count(*) from private.rekey_vaults('k1')$q$),
  '3,0');

select t.expect('key ids: sealed_rows gives one vault''s values and pending import values, optionally not on a key',
  t.run_role('reliquary_ops', format($q$select string_agg(kind || ':' || name || '@' || environment, ',' order by kind, name, environment) from private.sealed_rows(%L)$q$, t.id('team')))
  || ' / ' || t.run_role('reliquary_ops', format($q$select count(*) from private.sealed_rows(%L, null, 'k1')$q$, t.id('team')))
  || ' / ' || t.run_role('reliquary_ops', format($q$select count(*) from private.sealed_rows(%L, 'production')$q$, t.id('team'))),
  'import:NEW_KEY@development,value:API_KEY@development,value:API_KEY@production,value:DB_URL@development / 0 / 1');

-- ---------------------------------------------------------------------------
-- Reseal: the operator's re-encryption

create table t.before as
  select t.value_row('team', 'API_KEY', 'development') as dev, t.value_row('team', 'API_KEY', 'production') as prod,
         t.feed_count('team') as feed, t.log_count('team', 'set') + t.log_count('team', 'rotate') as sets;

select t.expect('reseal: moves values and pending import values of one vault to the new key',
  t.run_role('reliquary_ops', t.reseal_sql('team', 'rotate_key',
    jsonb_build_array(t.item('team', 'API_KEY', 'development', 'k2', 11), t.item('team', 'API_KEY', 'production', 'k2', 12),
                      t.item('team', 'DB_URL', 'development', 'k2', 13),
                      (select jsonb_build_object('kind', 'import', 'ref', t.id('push1'), 'name', 'NEW_KEY', 'environment', 'development',
                        'old_nonce', t.b64(t.nonce(900)), 'key_id', 'k2', 'nonce', t.b64(t.nonce(14)), 'ciphertext', t.b64(t.ct('push-k2'))))))),
  '4');

select t.expect('reseal: the rows now carry the new key id, nonce and ciphertext',
  (select key_id || '|' || encode(nonce, 'hex') || '|' || convert_from(ciphertext, 'utf8') from t.secret('team', 'API_KEY', 'development'))
  || ',' || (select key_id from private.env_import_secrets where import_id = t.id('push1')),
  'k2|00000000000000000000000b|CT-MARKER-API_KEY-development-k2,k2');

select t.expect_true('reseal: version, updated_by and updated_at stay; no feed event, set or rotate is written',
  (select b.dev = t.value_row('team', 'API_KEY', 'development') and b.prod = t.value_row('team', 'API_KEY', 'production')
          and b.feed = t.feed_count('team') and b.sets = t.log_count('team', 'set') + t.log_count('team', 'rotate')
     from t.before b));

select t.expect('reseal: one rotate_key row for the vault, from the operator, with names and counts and no ciphertext',
  (select count(*) || '|' || coalesce(actor::text, 'null') || '|' || agent || '|' || array_to_string(names, ' ') || '|' || detail::text
     from public.env_access_log where vault_id = t.id('team') and action = 'rotate_key' group by actor, agent, names, detail),
  '1|null|Reliquary operator|API_KEY DB_URL NEW_KEY|{"values": 3, "imports": 1, "key_ids": ["k2"]}');

select t.expect_true('reseal: nothing in the access log holds a ciphertext marker',
  not exists (select 1 from public.env_access_log where detail::text like '%MARKER%' or array_to_string(names, ' ') like '%MARKER%'));

select t.expect('reseal: owners and editors see the rotate_key row; viewers don''t',
  t.run('ana', format($q$select count(*) from public.env_access_log where vault_id = %L and action = 'rotate_key'$q$, t.id('team')))
  || ',' || t.run('ben', format($q$select count(*) from public.env_access_log where vault_id = %L and action = 'rotate_key'$q$, t.id('team')))
  || ',' || t.run('cal', format($q$select count(*) from public.env_access_log where vault_id = %L and action = 'rotate_key'$q$, t.id('team'))),
  '1,1,0');

-- A person rotates SIDE_KEY after the operator read it (nonce 4 -> 40): the
-- operator's item for nonce 4 must not overwrite the person's new value.
select t.setv('ana', 'side', 'SIDE_KEY', 'development', 'k2', 40);
select t.expect('reseal: a value set meanwhile (another nonce) is left alone, and nothing is logged',
  t.run_role('reliquary_ops', t.reseal_sql('side', 'rotate_key',
    jsonb_build_array(jsonb_build_object('kind', 'value', 'ref', (t.secret('side', 'SIDE_KEY', 'development')).variable_id,
      'name', 'SIDE_KEY', 'environment', 'development', 'old_nonce', t.b64(t.nonce(4)), 'key_id', 'k2',
      'nonce', t.b64(t.nonce(41)), 'ciphertext', t.b64(t.ct('stale'))))))
  || ',' || (select encode(nonce, 'hex') from t.secret('side', 'SIDE_KEY', 'development'))
  || ',' || t.log_count('side', 'rotate_key'),
  '0,000000000000000000000028,0');

select t.expect('reseal: an item for another vault''s row changes nothing',
  t.run_role('reliquary_ops', t.reseal_sql('team', 'rotate_key', jsonb_build_array(t.item('priv', 'PRIV_KEY', 'development', 'k2', 50))))
  || ',' || (select key_id from t.secret('priv', 'PRIV_KEY', 'development')),
  '0,k1');

select t.expect('reseal: malformed items, a bad key id, a short nonce or an unknown reason are refused',
  t.run_role('reliquary_ops', t.reseal_sql('priv', 'rotate_key', '{}'))
  || ',' || t.run_role('reliquary_ops', t.reseal_sql('priv', 'rotate_key', '[1]'))
  || ',' || t.run_role('reliquary_ops', t.reseal_sql('priv', 'rotate_key',
              jsonb_build_array(t.item('priv', 'PRIV_KEY', 'development', 'bad id', 51))))
  || ',' || t.run_role('reliquary_ops', t.reseal_sql('priv', 'rotate_key',
              jsonb_build_array(t.item('priv', 'PRIV_KEY', 'development', 'k2', 51) || '{"nonce": "AAAA"}')))
  || ',' || t.run_role('reliquary_ops', t.reseal_sql('priv', 'set', '[]')),
  'ERR 22023,ERR 22023,ERR 22023,ERR 22023,ERR 22023');

select t.expect('reseal: for a rename only inside that rename''s transaction',
  t.run_role('reliquary_ops', t.reseal_sql('priv', 'rename_environment',
    jsonb_build_array(t.item('priv', 'PRIV_KEY', 'development', 'k1', 52)))),
  'ERR 42501');

select t.expect('reseal: after it, variable_key_ids shows what is left on the old key',
  t.run_role('reliquary_ops', $q$select string_agg(key_id || ':' || "values" || '+' || imports, ',') from private.variable_key_ids()$q$),
  'k1:1+0,k2:4+1');

-- ---------------------------------------------------------------------------
-- Custom environments

create table t.env_before as select t.envs('team') as envs, (select count(*) from public.env_access_log) as logs,
  (select count(*) from public.log) as feed;

select t.expect('environments: editors, viewers, outsiders, anonymous, the owner''s agent, a CLI grant and the MCP role can''t create, rename or delete one',
  t.run('ben', format($q$select public.create_environment(%L, 'staging')$q$, t.id('team')))
  || ',' || t.run('cal', format($q$select public.create_environment(%L, 'staging')$q$, t.id('team')))
  || ',' || t.run('dee', format($q$select public.create_environment(%L, 'staging')$q$, t.id('team')))
  || ',' || t.run(null, format($q$select public.create_environment(%L, 'staging')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.create_environment(%L, 'staging')$q$, t.id('team')), 'Claude')
  || ',' || t.via('ana', t.g('ana-cli'), format($q$select public.create_environment(%L, 'staging')$q$, t.id('team')))
  || ',' || t.run_session('reliquary_mcp', jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated'),
              format($q$select public.create_environment(%L, 'staging')$q$, t.id('team')))
  || ',' || t.run('ben', format($q$select public.delete_environment(%L, 'preview', 'preview')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.delete_environment(%L, 'preview', 'preview')$q$, t.id('team')), 'Claude')
  || ',' || t.run('dee', format($q$select public.delete_environment(%L, 'preview', 'preview')$q$, t.id('team')))
  || ',' || t.run('ben', format($q$select public.rename_environment(%L, 'preview', 'qa')$q$, t.id('team')))
  || ',' || t.via('ana', t.g('ana-cli'), format($q$select public.rename_environment(%L, 'preview', 'qa')$q$, t.id('team'))),
  'ERR 42501,ERR 42501,ERR P0002,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR P0002,ERR 42501,ERR 42501');

select t.expect_true('environments: the refusals change and log nothing',
  (select b.envs = t.envs('team') and b.logs = (select count(*) from public.env_access_log)
          and b.feed = (select count(*) from public.log) from t.env_before b));

select t.expect('environments: an owner in person creates one, owners-only or not, logged and in the feed',
  t.run('ana', format($q$select public.create_environment(%L, 'staging')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.create_environment(%L, 'audit', true)$q$, t.id('team')))
  || ',' || t.envs('team')
  || ',' || t.log_count('team', 'create_environment')
  || ',' || t.q($s$select count(*) from public.log where vault_id = t.id('team') and event = 'environment.create'$s$),
  ',,audit*,development,preview,production*,staging,2,2');

select t.expect('environments: bad names, a taken name and an unknown vault are refused',
  t.run('ana', format($q$select public.create_environment(%L, 'Staging')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.create_environment(%L, '1st')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.create_environment(%L, 'a b')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.create_environment(%L, %L)$q$, t.id('team'), repeat('a', 33)))
  || ',' || t.run('ana', format($q$select public.create_environment(%L, null)$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.create_environment(%L, 'staging')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.create_environment(%L, 'x')$q$, t.id('priv'))),
  'ERR 22023,ERR 22023,ERR 22023,ERR 22023,ERR 22023,ERR 23505,ERR P0002');

select t.expect('environments: at most 20 a vault',
  (select string_agg(t.run('ana', format($q$select public.create_environment(%L, %L)$q$, t.id('side'), 'e' || i)), '' order by i)
     from generate_series(1, 17) i)
  || '|' || t.run('ana', format($q$select public.create_environment(%L, 'e18')$q$, t.id('side')))
  || '|' || t.q($s$select count(*) from public.environments where vault_id = t.id('side')$s$),
  '|ERR 55000|20');

select t.expect('environments: set_variable, env_vaults and the CLI see a custom one; an editor can''t set in an owners-only one',
  t.setv('ben', 'team', 'STAGE_KEY', 'staging', 'k2', 60)
  || ',' || t.setv('ana', 'team', 'AUDIT_KEY', 'audit', 'k2', 61)
  || ',' || t.setv('ben', 'team', 'AUDIT_KEY', 'audit', 'k2', 62)
  || ',' || t.run('ben', format($q$select array_to_string(environments, ' ') from public.env_vaults() where vault_id = %L$q$, t.id('team')))
  || ',' || t.via('ana', t.g('ana-cli'), format($q$select (public.read_variables(%L, 'staging') -> 'variables' -> 0 ->> 'name')$q$, t.id('team'))),
  'set,set,ERR 42501,development preview staging,STAGE_KEY');

-- A pending push for staging, to be rejected by the rename.
insert into t.ids select 'push2', (t.via('ana', t.g('ana-cli'), t.push_sql('team', 'staging', 'OTHER_KEY'))::jsonb ->> 'id')::uuid;
create table t.stage_before as select t.value_row('team', 'STAGE_KEY', 'staging') as row;

select t.expect('environments: the defaults keep their names; a taken name, the same name or a bad one is refused',
  t.run('ana', format($q$select public.rename_environment(%L, 'production', 'prod')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.rename_environment(%L, 'development', 'dev')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.rename_environment(%L, 'staging', 'audit')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.rename_environment(%L, 'staging', 'staging')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.rename_environment(%L, 'staging', 'Bad Name')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.rename_environment(%L, 'nope', 'other')$q$, t.id('team'))),
  'ERR 55000,ERR 55000,ERR 23505,ERR 22023,ERR 22023,ERR P0002');

-- The rename and the web app's reseal, in one transaction, as the web app
-- does it: as the person, then as reliquary_web, which reads the renamed
-- environment's values (private.renamed_rows) and swaps in the new name's
-- (private.reseal_renamed).
create function t.web_reseal_sql(p_vault text, p_env text) returns text language sql as $$
  select format($q$select private.reseal_renamed(%L, (select jsonb_agg(jsonb_build_object('kind', 'value', 'ref', r.ref,
      'name', r.name, 'environment', %L, 'old_nonce', encode(r.nonce, 'base64'), 'key_id', r.key_id, 'nonce', %L,
      'ciphertext', %L)) from private.renamed_rows(%L, %L) r))$q$,
    t.id(p_vault), p_env, t.b64(t.nonce(70)), t.b64(t.ct('resealed-' || p_env)), t.id(p_vault), p_env)
$$;
create function t.rename_and_reseal(p_vault text, p_from text, p_to text) returns text language plpgsql as $$
declare
  r text;
  n text;
begin
  r := t.run('ana', format($q$select public.rename_environment(%L, %L, %L)::text$q$, t.id(p_vault), p_from, p_to));
  if r like 'ERR %' then return r; end if;
  n := t.run_role('reliquary_web', t.web_reseal_sql(p_vault, p_to));
  return r || ' ' || n;
end $$;

select t.expect('environments: rename moves the values with their versions, rejects pending imports for it, and the reseal is allowed in its transaction',
  t.rename_and_reseal('team', 'staging', 'qa')
  || '|' || t.envs('team')
  || '|' || (t.value_row('team', 'STAGE_KEY', 'qa') = (select row from t.stage_before))
  || '|' || (select convert_from(ciphertext, 'utf8') from t.secret('team', 'STAGE_KEY', 'qa'))
  || '|' || t.q($s$select status from public.env_imports where id = t.id('push2')$s$)
  || '|' || t.q($s$select count(*) from private.env_import_secrets where import_id = t.id('push2')$s$)
  || '|' || t.q($s$select status from public.env_imports where id = t.id('push1')$s$),
  '{"moved": 1, "names": ["STAGE_KEY"], "rejected_imports": 1} 1|audit*,development,preview,production*,qa|true|CT-MARKER-resealed-qa|rejected|0|pending');

select t.expect('environments: a rename is logged (from, to, names) with the rejection, and in the feed',
  (select environment || ' ' || array_to_string(names, ' ') || ' ' || detail::text
     from public.env_access_log where vault_id = t.id('team') and action = 'rename_environment')
  || ',' || (select count(*) from public.env_access_log where vault_id = t.id('team') and action = 'reject'
               and detail ->> 'reason' = 'environment renamed')
  || ',' || (select count(*) from public.log where vault_id = t.id('team') and event = 'environment.rename'),
  'qa STAGE_KEY {"to": "qa", "from": "staging"},1,1');

select t.expect('environments: the reseal allowance names the vault and the new name only',
  t.q(format($q$select t.run('ana', format('select public.rename_environment(%%L, ''qa'', ''qa2'')::text', %L::uuid)) || ' '
    || t.run_role('reliquary_web', format('select private.reseal_renamed(%%L, %%L::jsonb)', %L::uuid,
         jsonb_build_array(t.item('team', 'API_KEY', 'development', 'k2', 71))))
    || ' ' || t.run_role('reliquary_web', format('select count(*) from private.renamed_rows(%%L, ''development'')', %L::uuid))$q$,
    t.id('team'), t.id('team'), t.id('team'))),
  '{"moved": 1, "names": ["STAGE_KEY"], "rejected_imports": 0} ERR 42501 ERR 42501');

select t.expect('environments: deleting needs the name typed; a default with values, or the last one, is refused',
  t.run('ana', format($q$select public.delete_environment(%L, 'qa2', 'qa')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.delete_environment(%L, 'qa2', null)$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.delete_environment(%L, 'development', 'development')$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.delete_environment(%L, 'nope', 'nope')$q$, t.id('team')))
  || ',' || t.run('dee', format($q$select public.delete_environment(%L, 'preview', 'preview')$q$, t.id('solo')))
  || ',' || t.run('dee', format($q$select public.delete_environment(%L, 'production', 'production')$q$, t.id('solo')))
  || ',' || t.run('dee', format($q$select public.delete_environment(%L, 'development', 'development')$q$, t.id('solo')))
  || ',' || t.envs('solo'),
  'ERR 22023,ERR 22023,ERR 55000,ERR P0002,{"names": [], "deleted": 0},{"names": [], "deleted": 0},ERR 55000,development');

-- ONLY_QA has a value only in qa2; STAGE_KEY too; API_KEY lives on elsewhere.
select t.setv('ana', 'team', 'API_KEY', 'qa2', 'k2', 80);
select t.setv('ana', 'team', 'ONLY_QA', 'qa2', 'k2', 81);
insert into t.ids select 'push3', (t.via('ana', t.g('ana-cli'), t.push_sql('team', 'qa2', 'THIRD_KEY'))::jsonb ->> 'id')::uuid;

select t.expect('environments: deleting a custom one destroys its values, variables left with none, and its pending imports',
  t.run('ana', format($q$select public.delete_environment(%L, 'qa2', 'qa2')::text$q$, t.id('team')))
  || '|' || t.envs('team')
  || '|' || t.q($s$select string_agg(name, ' ' order by name) from public.variables where vault_id = t.id('team')$s$)
  || '|' || t.q($s$select count(*) from public.variable_values where vault_id = t.id('team') and environment = 'qa2'$s$)
  || '|' || t.q($s$select count(*) from private.variable_secrets where environment = 'qa2'$s$)
  || '|' || t.q($s$select status from public.env_imports where id = t.id('push3')$s$)
  || '|' || t.q($s$select count(*) from private.env_import_secrets where import_id = t.id('push3')$s$),
  '{"names": ["API_KEY", "ONLY_QA", "STAGE_KEY"], "deleted": 3}|audit*,development,preview,production*|API_KEY AUDIT_KEY DB_URL|0|0|rejected|0');

select t.expect('environments: a deletion is logged with the names destroyed and in the feed',
  (select environment || ' ' || array_to_string(names, ' ') || ' ' || detail::text
     from public.env_access_log where vault_id = t.id('team') and action = 'delete_environment')
  || ',' || (select count(*) from public.log where vault_id = t.id('team') and event = 'environment.delete'),
  'qa2 API_KEY ONLY_QA STAGE_KEY {"values": 3},1');

select t.expect('environments: an empty default can be deleted by its owner',
  t.run('ana', format($q$select public.delete_environment(%L, 'preview', 'preview')::text$q$, t.id('team')))
  || ',' || t.envs('team'),
  '{"names": [], "deleted": 0},audit*,development,production*');

select t.expect('environments: env_access_log still refuses updates and deletes of the new rows',
  t.run_role('reliquary_web', $q$update public.env_access_log set names = '{}' where action = 'rotate_key' returning 1$q$),
  'ERR 42501');
select t.owner_error('environments: even the table owner can''t edit a rotate_key row',
  $q$update public.env_access_log set detail = '{}' where action = 'rotate_key'$q$);

-- ---------------------------------------------------------------------------
-- Limits

select t.expect('limits: a vault holds at most 1000 variables; a new value for an existing one still works',
  (select count(*) filter (where r = 'set') from (
     select t.run('dee', format($q$select public.set_variable(%L, %L, 'development', 'k1', %L::bytea, %L::bytea)$q$,
       t.id('priv'), 'V' || i, t.nonce(1000 + i), t.ct('v' || i))) as r
     from generate_series(1, 999) i) x)
  || ',' || t.run('dee', format($q$select public.set_variable(%L, 'ONE_MORE', 'development', 'k1', %L::bytea, %L::bytea)$q$,
       t.id('priv'), t.nonce(3000), t.ct('one-more')))
  || ',' || t.run('dee', format($q$select public.set_variable(%L, 'V1', 'development', 'k1', %L::bytea, %L::bytea)$q$,
       t.id('priv'), t.nonce(3001), t.ct('v1-again')))
  || ',' || t.q($s$select count(*) from public.variables where vault_id = t.id('priv')$s$),
  '999,ERR 55000,rotate,1000');
