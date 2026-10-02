-- Hostile tests for 20260925130000_efficiency_2: resolving a token inside the
-- tool call's transaction, the variables tables' set-based read policies,
-- search on stored words, and import rate limits and cleanup.
-- docs/research/server-load.md, "Second pass".

-- ---------------------------------------------------------------------------
-- Setup: Ana owns Team (Ben edits, Cal views) and Side; Dee owns Private.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
insert into t.ids select 'priv', t.run('dee', $q$select public.create_vault('Private')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.write_file(%L, 'notes/a.md', 'alpha words here')$q$, t.id('team')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/s.md', 'side words')$q$, t.id('side')));

-- Evaluates p_sql afresh. First column, as text.
create function t.q(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return v;
end $$;

-- Logged in as p_login (e.g. the MCP server's role), with claims.
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

create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name and kind = 'pat' $$;
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;

create table t.secret (name text primary key, token text);
insert into t.secret select 'ana-all', t.run('ana', $q$select public.create_access_token('ana-all', 30, null, 'write')$q$);
insert into t.secret select 'ana-side-ro',
  t.run('ana', format($q$select public.create_access_token('ana-side-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('side')));
insert into t.secret select 'ana-revoked', t.run('ana', $q$select public.create_access_token('ana-revoked', 30, null, 'write')$q$);
select t.run('ana', format($q$select public.revoke_access_token(%L)$q$, t.tok('ana-revoked')));
create function t.hash(p_name text) returns text language sql as
$$ select t.sha(token) from t.secret where name = p_name $$;

-- As the MCP server: log in as reliquary_mcp, call mcp_begin, then (in the
-- same transaction) run p_sql. Returns "user,current_user,act.tok[,p_sql's answer]".
create function t.begin_as(p_hash text, p_resource text default null, p_sql text default null) returns text
language plpgsql as $$
declare u text; v text;
begin
  perform set_config('role', 'reliquary_mcp', true);
  select coalesce(string_agg(user_id::text, ','), 'none') into u from private.mcp_begin(p_hash, p_resource);
  v := u || ',' || current_user || ',' ||
       coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'act' ->> 'tok', '-');
  if p_sql is not null then
    execute p_sql into u;
    v := v || ',' || coalesce(u, 'null');
  end if;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
exception when others then
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return 'ERR ' || sqlstate;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Resolving the token inside the transaction

select t.expect('mcp begin: a personal token makes the rest of the transaction its person, through that token',
  t.begin_as(t.hash('ana-all'), null, 'select private.uid()::text || ''/'' || private.agent()'),
  t.id('ana') || ',authenticated,' || t.tok('ana-all') || ',' || t.id('ana') || '/ana-all');
select t.expect('mcp begin: the token''s scope holds for the rest of the transaction',
  t.begin_as(t.hash('ana-side-ro'), null, format($q$select (select count(*) from public.files where vault_id = %L)
      || '/' || (select count(*) from public.files where vault_id = %L) || '/' || coalesce(private.role_in(%L), 'none')$q$,
    t.id('team'), t.id('side'), t.id('side'))),
  t.id('ana') || ',authenticated,' || t.tok('ana-side-ro') || ',0/1/viewer');
select t.expect('mcp begin: an unknown, revoked or expired token sets nothing: no person, no role, no claims',
  t.begin_as(t.sha('rlq_nope')) || ';' || t.begin_as(t.hash('ana-revoked')) || ';'
  || t.begin_as(t.hash('ana-revoked'), null, 'select count(*) from public.files'),
  'none,reliquary_mcp,-;none,reliquary_mcp,-;ERR 42501');
update public.access_tokens set expires_at = now() - interval '1 second' where name = 'ana-side-ro';
select t.expect('mcp begin: an expired token resolves to nobody',
  t.begin_as(t.hash('ana-side-ro')), 'none,reliquary_mcp,-');
select t.expect('mcp begin: people, anonymous callers and the web app''s role can''t call it',
  t.run('ana', format($q$select count(*) from private.mcp_begin(%L, null)$q$, t.hash('ana-all')))
  || ',' || t.run(null, format($q$select count(*) from private.mcp_begin(%L, null)$q$, t.hash('ana-all')))
  || ',' || t.run_role('reliquary_web', format($q$select count(*) from private.mcp_begin(%L, null)$q$, t.hash('ana-all'))),
  'ERR 42501,ERR 42501,ERR 42501');

update public.access_tokens set last_used_at = now() - interval '30 seconds' where name = 'ana-all';
create table t.used as select last_used_at from public.access_tokens where name = 'ana-all';
select t.begin_as(t.hash('ana-all'));
select t.expect_true('mcp begin: last_used_at is not rewritten within a minute',
  (select a.last_used_at = u.last_used_at from public.access_tokens a, t.used u where a.name = 'ana-all'));
update public.access_tokens set last_used_at = now() - interval '2 minutes' where name = 'ana-all';
select t.begin_as(t.hash('ana-all'));
select t.expect_true('mcp begin: a stale last_used_at is brought up to date',
  (select last_used_at > now() - interval '5 seconds' from public.access_tokens where name = 'ana-all'));

-- OAuth: an MCP grant's access token, bound to its resource.
create function t.oauth(p_user text, p_access text, p_resource text, p_kind text default 'mcp', p_push boolean default false)
returns text language plpgsql as $$
declare
  v_code text;
  v_client text := case p_kind when 'cli' then 'https://app.example/cli/oauth-client.json' else 'https://client.example/meta.json' end;
  v_redirect text := case p_kind when 'cli' then 'http://127.0.0.1:53682/callback' else 'https://client.example/callback' end;
  v_verifier text := repeat('v', 43) || 'erifier-for-tests';
begin
  if p_kind = 'cli' then
    v_code := t.run(p_user, format($q$select public.create_cli_grant(%L, %L, %L, %L, null, %L)$q$,
      v_client, v_redirect, p_resource, t.s256(v_verifier), p_push));
  else
    v_code := t.run(p_user, format($q$select public.create_oauth_grant('Chat', %L, %L, %L, %L, null, 'write')$q$,
      v_client, v_redirect, p_resource, t.s256(v_verifier)));
  end if;
  return t.run_role('reliquary_web', format($q$select private.oauth_redeem_code(%L, %L, %L, %L, %L, %L, %L)$q$,
    t.sha(v_code), v_client, v_redirect, p_resource, v_verifier, t.sha(p_access), t.sha(p_access || '-r')));
end $$;
select t.oauth('ana', 'rlo_efficiency_access', 'https://mcp.example/mcp');
select t.expect('mcp begin: an OAuth access token resolves only for the resource it was issued for',
  split_part(t.begin_as(t.sha('rlo_efficiency_access'), 'https://mcp.example/mcp'), ',', 1)
  || ',' || t.begin_as(t.sha('rlo_efficiency_access'), 'https://other.example/mcp')
  || ',' || t.begin_as(t.sha('rlo_efficiency_access')),
  t.id('ana') || ',none,reliquary_mcp,-,none,reliquary_mcp,-');

-- A CLI grant's token (the env API's): last_used_at once a minute too.
select t.oauth('ana', 'rle_efficiency_cli', 'https://app.example/api/env', 'cli', true);
create function t.cli_resolve() returns text language sql as $$
  select t.run_role('reliquary_web', format($q$select coalesce(string_agg(user_id::text, ','), 'none')
    from private.resolve_cli_token(%L, 'https://app.example/api/env')$q$, t.sha('rle_efficiency_cli')))
$$;
update public.access_tokens set last_used_at = now() - interval '30 seconds' where kind = 'cli' and user_id = t.id('ana');
create table t.cli_used as select last_used_at from public.access_tokens where kind = 'cli' and user_id = t.id('ana');
select t.expect('resolve cli: a live CLI token still resolves to its person',
  t.cli_resolve(), t.id('ana')::text);
select t.expect_true('resolve cli: last_used_at is not rewritten within a minute',
  (select a.last_used_at = u.last_used_at from public.access_tokens a, t.cli_used u where a.kind = 'cli' and a.user_id = t.id('ana')));
update public.access_tokens set last_used_at = now() - interval '2 minutes' where kind = 'cli' and user_id = t.id('ana');
select t.cli_resolve();
select t.expect_true('resolve cli: a stale last_used_at is brought up to date',
  (select last_used_at > now() - interval '5 seconds' from public.access_tokens where kind = 'cli' and user_id = t.id('ana')));
update public.access_tokens set revoked_at = now() where kind = 'cli' and user_id = t.id('ana');
select t.expect('resolve cli: a revoked CLI grant stops resolving', t.cli_resolve(), 'none');

-- ---------------------------------------------------------------------------
-- 2. The variables tables' read policies

select t.expect('rls variables: no variables policy calls is_member or role_in per row',
  (select coalesce(string_agg(tablename || '.' || policyname, ',' order by tablename), 'none') from pg_policies
    where schemaname = 'public' and tablename in ('environments', 'variables', 'variable_values', 'env_access_log', 'env_imports')
      and (qual like '%is_member(%' or qual like '%role_in(%')),
  'none');

-- writable_vaults is exactly the vaults where role_in is owner or editor,
-- for people in person and through every kind of token.
select t.run('ben', $q$select public.create_access_token('ben-all-rw', 30, null, 'write')$q$);
select t.run('ben', $q$select public.create_access_token('ben-all-ro', 30, null, 'read')$q$);
select t.run('ana', format($q$select public.create_access_token('ana-team-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
create function t.writable_matches(p_claims jsonb) returns text language sql as $$
  select t.run_claims(p_claims, $q$select (
      (select coalesce(array_agg(x order by x), '{}') from private.writable_vaults() x)
      = (select coalesce(array_agg(v.id order by v.id), '{}') from public.vaults v
          where coalesce(private.role_in(v.id) in ('owner', 'editor'), false))
      )::text || ':' || (select count(*) from private.writable_vaults())$q$)
$$;
create function t.claims(p_user text, p_tok text default null) returns jsonb language sql as $$
  select jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated')
    || case when p_tok is null then '{}'::jsonb
            else jsonb_build_object('act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))) end
$$;
select t.expect('rls writable: the writable set equals role_in owner or editor: owner, editor, viewer, outsider in person',
  t.writable_matches(t.claims('ana')) || ',' || t.writable_matches(t.claims('ben')) || ',' ||
  t.writable_matches(t.claims('cal')) || ',' || t.writable_matches(t.claims('dee')),
  'true:2,true:1,true:0,true:1');
select t.expect('rls writable: and through tokens: all-vaults read-write, read-only, scoped, another person''s',
  t.writable_matches(t.claims('ben', 'ben-all-rw')) || ',' || t.writable_matches(t.claims('ben', 'ben-all-ro')) || ','
  || t.writable_matches(t.claims('ana', 'ana-team-rw')) || ',' || t.writable_matches(t.claims('dee', 'ana-all')),
  'true:1,true:0,true:1,true:0');

-- Rows: an access-log row and a push in Team; who sees them.
insert into public.env_access_log (vault_id, actor, action, environment, names)
values (t.id('team'), t.id('ana'), 'read', 'development', array['K']);
insert into public.env_imports (vault_id, environments, names, source, created_by, expires_at)
values (t.id('team'), '{development}', '{K}', 'cli', t.id('ana'), now() + interval '1 day'),
       (t.id('team'), '{development}', '{K}', 'web', t.id('ana'), now() + interval '1 hour');
create function t.sees(p_claims jsonb) returns text language sql as $$
  select t.run_claims(p_claims, format($q$select (select count(*) from public.env_access_log where vault_id = %1$L)
      || '/' || (select count(*) from public.env_imports where vault_id = %1$L and source = 'cli')
      || '/' || (select count(*) from public.env_imports where vault_id = %1$L and source = 'web')
      || '/' || (select count(*) from public.environments where vault_id = %1$L)$q$, t.id('team')))
$$;
select t.expect('rls variables: log and pushes for owners and editors, the draft for its author in person, environments for members',
  t.sees(t.claims('ana')) || ',' || t.sees(t.claims('ben')) || ',' || t.sees(t.claims('cal')) || ',' || t.sees(t.claims('dee')),
  '1/1/1/3,1/1/0/3,0/0/0/3,0/0/0/0');
select t.expect('rls variables: through a token: read-write sees the log and pushes, never the draft; read-only sees names only',
  t.sees(t.claims('ana', 'ana-team-rw')) || ',' || t.sees(t.claims('ben', 'ben-all-ro')),
  '1/1/0/3,0/0/0/3');

-- ---------------------------------------------------------------------------
-- 3. Search on stored words

-- The search as it was (20260924190000_rule_for), for comparing answers.
create function t.search_before(p_vault uuid, p_query text, p_limit int default 20)
returns table (path text, policy text, body text, updated_at timestamptz, author uuid, agent text, rank real)
language sql stable security invoker set search_path = '' as $$
  select f.path, (private.rule_for(f.vault_id, f.path)).policy, v.body, f.updated_at,
         v.author, v.agent,
         ts_rank(to_tsvector('simple', coalesce(v.body, '')), websearch_to_tsquery('simple', p_query))
  from public.files f
  join public.file_versions v on v.id = f.current_version_id
  where f.vault_id = p_vault and f.deleted_at is null and v.body is not null
    and (to_tsvector('simple', coalesce(v.body, '')) @@ websearch_to_tsquery('simple', p_query)
         or (length(trim(coalesce(p_query, ''))) > 0 and strpos(lower(f.path), lower(trim(p_query))) > 0))
  order by 7 desc, f.updated_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;
grant usage on schema t to authenticated;
grant execute on function t.search_before(uuid, text, int) to authenticated;

insert into t.ids select 'find', t.run('ana', $q$select public.create_vault('Find')$q$)::uuid;
select t.run('ana', format($q$select public.write_file(%L, %L, %L)$q$, t.id('find'), 'notes/n' || i || '.md',
  'The workshop ' || repeat('agenda ', i) || case when i % 3 = 0 then 'retainer' else 'pricing' end))
  from generate_series(1, 12) i;
select t.run('ana', format($q$select public.write_file(%L, 'retainer/plan.md', 'nothing to see')$q$, t.id('find')));
select t.run('ana', format($q$select public.write_file(%L, 'gone.md', 'workshop gone')$q$, t.id('find')));
select t.run('ana', format($q$select public.delete_file(%L, 'gone.md')$q$, t.id('find')));
select t.run('ana', format($q$select public.write_file(%L, 'erased.md', 'workshop secret erased')$q$, t.id('find')));
select t.run('ana', format($q$select public.erase_file(%L, 'erased.md')$q$, t.id('find')));
-- notes/ becomes canon after the writes, so answers carry both policies.
select t.run('ana', format($q$select public.set_policy(%L, 'notes/', 'canon', 1)$q$, t.id('find')));

create function t.answers(p_fn text, p_query text, p_limit int default 20) returns text language sql as $$
  select t.run('cal', format($q$select coalesce(string_agg(path || ':' || policy || ':' || round(rank::numeric, 6), ' ' order by ord), '(none)')
    from (select *, row_number() over () as ord from %s(%L, %L, %s)) x$q$, p_fn, t.id('find'), p_query, p_limit))
$$;
select test_support.add_member(t.id('find'), t.id('cal'), 'viewer', t.id('ana'));
select t.expect('search: the same answers as before, in the same order, for words, phrases, or, exclusions, paths and nothing',
  (select string_agg(q || '=' || (t.answers('public.search', q, 20) = t.answers('t.search_before', q, 20))::text, ',' order by q)
     from unnest(array['workshop', '"workshop agenda agenda"', 'retainer or pricing', 'workshop -retainer',
                       'notes/n1', 'RETAINER', 'n1', 'erased', 'secret', '', '   ', 'zzz']) q),
  (select string_agg(q || '=true', ',' order by q)
     from unnest(array['workshop', '"workshop agenda agenda"', 'retainer or pricing', 'workshop -retainer',
                       'notes/n1', 'RETAINER', 'n1', 'erased', 'secret', '', '   ', 'zzz']) q));
select t.expect('search: limits are clamped as before (1 to 100)',
  (t.answers('public.search', 'workshop', 0) = t.answers('t.search_before', 'workshop', 0))::text || ','
  || (t.answers('public.search', 'workshop', 3) = t.answers('t.search_before', 'workshop', 3))::text,
  'true,true');
select t.expect('search: a real query finds something (the comparison isn''t empty against empty)',
  (t.answers('public.search', 'workshop', 20) like 'notes/%')::text || ',' || t.answers('public.search', 'retainer/plan', 20),
  'true,retainer/plan.md:open:0.000000');
select t.expect('search: erased text leaves no stored words behind',
  (select count(*) from public.file_versions where erased_at is not null and body_tsv <> ''::tsvector)::text
  || ',' || (select count(*) from public.file_versions where vault_id = t.id('find') and erased_at is not null),
  '0,1');
select t.expect('search: an outsider and a token scoped to another vault find nothing',
  t.run('dee', format($q$select count(*) from public.search(%L, 'workshop')$q$, t.id('find')))
  || ',' || t.run_tok('ana', 'ana-team-rw', format($q$select count(*) from public.search(%L, 'workshop')$q$, t.id('find'))),
  '0,0');

-- ---------------------------------------------------------------------------
-- 4. Imports: the rate-limit precheck, and cleanup

create function t.precheck(p_vault text, p_names text[] default '{K}') returns text language sql as
$$ select format($q$select public.env_import_precheck(%L, %L::text[])::text$q$, t.id(p_vault), p_names) $$;
create function t.err(p_json text) returns text language sql as
$$ select case when p_json like 'ERR %' then p_json else coalesce(p_json::jsonb ->> 'error', 'ok') end $$;
create function t.pending(p_user text, p_vault text, n int, p_expires interval default '1 hour') returns void language sql as $$
  insert into public.env_imports (vault_id, environments, names, source, created_by, expires_at)
  select t.id(p_vault), '{development}', array['P_' || g], 'web', t.id(p_user), now() + p_expires from generate_series(1, n) g
$$;
insert into t.ids select 'rate', t.run('ana', $q$select public.create_vault('Rate')$q$)::uuid;

select t.expect('precheck: under the limits a person may go on; anonymous is unauthorized',
  t.err(t.run('ana', t.precheck('rate'))) || ',' || t.err(t.run(null, t.precheck('rate'))),
  'ok,ERR 42501');
select t.expect('precheck: a signed-out request with claims but no person is unauthorized',
  t.err(t.run_claims('{"role": "authenticated"}', t.precheck('rate'))), 'unauthorized');
select t.pending('ana', 'rate', 20);
select t.expect('precheck: at 20 pending in a vault, refused as rate_limited and logged as create logs it',
  t.err(t.run('ana', t.precheck('rate', array['B_KEY', 'A_KEY'])))
  || ',' || t.q($s$select action || ':' || array_to_string(names, '+') || ':' || (detail ->> 'reason') || ':' || (detail ->> 'attempt')
               from public.env_access_log where vault_id = t.id('rate') order by seq desc limit 1$s$),
  'rate_limited,refused:A_KEY+B_KEY:too many imports; try again later:push');
select t.expect('precheck: names it would log must be names',
  t.run('ana', t.precheck('rate', array['PATH'])) || ',' || t.run('ana', t.precheck('rate', array['bad name'])),
  'ERR 22023,ERR 22023');
select test_support.add_member(t.id('rate'), t.id('ben'), 'editor', t.id('ana'));
select t.expect('precheck: another person, and the same person in another vault, may go on',
  t.err(t.run('ben', t.precheck('rate'))) || ',' || t.err(t.run('ana', t.precheck('side'))),
  'ok,ok');
create table t.log_before as select count(*) as n from public.env_access_log where vault_id = t.id('rate');
select t.expect('precheck: callers create refuses for who they are get ok and no log (create refuses and logs them)',
  t.err(t.run('ana', t.precheck('rate'), 'Some agent'))
  || ',' || t.err(t.run_session('reliquary_mcp', t.claims('ana'), t.precheck('rate')))
  || ',' || t.err(t.run('dee', t.precheck('rate')))
  || ',' || ((select count(*) from public.env_access_log where vault_id = t.id('rate')) = (select n from t.log_before))::text,
  'ok,ok,ok,true');
select t.expect('rate: a pending import past its time no longer counts, even before anything sweeps it',
  t.q($s$update public.env_imports set expires_at = now() - interval '1 second'
           where vault_id = t.id('rate') and names = '{P_1}' returning 'moved'$s$)
  || ',' || t.err(t.run('ana', t.precheck('rate')))
  || ',' || t.q($s$select status from public.env_imports where vault_id = t.id('rate') and names = '{P_1}'$s$),
  'moved,ok,pending');

-- Cleanup
create function t.secret_for(p_import uuid) returns void language sql as $$
  insert into private.env_import_secrets (import_id, name, environment, key_id, nonce, ciphertext)
  values (p_import, 'K', 'development', 'k1', decode(repeat('00', 12), 'hex'), convert_to('CT-MARKER-cleanup-padding', 'utf8'))
$$;
insert into t.ids select 'live', (select id from public.env_imports where vault_id = t.id('rate') and names = '{P_2}');
insert into t.ids select 'late', (select id from public.env_imports where vault_id = t.id('rate') and names = '{P_1}');
select t.secret_for(t.id('live'));
select t.secret_for(t.id('late'));
select t.expect('cleanup: API roles, the web app''s and the MCP server''s roles can''t run it',
  t.run('ana', 'select private.cleanup_expired_imports()::text') || ',' || t.run(null, 'select private.cleanup_expired_imports()::text')
  || ',' || t.run_role('reliquary_web', 'select private.cleanup_expired_imports()::text')
  || ',' || t.run_role('reliquary_mcp', 'select private.cleanup_expired_imports()::text'),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501');
select t.expect('cleanup: without pg_cron, requests still sweep (the fallback)',
  private.imports_swept_by_cron()::text, 'false');

-- As where pg_cron runs the job: a stand-in cron.job table.
create schema cron;
create table cron.job (jobname text, active boolean);
insert into cron.job values ('reliquary-expired-imports', true);
select private.sweep_env_imports();
select t.expect('cleanup: where pg_cron runs the job, a request doesn''t sweep, and the import still reads as expired',
  private.imports_swept_by_cron()::text
  || ',' || t.q($s$select status from public.env_imports where id = t.id('late')$s$)
  || ',' || t.q($s$select private.env_import_state(status, expires_at) from public.env_imports where id = t.id('late')$s$)
  || ',' || t.run('ana', format($q$select public.apply_env_import(%L)::jsonb ->> 'error'$q$, t.id('late'))),
  'true,pending,expired,expired');
update cron.job set active = false;
select t.expect('cleanup: an inactive job counts as no job', private.imports_swept_by_cron()::text, 'false');
drop schema cron cascade;

select t.expect('cleanup: it expires what is past its time, drops those values, and leaves live imports alone',
  private.cleanup_expired_imports()::text
  || ',' || t.q($s$select status from public.env_imports where id = t.id('late')$s$)
  || ',' || t.q($s$select count(*) from private.env_import_secrets where import_id = t.id('late')$s$)
  || ',' || t.q($s$select status from public.env_imports where id = t.id('live')$s$)
  || ',' || t.q($s$select count(*) from private.env_import_secrets where import_id = t.id('live')$s$),
  '1,expired,0,pending,1');
select t.expect('cleanup: a second run finds nothing to do',
  private.cleanup_expired_imports()::text, '0');
