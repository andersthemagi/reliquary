-- Open invite links: a link for anyone, not one address (design.md's
-- invite model extended, owner's decision 2026-09-29). An owner creating an
-- invite may leave the address blank and set how many times it may be
-- used (1 to 100, default 1: "one-time"). Whoever opens the link supplies
-- their own email during sign-up; no email is known ahead of time.
--
-- Reuses 20260925140000_invites' schema and functions rather than a
-- parallel table: `email` becomes nullable, and `max_uses`/`uses_count`
-- replace "used once" with "used up to N times." private.invite_state is
-- untouched, on purpose: `accepted_at` keeps meaning exactly what it did
-- (this invite has no uses left), so every function that only reads
-- invite_state (revoke_invite, my_invites, list_invites' filter,
-- account_deletion_summary, delete_account, require_people_room) needs no
-- change at all. The one place that has to know about counting is
-- take_invite, which now stamps accepted_at/accepted_by on the use that
-- exhausts the link rather than unconditionally; for the existing
-- max_uses = 1 default this is exactly the same moment as before (the
-- first and only use), so every existing single-address invite keeps its
-- exact behaviour.
--
-- The email-match refusal in take_invite is skipped only when the invite
-- has no address (an open link): anyone signed in may redeem it, up to
-- the cap, same as before for who may hold and use the link at all. The
-- people-limit check already re-runs on every single use
-- (require_people_room in take_invite), so a link's nominal max_uses
-- doesn't need to be weighed against room at creation time: the vault
-- simply stops accepting new joins through it once it's full, same as it
-- already does for a second invite email-bound invite today.

alter table private.vault_invites alter column email drop not null;
alter table private.vault_invites add column max_uses int not null default 1 check (max_uses between 1 and 100);
alter table private.vault_invites add column uses_count int not null default 0 check (uses_count >= 0 and uses_count <= max_uses);

-- How many uses a single link may be created with.
create function private.invite_max_uses_cap() returns int
language sql immutable set search_path = '' as $$ select 100 $$;

-- create_invite gains a 4th parameter (p_max_uses): a different function
-- identity to Postgres, so the 3-arg version is dropped first rather than
-- left as a stale, unreachable-from-the-app overload (as
-- 20260926140000_inbox_join already does for my_invites when its shape
-- changes). Existing 3-argument callers keep working unchanged: the new
-- parameter defaults to 1.
drop function public.create_invite(uuid, text, text);

-- As in 20260925240300_email_nfc, plus: p_email may be null or blank for
-- an open link (any address may redeem it), and p_max_uses (ignored,
-- forced to 1, for an address-bound invite: one address, one use, as
-- always) sets how many times an open link may be used.
create function public.create_invite(p_vault uuid, p_email text, p_role text, p_max_uses int default 1)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_token text := 'rli_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_email text := nullif(private.email_key(coalesce(p_email, '')), '');
  v_max_uses int := case when v_email is null then coalesce(p_max_uses, 1) else 1 end;
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
  if v_email is not null and
     (length(v_email) > 254
      or v_email !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$') then
    raise exception 'enter an email address, like name@example.com' using errcode = '22023';
  end if;
  if v_max_uses < 1 or v_max_uses > private.invite_max_uses_cap() then
    raise exception 'a link''s use count is 1 to %', private.invite_max_uses_cap() using errcode = '22023';
  end if;
  perform 1 from public.vaults where id = p_vault for update;
  -- One person's invites, counted one call at a time, whichever vault.
  perform pg_advisory_xact_lock(hashtextextended('reliquary.invite_rate:' || private.uid()::text, 0));
  if (select count(*) from private.vault_invites
       where created_by = private.uid() and created_at > now() - interval '1 hour') >= private.invite_rate() then
    raise exception 'you have created % invites in the last hour: try again later', private.invite_rate()
      using errcode = '54000';
  end if;
  if v_email is not null then
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
  end if;
  if (select count(*) from private.vault_invites
       where vault_id = p_vault and private.invite_state(accepted_at, revoked_at, expires_at) = 'pending')
     >= private.invite_cap() then
    raise exception 'this vault has % invites waiting: revoke some first', private.invite_cap() using errcode = '54000';
  end if;
  perform private.require_people_room(p_vault, true);
  insert into private.vault_invites (vault_id, email, role, max_uses, token_hash, created_by, expires_at)
  values (p_vault, v_email, p_role, v_max_uses, private.token_hash(v_token), private.uid(), now() + interval '7 days')
  returning id into v_id;
  perform private.log_event(p_vault, 'invite.create', null, null, null,
    jsonb_build_object('invite', v_id, 'role', p_role, 'max_uses', v_max_uses));
  return v_token;
end $$;

-- As in 20260926140000_inbox_join, plus: an open link (no address) skips
-- the address check entirely, and each use counts toward max_uses instead
-- of ending the invite outright. accepted_at/accepted_by are stamped on
-- the use that exhausts it (v_uses >= i.max_uses), which for the default
-- max_uses = 1 is the first and only use, unchanged from before.
create or replace function private.take_invite(p_invite uuid, p_via text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  i private.vault_invites;
  v_vault uuid;
  v_uses int;
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
  if i.email is not null and private.email_of(private.uid()) is distinct from i.email then
    raise exception 'this invite is for a different email address' using errcode = '42501';
  end if;
  if not exists (select 1 from public.vault_members where vault_id = i.vault_id and user_id = private.uid()) then
    perform private.require_people_room(i.vault_id, false,
      case when p_via = 'link' then 'open this link again' else 'choose Join in your inbox again' end);
  end if;
  insert into public.vault_members (vault_id, user_id, role)
  values (i.vault_id, private.uid(), i.role)
  on conflict (vault_id, user_id) do nothing;
  v_uses := i.uses_count + 1;
  update private.vault_invites
     set uses_count = v_uses,
         accepted_at = case when v_uses >= i.max_uses then now() else accepted_at end,
         accepted_by = case when v_uses >= i.max_uses then private.uid() else accepted_by end
   where id = i.id;
  perform private.admit(private.uid(), 'invite');
  perform private.log_event(i.vault_id, 'invite.accept', null, null, null,
    case when p_via = 'link' then jsonb_build_object('invite', i.id, 'role', i.role)
         else jsonb_build_object('invite', i.id, 'role', i.role, 'via', 'inbox') end);
  return i.vault_id;
end $$;

-- Both below add columns to their RETURNS TABLE, which CREATE OR REPLACE
-- can't do in place (Postgres refuses to change a function's return type
-- that way); dropped and recreated, same as create_invite above.
drop function private.invite_peek(text);
drop function public.list_invites(uuid);

-- As in 20260926140000_inbox_join, plus max_uses/uses_count so the invite
-- page and the Members page can say how many redemptions are left.
create function private.invite_peek(p_token text)
returns table (state text, vault_id uuid, vault_name text, role text, email text, expires_at timestamptz,
               max_uses int, uses_count int)
language sql stable security definer set search_path = '' as $$
  select case when i.declined_at is not null then 'declined'
              else private.invite_state(i.accepted_at, i.revoked_at, i.expires_at) end,
         i.vault_id, v.name, i.role, i.email, i.expires_at, i.max_uses, i.uses_count
    from private.vault_invites i join public.vaults v on v.id = i.vault_id
   where coalesce(p_token, '') ~ '^rli_[0-9a-f]{64}$'
     and i.token_hash = private.token_hash(p_token)
$$;

-- As in 20260925140000_invites, plus max_uses/uses_count, for the Members
-- page's pending-invites list.
create function public.list_invites(p_vault uuid)
returns table (id uuid, email text, role text, created_by uuid, created_at timestamptz, expires_at timestamptz,
               max_uses int, uses_count int)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners see invites' using errcode = '42501';
  end if;
  return query
    select i.id, i.email, i.role, i.created_by, i.created_at, i.expires_at, i.max_uses, i.uses_count
      from private.vault_invites i
     where i.vault_id = p_vault
       and private.invite_state(i.accepted_at, i.revoked_at, i.expires_at) = 'pending'
     order by i.created_at desc;
end $$;

-- DROP FUNCTION resets a function to Postgres's default ACL (PUBLIC gets
-- EXECUTE), unlike CREATE OR REPLACE on an unchanged signature, which
-- keeps whatever the function already had. Every function dropped and
-- recreated above needs its lockdown restated, exactly as
-- 20260925140000_invites first set it.
revoke all on function private.invite_max_uses_cap(), private.invite_peek(text)
  from public, anon, authenticated;
grant execute on function private.invite_peek(text) to reliquary_web;

revoke all on function public.create_invite(uuid, text, text, int), public.list_invites(uuid)
  from public, anon;
grant execute on function public.create_invite(uuid, text, text, int), public.list_invites(uuid)
  to authenticated;
