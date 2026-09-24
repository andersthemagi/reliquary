-- Environment variables (milestone 2). Spec: docs/variables.md. Design:
-- docs/design.md, "Environment variables".
--
-- Encryption happens in the web app (AES-256-GCM, key VARIABLES_KEY, the
-- vault id + environment + name as additional data). The database stores a
-- key id, a nonce and the ciphertext, and never sees the key or a value.
--
-- Who may do what, enforced here:
-- - Members see names, the environments each has a value in, and who set it
--   when (RLS on public.variables and public.variable_values). So do their
--   agents, within their token's scope. That's all an agent ever gets.
-- - Setting, rotating and deleting a value: people in person only (no `act`
--   claim; a value typed to an agent has already reached a model). Owners in
--   every environment; editors where the environment isn't owners-only
--   (production is); viewers never.
-- - Ciphertext lives in private.variable_secrets (no grants, RLS with no
--   policies). Only two functions return it, both logging in the same
--   transaction:
--     public.reveal_variable  one value, a person in person (the web UI);
--     public.read_variables   one environment, through a live CLI grant.
--   Every other caller, and every agent (an MCP token or OAuth grant, or an
--   `act` without a token), is refused and the refusal is logged. Both also
--   refuse when the session logged in as reliquary_mcp, whatever the claims.
-- - A CLI grant is a third kind of access_tokens row ('cli'), made at
--   consent for our own CLI client and bound to the env API resource
--   (`<issuer>/api/env`). It reads values within its person's role in the
--   vaults chosen at consent, and nothing else: role_in() gives it no role
--   (no files, proposals or feed) and require_person() refuses it (no
--   writes of any kind).
-- - env_access_log is append-only (trigger): set, rotate, delete, read,
--   reveal and refused, with names, environment, person, agent and token,
--   never a value. Owners and editors (and their agents, within scope) read
--   their vault's log.

-- ---------------------------------------------------------------------------
-- CLI grants: access_tokens rows of kind 'cli'

alter table public.access_tokens drop constraint access_tokens_kind_check;
alter table public.access_tokens add constraint access_tokens_kind_check
  check (kind in ('pat', 'oauth', 'cli'));
alter table public.access_tokens drop constraint access_tokens_oauth_shape_check;
-- An MCP grant can never be for the env API, and a CLI grant is only ever
-- read access, for the env API, from our own client at the same origin.
alter table public.access_tokens add constraint access_tokens_oauth_shape_check check (
  case kind
    when 'pat' then token_hash is not null and client_id is null and resource is null
    when 'oauth' then token_hash is null and client_id is not null and resource is not null
                      and resource !~ '/api/env$'
    when 'cli' then token_hash is null and access = 'read'
                    and resource ~ '^https?://[^/?#]+/api/env$'
                    and client_id = substring(resource from '^(https?://[^/?#]+)/api/env$') || '/cli/oauth-client.json'
  end);

-- The kind of the caller's own token, or NULL (in person, or no token).
create function private.token_kind() returns text
language sql stable security definer set search_path = '' as $$
  select t.kind from public.access_tokens t
   where t.id = private.token_id() and t.user_id = private.uid()
$$;

-- A CLI grant does nothing but read variables: every write path starts here.
create or replace function private.require_person() returns void
language plpgsql stable set search_path = '' as $$
begin
  if private.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if private.token_kind() = 'cli' then
    raise exception 'a CLI sign-in only reads environment variables' using errcode = '42501';
  end if;
end $$;

-- As before (20260924160000_token_scope), plus: a CLI grant has no role in
-- any vault, so RLS shows it nothing and no membership check passes.
create or replace function private.role_in(p_vault uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when private.token_id() is null then m.role
    when t.id is null then null
    when t.kind = 'cli' then null
    when coalesce(t.all_vaults or p_vault = any(t.vault_ids), false) is not true then null
    when t.access = 'write' then m.role
    when t.access = 'read' then 'viewer'
    else null
  end
  from public.vault_members m
  left join public.access_tokens t
    on t.id = private.token_id()
   and t.user_id = m.user_id
   and t.revoked_at is null
   and t.expires_at > now()
  where m.vault_id = p_vault and m.user_id = private.uid()
$$;

-- Consent for the CLI. Like create_oauth_grant, with the access fixed to
-- reading and the redirect on loopback (the CLI listens on this computer).
-- Returns the one-time code (`rlc_`).
create function public.create_cli_grant(
  p_client_id text, p_redirect_uri text, p_resource text, p_code_challenge text, p_vaults uuid[])
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
                                    access, kind, client_id, resource, client_name)
  values (private.uid(), 'Reliquary CLI', null, now() + interval '60 seconds', p_vaults is null,
          coalesce(v_vaults, '{}'), 'read', 'cli', p_client_id, p_resource, 'this computer')
  returning id into v_grant;

  insert into private.oauth_codes (code_hash, grant_id, client_id, redirect_uri, resource,
                                   code_challenge, expires_at)
  values (encode(extensions.digest(v_code, 'sha256'), 'hex'), v_grant, p_client_id,
          p_redirect_uri, p_resource, p_code_challenge, now() + interval '60 seconds');
  return v_code;
end $$;

-- The token endpoint's functions (20260924220000_oauth), unchanged except
-- that a CLI grant redeems, refreshes and revokes like an MCP one. Its
-- resource is checked the same way, so neither kind's tokens cross over.
create or replace function private.oauth_redeem_code(
  p_code_hash text, p_client_id text, p_redirect_uri text, p_resource text,
  p_verifier text, p_access_hash text, p_refresh_hash text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  c private.oauth_codes;
  v_grant public.access_tokens;
begin
  delete from private.oauth_codes where expires_at < now() - interval '1 day';
  if coalesce(p_access_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_refresh_hash, '') !~ '^[0-9a-f]{64}$' then
    return 'invalid_request';
  end if;
  select * into c from private.oauth_codes where code_hash = p_code_hash for update;
  if not found then
    return 'invalid_grant';
  end if;
  if c.used_at is not null then
    update public.access_tokens set revoked_at = coalesce(revoked_at, now()) where id = c.grant_id;
    return 'invalid_grant';
  end if;
  update private.oauth_codes set used_at = now() where code_hash = p_code_hash;
  if c.expires_at <= now()
     or c.client_id is distinct from p_client_id
     or c.redirect_uri is distinct from p_redirect_uri
     or c.resource is distinct from p_resource
     or coalesce(p_verifier, '') !~ '^[A-Za-z0-9._~-]{43,128}$'
     or c.code_challenge is distinct from
        translate(rtrim(encode(extensions.digest(p_verifier, 'sha256'), 'base64'), '='), '+/', '-_') then
    return 'invalid_grant';
  end if;
  select * into v_grant from public.access_tokens
   where id = c.grant_id and kind in ('oauth', 'cli') and revoked_at is null
   for update;
  if not found then
    return 'invalid_grant';
  end if;
  update public.access_tokens set expires_at = private.oauth_grant_expiry(created_at)
   where id = v_grant.id;
  insert into private.oauth_tokens (token_hash, grant_id, kind, expires_at) values
    (p_access_hash, v_grant.id, 'access', now() + interval '1 hour'),
    (p_refresh_hash, v_grant.id, 'refresh', now() + interval '30 days');
  return 'ok';
end $$;

create or replace function private.oauth_refresh(
  p_refresh_hash text, p_client_id text, p_resource text,
  p_access_hash text, p_new_refresh_hash text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  r private.oauth_tokens;
  v_grant public.access_tokens;
begin
  delete from private.oauth_tokens where expires_at < now() - interval '1 day';
  if coalesce(p_access_hash, '') !~ '^[0-9a-f]{64}$' or coalesce(p_new_refresh_hash, '') !~ '^[0-9a-f]{64}$' then
    return 'invalid_request';
  end if;
  select * into r from private.oauth_tokens
   where token_hash = p_refresh_hash and kind = 'refresh' for update;
  if not found then
    return 'invalid_grant';
  end if;
  select * into v_grant from public.access_tokens where id = r.grant_id for update;
  if r.used_at is not null then
    update public.access_tokens set revoked_at = coalesce(revoked_at, now()) where id = r.grant_id;
    return 'invalid_grant';
  end if;
  if v_grant.kind is null or v_grant.kind not in ('oauth', 'cli') or v_grant.revoked_at is not null
     or v_grant.expires_at <= now() or r.expires_at <= now()
     or v_grant.client_id is distinct from p_client_id
     or v_grant.resource is distinct from p_resource then
    return 'invalid_grant';
  end if;
  update private.oauth_tokens set used_at = now() where token_hash = p_refresh_hash;
  update public.access_tokens set expires_at = private.oauth_grant_expiry(created_at)
   where id = v_grant.id;
  insert into private.oauth_tokens (token_hash, grant_id, kind, expires_at) values
    (p_access_hash, v_grant.id, 'access', now() + interval '1 hour'),
    (p_new_refresh_hash, v_grant.id, 'refresh', least(now() + interval '30 days', v_grant.created_at + interval '366 days'));
  return 'ok';
end $$;

create or replace function private.oauth_revoke(p_token_hash text, p_client_id text)
returns void
language sql volatile security definer set search_path = '' as $$
  update public.access_tokens g set revoked_at = coalesce(g.revoked_at, now())
    from private.oauth_tokens t
   where t.token_hash = p_token_hash and t.grant_id = g.id
     and g.kind in ('oauth', 'cli') and g.client_id = p_client_id
$$;

-- The env API (reliquary_web only): a CLI access token, for this resource,
-- of a live CLI grant. private.resolve_oauth_token (the MCP server's) still
-- resolves only kind 'oauth', so a CLI token is useless at /mcp.
create function private.resolve_cli_token(p_token_hash text, p_resource text)
returns table (token_id uuid, user_id uuid, name text)
language plpgsql volatile security definer set search_path = '' as $$
begin
  return query
  with used as (
    update public.access_tokens g set last_used_at = now()
      from private.oauth_tokens t
     where t.token_hash = p_token_hash
       and t.kind = 'access'
       and t.expires_at > now()
       and t.grant_id = g.id
       and g.kind = 'cli'
       and g.revoked_at is null
       and g.expires_at > now()
       and g.resource = p_resource
    returning g.id, g.user_id, g.name
  )
  select * from used;
end $$;

-- ---------------------------------------------------------------------------
-- Tables

create table public.environments (
  vault_id    uuid not null references public.vaults on delete cascade,
  name        text not null check (name ~ '^[a-z][a-z0-9_-]{0,31}$'),
  owners_only boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (vault_id, name)
);

create function private.default_environments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.environments (vault_id, name, owners_only) values
    (new.id, 'development', false), (new.id, 'preview', false), (new.id, 'production', true);
  return new;
end $$;
create trigger vaults_default_environments after insert on public.vaults
  for each row execute function private.default_environments();
insert into public.environments (vault_id, name, owners_only)
select v.id, e.name, e.owners_only from public.vaults v
cross join (values ('development', false), ('preview', false), ('production', true)) e(name, owners_only)
on conflict do nothing;

create table public.variables (
  id         uuid primary key default gen_random_uuid(),
  vault_id   uuid not null references public.vaults on delete cascade,
  name       text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (vault_id, name)
);

-- One row per environment a variable has a value in: metadata only.
create table public.variable_values (
  variable_id uuid not null references public.variables on delete cascade,
  vault_id    uuid not null,
  environment text not null,
  version     int  not null default 1,
  updated_by  uuid not null,
  updated_at  timestamptz not null default now(),
  primary key (variable_id, environment),
  foreign key (vault_id, environment) references public.environments (vault_id, name) on delete cascade
);
create index on public.variable_values (vault_id, environment);

-- The ciphertext. No grants to anyone; RLS on with no policies.
create table private.variable_secrets (
  variable_id uuid not null,
  environment text not null,
  key_id      text not null check (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  nonce       bytea not null check (length(nonce) = 12),
  ciphertext  bytea not null check (length(ciphertext) between 16 and 65552),
  primary key (variable_id, environment),
  foreign key (variable_id, environment) references public.variable_values on delete cascade
);

create table public.env_access_log (
  seq         bigint generated always as identity primary key,
  vault_id    uuid not null references public.vaults on delete cascade,
  at          timestamptz not null default now(),
  actor       uuid,
  agent       text,
  token_id    uuid,
  client_id   text,
  action      text not null check (action in ('set', 'rotate', 'delete', 'read', 'reveal', 'refused')),
  environment text,
  names       text[] not null default '{}',
  detail      jsonb not null default '{}'
);
create index on public.env_access_log (vault_id, seq);

create trigger env_access_log_append_only before update or delete on public.env_access_log
  for each row execute function private.forbid_change();
create trigger env_access_log_no_truncate before truncate on public.env_access_log
  for each statement execute function private.forbid_change();

alter table public.environments     enable row level security;
alter table public.variables        enable row level security;
alter table public.variable_values  enable row level security;
alter table public.env_access_log   enable row level security;
alter table private.variable_secrets enable row level security;

create policy member_read on public.environments for select to authenticated
  using (private.is_member(vault_id));
create policy member_read on public.variables for select to authenticated
  using (private.is_member(vault_id));
create policy member_read on public.variable_values for select to authenticated
  using (private.is_member(vault_id));
create policy writer_read on public.env_access_log for select to authenticated
  using (coalesce(private.role_in(vault_id) in ('owner', 'editor'), false));

revoke all on public.environments, public.variables, public.variable_values, public.env_access_log
  from public, anon, authenticated;
grant select on public.environments, public.variables, public.variable_values, public.env_access_log
  to authenticated;
revoke all on private.variable_secrets from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers

-- Letters, digits and underscores, like a shell variable. Names that change
-- how a program starts or finds its code are refused: `reliquary run` puts
-- every variable into a process, so an editor could otherwise run code on
-- whoever runs it (LD_PRELOAD, NODE_OPTIONS, PATH, ...).
create function private.valid_variable_name(p_name text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_name is null or p_name !~ '^[A-Za-z_][A-Za-z0-9_]{0,127}$' then
    raise exception 'a variable name is letters, digits and underscores, not starting with a digit, up to 128 characters'
      using errcode = '22023';
  end if;
  if upper(p_name) ~ '^(LD_|DYLD_|BASH_FUNC_|GIT_CONFIG_)' or upper(p_name) in (
       'PATH', 'HOME', 'SHELL', 'USER', 'IFS', 'ENV', 'BASH_ENV', 'PS4', 'PROMPT_COMMAND', 'SHELLOPTS',
       'BASHOPTS', 'CDPATH', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME',
       'PERL5OPT', 'PERL5LIB', 'PERLLIB', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS',
       'JDK_JAVA_OPTIONS', 'CLASSPATH', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'GIT_ASKPASS',
       'SSH_ASKPASS', 'EDITOR', 'VISUAL', 'PAGER', 'TMPDIR') then
    raise exception '% changes how programs start, so it can''t be a shared variable', p_name
      using errcode = '22023';
  end if;
  return p_name;
end $$;

-- May this role use values in this environment? Owners everywhere; editors
-- where it isn't owners-only; nobody else. Never NULL.
create function private.env_allows(p_vault uuid, p_environment text, p_role text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case p_role when 'owner' then true when 'editor' then not e.owners_only else false end
      from public.environments e
     where e.vault_id = p_vault and e.name = p_environment), false)
$$;

-- The caller's role for reading values: a person in person (no `act`), or
-- a live CLI grant of theirs that reaches the vault. Every other agent gets
-- nothing, and so does any session that logged in as the MCP server's role.
create function private.env_role(p_vault uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when session_user::text = 'reliquary_mcp' then null
    when private.agent() is null then m.role
    when private.token_id() is null then null
    when t.id is null then null
    when t.kind <> 'cli' then null
    when coalesce(t.all_vaults or p_vault = any(t.vault_ids), false) is not true then null
    else m.role
  end
  from public.vault_members m
  left join public.access_tokens t
    on t.id = private.token_id()
   and t.user_id = m.user_id
   and t.revoked_at is null
   and t.expires_at > now()
  where m.vault_id = p_vault and m.user_id = private.uid()
$$;

-- Appends to env_access_log as the caller. Never takes a value.
create function private.env_log(p_vault uuid, p_action text, p_environment text,
  p_names text[], p_detail jsonb default '{}')
returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.env_access_log (vault_id, actor, agent, token_id, client_id, action,
                                     environment, names, detail)
  select p_vault, private.uid(), private.agent(), private.token_id(),
         (select t.client_id from public.access_tokens t where t.id = private.token_id()),
         p_action, p_environment, coalesce(p_names, '{}'), coalesce(p_detail, '{}')
   where exists (select 1 from public.vaults v where v.id = p_vault)
$$;

create function private.env_order(p_name text) returns int
language sql immutable set search_path = '' as $$
  select case p_name when 'development' then 0 when 'preview' then 1 when 'production' then 2 else 3 end
$$;

-- ---------------------------------------------------------------------------
-- Writing: people in person

-- Sets a value, or rotates it if the variable already has one in this
-- environment. The web app has encrypted it. Returns 'set' or 'rotate'.
create function public.set_variable(p_vault uuid, p_name text, p_environment text,
  p_key_id text, p_nonce bytea, p_ciphertext bytea)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text;
  v_var uuid;
  v_version int;
  v_action text;
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
  perform private.env_log(p_vault, v_action, p_environment, array[p_name]);
  perform private.log_event(p_vault, 'variable.' || v_action, null, null, null,
    jsonb_build_object('name', p_name, 'environment', p_environment));
  return v_action;
end $$;

-- Deletes a variable's value in one environment; the variable goes when its
-- last value does.
create function public.delete_variable(p_vault uuid, p_name text, p_environment text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text;
  v_var uuid;
begin
  perform private.require_human();
  v_role := private.role_in(p_vault);
  if v_role is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if v_role not in ('owner', 'editor') then
    raise exception 'viewers can''t delete variables' using errcode = '42501';
  end if;
  if not private.env_allows(p_vault, p_environment, v_role) then
    raise exception 'only owners delete values in %', coalesce(p_environment, 'null') using errcode = '42501';
  end if;
  select id into v_var from public.variables where vault_id = p_vault and name = p_name;
  delete from public.variable_values where variable_id = v_var and environment = p_environment;
  if not found then
    raise exception '% has no value in %', coalesce(p_name, 'null'), p_environment using errcode = 'P0002';
  end if;
  delete from public.variables v where v.id = v_var
     and not exists (select 1 from public.variable_values vv where vv.variable_id = v_var);
  perform private.env_log(p_vault, 'delete', p_environment, array[p_name]);
  perform private.log_event(p_vault, 'variable.delete', null, null, null,
    jsonb_build_object('name', p_name, 'environment', p_environment));
end $$;

-- ---------------------------------------------------------------------------
-- Reading values. Both return jsonb and never raise for a refusal, so the
-- refusal's log row commits:
--   {"ok": false, "error": "unauthorized" | "forbidden" | "not_found"}

-- One value, for a person in the web UI.
--   {"ok": true, "name", "environment", "key_id", "nonce", "ciphertext",
--    "updated_at", "updated_by"}   (nonce and ciphertext in base64)
create function public.reveal_variable(p_vault uuid, p_name text, p_environment text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text;
  r record;
  refused jsonb := jsonb_build_object('attempt', 'reveal');
begin
  if private.uid() is null then
    return '{"ok": false, "error": "unauthorized"}';
  end if;
  if private.agent() is not null or session_user::text = 'reliquary_mcp' then
    perform private.env_log(p_vault, 'refused', p_environment, array[p_name],
      refused || '{"reason": "an agent can''t reveal a value"}');
    return '{"ok": false, "error": "forbidden"}';
  end if;
  v_role := private.env_role(p_vault);
  if v_role is null then
    perform private.env_log(p_vault, 'refused', p_environment, array[p_name],
      refused || '{"reason": "not a member"}');
    return '{"ok": false, "error": "not_found"}';
  end if;
  if not private.env_allows(p_vault, p_environment, v_role) then
    perform private.env_log(p_vault, 'refused', p_environment, array[p_name],
      refused || jsonb_build_object('reason', 'role ' || v_role));
    return '{"ok": false, "error": "forbidden"}';
  end if;
  select v.name, vv.environment, vv.updated_at, vv.updated_by, s.key_id, s.nonce, s.ciphertext into r
    from public.variables v
    join public.variable_values vv on vv.variable_id = v.id
    join private.variable_secrets s on s.variable_id = vv.variable_id and s.environment = vv.environment
   where v.vault_id = p_vault and v.name = p_name and vv.environment = p_environment;
  if not found then
    return '{"ok": false, "error": "not_found"}';
  end if;
  perform private.env_log(p_vault, 'reveal', p_environment, array[p_name]);
  return jsonb_build_object('ok', true, 'name', r.name, 'environment', r.environment,
    'key_id', r.key_id, 'nonce', encode(r.nonce, 'base64'), 'ciphertext', encode(r.ciphertext, 'base64'),
    'updated_at', r.updated_at, 'updated_by', r.updated_by);
end $$;

-- Every value in one environment, for the CLI (a live CLI grant only).
--   {"ok": true, "environment", "variables": [{"name", "key_id", "nonce",
--    "ciphertext", "updated_at"}, ...]}   (ordered by name)
create function public.read_variables(p_vault uuid, p_environment text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_role text;
  v_rows jsonb;
  v_names text[];
  refused jsonb := jsonb_build_object('attempt', 'read');
begin
  if private.uid() is null then
    return '{"ok": false, "error": "unauthorized"}';
  end if;
  if private.agent() is null then
    perform private.env_log(p_vault, 'refused', p_environment, '{}',
      refused || '{"reason": "in person, values are revealed one at a time"}');
    return '{"ok": false, "error": "forbidden"}';
  end if;
  if session_user::text = 'reliquary_mcp' or private.token_kind() is distinct from 'cli' then
    perform private.env_log(p_vault, 'refused', p_environment, '{}',
      refused || '{"reason": "an agent can''t read values"}');
    return '{"ok": false, "error": "forbidden"}';
  end if;
  v_role := private.env_role(p_vault);
  if v_role is null then
    perform private.env_log(p_vault, 'refused', p_environment, '{}',
      refused || '{"reason": "not reachable with this sign-in"}');
    return '{"ok": false, "error": "not_found"}';
  end if;
  if not exists (select 1 from public.environments where vault_id = p_vault and name = p_environment) then
    return '{"ok": false, "error": "not_found"}';
  end if;
  if not private.env_allows(p_vault, p_environment, v_role) then
    perform private.env_log(p_vault, 'refused', p_environment, '{}',
      refused || jsonb_build_object('reason', 'role ' || v_role));
    return '{"ok": false, "error": "forbidden"}';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('name', v.name, 'key_id', s.key_id,
           'nonce', encode(s.nonce, 'base64'), 'ciphertext', encode(s.ciphertext, 'base64'),
           'updated_at', vv.updated_at) order by v.name), '[]'),
         coalesce(array_agg(v.name order by v.name), '{}')
    into v_rows, v_names
    from public.variables v
    join public.variable_values vv on vv.variable_id = v.id
    join private.variable_secrets s on s.variable_id = vv.variable_id and s.environment = vv.environment
   where v.vault_id = p_vault and vv.environment = p_environment;
  perform private.env_log(p_vault, 'read', p_environment, v_names);
  return jsonb_build_object('ok', true, 'environment', p_environment, 'variables', v_rows);
end $$;

-- The vaults whose values the caller may read, with the environments they
-- may read in each (empty for a viewer). For the CLI; a person gets theirs;
-- any other agent gets none.
create function public.env_vaults()
returns table (vault_id uuid, vault_name text, role text, environments text[])
language sql stable security definer set search_path = '' as $$
  select v.id, v.name, r.role,
         array(select e.name from public.environments e
                where e.vault_id = v.id and private.env_allows(v.id, e.name, r.role)
                order by private.env_order(e.name), e.name)
    from public.vaults v
    join public.vault_members m on m.vault_id = v.id and m.user_id = private.uid()
    cross join lateral (select private.env_role(v.id) as role) r
   where r.role is not null
   order by v.name, v.id
$$;

-- ---------------------------------------------------------------------------
-- Grants. New functions in public are granted to everyone by default
-- (Supabase), and in private to PUBLIC: take it back, then grant what's meant.

revoke all on function private.token_kind(), private.valid_variable_name(text),
  private.env_allows(uuid, text, text), private.env_role(uuid),
  private.env_log(uuid, text, text, text[], jsonb), private.env_order(text),
  private.default_environments(), private.resolve_cli_token(text, text)
  from public, anon, authenticated;
grant execute on function private.token_kind() to authenticated;
grant execute on function private.resolve_cli_token(text, text) to reliquary_web;

revoke all on function public.create_cli_grant(text, text, text, text, uuid[]),
  public.set_variable(uuid, text, text, text, bytea, bytea), public.delete_variable(uuid, text, text),
  public.reveal_variable(uuid, text, text), public.read_variables(uuid, text), public.env_vaults()
  from public, anon;
grant execute on function public.create_cli_grant(text, text, text, text, uuid[]),
  public.set_variable(uuid, text, text, text, bytea, bytea), public.delete_variable(uuid, text, text),
  public.reveal_variable(uuid, text, text), public.read_variables(uuid, text), public.env_vaults()
  to authenticated;
