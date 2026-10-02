-- Hostile tests for .env imports (20260925100000_env_imports). Spec:
-- docs/variables.md, "Imports". Values are sealed by the web app; here a
-- "ciphertext" is a marker, so a test can see exactly where it goes.

-- ---------------------------------------------------------------------------
-- Setup: Ana owns Team (Ben edits, Cal views) and Side; Dee owns Private.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
insert into t.ids select 'priv', t.run('dee', $q$select public.create_vault('Private')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));

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

create table t.grants (name text primary key, id uuid);

-- A CLI sign-in as consent and the token endpoint make it; p_push is the
-- consent page's "may push" choice.
create function t.cli_grant(p_name text, p_user text, p_vaults text, p_push boolean) returns text language plpgsql as $$
declare
  v_code text;
  v_access text := 'rle_' || p_name || encode(extensions.gen_random_bytes(8), 'hex');
  v_out text;
begin
  v_code := t.run(p_user, format($q$select public.create_cli_grant(%L, %L, %L, %L, %s, %L)$q$,
    t.c('cli'), t.c('loopback'), t.c('env'), t.s256(t.c('verifier')), p_vaults, p_push));
  if v_code like 'ERR %' then return v_code; end if;
  v_out := t.run_role('reliquary_web', format($q$select private.oauth_redeem_code(%L, %L, %L, %L, %L, %L, %L)$q$,
    t.sha(v_code), t.c('cli'), t.c('loopback'), t.c('env'), t.c('verifier'), t.sha(v_access), t.sha(v_access || '-r')));
  insert into t.grants select p_name, o.grant_id from private.oauth_tokens o where o.token_hash = t.sha(v_access);
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
  insert into t.grants select p_name, o.grant_id from private.oauth_tokens o where o.token_hash = t.sha(v_access);
  return v_out;
end $$;

-- Evaluates p_sql afresh (a volatile call sees what earlier parts of the
-- same statement wrote; a plain subquery doesn't). First column, as text.
create function t.q(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return v;
end $$;

create function t.g(p_name text) returns uuid language sql as $$ select id from t.grants where name = p_name $$;
create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name and kind = 'pat' $$;

-- Through a grant or token, as the web app (CLI) or MCP server does.
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

-- Items: every name in every environment, sealed as a marker naming its
-- slot and a tag, base64 as the web app sends them.
create function t.ct(p_tag text, p_name text, p_env text) returns bytea language sql as
$$ select convert_to('CT-MARKER-' || p_tag || '-' || p_name || '-' || p_env, 'utf8') $$;
create function t.items(p_names text[], p_envs text[], p_tag text) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('name', n, 'environment', e, 'key_id', 'k1',
    'nonce', encode(decode(repeat('00', 12), 'hex'), 'base64'),
    'ciphertext', encode(t.ct(p_tag, n, e), 'base64')))
  from unnest(p_names) n cross join unnest(p_envs) e
$$;
create function t.create_sql(p_vault text, p_envs text[], p_names text[], p_tag text default 'x',
                             p_refused jsonb default '[]') returns text language sql as $$
  select format($q$select public.create_env_import(%L, %L::text[], %L::jsonb, %L::jsonb)::text$q$,
    t.id(p_vault), p_envs, t.items(p_names, p_envs, p_tag), p_refused)
$$;
create function t.err(p_json text) returns text language sql as
$$ select case when p_json like 'ERR %' then p_json else coalesce(p_json::jsonb ->> 'error', 'ok') end $$;
create function t.imp(p_json text) returns uuid language sql as $$ select (p_json::jsonb ->> 'id')::uuid $$;
create function t.apply_sql(p_import uuid) returns text language sql as
$$ select format($q$select public.apply_env_import(%L)::text$q$, p_import) $$;
create function t.reject_sql(p_import uuid) returns text language sql as
$$ select format($q$select public.reject_env_import(%L)::text$q$, p_import) $$;
create function t.status_sql(p_import uuid) returns text language sql as
$$ select format($q$select public.env_import_status(%L)::text$q$, p_import) $$;
create function t.log_count(p_vault text, p_action text) returns bigint language sql as
$$ select count(*) from public.env_access_log where vault_id = t.id(p_vault) and action = p_action $$;
create function t.secrets(p_import uuid) returns bigint language sql as
$$ select count(*) from private.env_import_secrets where import_id = p_import $$;

-- Sign-ins: CLI grants with and without push, scoped, revoked; an MCP
-- connection; personal tokens.
select t.cli_grant('ana-push', 'ana', 'null', true);
select t.cli_grant('ana-nopush', 'ana', 'null', false);
select t.cli_grant('ana-side-push', 'ana', format('array[%L]::uuid[]', t.id('side')), true);
select t.cli_grant('ana-push-revoked', 'ana', 'null', true);
select t.cli_grant('ben-push', 'ben', 'null', true);
select t.cli_grant('cal-push', 'cal', 'null', true);
select t.cli_grant('dee-push', 'dee', 'null', true);
update public.access_tokens set revoked_at = now() where id = t.g('ana-push-revoked');
select t.mcp_grant('ana-mcp', 'ana');
select t.run('ana', $q$select public.create_access_token('ana-pat', 30)$q$);

-- ---------------------------------------------------------------------------
-- Consent: the push permission

select t.run('ana', format($q$select public.create_cli_grant(%L, %L, %L, %L, null) is not null$q$,
  t.c('cli'), t.c('loopback'), t.c('env'), t.s256(t.c('verifier'))));
select t.expect('grant: consent records whether the CLI may push, and the default is no',
  (select string_agg(n || '=' || t2.env_push, ',' order by n)
     from (values ('ana-push'), ('ana-nopush')) v(n) join public.access_tokens t2 on t2.id = t.g(v.n))
  || ',' || (select env_push from public.access_tokens where kind = 'cli' order by created_at desc limit 1),
  'ana-nopush=false,ana-push=true,false');

select t.expect('grant: only a CLI grant can carry the push permission',
  t.run_role('postgres', format($q$update public.access_tokens set env_push = true where id = %L returning 1$q$, t.tok('ana-pat'))),
  'ERR 23514');

select t.expect('grant: an agent can''t make a CLI grant that pushes',
  t.run('ana', format($q$select public.create_cli_grant(%L, %L, %L, %L, null, true)$q$,
    t.c('cli'), t.c('loopback'), t.c('env'), t.s256(t.c('verifier'))), 'Some agent'),
  'ERR 42501');

-- ---------------------------------------------------------------------------
-- Creating

select t.expect('create: a person in person makes a draft (source web) that expires in 30 minutes',
  (select r::jsonb ->> 'source' || ',' || (abs(extract(epoch from ((r::jsonb ->> 'expires_at')::timestamptz - now() - interval '30 minutes'))) < 60)
     from (select t.run('ana', t.create_sql('team', array['development', 'preview'], array['API_KEY', 'DB_URL'])) r) x),
  'web,true');

select t.expect('create: a CLI grant allowed to push makes a pending import (source cli) that expires in 24 hours',
  (select r::jsonb ->> 'source' || ',' || (r::jsonb -> 'names')::text || ',' ||
          (abs(extract(epoch from ((r::jsonb ->> 'expires_at')::timestamptz - now() - interval '24 hours'))) < 60)
     from (select t.via('ana', t.g('ana-push'), t.create_sql('team', array['development'], array['B_KEY', 'A_KEY'])) r) x),
  'cli,["A_KEY", "B_KEY"],true');

select t.expect('create: a push is logged as push with its names, environment, grant and client, never a value',
  (select action || ',' || environment || ',' || array_to_string(names, '+') || ',' || agent || ',' ||
          (token_id = t.g('ana-push')) || ',' || client_id || ',' || (detail ? 'import') || ',' ||
          (row_to_json(l)::text like '%MARKER%')
     from public.env_access_log l where vault_id = t.id('team') and action = 'push' order by seq desc limit 1),
  'push,development,A_KEY+B_KEY,Reliquary CLI,true,https://app.example/cli/oauth-client.json,true,false');

select t.expect('create: a draft is not logged (nothing has happened to a value yet)',
  t.log_count('team', 'push')::text, '1');

select t.expect('create: a push says which names would overwrite a value already set',
  (select t.run('ana', format($q$select public.set_variable(%L, 'A_KEY', 'development', 'k1', decode(%L, 'hex'), decode(%L, 'hex'))$q$,
     t.id('team'), repeat('00', 12), repeat('ab', 20))) || ',' ||
   (t.via('ana', t.g('ana-push'), t.create_sql('team', array['development'], array['A_KEY', 'NEW_KEY']))::jsonb -> 'overwrites')::text),
  'set,["A_KEY"]');

select t.expect('create: a CLI grant not allowed to push is refused, and the refusal logged',
  t.err(t.via('ana', t.g('ana-nopush'), t.create_sql('team', array['development'], array['X_KEY'])))
  || ',' || t.q($s$select detail ->> 'reason' from public.env_access_log where vault_id = t.id('team') and action = 'refused' order by seq desc limit 1$s$),
  'push_not_allowed,this sign-in wasn''t allowed to push');

select t.expect('create: a CLI grant scoped to one vault can''t push to another (not found, logged)',
  t.err(t.via('ana', t.g('ana-side-push'), t.create_sql('team', array['development'], array['X_KEY'])))
  || ',' || t.q($s$select detail ->> 'reason' from public.env_access_log where vault_id = t.id('team') and action = 'refused' order by seq desc limit 1$s$)
  || ',' || t.err(t.via('ana', t.g('ana-side-push'), t.create_sql('side', array['development'], array['X_KEY']))),
  'not_found,not reachable with this sign-in,ok');

select t.expect('create: a revoked CLI grant can''t push',
  t.err(t.via('ana', t.g('ana-push-revoked'), t.create_sql('team', array['development'], array['X_KEY']))),
  'not_found');

select t.expect('create: an editor''s push to production is refused when it''s made (logged); to development it''s taken',
  t.err(t.via('ben', t.g('ben-push'), t.create_sql('team', array['production'], array['X_KEY'])))
  || ',' || t.q($s$select environment || ' ' || (detail ->> 'reason') from public.env_access_log
              where vault_id = t.id('team') and action = 'refused' order by seq desc limit 1$s$)
  || ',' || t.err(t.run('ben', t.create_sql('team', array['development', 'production'], array['X_KEY'])))
  || ',' || t.err(t.via('ben', t.g('ben-push'), t.create_sql('team', array['development'], array['BEN_KEY']))),
  'forbidden,production role editor,forbidden,ok');

select t.expect('create: a viewer can''t push or paste',
  t.err(t.via('cal', t.g('cal-push'), t.create_sql('team', array['development'], array['X_KEY'])))
  || ',' || t.err(t.run('cal', t.create_sql('team', array['development'], array['X_KEY']))),
  'forbidden,forbidden');

select t.expect('create: an outsider gets not found',
  t.err(t.via('dee', t.g('dee-push'), t.create_sql('team', array['development'], array['X_KEY'])))
  || ',' || t.err(t.run('dee', t.create_sql('team', array['development'], array['X_KEY']))),
  'not_found,not_found');

select t.expect('create: an agent can''t create an import: MCP OAuth grant, personal token, act without a token (logged)',
  t.err(t.via('ana', t.g('ana-mcp'), t.create_sql('team', array['development'], array['X_KEY']), 'Chat'))
  || ',' || t.err(t.via('ana', t.tok('ana-pat'), t.create_sql('team', array['development'], array['X_KEY']), 'ana-pat'))
  || ',' || t.err(t.run('ana', t.create_sql('team', array['development'], array['X_KEY']), 'Some agent'))
  || ',' || t.q($s$select count(*) from public.env_access_log where vault_id = t.id('team') and action = 'refused'
              and detail ->> 'reason' = 'an agent can''t send values'$s$),
  'forbidden,forbidden,forbidden,3');

select t.expect('create: a session logged in as reliquary_mcp can''t, whatever its claims',
  t.err(t.run_session('reliquary_mcp', jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated'),
    t.create_sql('team', array['development'], array['X_KEY']))),
  'forbidden');

select t.expect('create: anonymous can''t call it',
  t.err(t.run(null, t.create_sql('team', array['development'], array['X_KEY']))),
  'ERR 42501');

select t.expect('create: names that aren''t names, or change how programs start, are refused',
  t.run('ana', t.create_sql('team', array['development'], array['PATH']))
  || ',' || t.run('ana', t.create_sql('team', array['development'], array['LD_PRELOAD']))
  || ',' || t.run('ana', t.create_sql('team', array['development'], array['1BAD'])),
  'ERR 22023,ERR 22023,ERR 22023');

select t.expect('create: every name needs a value in every chosen environment, once, in a chosen environment',
  t.run('ana', format($q$select public.create_env_import(%L, array['development', 'preview'], %L::jsonb)$q$,
    t.id('team'), t.items(array['A_KEY'], array['development'], 'x')))
  || ',' || t.run('ana', format($q$select public.create_env_import(%L, array['development'], %L::jsonb)$q$,
    t.id('team'), t.items(array['A_KEY'], array['preview'], 'x')))
  || ',' || t.run('ana', format($q$select public.create_env_import(%L, array['development'], %L::jsonb)$q$,
    t.id('team'), t.items(array['A_KEY'], array['development'], 'x') || t.items(array['A_KEY'], array['development'], 'y')))
  || ',' || t.run('ana', format($q$select public.create_env_import(%L, array['development'], '[]'::jsonb)$q$, t.id('team')))
  || ',' || t.run('ana', format($q$select public.create_env_import(%L, array[]::text[], %L::jsonb)$q$,
    t.id('team'), t.items(array['A_KEY'], array['development'], 'x'))),
  'ERR 22023,ERR 22023,ERR 22023,ERR 22023,ERR 22023');

select t.expect('create: an unknown environment is not found',
  t.err(t.run('ana', t.create_sql('team', array['staging'], array['A_KEY']))),
  'not_found');

select t.expect('create: at most 200 names an import',
  t.run('ana', t.create_sql('side', array['development'], array(select 'K_' || g from generate_series(1, 201) g))),
  'ERR 22023');

select t.expect('create: refused lines keep line numbers, name-shaped names and reasons; anything else is refused',
  (t.run('ana', t.create_sql('side', array['development'], array['OK_KEY'], 'x',
     '[{"line": 3, "name": "PATH", "reason": "changes how programs start"}, {"line": 1, "name": null, "reason": "no = sign"}]'))::jsonb ->> 'ok')
  || ',' || t.q($s$select refused::text from public.env_imports where vault_id = t.id('side') order by created_at desc limit 1$s$)
  || ',' || t.run('ana', t.create_sql('side', array['development'], array['OK_KEY'], 'x',
     '[{"line": 2, "name": "sk_live abc", "reason": "bad name"}]')),
  'true,[{"line": 1, "name": null, "reason": "no = sign"}, {"line": 3, "name": "PATH", "reason": "changes how programs start"}],ERR 22023');

-- ---------------------------------------------------------------------------
-- Reading imports: owners and editors see pushes; a draft its author only

insert into t.ids select 'draft', t.imp(t.run('ana', t.create_sql('team', array['development'], array['DRAFT_KEY'], 'draft')));
insert into t.ids select 'push1', t.imp(t.via('ana', t.g('ana-push'), t.create_sql('team', array['development', 'preview'], array['P1_KEY', 'P2_KEY'], 'push1')));

select t.expect('tables: an owner and an editor see the vault''s pushes; a viewer and an outsider see none',
  t.run('ana', format($q$select count(*) from public.env_imports where id = %L$q$, t.id('push1')))
  || t.run('ben', format($q$select count(*) from public.env_imports where id = %L$q$, t.id('push1')))
  || t.run('cal', format($q$select count(*) from public.env_imports where id = %L$q$, t.id('push1')))
  || t.run('dee', format($q$select count(*) from public.env_imports where id = %L$q$, t.id('push1'))),
  '1100');

select t.expect('tables: a pasted draft is its author''s alone (not another owner''s or editor''s, not an agent''s)',
  t.run('ana', format($q$select count(*) from public.env_imports where id = %L$q$, t.id('draft')))
  || t.run('ben', format($q$select count(*) from public.env_imports where id = %L$q$, t.id('draft')))
  || t.via('ana', t.g('ana-mcp'), format($q$select count(*) from public.env_imports where id = %L$q$, t.id('draft')), 'Chat'),
  '100');

select t.expect('tables: a CLI grant sees no imports by SQL',
  t.via('ana', t.g('ana-push'), format($q$select count(*) from public.env_imports where id = %L$q$, t.id('push1'))),
  '0');

select t.expect('tables: no API role reads import values, or writes the imports table directly',
  t.run('ana', 'select count(*) from private.env_import_secrets')
  || ',' || t.run('ana', format($q$insert into public.env_imports (vault_id, environments, names, source, created_by, expires_at) values (%L, '{development}', '{A}', 'web', %L, now() + interval '1 day') returning 1$q$, t.id('team'), t.id('ana')))
  || ',' || t.run('ana', format($q$update public.env_imports set status = 'applied' where id = %L returning 1$q$, t.id('push1')))
  || ',' || t.run('ana', format($q$delete from public.env_imports where id = %L returning 1$q$, t.id('push1')))
  || ',' || t.run_role('reliquary_web', 'select count(*) from private.env_import_secrets')
  || ',' || t.run_role('reliquary_mcp', 'select count(*) from private.env_import_secrets'),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501');

select t.expect('tables: no callable function returns an import''s values',
  (select string_agg(p.proname, ',' order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosrc like '%env_import_secrets%'
      and has_function_privilege('authenticated', p.oid, 'execute')),
  'apply_env_import,create_env_import,reject_env_import');

select t.expect('tables: env_imports rows hold no value',
  (select count(*) from public.env_imports i where row_to_json(i)::text like '%MARKER%')::text, '0');

-- ---------------------------------------------------------------------------
-- Status (reliquary env push --wait)

select t.expect('status: the author''s CLI grant sees its push''s status, names and environments',
  (select r::jsonb ->> 'status' || ',' || (r::jsonb -> 'names')::text || ',' || (r::jsonb -> 'environments')::text
     from (select t.via('ana', t.g('ana-push'), t.status_sql(t.id('push1'))) r) x),
  'pending,["P1_KEY", "P2_KEY"],["development", "preview"]');

select t.expect('status: another person, a grant that can''t reach the vault, an MCP agent and reliquary_mcp get not found',
  t.err(t.via('ben', t.g('ben-push'), t.status_sql(t.id('push1'))))
  || ',' || t.err(t.run('ben', t.status_sql(t.id('push1'))))
  || ',' || t.err(t.via('ana', t.g('ana-side-push'), t.status_sql(t.id('push1'))))
  || ',' || t.err(t.via('ana', t.g('ana-mcp'), t.status_sql(t.id('push1')), 'Chat'))
  || ',' || t.err(t.run_session('reliquary_mcp', jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated'), t.status_sql(t.id('push1')))),
  'not_found,not_found,not_found,not_found,not_found');

-- ---------------------------------------------------------------------------
-- Applying: a person, in person

select t.expect('apply: the CLI that pushed can''t apply it (logged), nor reject it',
  t.err(t.via('ana', t.g('ana-push'), t.apply_sql(t.id('push1'))))
  || ',' || t.err(t.via('ana', t.g('ana-push'), t.reject_sql(t.id('push1'))))
  || ',' || t.q($s$select detail ->> 'attempt' || ':' || (detail ->> 'reason') from public.env_access_log
              where vault_id = t.id('team') and action = 'refused' and detail ->> 'attempt' = 'apply' order by seq desc limit 1$s$)
  || ',' || t.secrets(t.id('push1')),
  'forbidden,forbidden,apply:an agent can''t apply an import; a person does, in the web UI,4');

select t.expect('apply: no agent can apply: MCP OAuth grant, personal token, act without a token, reliquary_mcp',
  t.err(t.via('ana', t.g('ana-mcp'), t.apply_sql(t.id('push1')), 'Chat'))
  || ',' || t.err(t.via('ana', t.tok('ana-pat'), t.apply_sql(t.id('push1')), 'ana-pat'))
  || ',' || t.err(t.run('ana', t.apply_sql(t.id('push1')), 'Some agent'))
  || ',' || t.err(t.run_session('reliquary_mcp', jsonb_build_object('sub', t.id('ana'), 'role', 'authenticated'), t.apply_sql(t.id('push1'))))
  || ',' || t.q($s$select status from public.env_imports where id = t.id('push1')$s$),
  'forbidden,forbidden,forbidden,forbidden,pending');

select t.expect('apply: a viewer and an outsider can''t apply a push',
  t.err(t.run('cal', t.apply_sql(t.id('push1')))) || ',' || t.err(t.run('dee', t.apply_sql(t.id('push1')))),
  'forbidden,not_found');

select t.expect('apply: a draft is applied by its author only',
  t.err(t.run('ben', t.apply_sql(t.id('draft')))) || ',' || t.err(t.run('ben', t.reject_sql(t.id('draft')))),
  'not_found,not_found');

select t.expect('apply: an editor applies a push to development and preview; the values land as sealed, one log row per variable and environment',
  t.err(t.run('ben', t.apply_sql(t.id('push1'))))
  || ',' || t.q($s$select string_agg(v.name || '/' || s.environment || '=' || convert_from(s.ciphertext, 'utf8'), ' ' order by v.name, s.environment)
               from private.variable_secrets s join public.variables v on v.id = s.variable_id
              where v.vault_id = t.id('team') and v.name in ('P1_KEY', 'P2_KEY')$s$)
  || ',' || t.q($s$select string_agg(action || ':' || array_to_string(names, '') || '/' || environment || ':' || (detail ->> 'import' = t.id('push1')::text), ' ' order by seq)
               from public.env_access_log where vault_id = t.id('team') and detail ->> 'import' = t.id('push1')::text and action in ('set', 'rotate')$s$),
  'ok,P1_KEY/development=CT-MARKER-push1-P1_KEY-development P1_KEY/preview=CT-MARKER-push1-P1_KEY-preview P2_KEY/development=CT-MARKER-push1-P2_KEY-development P2_KEY/preview=CT-MARKER-push1-P2_KEY-preview,set:P1_KEY/development:true set:P1_KEY/preview:true set:P2_KEY/development:true set:P2_KEY/preview:true');

select t.expect('apply: the values are set by the person who applied, the import is applied and its values dropped, and the feed has the sets',
  ((select string_agg(distinct vv.updated_by::text, ',') from public.variable_values vv join public.variables v on v.id = vv.variable_id
    where v.vault_id = t.id('team') and v.name in ('P1_KEY', 'P2_KEY')) = t.id('ben')::text)::text
  || ',' || t.q($s$select status || ':' || (decided_by = t.id('ben')) from public.env_imports where id = t.id('push1')$s$)
  || ',' || t.secrets(t.id('push1'))
  || ',' || t.q($s$select count(*) from public.log where vault_id = t.id('team') and event = 'variable.set' and detail ->> 'name' in ('P1_KEY', 'P2_KEY')$s$),
  'true,applied:true,0,4');

select t.expect('apply: an applied import can''t be applied or rejected again',
  t.err(t.run('ana', t.apply_sql(t.id('push1')))) || ',' || t.err(t.run('ana', t.reject_sql(t.id('push1'))))
  || ',' || (t.via('ana', t.g('ana-push'), t.status_sql(t.id('push1')))::jsonb ->> 'status'),
  'applied,applied,applied');

select t.expect('apply: an existing value is rotated, not duplicated',
  (select t.err(t.run('ana', t.apply_sql(t.imp(t.via('ana', t.g('ana-push'), t.create_sql('team', array['development'], array['P1_KEY'], 'again')))))))
  || ',' || t.q($s$select vv.version || ':' || convert_from(s.ciphertext, 'utf8')
               from public.variables v join public.variable_values vv on vv.variable_id = v.id
               join private.variable_secrets s on s.variable_id = vv.variable_id and s.environment = vv.environment
              where v.vault_id = t.id('team') and v.name = 'P1_KEY' and vv.environment = 'development'$s$),
  'ok,2:CT-MARKER-again-P1_KEY-development');

insert into t.ids select 'prod', t.imp(t.via('ana', t.g('ana-push'), t.create_sql('team', array['production'], array['PROD_KEY'], 'prod')));

select t.expect('apply: an editor can''t apply or reject an owner''s push to production (logged); the owner can apply it',
  t.err(t.run('ben', t.apply_sql(t.id('prod'))))
  || ',' || t.err(t.run('ben', t.reject_sql(t.id('prod'))))
  || ',' || t.q($s$select environment || ' ' || (detail ->> 'reason') from public.env_access_log
              where vault_id = t.id('team') and action = 'refused' and detail ->> 'attempt' = 'apply' order by seq desc limit 1$s$)
  || ',' || t.err(t.run('ana', t.apply_sql(t.id('prod')))),
  'forbidden,forbidden,production role editor,ok');

insert into t.ids select 'old', t.imp(t.via('ana', t.g('ana-push'), t.create_sql('team', array['development'], array['OLD_KEY'], 'old')));
update public.env_imports set created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' where id = t.id('old');

select t.expect('apply: an expired import can''t be applied or rejected, and its values are dropped',
  t.via('ana', t.g('ana-push'), t.status_sql(t.id('old')))::jsonb ->> 'status'
  || ',' || t.err(t.run('ana', t.apply_sql(t.id('old'))))
  || ',' || t.err(t.run('ana', t.reject_sql(t.id('old'))))
  || ',' || t.q($s$select status from public.env_imports where id = t.id('old')$s$)
  || ',' || t.secrets(t.id('old'))
  || ',' || t.q($s$select count(*) from public.variables where vault_id = t.id('team') and name = 'OLD_KEY'$s$),
  'expired,expired,expired,expired,0,0');

-- ---------------------------------------------------------------------------
-- Rejecting

insert into t.ids select 'nope', t.imp(t.via('ana', t.g('ana-push'), t.create_sql('team', array['development'], array['NOPE_KEY'], 'nope')));

select t.expect('reject: an editor rejects a push: its values are dropped, it''s logged as reject, and it can''t be applied after',
  t.err(t.run('ben', t.reject_sql(t.id('nope'))))
  || ',' || t.secrets(t.id('nope'))
  || ',' || t.q($s$select action || ':' || array_to_string(names, '') from public.env_access_log
              where vault_id = t.id('team') and action = 'reject' and detail ->> 'import' = t.id('nope')::text$s$)
  || ',' || t.err(t.run('ana', t.apply_sql(t.id('nope'))))
  || ',' || (t.via('ana', t.g('ana-push'), t.status_sql(t.id('nope')))::jsonb ->> 'status')
  || ',' || t.q($s$select count(*) from public.variables where vault_id = t.id('team') and name = 'NOPE_KEY'$s$),
  'ok,0,reject:NOPE_KEY,rejected,rejected,0');

select t.expect('reject: the author discards their own draft, and nothing is logged',
  t.err(t.run('ana', t.reject_sql(t.id('draft'))))
  || ',' || t.secrets(t.id('draft'))
  || ',' || t.q($s$select count(*) from public.env_access_log where detail ->> 'import' = t.id('draft')::text$s$),
  'ok,0,0');

-- ---------------------------------------------------------------------------
-- Deleting a vault (public.delete_vault, 20260925120000_vault_admin)

insert into t.ids select 'gone', t.run('ana', $q$select public.create_vault('Gone')$q$)::uuid;
insert into t.ids select 'gone_push', t.imp(t.via('ana', t.g('ana-push'), t.create_sql('gone', array['development'], array['GONE_KEY'], 'gone')));
insert into t.ids select 'gone_draft', t.imp(t.run('ana', t.create_sql('gone', array['preview'], array['DRAFT_GONE'], 'gone')));

select t.expect('delete: deleting a vault removes its pending imports and their ciphertexts',
  t.secrets(t.id('gone_push')) || ',' || t.secrets(t.id('gone_draft'))
  || ',' || t.run('ana', format($q$select public.delete_vault(%L, 'Gone') is not null$q$, t.id('gone')))
  || ',' || t.q(format($s$select count(*) from public.env_imports where id in (%L, %L)$s$, t.id('gone_push'), t.id('gone_draft')))
  || ',' || t.q(format($s$select count(*) from private.env_import_secrets where import_id in (%L, %L)$s$, t.id('gone_push'), t.id('gone_draft'))),
  '1,1,true,0,0');

-- ---------------------------------------------------------------------------
-- Rate limits

insert into t.ids select 'rl_vault', t.run('ana', $q$select public.create_vault('Rate')$q$)::uuid;
select t.expect('rate: 20 pending imports per person per vault; the 21st is refused (logged), and deciding one frees a slot',
  ((select string_agg(t.err(t.via('ana', t.g('ana-push'), t.create_sql('rl_vault', array['development'], array['R_' || g]))), '' order by g)
     from generate_series(1, 20) g) = repeat('ok', 20))::text
  || ',' || t.err(t.via('ana', t.g('ana-push'), t.create_sql('rl_vault', array['development'], array['R_21'])))
  || ',' || t.q($s$select detail ->> 'reason' from public.env_access_log where vault_id = t.id('rl_vault') and action = 'refused' order by seq desc limit 1$s$)
  || ',' || t.err(t.run('ana', t.reject_sql(t.q($s$select id from public.env_imports where vault_id = t.id('rl_vault') limit 1$s$)::uuid)))
  || ',' || t.err(t.via('ana', t.g('ana-push'), t.create_sql('rl_vault', array['development'], array['R_21']))),
  'true,rate_limited,too many imports; try again later,ok,ok');

select t.expect('rate: 60 imports per person an hour, across vaults',
  (select count(*) >= 60 from public.env_imports where created_by = t.id('ana') and created_at > now() - interval '1 hour')::text
  || ',' || t.err(t.via('ana', t.g('ana-push'), t.create_sql('side', array['development'], array['LATE']))),
  'false,ok');
update public.env_imports set created_at = now() - interval '10 minutes'
 where id in (select id from public.env_imports where created_by = t.id('ana') and status <> 'pending');
insert into public.env_imports (vault_id, environments, names, source, created_by, expires_at, status, decided_by, decided_at)
select t.id('side'), '{development}', array['FILL_' || g], 'web', t.id('ana'), now() + interval '1 hour', 'rejected', t.id('ana'), now()
  from generate_series(1, 60) g;
select t.expect('rate: past 60 an hour, the person''s next is refused; another person''s isn''t',
  t.err(t.via('ana', t.g('ana-push'), t.create_sql('side', array['development'], array['LATER'])))
  || ',' || t.err(t.run('ben', t.create_sql('team', array['development'], array['BEN_TOO']))),
  'rate_limited,ok');

-- ---------------------------------------------------------------------------
-- The log and the functions

select t.expect('log: push and reject rows are append-only like the rest',
  t.run_role('postgres', format($q$update public.env_access_log set names = '{}' where vault_id = %L and action = 'push' returning 1$q$, t.id('team')))
  || ',' || t.run_role('postgres', format($q$delete from public.env_access_log where vault_id = %L and action = 'reject' returning 1$q$, t.id('team'))),
  'ERR 42501,ERR 42501');

select t.expect('log: no access-log or feed row holds an import''s value',
  ((select count(*) from public.env_access_log l where row_to_json(l)::text like '%MARKER%')
   + (select count(*) from public.log l where row_to_json(l)::text like '%MARKER%'))::text,
  '0');

select t.expect('functions: every new function pins its search_path and runs as its definer where it must',
  (select string_agg(p.proname || ':' || p.prosecdef || ':' ||
            exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c = 'search_path=""'), ',' order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname in ('create_env_import', 'apply_env_import', 'reject_env_import', 'env_import_status',
                        'put_variable', 'sweep_env_imports', 'env_import_state', 'create_cli_grant', 'set_variable')),
  'apply_env_import:true:true,create_cli_grant:true:true,create_env_import:true:true,env_import_state:false:true,env_import_status:true:true,put_variable:true:true,reject_env_import:true:true,set_variable:true:true,sweep_env_imports:true:true');

select t.expect('functions: the helpers that write aren''t callable by API roles',
  t.run('ana', format($q$select private.put_variable(%L, 'SNEAK', 'development', 'k1', decode(%L, 'hex'), decode(%L, 'hex'))$q$,
    t.id('team'), repeat('00', 12), repeat('ab', 20)))
  || ',' || t.run('ana', 'select private.sweep_env_imports()::text'),
  'ERR 42501,ERR 42501');
