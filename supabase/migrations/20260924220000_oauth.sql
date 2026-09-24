-- OAuth 2.1 for the remote MCP endpoint (docs/research/hosting.md, section 4
-- and chunk C). The web app is the authorization server; the MCP app is the
-- resource server.
--
-- An OAuth grant IS an access_tokens row (kind 'oauth'). It has no bearer
-- secret of its own: the client holds short-lived access tokens (`rlo_`, 1 h)
-- and a rotating refresh token (`rlr_`, 30 days), stored here as SHA-256 and
-- tied to the grant. The MCP server resolves an access token to its grant and
-- then acts exactly as for a personal token: `act.tok` = the grant's id, so
-- private.role_in() applies the vaults and access chosen at consent, the
-- delegation ceiling applies because `act` is present, and revoking the row
-- on the Tokens page cuts the client off on its next request.
--
-- Who may do what:
-- - Consent (creating a grant and its one-time code) is a person, never an
--   agent: public.create_oauth_grant() requires a human caller.
-- - Redeeming a code, rotating a refresh token and revoking by token are
--   the token endpoint's job: only reliquary_web (the web app's login role,
--   with no person in the claims) can call them.
-- - Resolving an access token is the MCP server's job: only reliquary_mcp.
-- - The resource (RFC 8707) is fixed at consent. A token only resolves when
--   the MCP server asks for that exact resource.
--
-- Codes and tokens are working state, not history: expired ones may be
-- deleted (unlike `log`).

-- ---------------------------------------------------------------------------
-- Grants are access_tokens rows

alter table public.access_tokens
  add column kind      text not null default 'pat' check (kind in ('pat', 'oauth')),
  add column client_id text check (length(client_id) between 1 and 2048),
  add column resource  text check (length(resource) between 1 and 2048);
alter table public.access_tokens alter column token_hash drop not null;
alter table public.access_tokens
  add constraint access_tokens_oauth_shape_check check (
    case kind
      when 'pat' then token_hash is not null and client_id is null and resource is null
      when 'oauth' then token_hash is null and client_id is not null and resource is not null
    end);

grant select (kind, client_id) on public.access_tokens to authenticated;

-- A personal token never resolves an OAuth grant (they have no hash, but say
-- it anyway).
create or replace function private.resolve_access_token(p_token_hash text)
returns table (token_id uuid, user_id uuid, name text)
language plpgsql volatile security definer set search_path = '' as $$
begin
  return query
  with used as (
    update public.access_tokens t set last_used_at = now()
    where t.token_hash = p_token_hash
      and t.kind = 'pat'
      and t.revoked_at is null
      and (t.expires_at is null or t.expires_at > now())
    returning t.id, t.user_id, t.name
  )
  select * from used;
end $$;

-- ---------------------------------------------------------------------------
-- Working state: codes and tokens, in the private schema (never exposed),
-- with RLS on and no policies, so only the functions below touch them.

create table private.oauth_codes (
  code_hash      text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  grant_id       uuid not null references public.access_tokens (id) on delete cascade,
  client_id      text not null,
  redirect_uri   text not null,
  resource       text not null,
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  expires_at     timestamptz not null,
  used_at        timestamptz
);
create index on private.oauth_codes (grant_id);

create table private.oauth_tokens (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  grant_id   uuid not null references public.access_tokens (id) on delete cascade,
  kind       text not null check (kind in ('access', 'refresh')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz -- refresh tokens: when it was rotated
);
create index on private.oauth_tokens (grant_id);

alter table private.oauth_codes enable row level security;
alter table private.oauth_tokens enable row level security;
revoke all on private.oauth_codes, private.oauth_tokens from public, anon, authenticated;

-- A grant slides: each refresh extends it by 30 days, never beyond a year
-- from consent, like the longest personal token.
create or replace function private.oauth_grant_expiry(p_created timestamptz)
returns timestamptz language sql stable as $$
  select least(now() + interval '30 days', p_created + interval '366 days')
$$;

-- ---------------------------------------------------------------------------
-- Consent: the person approves a client. Returns the one-time code (`rlc_`),
-- valid 60 s. The grant itself lives 60 s too until the code is redeemed, so
-- an abandoned consent leaves nothing usable behind.
--
-- p_vaults: the vaults it reaches, or NULL for all of the person's vaults.
-- p_access: 'read' or 'write'. The web app has already checked the client's
-- metadata, the redirect URI and the resource; the database checks who is
-- asking and what they may hand out.

create function public.create_oauth_grant(
  p_name text, p_client_id text, p_redirect_uri text, p_resource text,
  p_code_challenge text, p_vaults uuid[], p_access text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text := 'rlc_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_vaults uuid[];
  v_grant uuid;
begin
  perform private.require_human();
  if p_access is null or p_access not in ('read', 'write') then
    raise exception 'access must be read or write' using errcode = '22023';
  end if;
  if p_code_challenge is null or p_code_challenge !~ '^[A-Za-z0-9_-]{43}$' then
    raise exception 'a PKCE S256 code challenge is required' using errcode = '22023';
  end if;
  if coalesce(p_client_id, '') !~ '^https?://' or coalesce(p_redirect_uri, '') !~ '^https?://'
     or coalesce(p_resource, '') !~ '^https?://' then
    raise exception 'client, redirect and resource must be URLs' using errcode = '22023';
  end if;
  if p_vaults is not null then
    select coalesce(array_agg(distinct v), '{}') into v_vaults from unnest(p_vaults) v;
    if cardinality(v_vaults) = 0 then
      raise exception 'choose at least one vault, or all of them' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_vaults) v where v is null or not private.is_member(v)) then
      raise exception 'a connection can only reach vaults you belong to' using errcode = '22023';
    end if;
  end if;

  insert into public.access_tokens (user_id, name, token_hash, expires_at, all_vaults, vault_ids,
                                    access, kind, client_id, resource, client_name)
  values (private.uid(), p_name, null, now() + interval '60 seconds', p_vaults is null,
          coalesce(v_vaults, '{}'), p_access, 'oauth', p_client_id, p_resource,
          left(substring(p_redirect_uri from '^https?://(\[[^]]+\]|[^/:?#\[]+)'), 100))
  returning id into v_grant;

  insert into private.oauth_codes (code_hash, grant_id, client_id, redirect_uri, resource,
                                   code_challenge, expires_at)
  values (encode(extensions.digest(v_code, 'sha256'), 'hex'), v_grant, p_client_id,
          p_redirect_uri, p_resource, p_code_challenge, now() + interval '60 seconds');
  return v_code;
end $$;

-- ---------------------------------------------------------------------------
-- Token endpoint (reliquary_web only). Each returns 'ok' or an OAuth error
-- code, and never raises for a bad request: a refusal must still commit what
-- it marked (a burned code, a revoked grant). The app makes the new tokens
-- and passes only their hashes.

-- authorization_code: the code is single use. A second use means someone
-- else has it, so the grant it created is revoked (RFC 9700, 4.2.1).
create function private.oauth_redeem_code(
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
  -- Burned on first presentation, whatever happens next.
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
   where id = c.grant_id and kind = 'oauth' and revoked_at is null
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

-- refresh_token: rotation. A refresh token that was already rotated and is
-- presented again was copied: the whole grant is revoked.
create function private.oauth_refresh(
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
  if v_grant.kind is distinct from 'oauth' or v_grant.revoked_at is not null
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

-- RFC 7009: revoking either token revokes the grant, if the client asking is
-- the one it was issued to. Unknown tokens are not an error.
create function private.oauth_revoke(p_token_hash text, p_client_id text)
returns void
language sql volatile security definer set search_path = '' as $$
  update public.access_tokens g set revoked_at = coalesce(g.revoked_at, now())
    from private.oauth_tokens t
   where t.token_hash = p_token_hash and t.grant_id = g.id
     and g.kind = 'oauth' and g.client_id = p_client_id
$$;

-- ---------------------------------------------------------------------------
-- Resource server (reliquary_mcp only): an access token, for this resource,
-- of a live grant. Same shape as resolve_access_token.

create function private.resolve_oauth_token(p_token_hash text, p_resource text)
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
       and g.kind = 'oauth'
       and g.revoked_at is null
       and g.expires_at > now()
       and g.resource = p_resource
    returning g.id, g.user_id, g.name
  )
  select * from used;
end $$;

-- ---------------------------------------------------------------------------
-- Grants

grant usage on schema private to reliquary_web;

revoke all on function public.create_oauth_grant(text, text, text, text, text, uuid[], text) from public, anon;
grant execute on function public.create_oauth_grant(text, text, text, text, text, uuid[], text) to authenticated;

revoke all on function private.oauth_redeem_code(text, text, text, text, text, text, text),
  private.oauth_refresh(text, text, text, text, text), private.oauth_revoke(text, text),
  private.resolve_oauth_token(text, text), private.oauth_grant_expiry(timestamptz)
  from public, anon, authenticated;
grant execute on function private.oauth_redeem_code(text, text, text, text, text, text, text),
  private.oauth_refresh(text, text, text, text, text), private.oauth_revoke(text, text)
  to reliquary_web;
grant execute on function private.resolve_oauth_token(text, text) to reliquary_mcp;
