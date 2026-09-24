-- Personal access tokens for MCP clients, full-text search, and the role the
-- MCP server connects as.
--
-- A token always acts as its person *through an agent*: the MCP server puts
-- the token's name in the `act` claim, so every call made with a token gets
-- the delegation ceiling (no approving, no policy or member changes, no
-- erasure). Tokens are shown once and stored as SHA-256.

create table public.access_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,
  name         text not null check (length(name) between 1 and 100),
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index on public.access_tokens (user_id);

alter table public.access_tokens enable row level security;
create policy own_tokens on public.access_tokens for select to authenticated
  using (user_id = private.uid());

-- Supabase grants API roles everything on new tables; take it back, then
-- expose every column except the hash.
revoke all on public.access_tokens from anon, authenticated;
grant select (id, user_id, name, created_at, expires_at, last_used_at, revoked_at)
  on public.access_tokens to authenticated;

-- Create a token for the calling person. People only, never an agent: a
-- token is a new agent, and agents don't mint agents.
create or replace function public.create_access_token(p_name text, p_days int default 90)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_token text := 'rlq_' || encode(extensions.gen_random_bytes(32), 'hex');
begin
  perform private.require_human();
  if p_days is not null and (p_days < 1 or p_days > 366) then
    raise exception 'tokens last 1 to 366 days' using errcode = '22023';
  end if;
  insert into public.access_tokens (user_id, name, token_hash, expires_at)
  values (private.uid(), p_name, encode(extensions.digest(v_token, 'sha256'), 'hex'),
          case when p_days is null then null else now() + make_interval(days => p_days) end);
  return v_token;
end $$;

-- Revoking is protective, so a person or their agent may revoke their own.
create or replace function public.revoke_access_token(p_id uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_person();
  update public.access_tokens set revoked_at = coalesce(revoked_at, now())
  where id = p_id and user_id = private.uid();
  if not found then
    raise exception 'no such token' using errcode = 'P0002';
  end if;
end $$;

-- Full-text search over the current version of each file. Security invoker:
-- RLS on files and file_versions decides what the caller can find.
create index file_versions_body_fts on public.file_versions
  using gin (to_tsvector('simple', coalesce(body, '')));

create or replace function public.search(p_vault uuid, p_query text, p_limit int default 20)
returns table (path text, policy text, body text, updated_at timestamptz,
               author uuid, agent text, rank real)
language sql stable security invoker set search_path = '' as $$
  select f.path, (private.policy_for(f.vault_id, f.path)).policy, v.body, f.updated_at,
         v.author, v.agent,
         ts_rank(to_tsvector('simple', coalesce(v.body, '')),
                 websearch_to_tsquery('simple', p_query))
  from public.files f
  join public.file_versions v on v.id = f.current_version_id
  where f.vault_id = p_vault
    and f.deleted_at is null
    and v.body is not null
    and (to_tsvector('simple', coalesce(v.body, '')) @@ websearch_to_tsquery('simple', p_query)
         -- literal substring, no pattern syntax; an empty query matches nothing
         or (length(trim(coalesce(p_query, ''))) > 0
             and strpos(lower(f.path), lower(trim(p_query))) > 0))
  order by 7 desc, f.updated_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;

revoke all on function public.create_access_token(text, int), public.revoke_access_token(uuid),
  public.search(uuid, text, int) from public, anon;
grant execute on function public.create_access_token(text, int), public.revoke_access_token(uuid),
  public.search(uuid, text, int) to authenticated;

-- ---------------------------------------------------------------------------
-- The MCP server's role. It logs in as reliquary_mcp (password set outside
-- migrations), resolves a bearer token here, then runs each call as
-- `authenticated` with the resolved person and agent in the claims, the way
-- PostgREST does. It can do nothing else.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'reliquary_mcp') then
    create role reliquary_mcp nologin noinherit;
  end if;
end $$;
grant authenticated to reliquary_mcp;
grant usage on schema private to reliquary_mcp;

create or replace function private.resolve_access_token(p_token_hash text)
returns table (token_id uuid, user_id uuid, name text)
language plpgsql volatile security definer set search_path = '' as $$
begin
  return query
  with used as (
    update public.access_tokens t set last_used_at = now()
    where t.token_hash = p_token_hash
      and t.revoked_at is null
      and (t.expires_at is null or t.expires_at > now())
    returning t.id, t.user_id, t.name
  )
  select * from used;
end $$;

revoke all on function private.resolve_access_token(text) from public;
grant execute on function private.resolve_access_token(text) to reliquary_mcp;
