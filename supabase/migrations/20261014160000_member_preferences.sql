-- A member's per-vault choices are theirs alone and outlive their
-- membership (owner, 2026-10-13; hostile tests in
-- supabase/tests/member_preferences_test.sql). Fixes forward
-- 20261014150000_display_preferences.sql, whose email_consents hung off
-- the membership (leaving dropped the consent) and which an owner turning
-- the requirement off cleared.
--
-- 1. public.member_preferences: one row per person, vault and preference
--    (today only show_email), with its value and when it was set. Only the
--    vault's deletion (on delete cascade) or the account's erasure removes
--    a row; leaving, removal and the vault's requirement changing leave it
--    alone. No API role reads or writes the table: only the functions
--    below do.
-- 2. public.set_member_preference(vault, preference, value): the caller's
--    own row, in person, while they are a member, either way.
--    consent_to_show_email (the web notice) is it with show_email = true.
-- 3. set_require_emails no longer deletes anything.
-- 4. The rule (private.email_hidden): a show_email row reveals the email,
--    to people only (an agent never gets one), to readers who share that
--    vault, only while its person is a member of it and the vault requires
--    emails. The row stays when either stops being true, and reveals
--    nothing meanwhile: a former member's row until they rejoin, a vault's
--    rows until it requires emails again. Then it applies again with no
--    new prompt.

-- ---------------------------------------------------------------------------
-- 1. The table

create table public.member_preferences (
  user_id    uuid not null references auth.users (id) on delete cascade,
  vault_id   uuid not null references public.vaults (id) on delete cascade,
  preference text not null check (preference in ('show_email')),
  value      boolean not null,
  set_at     timestamptz not null default now(),
  primary key (user_id, vault_id, preference)
);
create index on public.member_preferences (vault_id);
alter table public.member_preferences enable row level security;
revoke all on public.member_preferences
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;

insert into public.member_preferences (user_id, vault_id, preference, value, set_at)
select user_id, vault_id, 'show_email', true, consented_at from public.email_consents;

-- ---------------------------------------------------------------------------
-- 2. Setting your own

create function public.set_member_preference(p_vault uuid, p_preference text, p_value boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if p_preference is distinct from 'show_email' then
    raise exception 'there is no vault preference called "%"; the one there is: show_email', p_preference using errcode = '22023';
  end if;
  if p_value is null then
    raise exception 'say whether to show your email in this vault or not' using errcode = '22023';
  end if;
  insert into public.member_preferences (user_id, vault_id, preference, value)
  values (private.uid(), p_vault, p_preference, p_value)
  on conflict (user_id, vault_id, preference) do update set value = excluded.value, set_at = now();
end $$;

-- As in 20261014150000_display_preferences.sql, stored as the caller's
-- show_email row for the vault.
create or replace function public.consent_to_show_email(p_vault uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if not (select require_emails from public.vaults where id = p_vault) then
    raise exception 'this vault doesn''t require members'' emails, so there is nothing to agree to' using errcode = '22023';
  end if;
  perform public.set_member_preference(p_vault, 'show_email', true);
end $$;

-- ---------------------------------------------------------------------------
-- 3. The requirement changes nobody's choice

create or replace function public.set_require_emails(p_vault uuid, p_on boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_old boolean;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners decide whether a vault requires members'' emails' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'say whether the vault requires members'' emails' using errcode = '22023';
  end if;
  select require_emails into v_old from public.vaults where id = p_vault for update;
  if v_old = p_on then
    return;
  end if;
  update public.vaults set require_emails = p_on where id = p_vault;
  perform private.log_event(p_vault, 'vault.require_emails', null, null, null,
    jsonb_build_object('require_emails', p_on));
end $$;

-- ---------------------------------------------------------------------------
-- 4. The rule, and who is asked

create or replace function public.email_consent_needed(p_vault uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(v.require_emails, false)
     and exists (select 1 from public.display_preferences d where d.user_id = private.uid() and not d.show_email)
     and not exists (select 1 from public.member_preferences p
                      where p.user_id = private.uid() and p.vault_id = p_vault and p.preference = 'show_email' and p.value)
    from public.vaults v
   where v.id = p_vault and private.role_in(p_vault) is not null
$$;

create or replace function private.email_hidden(p_person uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.agent() is not null
      or (p_person is distinct from private.uid()
          and exists (select 1 from public.display_preferences d where d.user_id = p_person and not d.show_email)
          and not exists (select 1 from public.member_preferences p
                            join public.vault_members m on m.vault_id = p.vault_id and m.user_id = p.user_id
                            join public.vaults v on v.id = p.vault_id and v.require_emails
                           where p.user_id = p_person and p.preference = 'show_email' and p.value
                             and private.role_in(p.vault_id) is not null))
$$;

drop table public.email_consents;

revoke all on function public.set_member_preference(uuid, text, boolean) from public, anon;
grant execute on function public.set_member_preference(uuid, text, boolean) to authenticated;
