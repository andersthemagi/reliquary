-- Scoped, expiring agent tokens. See docs/research/ux-patterns.md (Tokens).
--
-- A token reaches either all of its person's vaults or a chosen set, and is
-- either read-only or read-write. Scope is fixed at creation: to change it,
-- revoke and recreate. Every token has an expiry (1 to 366 days).
--
-- How the database enforces it:
-- - The MCP server puts the resolved token's id in the claims as `act.tok`.
-- - private.role_in(), which every membership check derives from (is_member
--   for RLS reads, can_write for every write, propose and revise), consults
--   that token when it is present:
--     * the token must be live (not revoked, not expired) and belong to `sub`,
--       or the caller has no role anywhere;
--     * a vault outside the token's scope gives no role, so it is invisible
--       (RLS) and unwritable;
--     * a read-only token caps the role at 'viewer', which can read but not
--       write, propose, revise or decide.
--   Every branch fails closed: anything unexpected yields NULL (no access).
-- - A request whose claims carry `act` in any form is an agent, so the
--   delegation ceiling holds even if the name is missing.
--
-- Existing tokens keep working: they become "all vaults, read-write", which
-- is exactly what they could do before, so nobody's agent breaks mid-week.
-- The few with no expiry get one year from creation.

alter table public.access_tokens
  add column all_vaults  boolean not null default true,
  add column vault_ids   uuid[]  not null default '{}',
  add column access      text    not null default 'write' check (access in ('read', 'write')),
  add column client_name text check (length(client_name) <= 100),
  add constraint access_tokens_scope_check
    check (all_vaults = (cardinality(vault_ids) = 0));

update public.access_tokens set expires_at = created_at + interval '366 days'
where expires_at is null;
alter table public.access_tokens alter column expires_at set not null;

grant select (all_vaults, vault_ids, access, client_name) on public.access_tokens to authenticated;

-- ---------------------------------------------------------------------------
-- Identity

-- Any `act` claim at all means an agent is acting. Before, an `act` without
-- a name or sub read as the person themself.
create or replace function private.agent() returns text
language sql stable as $$
  with c as (select nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'act' as act)
  select case when act is not null and jsonb_typeof(act) <> 'null'
    then coalesce(nullif(act ->> 'name', ''), nullif(act ->> 'sub', ''), 'agent') end
  from c
$$;

-- The token the request came through, or NULL for the web UI (no token).
-- A malformed id raises, which fails the request.
create or replace function private.token_id() returns uuid
language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'act' ->> 'tok')::uuid
$$;

-- The caller's role in a vault, as limited by their token. Everything else
-- (is_member, can_write, RLS, the write API) goes through here.
create or replace function private.role_in(p_vault uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when private.token_id() is null then m.role
    -- no live token of this person's matched: no access at all
    when t.id is null then null
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

-- ---------------------------------------------------------------------------
-- Creating a token: people only, with a scope and an expiry.

drop function public.create_access_token(text, int);

-- p_vaults: the vaults it reaches, or NULL for all of the person's vaults
-- (including ones they join later). p_access: 'read' or 'write'.
create function public.create_access_token(p_name text, p_days int default 90,
  p_vaults uuid[] default null, p_access text default 'write')
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_token text := 'rlq_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_vaults uuid[];
begin
  perform private.require_human();
  if p_days is null or p_days < 1 or p_days > 366 then
    raise exception 'tokens last 1 to 366 days' using errcode = '22023';
  end if;
  if p_access is null or p_access not in ('read', 'write') then
    raise exception 'access must be read or write' using errcode = '22023';
  end if;
  if p_vaults is not null then
    select coalesce(array_agg(distinct v), '{}') into v_vaults from unnest(p_vaults) v;
    if cardinality(v_vaults) = 0 then
      raise exception 'choose at least one vault, or all of them' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_vaults) v where v is null or not private.is_member(v)) then
      raise exception 'a token can only reach vaults you belong to' using errcode = '22023';
    end if;
  end if;
  insert into public.access_tokens (user_id, name, token_hash, expires_at, all_vaults, vault_ids, access)
  values (private.uid(), p_name, encode(extensions.digest(v_token, 'sha256'), 'hex'),
          now() + make_interval(days => p_days), p_vaults is null, coalesce(v_vaults, '{}'), p_access);
  return v_token;
end $$;

revoke all on function public.create_access_token(text, int, uuid[], text) from public, anon;
grant execute on function public.create_access_token(text, int, uuid[], text) to authenticated;

-- ---------------------------------------------------------------------------
-- The MCP server records the client's self-reported name at initialize
-- (clientInfo.name), for the Tokens page. Only for a live token, by hash, so
-- the server needs the token itself, not just an id. The name is shown to
-- the person, never to a model, and is trimmed of control characters.

create or replace function private.record_token_client(p_token_hash text, p_client text)
returns void
language sql volatile security definer set search_path = '' as $$
  update public.access_tokens t
  set client_name = nullif(left(trim(regexp_replace(coalesce(p_client, ''), '[[:cntrl:]]', ' ', 'g')), 100), '')
  where t.token_hash = p_token_hash
    and t.revoked_at is null
    and t.expires_at > now()
$$;

revoke all on function private.record_token_client(text, text), private.token_id()
  from public, anon, authenticated;
grant execute on function private.record_token_client(text, text) to reliquary_mcp;
