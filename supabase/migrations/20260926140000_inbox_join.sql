-- Join or decline an invite from the Inbox (web/src/pages.ts; hostile
-- tests in supabase/tests/inbox_join_test.sql, the race in
-- web/test/races.test.mjs).
--
-- Until now the Inbox listed invites to your address (my_invites,
-- 20260926100000_shell_inbox.sql) but joining still needed the emailed
-- link. Now a person signed in to the web app, in person, whose account's
-- confirmed email is the invite's address, can join from the Inbox, or
-- decline:
--
-- - public.my_invites also returns each invite's id. The id is only useful
--   to its addressee: accept_my_invite and decline_my_invite check the
--   caller's address against the invite's, and anyone else is told only
--   that no such invite waits for them (not whether it exists, nor its
--   state). Owners already knew the id (list_invites); they can't use it
--   here unless it is their own address.
-- - Only a confirmed address counts (auth.users.email_confirmed_at): the
--   link proves the invitee reads that mailbox, and joining without it
--   needs Auth to have proved the same. An account whose address isn't
--   confirmed doesn't see invites in its inbox either.
-- - public.accept_my_invite(id) does exactly what accept_invite does: the
--   vault's row locked before the invite's (20260925240100_lock_order),
--   the same state and address checks, the people limit, membership,
--   admission (20260925240000_admission) and the invite.accept log row.
--   Both now go through one function, private.take_invite.
-- - public.decline_my_invite(id) ends the invite: its link stops working,
--   it leaves the owners' list of waiting invites (freeing its place under
--   the people limit), and the vault's log gets invite.decline (ids and
--   the role, never the address), so the owners learn the answer. Declined
--   is its own state to the invitee ("you declined this invite") and to
--   the link's page; for everything else it is a withdrawn invite. To join
--   later, the person asks for a new invite.
-- - Both are refused to any `act` claim (agents, tokens, OAuth clients, CLI
--   grants): joining a vault is the person's own act (AGENTS.md, the
--   delegation ceiling), as with accept_invite.

-- ---------------------------------------------------------------------------
-- Declined invites

alter table private.vault_invites add column declined_at timestamptz;
-- A declined invite is also revoked, at the same moment, by its invitee:
-- every check that refuses a withdrawn invite refuses a declined one.
alter table private.vault_invites add constraint vault_invites_declined_is_revoked
  check (declined_at is null or revoked_at = declined_at);

-- The caller's address as Reliquary compares it (private.email_key), only
-- once Auth has confirmed it; NULL otherwise.
create function private.confirmed_email_of(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select private.email_key(u.email::text) from auth.users u
   where u.id = p_user and u.email_confirmed_at is not null
$$;

-- ---------------------------------------------------------------------------
-- The people limit, with what to do next said for the way someone joins

-- As require_people_room (20260925230000_plans), with the last words of
-- the members-only refusal ("then <p_then>") chosen by the caller.
create function private.require_people_room(p_vault uuid, p_with_invites boolean, p_then text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  l record;
  v_members int;
  v_invites int := 0;
begin
  select * into l from private.vault_limits(p_vault);
  select count(*) into v_members from public.vault_members where vault_id = p_vault;
  if p_with_invites then
    select count(*) into v_invites from private.vault_invites
     where vault_id = p_vault and private.invite_state(accepted_at, revoked_at, expires_at) = 'pending';
  end if;
  if v_members + v_invites < l.max_members then
    return;
  end if;
  if p_with_invites then
    raise exception '% is at its %-person limit on % (% and %): revoke an invite or remove someone first',
        (select v.name from public.vaults v where v.id = p_vault), l.max_members, l.label,
        v_members || case when v_members = 1 then ' member' else ' members' end,
        v_invites || case when v_invites = 1 then ' invite waiting' else ' invites waiting' end
      using errcode = 'RLP01',
            detail = jsonb_build_object('limit', 'people', 'used', v_members + v_invites, 'members', v_members,
                       'invites', v_invites, 'max', l.max_members, 'plan', l.plan_id, 'tier', l.tier_id)::text;
  end if;
  raise exception '% is at its %-person limit on % (% members): ask an owner to make room, then %',
      (select v.name from public.vaults v where v.id = p_vault), l.max_members, l.label, v_members, p_then
    using errcode = 'RLP01',
          detail = jsonb_build_object('limit', 'people', 'used', v_members, 'members', v_members,
                     'max', l.max_members, 'plan', l.plan_id, 'tier', l.tier_id)::text;
end $$;

-- The two-argument form keeps its words (the invite link's).
create or replace function private.require_people_room(p_vault uuid, p_with_invites boolean) returns void
language sql stable security definer set search_path = '' as $$
  select private.require_people_room(p_vault, p_with_invites, 'open this link again')
$$;

-- ---------------------------------------------------------------------------
-- Joining, one way for the link and the Inbox

-- Refuses an invite that isn't waiting, in words for its invitee.
create function private.invite_refusal(i private.vault_invites) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_state text := private.invite_state(i.accepted_at, i.revoked_at, i.expires_at);
begin
  if i.declined_at is not null then
    raise exception 'you declined this invite: to join, ask an owner of the vault to invite you again' using errcode = '55000';
  elsif v_state = 'accepted' then
    raise exception 'this invite has already been used' using errcode = '55000';
  elsif v_state = 'revoked' then
    raise exception 'this invite was withdrawn' using errcode = '55000';
  elsif v_state = 'expired' then
    raise exception 'this invite has expired' using errcode = '55000';
  end if;
end $$;

-- The caller joins with invite p_invite, found by the caller (by its
-- link's token, or by id from the Inbox). What accept_invite did
-- (20260925240100_lock_order): the vault's row, then the invite's, locked;
-- the invite must be waiting and for the caller's address; the people
-- limit (members only: this invite's place is its own); membership (an
-- invite never demotes); the invite used; the account admitted; logged.
-- p_via is 'link' or 'inbox', for the refusals' words and the log.
create function private.take_invite(p_invite uuid, p_via text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  i private.vault_invites;
  v_vault uuid;
begin
  select x.vault_id into v_vault from private.vault_invites x where x.id = p_invite;
  perform 1 from public.vaults where id = v_vault for update;
  select * into i from private.vault_invites where id = p_invite for update;
  if i.id is null then
    if p_via = 'link' then
      raise exception 'this invite link is not valid: check you copied all of it' using errcode = 'P0002';
    end if;
    raise exception 'this invite is no longer waiting for you: it was withdrawn, or its vault was deleted' using errcode = 'P0002';
  end if;
  perform private.invite_refusal(i);
  if private.email_of(private.uid()) is distinct from i.email then
    raise exception 'this invite is for a different email address' using errcode = '42501';
  end if;
  if not exists (select 1 from public.vault_members where vault_id = i.vault_id and user_id = private.uid()) then
    perform private.require_people_room(i.vault_id, false,
      case when p_via = 'link' then 'open this link again' else 'choose Join in your inbox again' end);
  end if;
  insert into public.vault_members (vault_id, user_id, role)
  values (i.vault_id, private.uid(), i.role)
  on conflict (vault_id, user_id) do nothing;
  update private.vault_invites set accepted_at = now(), accepted_by = private.uid() where id = i.id;
  perform private.admit(private.uid(), 'invite');
  perform private.log_event(i.vault_id, 'invite.accept', null, null, null,
    case when p_via = 'link' then jsonb_build_object('invite', i.id, 'role', i.role)
         else jsonb_build_object('invite', i.id, 'role', i.role, 'via', 'inbox') end);
  return i.vault_id;
end $$;

-- As in 20260925240100_lock_order, through take_invite: same checks, same
-- words, same locks in the same order.
create or replace function public.accept_invite(p_token text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform private.require_human();
  if coalesce(p_token, '') ~ '^rli_[0-9a-f]{64}$' then
    select x.id into v_id from private.vault_invites x where x.token_hash = private.token_hash(p_token);
  end if;
  if v_id is null then
    raise exception 'this invite link is not valid: check you copied all of it' using errcode = 'P0002';
  end if;
  return private.take_invite(v_id, 'link');
end $$;

-- ---------------------------------------------------------------------------
-- From the Inbox

-- The invite p_invite, if it is made out to the caller's confirmed
-- address; the caller in person. Anyone else learns nothing about it.
create function private.invite_for_me(p_invite uuid) returns private.vault_invites
language plpgsql stable security definer set search_path = '' as $$
declare
  v_email text;
  i private.vault_invites;
begin
  perform private.require_human();
  v_email := private.confirmed_email_of(private.uid());
  if v_email is null then
    raise exception 'your account''s email address isn''t confirmed yet, so invites can''t be answered from your inbox: open the invite link you were sent instead'
      using errcode = '42501';
  end if;
  select * into i from private.vault_invites where id = p_invite and email = v_email;
  if i.id is null then
    raise exception 'no invite with this id is waiting for your address: it may have been sent to another address, or its vault deleted'
      using errcode = 'P0002';
  end if;
  return i;
end $$;

-- Join from the Inbox. Returns the vault's id.
create function public.accept_my_invite(p_invite uuid)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.invite_for_me(p_invite);
  return private.take_invite(p_invite, 'inbox');
end $$;

-- Decline from the Inbox. Returns the vault's name (the decliner can't
-- read it any other way).
create function public.decline_my_invite(p_invite uuid)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  i private.vault_invites;
  v_vault uuid;
begin
  perform private.invite_for_me(p_invite);
  -- The vault's row, then the invite's, as take_invite.
  select x.vault_id into v_vault from private.vault_invites x where x.id = p_invite;
  perform 1 from public.vaults where id = v_vault for update;
  select * into i from private.vault_invites where id = p_invite for update;
  if i.id is null then
    raise exception 'this invite is no longer waiting for you: it was withdrawn, or its vault was deleted' using errcode = 'P0002';
  end if;
  if i.declined_at is not null then
    raise exception 'you already declined this invite' using errcode = '55000';
  end if;
  perform private.invite_refusal(i);
  update private.vault_invites set revoked_at = now(), revoked_by = private.uid(), declined_at = now()
   where id = i.id;
  perform private.log_event(i.vault_id, 'invite.decline', null, null, null,
    jsonb_build_object('invite', i.id, 'role', i.role));
  return (select v.name from public.vaults v where v.id = i.vault_id);
end $$;

-- As in 20260926100000_shell_inbox, plus each invite's id (for Join and
-- Decline), and only for a confirmed address.
drop function public.my_invites();
create function public.my_invites()
returns table (id uuid, vault_name text, role text, invited_by_email text, created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_email text;
begin
  perform private.require_human();
  v_email := private.confirmed_email_of(private.uid());
  if v_email is null then
    return;
  end if;
  return query
    select i.id, v.name, i.role, private.email_of(i.created_by), i.created_at, i.expires_at
      from private.vault_invites i
      join public.vaults v on v.id = i.vault_id
     where i.email = v_email
       and private.invite_state(i.accepted_at, i.revoked_at, i.expires_at) = 'pending'
       and not exists (select 1 from public.vault_members m where m.vault_id = i.vault_id and m.user_id = private.uid())
     order by i.created_at desc
     limit 50;
end $$;

-- As in 20260925140000_invites, plus 'declined' for a link its invitee
-- declined.
create or replace function private.invite_peek(p_token text)
returns table (state text, vault_id uuid, vault_name text, role text, email text, expires_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select case when i.declined_at is not null then 'declined'
              else private.invite_state(i.accepted_at, i.revoked_at, i.expires_at) end,
         i.vault_id, v.name, i.role, i.email, i.expires_at
    from private.vault_invites i join public.vaults v on v.id = i.vault_id
   where coalesce(p_token, '') ~ '^rli_[0-9a-f]{64}$'
     and i.token_hash = private.token_hash(p_token)
$$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.confirmed_email_of(uuid), private.require_people_room(uuid, boolean, text),
  private.invite_refusal(private.vault_invites), private.take_invite(uuid, text),
  private.invite_for_me(uuid)
  from public, anon, authenticated;

revoke all on function public.accept_my_invite(uuid), public.decline_my_invite(uuid), public.my_invites()
  from public, anon;
grant execute on function public.accept_my_invite(uuid), public.decline_my_invite(uuid), public.my_invites()
  to authenticated;
