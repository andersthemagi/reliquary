-- Members and invites (docs/research/positioning.md, section 8, item 1;
-- docs/parity.md, "Manage members").
--
-- Managing members is in the delegation ceiling (AGENTS.md): every function
-- here that changes who is in a vault, or shows who is, is a person's, in
-- the web UI (require_human). An agent, a personal token, an OAuth client,
-- a CLI grant, the MCP server's role and anonymous callers are all refused.
--
-- 1. Emails. Members are shown by email, read from auth.users by a
--    security-definer function, never copied into a table. A person sees the
--    emails of people they share a vault with, and nobody else's:
--    list_members() answers only for a vault the caller is a member of, in
--    person. auth.users and email_of() are not reachable by any API role.
--    Owners also see the addresses they (or a co-owner) invited while the
--    invite is pending: they typed them.
--
-- 2. Invites. An owner invites an email address with a role. The invite is a
--    single-use link holding a random 32-byte token (`rli_` + 64 hex),
--    stored only as its SHA-256; it expires after 7 days and an owner can
--    revoke it. Accepting needs the invitee signed in, in person, as an
--    account whose email (auth.users) is the invite's, compared without
--    case. Then they become a member with the invite's role (someone already
--    a member keeps their role: an invite never demotes). Nothing about an
--    invite is logged with its email: the log is readable by every member
--    and their agents (changes_since), and the invitee isn't a co-member yet.
--    Invites live in the private schema with no grants; only these
--    functions touch them. Deleting a vault deletes its invites (cascade).
--
-- 3. Members. set_member keeps its contract, plus: a vault always keeps an
--    owner (the last owner can't be demoted), removing someone who isn't a
--    member is an error rather than a logged no-op, and owners are locked
--    while the check runs, so two owners demoting each other at once can't
--    leave none.
--
-- 4. Connections. An owner sees each member's live agent connections that
--    reach the vault (personal tokens, OAuth grants, CLI grants: name,
--    client, access, last use) and can cut one off from this vault. That
--    narrows the token rather than revoking it outright, so an owner of one
--    vault can't end a member's access to vaults they don't own: a token
--    that reached only this vault is revoked; one with a list loses this
--    vault; an all-vaults token becomes a list of the member's other vaults.
--
-- Log events: invite.create, invite.revoke, invite.accept and
-- member.connection_revoke carry ids and roles only; member.set as before.

-- ---------------------------------------------------------------------------
-- Emails

-- The account's email, lower-cased, or NULL. Only other security-definer
-- functions call it.
create function private.email_of(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select lower(u.email::text) from auth.users u where u.id = p_user
$$;

-- A vault's members with their emails, for a member of it in person.
create function public.list_members(p_vault uuid)
returns table (user_id uuid, email text, role text, added_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  return query
    select m.user_id, private.email_of(m.user_id), m.role, m.added_at
      from public.vault_members m
     where m.vault_id = p_vault
     order by case m.role when 'owner' then 0 when 'editor' then 1 else 2 end,
              private.email_of(m.user_id) nulls last, m.user_id;
end $$;

-- The caller's own email (the invite page says who is signed in).
create function public.my_email() returns text
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  return private.email_of(private.uid());
end $$;

-- ---------------------------------------------------------------------------
-- Members: set_member with an owner always kept

create or replace function public.set_member(p_vault uuid, p_user uuid, p_role text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_old text;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners manage members' using errcode = '42501';
  end if;
  if p_role is not null and p_role not in ('owner', 'editor', 'viewer') then
    raise exception 'a role is owner, editor or viewer' using errcode = '22023';
  end if;
  -- Lock the owners, so concurrent changes see each other's result.
  perform 1 from public.vault_members
   where vault_id = p_vault and role = 'owner' order by user_id for update;
  select role into v_old from public.vault_members
   where vault_id = p_vault and user_id = p_user for update;
  if p_role is null then
    if p_user = private.uid() then
      raise exception 'owners cannot remove themselves' using errcode = '42501';
    end if;
    if v_old is null then
      raise exception 'not a member of this vault' using errcode = 'P0002';
    end if;
  end if;
  if v_old = 'owner' and p_role is distinct from 'owner'
     and (select count(*) from public.vault_members where vault_id = p_vault and role = 'owner') <= 1 then
    raise exception 'a vault needs at least one owner: make someone else an owner first' using errcode = '55000';
  end if;
  if p_role is null then
    delete from public.vault_members where vault_id = p_vault and user_id = p_user;
  else
    insert into public.vault_members (vault_id, user_id, role) values (p_vault, p_user, p_role)
    on conflict (vault_id, user_id) do update set role = excluded.role;
  end if;
  perform private.log_event(p_vault, 'member.set', null, null, null,
    jsonb_build_object('user', p_user, 'role', p_role));
end $$;

-- ---------------------------------------------------------------------------
-- Invites

create table private.vault_invites (
  id          uuid primary key default gen_random_uuid(),
  vault_id    uuid not null references public.vaults on delete cascade,
  email       text not null check (email = lower(email) and length(email) <= 254
                                   and email ~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$'),
  role        text not null check (role in ('owner', 'editor', 'viewer')),
  token_hash  text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by  uuid not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid,
  revoked_at  timestamptz,
  revoked_by  uuid,
  check (accepted_at is null or revoked_at is null)
);
create index on private.vault_invites (vault_id);
alter table private.vault_invites enable row level security;
revoke all on private.vault_invites from public, anon, authenticated;

-- How many invites a vault may have waiting at once.
create function private.invite_cap() returns int
language sql immutable set search_path = '' as $$ select 50 $$;

create function private.invite_state(p_accepted timestamptz, p_revoked timestamptz, p_expires timestamptz)
returns text language sql stable set search_path = '' as $$
  select case when p_accepted is not null then 'accepted'
              when p_revoked is not null then 'revoked'
              when p_expires <= now() then 'expired'
              else 'pending' end
$$;

create function private.token_hash(p_token text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

-- An owner, in person, invites an email address with a role. Returns the
-- token (`rli_...`), once: the app turns it into the link and never stores
-- it. A pending invite to the same address in this vault is replaced.
create function public.create_invite(p_vault uuid, p_email text, p_role text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_token text := 'rli_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_email text := lower(trim(coalesce(p_email, '')));
  v_id uuid;
  v_old uuid;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners invite people' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('owner', 'editor', 'viewer') then
    raise exception 'a role is owner, editor or viewer' using errcode = '22023';
  end if;
  if length(v_email) > 254
     or v_email !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$' then
    raise exception 'enter an email address, like name@example.com' using errcode = '22023';
  end if;
  perform 1 from public.vaults where id = p_vault for update;
  if exists (select 1 from public.vault_members m
              where m.vault_id = p_vault and private.email_of(m.user_id) = v_email) then
    raise exception 'that address already belongs to a member of this vault' using errcode = '23505';
  end if;
  for v_old in
    update private.vault_invites set revoked_at = now(), revoked_by = private.uid()
     where vault_id = p_vault and email = v_email
       and private.invite_state(accepted_at, revoked_at, expires_at) = 'pending'
    returning id
  loop
    perform private.log_event(p_vault, 'invite.revoke', null, null, null,
      jsonb_build_object('invite', v_old, 'replaced', true));
  end loop;
  if (select count(*) from private.vault_invites
       where vault_id = p_vault and private.invite_state(accepted_at, revoked_at, expires_at) = 'pending')
     >= private.invite_cap() then
    raise exception 'this vault has % invites waiting: revoke some first', private.invite_cap() using errcode = '54000';
  end if;
  insert into private.vault_invites (vault_id, email, role, token_hash, created_by, expires_at)
  values (p_vault, v_email, p_role, private.token_hash(v_token), private.uid(), now() + interval '7 days')
  returning id into v_id;
  perform private.log_event(p_vault, 'invite.create', null, null, null,
    jsonb_build_object('invite', v_id, 'role', p_role));
  return v_token;
end $$;

-- The invites waiting in a vault, for its owners in person.
create function public.list_invites(p_vault uuid)
returns table (id uuid, email text, role text, created_by uuid, created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners see invites' using errcode = '42501';
  end if;
  return query
    select i.id, i.email, i.role, i.created_by, i.created_at, i.expires_at
      from private.vault_invites i
     where i.vault_id = p_vault
       and private.invite_state(i.accepted_at, i.revoked_at, i.expires_at) = 'pending'
     order by i.created_at desc;
end $$;

create function public.revoke_invite(p_invite uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare i private.vault_invites;
begin
  perform private.require_human();
  select * into i from private.vault_invites where id = p_invite for update;
  -- A non-owner learns nothing about whether it exists.
  if i.id is null or private.role_in(i.vault_id) is distinct from 'owner' then
    raise exception 'no such invite' using errcode = 'P0002';
  end if;
  if private.invite_state(i.accepted_at, i.revoked_at, i.expires_at) <> 'pending' then
    raise exception 'that invite is already %', private.invite_state(i.accepted_at, i.revoked_at, i.expires_at)
      using errcode = '55000';
  end if;
  update private.vault_invites set revoked_at = now(), revoked_by = private.uid() where id = i.id;
  perform private.log_event(i.vault_id, 'invite.revoke', null, null, null,
    jsonb_build_object('invite', i.id));
end $$;

-- The invitee, signed in, in person. Returns the vault's id. Refusals don't
-- use the invite up: a wrong account can sign out and come back.
create function public.accept_invite(p_token text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  i private.vault_invites;
  v_state text;
begin
  perform private.require_human();
  select * into i from private.vault_invites where token_hash = private.token_hash(p_token) for update;
  if i.id is null or coalesce(p_token, '') !~ '^rli_[0-9a-f]{64}$' then
    raise exception 'this invite link is not valid: check you copied all of it' using errcode = 'P0002';
  end if;
  v_state := private.invite_state(i.accepted_at, i.revoked_at, i.expires_at);
  if v_state = 'accepted' then
    raise exception 'this invite has already been used' using errcode = '55000';
  elsif v_state = 'revoked' then
    raise exception 'this invite was withdrawn' using errcode = '55000';
  elsif v_state = 'expired' then
    raise exception 'this invite has expired' using errcode = '55000';
  end if;
  if private.email_of(private.uid()) is distinct from i.email then
    raise exception 'this invite is for a different email address' using errcode = '42501';
  end if;
  insert into public.vault_members (vault_id, user_id, role)
  values (i.vault_id, private.uid(), i.role)
  on conflict (vault_id, user_id) do nothing;
  update private.vault_invites set accepted_at = now(), accepted_by = private.uid() where id = i.id;
  perform private.log_event(i.vault_id, 'invite.accept', null, null, null,
    jsonb_build_object('invite', i.id, 'role', i.role));
  return i.vault_id;
end $$;

-- What an invite link is for, before anyone signs in: the web app's own
-- role only (reliquary_web, no person in the claims). The link is the
-- secret; whoever holds it may learn the vault's name, the role, the
-- address it was sent to and whether it is still usable.
create function private.invite_peek(p_token text)
returns table (state text, vault_id uuid, vault_name text, role text, email text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select private.invite_state(i.accepted_at, i.revoked_at, i.expires_at), i.vault_id, v.name, i.role, i.email, i.expires_at
    from private.vault_invites i join public.vaults v on v.id = i.vault_id
   where coalesce(p_token, '') ~ '^rli_[0-9a-f]{64}$'
     and i.token_hash = private.token_hash(p_token)
$$;

-- ---------------------------------------------------------------------------
-- Members' agent connections

-- Live tokens and grants of this vault's members that reach it.
create function public.member_connections(p_vault uuid)
returns table (id uuid, user_id uuid, name text, kind text, client_name text, access text,
               all_vaults boolean, created_at timestamptz, last_used_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners see agent connections' using errcode = '42501';
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

-- Cut one connection off from this vault (see the top of this file).
create function public.revoke_member_connection(p_vault uuid, p_token uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  t public.access_tokens;
  v_rest uuid[];
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners revoke agent connections' using errcode = '42501';
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

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.email_of(uuid), private.invite_cap(),
  private.invite_state(timestamptz, timestamptz, timestamptz), private.token_hash(text),
  private.invite_peek(text)
  from public, anon, authenticated;
grant execute on function private.invite_peek(text) to reliquary_web;

revoke all on function public.list_members(uuid), public.my_email(), public.create_invite(uuid, text, text),
  public.list_invites(uuid), public.revoke_invite(uuid), public.accept_invite(text),
  public.member_connections(uuid), public.revoke_member_connection(uuid, uuid)
  from public, anon;
grant execute on function public.list_members(uuid), public.my_email(), public.create_invite(uuid, text, text),
  public.list_invites(uuid), public.revoke_invite(uuid), public.accept_invite(text),
  public.member_connections(uuid), public.revoke_member_connection(uuid, uuid)
  to authenticated;
