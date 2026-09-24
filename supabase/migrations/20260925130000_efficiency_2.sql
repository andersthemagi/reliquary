-- Server load, second pass (docs/research/server-load.md, "Second pass").
--
-- 1. The MCP server resolves a token and becomes its person in one
--    statement at the start of the tool call's transaction
--    (private.mcp_begin), so an MCP request checks out one pooled
--    connection, not two. A CLI grant's last_used_at is written at most
--    once a minute, as personal and OAuth tokens' already are.
-- 2. The variables tables' read policies check the set of vaults the caller
--    can read (or write) once per statement, as the core tables' do since
--    20260925110000_hardening.sql, section 7. Same rules.
-- 3. Search no longer parses every file's text on every search: each
--    version keeps its tsvector (a generated column, so erasing the text
--    erases it too). The expression index on the text is dropped: search
--    runs under RLS, where a full-text match isn't leakproof and so could
--    never use it.
-- 4. .env imports: the rate limit can be checked before the web app seals
--    anything (public.env_import_precheck); a pending import past its time
--    no longer counts against it; expired imports are swept by pg_cron
--    where it is available (private.cleanup_expired_imports), and at
--    request time only where it isn't.

-- ---------------------------------------------------------------------------
-- 1. Token resolution inside the transaction

-- Resolves a personal token (p_resource null) or an OAuth access token for
-- p_resource, and makes the rest of the transaction run as its person
-- through it: role authenticated, and the claims asIdentity() used to set
-- (sub, role, act {sub, name, tok}). No row, and nothing set, when the
-- token doesn't resolve. SET LOCAL throughout, so it ends with the
-- transaction. Not a definer function (a definer can't change the role);
-- the resolving is done by the definer functions it calls, which write
-- last_used_at at most once a minute. Only the MCP server's role calls it.
create function private.mcp_begin(p_token_hash text, p_resource text)
returns table (token_id uuid, user_id uuid, name text)
language plpgsql volatile set search_path = '' as $$
declare
  r record;
begin
  if p_resource is null then
    select x.token_id, x.user_id, x.name into r from private.resolve_access_token(p_token_hash) x;
  else
    select x.token_id, x.user_id, x.name into r from private.resolve_oauth_token(p_token_hash, p_resource) x;
  end if;
  if r.token_id is null then
    return;
  end if;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', r.user_id, 'role', 'authenticated',
    'act', jsonb_build_object('sub', r.token_id, 'name', r.name, 'tok', r.token_id))::text, true);
  perform set_config('role', 'authenticated', true);
  token_id := r.token_id;
  user_id := r.user_id;
  name := r.name;
  return next;
end $$;
revoke all on function private.mcp_begin(text, text) from public, anon, authenticated;
grant execute on function private.mcp_begin(text, text) to reliquary_mcp;

-- As in 20260925090000_variables, but last_used_at is written at most once
-- a minute (20260925110000_hardening.sql, section 4, for the other kinds).
create or replace function private.resolve_cli_token(p_token_hash text, p_resource text)
returns table (token_id uuid, user_id uuid, name text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.access_tokens;
begin
  select a.* into g
    from private.oauth_tokens k
    join public.access_tokens a on a.id = k.grant_id
   where k.token_hash = p_token_hash
     and k.kind = 'access'
     and k.expires_at > now()
     and a.kind = 'cli'
     and a.revoked_at is null
     and a.expires_at > now()
     and a.resource = p_resource;
  if not found then
    return;
  end if;
  if g.last_used_at is null or g.last_used_at < now() - interval '1 minute' then
    update public.access_tokens a set last_used_at = now() where a.id = g.id;
  end if;
  token_id := g.id;
  user_id := g.user_id;
  name := g.name;
  return next;
end $$;

-- ---------------------------------------------------------------------------
-- 2. RLS on the variables tables: one membership lookup per statement

-- The vaults where the caller's role (as limited by their token) is owner
-- or editor: the set form of coalesce(role_in(v) in ('owner', 'editor'), false).
create function private.writable_vaults() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.vault_id from public.vault_members m
   where m.user_id = private.uid() and private.role_in(m.vault_id) in ('owner', 'editor')
$$;
revoke all on function private.writable_vaults() from public, anon;
grant execute on function private.writable_vaults() to authenticated;

alter policy member_read on public.environments using (vault_id in (select private.readable_vaults()));
alter policy member_read on public.variables using (vault_id in (select private.readable_vaults()));
alter policy member_read on public.variable_values using (vault_id in (select private.readable_vaults()));
alter policy writer_read on public.env_access_log using (vault_id in (select private.writable_vaults()));
alter policy writer_read on public.env_imports
  using (vault_id in (select private.writable_vaults())
         and (source = 'cli' or (created_by = (select private.uid()) and (select private.agent()) is null)));

-- ---------------------------------------------------------------------------
-- 3. Search

-- Each version's words, computed once when it is written. Erasing a
-- version (body set to null) empties it.
alter table public.file_versions add column body_tsv tsvector
  generated always as (to_tsvector('simple', coalesce(body, ''))) stored;
-- Search runs as the caller, under RLS; `@@` isn't leakproof, so Postgres
-- never used this index there (it filtered the vault's rows and parsed each
-- text instead). Nothing else reads it.
drop index if exists public.file_versions_body_fts;

-- As in 20260924190000_rule_for, with the same results: the stored words
-- instead of parsing every text on every search, and the rule for the
-- returned paths only, in one call (private.rules_for).
create or replace function public.search(p_vault uuid, p_query text, p_limit int default 20)
returns table (path text, policy text, body text, updated_at timestamptz,
               author uuid, agent text, rank real)
language sql stable security invoker set search_path = '' as $$
  with hit as (
    select f.path, v.body, f.updated_at, v.author, v.agent,
           ts_rank(v.body_tsv, websearch_to_tsquery('simple', p_query)) as rank
      from public.files f
      join public.file_versions v on v.id = f.current_version_id
     where f.vault_id = p_vault
       and v.vault_id = p_vault
       and f.deleted_at is null
       and v.body is not null
       and (v.body_tsv @@ websearch_to_tsquery('simple', p_query)
            -- literal substring, no pattern syntax; an empty query matches nothing
            or (length(trim(coalesce(p_query, ''))) > 0
                and strpos(lower(f.path), lower(trim(p_query))) > 0))
     order by 6 desc, f.updated_at desc
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
  )
  select h.path, r.policy, h.body, h.updated_at, h.author, h.agent, h.rank
    from hit h
    join private.rules_for(p_vault, array(select hit.path from hit)) r on r.path = h.path
   order by h.rank desc, h.updated_at desc
$$;

-- ---------------------------------------------------------------------------
-- 4. Imports: rate limit first, cleanup off the request path

-- Whether the caller has reached an import rate limit: 20 pending (and not
-- yet expired) in this vault, or 60 made in the last hour anywhere.
create function private.env_imports_rate_limited(p_vault uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (select count(*) from public.env_imports
           where created_by = private.uid() and vault_id = p_vault
             and status = 'pending' and expires_at > now()) >= 20
      or (select count(*) from public.env_imports
           where created_by = private.uid() and created_at > now() - interval '1 hour') >= 60
$$;

-- Called before the web app seals an import's values (sealing 200 values
-- for several environments is the costly part of a push), so a caller over
-- the limit is refused before that work. p_names: the names about to be
-- sent, for the log. {"ok": true} or {"ok": false, "error": "unauthorized"
-- | "rate_limited"}; a rate-limit refusal is logged exactly as
-- create_env_import logs it. A caller create_env_import would refuse for
-- who they are, or for the vault, gets {"ok": true}: create_env_import
-- refuses and logs them with the precise reason. create_env_import checks
-- the limit again, under its lock.
create function public.env_import_precheck(p_vault uuid, p_names text[] default '{}')
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text;
  v_names text[];
begin
  if private.uid() is null then
    return '{"ok": false, "error": "unauthorized"}';
  end if;
  if session_user::text = 'reliquary_mcp' then
    return '{"ok": true}';
  end if;
  if private.agent() is null then
    v_role := private.role_in(p_vault);
  elsif private.token_kind() = 'cli' then
    v_role := private.env_role(p_vault);
    if not coalesce((
         select t.env_push from public.access_tokens t
          where t.id = private.token_id() and t.user_id = private.uid()
            and t.revoked_at is null and t.expires_at > now()), false) then
      return '{"ok": true}';
    end if;
  else
    return '{"ok": true}';
  end if;
  if v_role is null then
    return '{"ok": true}';
  end if;
  if cardinality(coalesce(p_names, '{}')) > 200 then
    raise exception 'an import holds at most 200 variables' using errcode = '22023';
  end if;
  perform private.valid_variable_name(n) from unnest(coalesce(p_names, '{}')) n;
  if private.env_imports_rate_limited(p_vault) then
    select coalesce(array_agg(distinct n order by n), '{}') into v_names from unnest(coalesce(p_names, '{}')) n;
    perform private.env_log(p_vault, 'refused', null, v_names,
      '{"attempt": "push", "reason": "too many imports; try again later"}');
    return '{"ok": false, "error": "rate_limited"}';
  end if;
  return '{"ok": true}';
end $$;

-- Marks every pending import past its time as expired and deletes the
-- values of every import that isn't pending. Returns how many it expired.
-- Run by pg_cron every five minutes where pg_cron is available; otherwise
-- at the start of every create, apply and reject (private.sweep_env_imports).
-- Correctness never waits for it: an import past expires_at reads as
-- expired everywhere and can't be applied, and doesn't count against the
-- rate limit.
create function private.cleanup_expired_imports() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  n int;
begin
  update public.env_imports set status = 'expired'
   where status = 'pending' and expires_at <= now();
  get diagnostics n = row_count;
  delete from private.env_import_secrets s
   using public.env_imports i
   where i.id = s.import_id and i.status <> 'pending';
  return n;
end $$;

-- Whether pg_cron runs the cleanup here (the job below exists and is active).
create function private.imports_swept_by_cron() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v boolean;
begin
  if to_regclass('cron.job') is null then
    return false;
  end if;
  execute 'select exists (select 1 from cron.job where jobname = $1 and active)'
    into v using 'reliquary-expired-imports';
  return coalesce(v, false);
exception when others then
  return false;
end $$;

-- As before (20260925100000_env_imports), but only where pg_cron doesn't
-- run the cleanup: then it's the fallback, at request time.
create or replace function private.sweep_env_imports() returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not private.imports_swept_by_cron() then
    perform private.cleanup_expired_imports();
  end if;
end $$;

revoke all on function private.env_imports_rate_limited(uuid), private.cleanup_expired_imports(),
  private.imports_swept_by_cron() from public, anon, authenticated;
revoke all on function public.env_import_precheck(uuid, text[]) from public, anon;
grant execute on function public.env_import_precheck(uuid, text[]) to authenticated;

-- pg_cron, where the platform has it (Supabase does; plain Postgres, as in
-- the tests, doesn't). If it can't be created, nothing else changes: the
-- sweep stays at request time.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      perform cron.schedule('reliquary-expired-imports', '*/5 * * * *',
        'select private.cleanup_expired_imports()');
    exception when others then
      raise notice 'pg_cron is not usable here (%); expired imports are swept at request time', sqlerrm;
    end;
  end if;
end $$;

-- As in 20260925100000_env_imports, with the rate limit from
-- private.env_imports_rate_limited (an expired import no longer counts).
create or replace function public.create_env_import(p_vault uuid, p_environments text[], p_items jsonb,
  p_refused jsonb default '[]')
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_source text;
  v_role text;
  v_envs text[];
  v_names text[];
  v_count int;
  v_bytes bigint;
  v_id uuid;
  v_expires timestamptz;
  v_refused jsonb;
  v_env text;
  refused jsonb := jsonb_build_object('attempt', 'push');
begin
  if private.uid() is null then
    return '{"ok": false, "error": "unauthorized"}';
  end if;
  if session_user::text = 'reliquary_mcp' then
    perform private.env_log(p_vault, 'refused', null, '{}', refused || '{"reason": "an agent can''t send values"}');
    return '{"ok": false, "error": "forbidden"}';
  end if;
  if private.agent() is null then
    v_source := 'web';
    v_role := private.role_in(p_vault);
  elsif private.token_kind() = 'cli' then
    v_source := 'cli';
    v_role := private.env_role(p_vault);
  else
    perform private.env_log(p_vault, 'refused', null, '{}', refused || '{"reason": "an agent can''t send values"}');
    return '{"ok": false, "error": "forbidden"}';
  end if;
  if v_role is null then
    perform private.env_log(p_vault, 'refused', null, '{}',
      refused || jsonb_build_object('reason', case v_source when 'cli' then 'not reachable with this sign-in' else 'not a member' end));
    return '{"ok": false, "error": "not_found"}';
  end if;
  if v_source = 'cli' and not coalesce((
       select t.env_push from public.access_tokens t
        where t.id = private.token_id() and t.user_id = private.uid()
          and t.revoked_at is null and t.expires_at > now()), false) then
    perform private.env_log(p_vault, 'refused', null, '{}',
      refused || '{"reason": "this sign-in wasn''t allowed to push"}');
    return '{"ok": false, "error": "push_not_allowed"}';
  end if;

  select coalesce(array_agg(e order by private.env_order(e), e), '{}') into v_envs
    from (select distinct e from unnest(p_environments) e) d;
  if cardinality(v_envs) = 0 or array_position(v_envs, null) is not null then
    raise exception 'choose at least one environment' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_envs) e
              where not exists (select 1 from public.environments x where x.vault_id = p_vault and x.name = e)) then
    return '{"ok": false, "error": "not_found"}';
  end if;
  foreach v_env in array v_envs loop
    if not private.env_allows(p_vault, v_env, v_role) then
      perform private.env_log(p_vault, 'refused', v_env, '{}', refused || jsonb_build_object('reason', 'role ' || v_role));
      return '{"ok": false, "error": "forbidden"}';
    end if;
  end loop;

  -- The items: every name in every environment, once, each a sealed value.
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'nothing to import' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) x where jsonb_typeof(x) <> 'object') then
    raise exception 'each item is an object' using errcode = '22023';
  end if;
  perform private.valid_variable_name(x.name)
     from jsonb_to_recordset(p_items) as x(name text);
  if exists (select 1 from jsonb_to_recordset(p_items) as x(environment text)
              where x.environment is null or not x.environment = any(v_envs)) then
    raise exception 'every item is for one of the chosen environments' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct x.name order by x.name), '{}'), count(*)
    into v_names, v_count
    from jsonb_to_recordset(p_items) as x(name text);
  if cardinality(v_names) > 200 then
    raise exception 'an import holds at most 200 variables' using errcode = '22023';
  end if;
  if v_count <> cardinality(v_names) * cardinality(v_envs)
     or (select count(distinct (x.name, x.environment)) from jsonb_to_recordset(p_items) as x(name text, environment text)) <> v_count then
    raise exception 'every variable needs one value in each chosen environment' using errcode = '22023';
  end if;
  select coalesce(sum(length(decode(x.ciphertext, 'base64'))), 0) into v_bytes
    from jsonb_to_recordset(p_items) as x(ciphertext text);
  if v_bytes > 4 * 1024 * 1024 then
    raise exception 'an import holds at most 4 MiB' using errcode = '22023';
  end if;

  -- What wasn't taken: line numbers, names that look like names, reasons.
  if p_refused is null then
    v_refused := '[]';
  elsif jsonb_typeof(p_refused) <> 'array' or jsonb_array_length(p_refused) > 1000 then
    raise exception 'refused lines are a list of at most 1000' using errcode = '22023';
  else
    if exists (select 1 from jsonb_array_elements(p_refused) r
                where jsonb_typeof(r) <> 'object'
                   or jsonb_typeof(r -> 'line') is distinct from 'number'
                   or jsonb_typeof(r -> 'reason') is distinct from 'string'
                   or length(r ->> 'reason') > 200
                   or (r ? 'name' and jsonb_typeof(r -> 'name') <> 'null'
                       and coalesce(r ->> 'name', '') !~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$')) then
      raise exception 'a refused line is {line, name, reason}, and its name looks like a name' using errcode = '22023';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('line', (r ->> 'line')::int, 'name', r -> 'name', 'reason', r ->> 'reason')
                              order by (r ->> 'line')::int), '[]')
      into v_refused
      from jsonb_array_elements(p_refused) r;
  end if;

  -- Rate limits, per person, taken in turn.
  perform pg_advisory_xact_lock(hashtextextended('reliquary.env_imports:' || private.uid()::text, 0));
  perform private.sweep_env_imports();
  if private.env_imports_rate_limited(p_vault) then
    perform private.env_log(p_vault, 'refused', null, v_names, refused || '{"reason": "too many imports; try again later"}');
    return '{"ok": false, "error": "rate_limited"}';
  end if;

  v_expires := now() + case v_source when 'cli' then interval '24 hours' else interval '30 minutes' end;
  insert into public.env_imports (vault_id, environments, names, refused, source, created_by, agent,
                                  token_id, client_id, expires_at)
  values (p_vault, v_envs, v_names, v_refused, v_source, private.uid(), private.agent(), private.token_id(),
          (select t.client_id from public.access_tokens t where t.id = private.token_id()), v_expires)
  returning id into v_id;
  insert into private.env_import_secrets (import_id, name, environment, key_id, nonce, ciphertext)
  select v_id, x.name, x.environment, x.key_id, decode(x.nonce, 'base64'), decode(x.ciphertext, 'base64')
    from jsonb_to_recordset(p_items) as x(name text, environment text, key_id text, nonce text, ciphertext text);

  if v_source = 'cli' then
    foreach v_env in array v_envs loop
      perform private.env_log(p_vault, 'push', v_env, v_names, jsonb_build_object('import', v_id));
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id, 'source', v_source, 'environments', to_jsonb(v_envs),
    'names', to_jsonb(v_names),
    'overwrites', to_jsonb(array(
      select distinct v.name from public.variables v
        join public.variable_values vv on vv.variable_id = v.id
       where v.vault_id = p_vault and v.name = any(v_names) and vv.environment = any(v_envs)
       order by v.name)),
    'expires_at', v_expires);
end $$;
