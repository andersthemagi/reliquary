-- Importing .env files (milestone 2). Spec: docs/variables.md, "Imports".
--
-- Two ways to bring many values in at once, both ending in the same place:
-- a pending import, whose values a person applies in the web UI.
--
-- - Paste (the web UI): a person pastes a .env; the web app parses it,
--   encrypts every value for every chosen environment and stores them here
--   as a draft (source 'web', 30 minutes, visible to its author only). The
--   preview page names what will be set or overwritten, never a value; the
--   author applies it or discards it. The values never go back to the
--   browser.
-- - Push (the CLI, `reliquary env push`): an agent may run the CLI, so a
--   push never writes a value. It makes a pending import (source 'cli', 24
--   hours) that an owner or editor applies or rejects in the web UI. Only a
--   CLI grant whose person allowed pushing at consent (access_tokens.env_push)
--   may create one; no other agent may, and the CLI can't apply one.
--
-- Enforced here:
-- - Creating: a person in person (a draft), or a live CLI grant with
--   env_push that reaches the vault (a push). Owners in every environment,
--   editors where it isn't owners-only; viewers never. So an editor's push
--   to production is refused when it's made, not left for an owner to find:
--   production values come from owners. MCP tokens, OAuth
--   grants, `act` without a token and reliquary_mcp sessions are refused and
--   the refusal logged. Rate limits: 20 pending per person per vault, 60 a
--   person an hour; at most 200 names and 4 MiB of ciphertext an import.
-- - Applying: a person in person only (no `act`: approval needs the person),
--   within their role in every target environment; a draft only by its
--   author. Applying writes every value through the same path as
--   set_variable (private.put_variable), one access-log row per variable
--   and environment, all in one transaction. Expired, rejected and applied
--   imports can't be applied.
-- - Rejecting: the same people, or the import's author. Values are deleted
--   the moment an import is applied, rejected or found expired.
-- - Values: encrypted by the web app with the same key and additional data
--   as a stored value (vault, environment, name), so applying copies the
--   ciphertext without decrypting it. private.env_import_secrets has no
--   grants and no policies; no function returns its rows.

-- ---------------------------------------------------------------------------
-- The CLI's permission to push

alter table public.access_tokens add column env_push boolean not null default false;
alter table public.access_tokens add constraint access_tokens_env_push_check
  check (not env_push or kind = 'cli');
-- The Tokens page shows it (RLS already limits rows to the person's own).
grant select (env_push) on public.access_tokens to authenticated;

-- As in 20260925090000_variables, plus p_push: whether this sign-in may also
-- send .env files for a person to approve (reliquary env push).
drop function public.create_cli_grant(text, text, text, text, uuid[]);
create function public.create_cli_grant(
  p_client_id text, p_redirect_uri text, p_resource text, p_code_challenge text, p_vaults uuid[],
  p_push boolean default false)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text := 'rlc_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_vaults uuid[];
  v_grant uuid;
begin
  perform private.require_human();
  if p_code_challenge is null or p_code_challenge !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'a PKCE S256 code challenge is required' using errcode = '22023';
  end if;
  if coalesce(p_resource, '') !~ '^https?://[^/?#]+/api/env$'
     or p_client_id is distinct from substring(p_resource from '^(https?://[^/?#]+)/api/env$') || '/cli/oauth-client.json' then
    raise exception 'only Reliquary''s own CLI reads variables' using errcode = '22023';
  end if;
  if coalesce(p_redirect_uri, '') !~ '^http://(127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?/' then
    raise exception 'the CLI must come back to this computer' using errcode = '22023';
  end if;
  if p_vaults is not null then
    select coalesce(array_agg(distinct v), '{}') into v_vaults from unnest(p_vaults) v;
    if cardinality(v_vaults) = 0 then
      raise exception 'choose at least one vault, or all of them' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_vaults) v where v is null or not private.is_member(v)) then
      raise exception 'the CLI can only reach vaults you belong to' using errcode = '22023';
    end if;
  end if;

  insert into public.access_tokens (user_id, name, token_hash, expires_at, all_vaults, vault_ids,
                                    access, kind, client_id, resource, client_name, env_push)
  values (private.uid(), 'Reliquary CLI', null, now() + interval '60 seconds', p_vaults is null,
          coalesce(v_vaults, '{}'), 'read', 'cli', p_client_id, p_resource, 'this computer',
          coalesce(p_push, false))
  returning id into v_grant;

  insert into private.oauth_codes (code_hash, grant_id, client_id, redirect_uri, resource,
                                   code_challenge, expires_at)
  values (encode(extensions.digest(v_code, 'sha256'), 'hex'), v_grant, p_client_id,
          p_redirect_uri, p_resource, p_code_challenge, now() + interval '60 seconds');
  return v_code;
end $$;

-- ---------------------------------------------------------------------------
-- Tables

create table public.env_imports (
  id           uuid primary key default gen_random_uuid(),
  vault_id     uuid not null references public.vaults on delete cascade,
  environments text[] not null check (cardinality(environments) between 1 and 16),
  names        text[] not null check (cardinality(names) between 1 and 200),
  -- Lines of the file that weren't taken: [{"line", "name" (or null), "reason"}]. Never a value.
  refused      jsonb not null default '[]' check (jsonb_typeof(refused) = 'array'),
  source       text not null check (source in ('web', 'cli')),
  created_by   uuid not null,
  agent        text,
  token_id     uuid,
  client_id    text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  status       text not null default 'pending' check (status in ('pending', 'applied', 'rejected', 'expired')),
  decided_by   uuid,
  decided_at   timestamptz,
  check ((status in ('applied', 'rejected')) = (decided_by is not null and decided_at is not null))
);
create index on public.env_imports (vault_id, status, created_at);
create index on public.env_imports (created_by, created_at);
create index on public.env_imports (expires_at) where status = 'pending';

-- The values, sealed exactly as private.variable_secrets holds them.
create table private.env_import_secrets (
  import_id   uuid not null references public.env_imports on delete cascade,
  name        text not null,
  environment text not null,
  key_id      text not null check (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  nonce       bytea not null check (length(nonce) = 12),
  ciphertext  bytea not null check (length(ciphertext) between 16 and 65552),
  primary key (import_id, name, environment)
);

alter table public.env_imports enable row level security;
alter table private.env_import_secrets enable row level security;

-- Owners and editors (and their agents, within scope) see the vault's
-- pushes; a pasted draft only its author, in person.
create policy writer_read on public.env_imports for select to authenticated
  using (coalesce(private.role_in(vault_id) in ('owner', 'editor'), false)
         and (source = 'cli' or (created_by = private.uid() and private.agent() is null)));

revoke all on public.env_imports from public, anon, authenticated;
grant select on public.env_imports to authenticated;
revoke all on private.env_import_secrets from public, anon, authenticated;

-- Pushes and rejections join the access log's actions.
alter table public.env_access_log drop constraint env_access_log_action_check;
alter table public.env_access_log add constraint env_access_log_action_check
  check (action in ('set', 'rotate', 'delete', 'read', 'reveal', 'refused', 'push', 'reject'));

-- ---------------------------------------------------------------------------
-- Writing one value: shared by set_variable and apply_env_import. The caller
-- has checked who may write where. Returns 'set' or 'rotate'.

create function private.put_variable(p_vault uuid, p_name text, p_environment text,
  p_key_id text, p_nonce bytea, p_ciphertext bytea, p_detail jsonb default '{}')
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_var uuid;
  v_version int;
  v_action text;
begin
  perform private.valid_variable_name(p_name);
  if p_key_id is null or p_key_id !~ '^[A-Za-z0-9_-]{1,32}$' or p_nonce is null or length(p_nonce) <> 12
     or p_ciphertext is null or length(p_ciphertext) not between 16 and 65552 then
    raise exception 'that isn''t an encrypted value (or it is over 64 KiB)' using errcode = '22023';
  end if;

  insert into public.variables (vault_id, name, created_by) values (p_vault, p_name, private.uid())
  on conflict (vault_id, name) do nothing;
  select id into v_var from public.variables where vault_id = p_vault and name = p_name;
  insert into public.variable_values (variable_id, vault_id, environment, updated_by)
  values (v_var, p_vault, p_environment, private.uid())
  on conflict (variable_id, environment) do update
    set version = public.variable_values.version + 1, updated_by = excluded.updated_by, updated_at = now()
  returning version into v_version;
  insert into private.variable_secrets (variable_id, environment, key_id, nonce, ciphertext)
  values (v_var, p_environment, p_key_id, p_nonce, p_ciphertext)
  on conflict (variable_id, environment) do update
    set key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext;

  v_action := case when v_version = 1 then 'set' else 'rotate' end;
  perform private.env_log(p_vault, v_action, p_environment, array[p_name], coalesce(p_detail, '{}'));
  perform private.log_event(p_vault, 'variable.' || v_action, null, null, null,
    jsonb_build_object('name', p_name, 'environment', p_environment));
  return v_action;
end $$;

-- Unchanged in behaviour (20260925090000_variables); the writing moved to
-- private.put_variable.
create or replace function public.set_variable(p_vault uuid, p_name text, p_environment text,
  p_key_id text, p_nonce bytea, p_ciphertext bytea)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text;
begin
  perform private.require_human();
  v_role := private.role_in(p_vault);
  if v_role is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  perform private.valid_variable_name(p_name);
  if not exists (select 1 from public.environments where vault_id = p_vault and name = p_environment) then
    raise exception 'no environment named %', coalesce(p_environment, 'null') using errcode = 'P0002';
  end if;
  if v_role not in ('owner', 'editor') then
    raise exception 'viewers can''t set variables' using errcode = '42501';
  end if;
  if not private.env_allows(p_vault, p_environment, v_role) then
    raise exception 'only owners set values in %', p_environment using errcode = '42501';
  end if;
  return private.put_variable(p_vault, p_name, p_environment, p_key_id, p_nonce, p_ciphertext, '{}');
end $$;

-- ---------------------------------------------------------------------------
-- Imports

-- Marks pending imports past their time as expired and drops their values.
-- Runs at the start of every create, apply and reject.
create function private.sweep_env_imports() returns void
language sql volatile security definer set search_path = '' as $$
  with gone as (
    update public.env_imports set status = 'expired'
     where status = 'pending' and expires_at <= now()
    returning id
  )
  delete from private.env_import_secrets s using gone where s.import_id = gone.id
$$;

-- An import's status as its readers should see it: a pending one past its
-- time is expired, whether or not a sweep has marked it yet.
create function private.env_import_state(p_status text, p_expires timestamptz) returns text
language sql stable set search_path = '' as $$
  select case when p_status = 'pending' and p_expires <= now() then 'expired' else p_status end
$$;

-- Creates a pending import. p_items: [{"name", "environment", "key_id",
-- "nonce", "ciphertext"}] (nonce and ciphertext base64), one per name and
-- environment in p_environments. p_refused: the file's lines that weren't
-- taken, [{"line", "name" (a variable-shaped name or null), "reason"}].
-- Returns {"ok": true, "id", "source", "environments", "names", "overwrites",
-- "expires_at"} or {"ok": false, "error": "unauthorized" | "forbidden" |
-- "push_not_allowed" | "not_found" | "rate_limited"}; refusals are logged.
-- Malformed input raises 22023.
create function public.create_env_import(p_vault uuid, p_environments text[], p_items jsonb,
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
  if (select count(*) from public.env_imports
       where created_by = private.uid() and vault_id = p_vault and status = 'pending') >= 20
     or (select count(*) from public.env_imports
          where created_by = private.uid() and created_at > now() - interval '1 hour') >= 60 then
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

-- Applies a pending import: a person in person, within their role in every
-- target environment; a draft only by its author. Every value goes through
-- private.put_variable (logged set or rotate, with the import's id), then
-- the import is marked applied and its values dropped, in one transaction.
-- Returns {"ok": true, "applied": n, "names", "environments"} or
-- {"ok": false, "error": "unauthorized" | "forbidden" | "not_found" |
-- "expired" | "applied" | "rejected"}.
create function public.apply_env_import(p_import uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  i public.env_imports;
  v_role text;
  v_env text;
  v_n int := 0;
  r record;
  refused jsonb := jsonb_build_object('attempt', 'apply', 'import', p_import);
begin
  if private.uid() is null then
    return '{"ok": false, "error": "unauthorized"}';
  end if;
  if private.agent() is not null or session_user::text = 'reliquary_mcp' then
    select * into i from public.env_imports where id = p_import;
    if found then
      perform private.env_log(i.vault_id, 'refused', null, i.names,
        refused || '{"reason": "an agent can''t apply an import; a person does, in the web UI"}');
    end if;
    return '{"ok": false, "error": "forbidden"}';
  end if;
  perform private.sweep_env_imports();
  select * into i from public.env_imports where id = p_import for update;
  if not found then
    return '{"ok": false, "error": "not_found"}';
  end if;
  v_role := private.role_in(i.vault_id);
  if v_role is null or (i.source = 'web' and i.created_by <> private.uid()) then
    return '{"ok": false, "error": "not_found"}';
  end if;
  if i.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', i.status);
  end if;
  if i.expires_at <= now() then
    return '{"ok": false, "error": "expired"}';
  end if;
  foreach v_env in array i.environments loop
    if not private.env_allows(i.vault_id, v_env, v_role) then
      perform private.env_log(i.vault_id, 'refused', v_env, i.names, refused || jsonb_build_object('reason', 'role ' || v_role));
      return '{"ok": false, "error": "forbidden"}';
    end if;
  end loop;

  for r in
    select s.name, s.environment, s.key_id, s.nonce, s.ciphertext
      from private.env_import_secrets s
     where s.import_id = i.id
     order by s.name, private.env_order(s.environment), s.environment
  loop
    perform private.put_variable(i.vault_id, r.name, r.environment, r.key_id, r.nonce, r.ciphertext,
      jsonb_build_object('import', i.id, 'source', i.source, 'by', i.created_by));
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then
    raise exception 'this import has no values left' using errcode = 'P0002';
  end if;
  update public.env_imports set status = 'applied', decided_by = private.uid(), decided_at = now()
   where id = i.id;
  delete from private.env_import_secrets where import_id = i.id;
  return jsonb_build_object('ok', true, 'applied', v_n, 'names', to_jsonb(i.names),
    'environments', to_jsonb(i.environments));
end $$;

-- Rejects (a push) or discards (a draft) a pending import and drops its
-- values: a person in person who could apply it, or its author. Returns
-- {"ok": true} or {"ok": false, "error": ...} as apply_env_import.
create function public.reject_env_import(p_import uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  i public.env_imports;
  v_role text;
  v_env text;
  refused jsonb := jsonb_build_object('attempt', 'reject', 'import', p_import);
begin
  if private.uid() is null then
    return '{"ok": false, "error": "unauthorized"}';
  end if;
  if private.agent() is not null or session_user::text = 'reliquary_mcp' then
    select * into i from public.env_imports where id = p_import;
    if found then
      perform private.env_log(i.vault_id, 'refused', null, i.names,
        refused || '{"reason": "an agent can''t decide on an import"}');
    end if;
    return '{"ok": false, "error": "forbidden"}';
  end if;
  perform private.sweep_env_imports();
  select * into i from public.env_imports where id = p_import for update;
  if not found then
    return '{"ok": false, "error": "not_found"}';
  end if;
  v_role := private.role_in(i.vault_id);
  if v_role is null or (i.source = 'web' and i.created_by <> private.uid()) then
    return '{"ok": false, "error": "not_found"}';
  end if;
  if i.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', i.status);
  end if;
  if i.expires_at <= now() then
    return '{"ok": false, "error": "expired"}';
  end if;
  if i.created_by <> private.uid() then
    foreach v_env in array i.environments loop
      if not private.env_allows(i.vault_id, v_env, v_role) then
        perform private.env_log(i.vault_id, 'refused', v_env, i.names, refused || jsonb_build_object('reason', 'role ' || v_role));
        return '{"ok": false, "error": "forbidden"}';
      end if;
    end loop;
  end if;
  update public.env_imports set status = 'rejected', decided_by = private.uid(), decided_at = now()
   where id = i.id;
  delete from private.env_import_secrets where import_id = i.id;
  if i.source = 'cli' then
    foreach v_env in array i.environments loop
      perform private.env_log(i.vault_id, 'reject', v_env, i.names, jsonb_build_object('import', i.id));
    end loop;
  end if;
  return '{"ok": true}';
end $$;

-- An import's status for its author: in person, or through a live CLI grant
-- of theirs that reaches the vault (`reliquary env push --wait`). Any other
-- agent, and anyone else, gets not_found. No values, so not logged.
-- {"ok": true, "id", "status", "source", "environments", "names",
--  "expires_at", "decided_at"} or {"ok": false, "error"}.
create function public.env_import_status(p_import uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  i public.env_imports;
begin
  if private.uid() is null then
    return '{"ok": false, "error": "unauthorized"}';
  end if;
  select * into i from public.env_imports where id = p_import and created_by = private.uid();
  if not found
     or session_user::text = 'reliquary_mcp'
     or (private.agent() is not null and (private.token_kind() is distinct from 'cli' or private.env_role(i.vault_id) is null)) then
    return '{"ok": false, "error": "not_found"}';
  end if;
  return jsonb_build_object('ok', true, 'id', i.id, 'status', private.env_import_state(i.status, i.expires_at),
    'source', i.source, 'environments', to_jsonb(i.environments), 'names', to_jsonb(i.names),
    'expires_at', i.expires_at, 'decided_at', i.decided_at);
end $$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.put_variable(uuid, text, text, text, bytea, bytea, jsonb),
  private.sweep_env_imports(), private.env_import_state(text, timestamptz)
  from public, anon, authenticated;
grant execute on function private.env_import_state(text, timestamptz) to authenticated;

revoke all on function public.create_cli_grant(text, text, text, text, uuid[], boolean),
  public.create_env_import(uuid, text[], jsonb, jsonb), public.apply_env_import(uuid),
  public.reject_env_import(uuid), public.env_import_status(uuid)
  from public, anon;
grant execute on function public.create_cli_grant(text, text, text, text, uuid[], boolean),
  public.create_env_import(uuid, text[], jsonb, jsonb), public.apply_env_import(uuid),
  public.reject_env_import(uuid), public.env_import_status(uuid)
  to authenticated;
