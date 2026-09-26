-- One vocabulary for connections (owner's decision, 2026-09-26).
--
-- A connection is anything that can act as you: a token, an app or the
-- Reliquary CLI (docs/public/concepts/connections.md). Two things in the
-- database still spoke otherwise:
--
--   - create_cli_grant stored the client name "this computer" on every CLI
--     grant. It is true for the person who signed in and wrong for anyone
--     else who reads it (an owner on Members), and the Connections page
--     showed it as "from this computer". The CLI reports no client name now,
--     like a token that was never used; the row is already named
--     "Reliquary CLI". Existing CLI rows with that stored name lose it: it
--     was never a client's report, only this function's constant.
--   - member_connections and revoke_member_connection refused non-owners
--     with "agent connections"; they now say "the connections members have
--     to this vault".
--     Same checks, same SQLSTATE (42501): only the messages change.
--
-- Bodies are otherwise exactly as in 20260925100000_env_imports.sql and
-- 20260925140000_invites.sql; grants on the functions are unchanged by
-- create or replace.

-- As in 20260925100000_env_imports.sql, with no client name.
create or replace function public.create_cli_grant(
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
          coalesce(v_vaults, '{}'), 'read', 'cli', p_client_id, p_resource, null,
          coalesce(p_push, false))
  returning id into v_grant;

  insert into private.oauth_codes (code_hash, grant_id, client_id, redirect_uri, resource,
                                   code_challenge, expires_at)
  values (encode(extensions.digest(v_code, 'sha256'), 'hex'), v_grant, p_client_id,
          p_redirect_uri, p_resource, p_code_challenge, now() + interval '60 seconds');
  return v_code;
end $$;

update public.access_tokens set client_name = null
 where kind = 'cli' and client_name = 'this computer';

-- As in 20260925140000_invites.sql, with the new words.
create or replace function public.member_connections(p_vault uuid)
returns table (id uuid, user_id uuid, name text, kind text, client_name text, access text,
               all_vaults boolean, created_at timestamptz, last_used_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners see the connections members have to this vault' using errcode = '42501';
  end if;
  return query
    select t.id, t.user_id, t.name, t.kind, t.client_name, t.access, t.all_vaults,
           t.created_at, t.last_used_at, t.expires_at
      from public.access_tokens t
      join public.vault_members m on m.vault_id = p_vault and m.user_id = t.user_id
     where t.revoked_at is null and t.expires_at > now()
       and (t.all_vaults or p_vault = any(t.vault_ids))
     order by t.last_used_at desc nulls last, t.created_at desc;
end $$;

-- As in 20260925140000_invites.sql, with the new words.
create or replace function public.revoke_member_connection(p_vault uuid, p_token uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t public.access_tokens;
  v_rest uuid[];
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners revoke the connections members have to this vault' using errcode = '42501';
  end if;
  select a.* into t from public.access_tokens a
    join public.vault_members m on m.vault_id = p_vault and m.user_id = a.user_id
   where a.id = p_token and a.revoked_at is null and a.expires_at > now()
     and (a.all_vaults or p_vault = any(a.vault_ids))
   for update of a;
  if t.id is null then
    raise exception 'no such connection' using errcode = 'P0002';
  end if;
  if t.all_vaults then
    select coalesce(array_agg(m.vault_id order by m.vault_id), '{}') into v_rest
      from public.vault_members m where m.user_id = t.user_id and m.vault_id <> p_vault;
  else
    v_rest := array_remove(t.vault_ids, p_vault);
  end if;
  if cardinality(v_rest) = 0 then
    update public.access_tokens set revoked_at = now() where id = t.id;
  else
    update public.access_tokens set all_vaults = false, vault_ids = v_rest where id = t.id;
  end if;
  perform private.log_event(p_vault, 'member.connection_revoke', null, null, null,
    jsonb_build_object('user', t.user_id, 'token', t.id, 'revoked', cardinality(v_rest) = 0));
end $$;
