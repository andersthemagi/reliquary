-- Deleting an account (web/src/settings.ts; hostile tests in
-- supabase/tests/delete_account_test.sql; the model is docs/design.md,
-- "Deleting an account").
--
-- One database function, public.delete_account, for the person in person,
-- with their email address typed (the database checks it, so no surface can
-- skip it). An agent, a personal token, a connected app, a CLI grant and
-- anonymous callers are refused: deleting an account is behind the ceiling,
-- like deleting a vault.
--
-- Refused while the person is the only owner of a vault: the message names
-- those vaults, and they must make someone else an owner or delete the vault
-- first (a vault always keeps an owner). Otherwise, in one transaction:
--
--  - they leave every vault (a member.leave entry in each vault's log,
--    marked account_deleted), and vaults they created count against the
--    longest-standing remaining owner from now on (vaults.created_by: plans
--    count a vault against its creator, and a vault needs someone to count
--    against);
--  - every connection is deleted: personal tokens, connected apps and CLI
--    sign-ins, with their OAuth codes and tokens;
--  - invites they made that are still waiting are withdrawn (an
--    invite.revoke entry, marked account_deleted), and invites they accepted
--    are deleted: those rows are the only place Reliquary's own tables tie
--    the account to an email address;
--  - their display name, plan, admission, snoozes, deletion notices, session
--    cutoff and .env imports pasted but not applied (their private drafts)
--    are deleted;
--  - the sign-in account itself is deleted from auth.users, so Supabase Auth
--    forgets the address and every session (its identities, sessions and
--    refresh tokens go with it, on delete cascade);
--  - a row in private.deleted_accounts keeps the id and when, and nothing
--    else. private.check_session refuses that id from then on, whatever the
--    session, and public.co_member_people names it as a deleted account.
--
-- What stays: what they wrote in vaults (versions, proposals, approvals,
-- comments, notes), the log and the variables access log, all of which
-- belong to the vaults and their owners, and keep the account id only. The
-- log is append-only and nothing here updates or deletes a log row. Invites
-- other people made out to the address stay theirs: an owner typed it.
--
-- Why in the database and not Supabase's admin API: that needs the project's
-- secret key, which the web app never holds (docs/research/hosting.md: never
-- on Vercel). The migration role owns this function and may delete from
-- auth.users; if it ever can't, the whole deletion fails and nothing is
-- changed.

create table private.deleted_accounts (
  user_id    uuid primary key,
  deleted_at timestamptz not null default now()
);
alter table private.deleted_accounts enable row level security;
revoke all on private.deleted_accounts
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;

-- As in 20260926140000_sign_out_everywhere, plus: a deleted account's
-- sessions are refused, with or without an iat.
create or replace function private.check_session() returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_iat numeric;
  v_sub uuid;
begin
  if v_claims is null or v_claims ->> 'sub' is null then
    return;
  end if;
  v_sub := (v_claims ->> 'sub')::uuid;
  if exists (select 1 from private.deleted_accounts d where d.user_id = v_sub) then
    raise exception 'this account was deleted: its sessions ended with it'
      using errcode = 'RLA01';
  end if;
  if jsonb_typeof(v_claims -> 'iat') = 'number' then
    v_iat := (v_claims ->> 'iat')::numeric;
    if exists (select 1 from private.session_cutoffs c
                where c.user_id = v_sub and to_timestamp(v_iat) < c.not_before) then
      raise exception 'this session was signed out: you (or someone signed in as you) chose Sign out everywhere after it began. Sign in again'
        using errcode = 'RLA01';
    end if;
  end if;
end $$;

-- The one check every account function starts with: the person, in person,
-- through no token of any kind.
create function private.require_account_owner() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.token_kind() is not null then
    raise exception 'only you, signed in to the web app, can do this to your account' using errcode = '42501';
  end if;
end $$;

-- Vaults whose only owner is the caller.
create function private.sole_owned() returns table (id uuid, name text)
language sql stable security definer set search_path = '' as $$
  select v.id, v.name
    from public.vaults v
    join public.vault_members m on m.vault_id = v.id and m.user_id = private.uid() and m.role = 'owner'
   where not exists (select 1 from public.vault_members o
                      where o.vault_id = v.id and o.role = 'owner' and o.user_id <> private.uid())
   order by v.name, v.id
$$;

-- What deleting the caller's account would do, for the confirm page:
--   email:       the address to type (null: type "delete my account")
--   sole_owner:  [{id, name}] vaults that block it
--   vaults:      [{id, name, role}] vaults they would leave
--   connections: live connections that would be deleted
--   invites:     invites they made that are waiting
create function public.account_deletion_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_account_owner();
  return jsonb_build_object(
    'email', private.email_of(private.uid()),
    'sole_owner', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name)) from private.sole_owned() s), '[]'::jsonb),
    'vaults', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'role', m.role) order by v.name, v.id)
                          from public.vaults v join public.vault_members m on m.vault_id = v.id
                         where m.user_id = private.uid()), '[]'::jsonb),
    'connections', (select count(*) from public.access_tokens t
                     where t.user_id = private.uid() and t.revoked_at is null
                       and (t.expires_at is null or t.expires_at > now())),
    'invites', (select count(*) from private.vault_invites i
                 where i.created_by = private.uid()
                   and private.invite_state(i.accepted_at, i.revoked_at, i.expires_at) = 'pending'));
end $$;

-- Deletes the caller's account (see the top of this file). p_confirm is
-- their email address as they typed it (compared as addresses are:
-- trimmed, NFC, without case), or "delete my account" for an account with
-- no address. Returns counts: {vaults, connections, invites}.
create function public.delete_account(p_confirm text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me uuid := private.uid();
  v_email text;
  v_sole text[];
  v_n_sole int;
  v_row record;
  v_vaults int := 0;
  v_connections int;
  v_invites int := 0;
begin
  perform private.require_account_owner();
  v_email := private.email_of(v_me);
  if v_email is not null then
    if p_confirm is null or private.email_key(p_confirm) <> v_email then
      raise exception 'type your email address exactly to delete your account' using errcode = '22023';
    end if;
  elsif lower(trim(coalesce(p_confirm, ''))) <> 'delete my account' then
    raise exception 'type "delete my account" to delete your account' using errcode = '22023';
  end if;

  -- Locks in the order delete_vault, create_invite and accept_invite take
  -- them (20260925240100_lock_order.sql): the vaults' rows, by id, then
  -- each vault's owners (set_member's and leave_vault's order), so a role
  -- change, a leave or a vault deletion at the same time waits for this or
  -- this for it, and the only-owner check below can't be outrun.
  perform 1 from public.vaults
   where id in (select vault_id from public.vault_members where user_id = v_me)
      or created_by = v_me
   order by id for update;
  perform 1 from public.vault_members
   where role = 'owner' and vault_id in (select vault_id from public.vault_members where user_id = v_me)
   order by vault_id, user_id for update;

  select array_agg(format('“%s”', s.name) order by s.name, s.id), count(*) into v_sole, v_n_sole from private.sole_owned() s;
  if v_n_sole > 0 then
    raise exception 'you are the only owner of %: in each, make someone else an owner on Members, or delete the vault; then delete your account',
        case when v_n_sole <= 10 then array_to_string(v_sole, ', ')
             else array_to_string(v_sole[1:10], ', ') || format(' and %s more', v_n_sole - 10) end
      using errcode = '55000',
            detail = jsonb_build_object('only_owner_of', (select jsonb_agg(s.id) from private.sole_owned() s))::text;
  end if;

  -- Vaults they created count against the longest-standing other owner.
  update public.vaults v
     set created_by = (select o.user_id from public.vault_members o
                        where o.vault_id = v.id and o.role = 'owner' and o.user_id <> v_me
                        order by o.added_at, o.user_id limit 1)
   where v.created_by = v_me
     and exists (select 1 from public.vault_members o
                  where o.vault_id = v.id and o.role = 'owner' and o.user_id <> v_me);

  -- Connections go first, so leaving vaults narrows nothing that is about
  -- to be deleted anyway.
  with gone as (
    delete from public.access_tokens t
     where t.user_id = v_me
    returning t.revoked_at is null and (t.expires_at is null or t.expires_at > now()) as live
  )
  select count(*) filter (where live) into v_connections from gone;

  for v_row in select m.vault_id, m.role from public.vault_members m where m.user_id = v_me order by m.vault_id loop
    perform private.log_event(v_row.vault_id, 'member.leave', null, null, null,
      jsonb_build_object('user', v_me, 'role', v_row.role, 'account_deleted', true));
    v_vaults := v_vaults + 1;
  end loop;
  delete from public.vault_members where user_id = v_me;

  for v_row in
    update private.vault_invites set revoked_at = now(), revoked_by = v_me
     where created_by = v_me and private.invite_state(accepted_at, revoked_at, expires_at) = 'pending'
    returning id, vault_id
  loop
    perform private.log_event(v_row.vault_id, 'invite.revoke', null, null, null,
      jsonb_build_object('invite', v_row.id, 'account_deleted', true));
    v_invites := v_invites + 1;
  end loop;
  delete from private.vault_invites where accepted_by = v_me;

  delete from public.env_imports where created_by = v_me and source = 'web' and status = 'pending';
  delete from public.review_snoozes where user_id = v_me;
  delete from public.profiles where user_id = v_me;
  delete from private.vault_deletion_notices where user_id = v_me;
  delete from private.account_plans where user_id = v_me;
  delete from private.admissions where user_id = v_me;
  delete from private.session_cutoffs where user_id = v_me;

  delete from auth.users where id = v_me;
  insert into private.deleted_accounts (user_id) values (v_me);

  return jsonb_build_object('vaults', v_vaults, 'connections', v_connections, 'invites', v_invites);
end $$;

-- co_member_people (20260926100000_shell_inbox.sql), plus: a deleted
-- account, named as one (deleted, with no email or name) to whoever asks,
-- in person; its id is all anyone had of it.
drop function public.co_member_people(uuid[]);
create function public.co_member_people(p_users uuid[])
returns table (user_id uuid, email text, display_name text, deleted boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if cardinality(p_users) > private.email_batch_cap() then
    raise exception 'at most % people at once', private.email_batch_cap() using errcode = '54000';
  end if;
  return query
    select u.id, lower(au.email::text), pr.display_name, false
      from (select distinct x as id from unnest(coalesce(p_users, '{}')) x where x is not null) u
      left join auth.users au on au.id = u.id
      left join public.profiles pr on pr.user_id = u.id
     where (au.email is not null or pr.display_name is not null)
       and (u.id = private.uid()
            or exists (select 1 from public.vault_members mine
                         join public.vault_members theirs on theirs.vault_id = mine.vault_id
                        where mine.user_id = private.uid() and theirs.user_id = u.id))
    union all
    select d.user_id, null, null, true
      from private.deleted_accounts d
     where d.user_id = any(coalesce(p_users, '{}'));
end $$;

revoke all on function private.require_account_owner(), private.sole_owned()
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
revoke all on function public.account_deletion_summary(), public.delete_account(text),
  public.co_member_people(uuid[])
  from public, anon;
grant execute on function public.account_deletion_summary(), public.delete_account(text),
  public.co_member_people(uuid[])
  to authenticated;
