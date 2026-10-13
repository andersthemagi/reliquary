-- How people see you (issue #347; hostile tests in
-- supabase/tests/display_preferences_test.sql). A person is their user id;
-- how others see them is their choice, within reason:
--
-- 1. public.display_preferences: "Show me to others as" display name and
--    email (the default, no row needed) or display name alone. Your own
--    row, set in person only (public.set_email_shown), like the display
--    name itself.
-- 2. public.vaults.require_emails: an owner, in person, can make a vault
--    require that its members' emails be visible (public.set_require_emails).
-- 3. public.email_consents: a member who hides their email agrees to show
--    it in a vault that requires it (public.consent_to_show_email), or
--    leaves. The row hangs off their membership, so leaving (or being
--    removed) takes the consent with it, and a vault that stops requiring
--    emails forgets every consent it had: turning it back on asks again.
--    Until they agree, their email stays hidden, there too.
-- 4. private.email_hidden(person): the one rule. An agent never gets an
--    email, anyone's, whatever their choice or a vault's requirement
--    (owner, 2026-10-13: agents get the least that tells people apart,
--    never contact details). For a person, an email is hidden unless they
--    are its owner, its owner shows it, or its owner consented in a vault
--    that requires emails and that the caller is in. Consent in vault A
--    shows the email to A's members, wherever they read it, and to nobody
--    who shares only B.
-- 5. public.co_member_people, where pages (web/src/people.ts) and MCP
--    responses (mcp/src/tools-shared.ts) resolve a person, applies it and
--    writes the label both show: "Ana (ana@example.com)", the email alone,
--    or, when hidden, "Ana · 3f2a1b9c" (the first 8 characters of the id,
--    so two Anas can be told apart) or the tag alone. Agents may call it
--    now, through their token's vaults only, and always get the name and
--    tag with no email.
--    list_members, my_invites, my_deletion_notices, take_deletion_notices
--    and co_member_emails give a hidden email as null.

-- ---------------------------------------------------------------------------
-- 1. The choice

create table public.display_preferences (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  show_email boolean not null,
  updated_at timestamptz not null default now()
);
alter table public.display_preferences enable row level security;
revoke all on public.display_preferences from public, anon, authenticated;
grant select on public.display_preferences to authenticated;
create policy own_display_read on public.display_preferences for select to authenticated
  using (user_id = (select private.uid()) and (select private.agent()) is null);

create function public.set_email_shown(p_show boolean) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.uid() is null or private.agent() is not null then
    raise exception 'only you, signed in to the web app, can choose how people see you' using errcode = '42501';
  end if;
  if p_show is null then
    raise exception 'choose to show your email or to hide it' using errcode = '22023';
  end if;
  insert into public.display_preferences (user_id, show_email) values (private.uid(), p_show)
  on conflict (user_id) do update set show_email = excluded.show_email, updated_at = now();
  return p_show;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Vaults that require emails

alter table public.vaults add column require_emails boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. Consent

create table public.email_consents (
  vault_id     uuid not null,
  user_id      uuid not null,
  consented_at timestamptz not null default now(),
  primary key (vault_id, user_id),
  foreign key (vault_id, user_id) references public.vault_members (vault_id, user_id) on delete cascade
);
alter table public.email_consents enable row level security;
revoke all on public.email_consents from public, anon, authenticated;

create function public.set_require_emails(p_vault uuid, p_on boolean) returns void
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
  if not p_on then
    delete from public.email_consents where vault_id = p_vault;
  end if;
  perform private.log_event(p_vault, 'vault.require_emails', null, null, null,
    jsonb_build_object('require_emails', p_on));
end $$;

create function public.consent_to_show_email(p_vault uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if not (select require_emails from public.vaults where id = p_vault) then
    raise exception 'this vault doesn''t require members'' emails, so there is nothing to agree to' using errcode = '22023';
  end if;
  insert into public.email_consents (vault_id, user_id) values (p_vault, private.uid())
  on conflict do nothing;
end $$;

-- Whether the caller should be asked, on this vault's pages, to show their
-- email or leave: the vault requires emails, they hide theirs, and they
-- haven't agreed here.
create function public.email_consent_needed(p_vault uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(v.require_emails, false)
     and exists (select 1 from public.display_preferences d where d.user_id = private.uid() and not d.show_email)
     and not exists (select 1 from public.email_consents c where c.vault_id = p_vault and c.user_id = private.uid())
    from public.vaults v
   where v.id = p_vault and private.role_in(p_vault) is not null
$$;

-- ---------------------------------------------------------------------------
-- 4. The rule

-- A consent only exists while its vault requires emails (consent_to_show_email
-- refuses otherwise, and set_require_emails deletes them on the way off),
-- and only while its person is a member (the foreign key), so neither is
-- checked again here.
create function private.email_hidden(p_person uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.agent() is not null
      or (p_person is distinct from private.uid()
          and exists (select 1 from public.display_preferences d where d.user_id = p_person and not d.show_email)
          and not exists (select 1 from public.email_consents c
                           where c.user_id = p_person and private.role_in(c.vault_id) is not null))
$$;

-- ---------------------------------------------------------------------------
-- 5. Where people are resolved

-- co_member_people (20260926140200_delete_account.sql), plus: the rule
-- above, the label, and agents (through their token's vaults: the vaults
-- the caller shares with someone are the ones role_in still gives a role;
-- the rule gives them no email at all, their own person's included).
drop function public.co_member_people(uuid[]);
create function public.co_member_people(p_users uuid[])
returns table (user_id uuid, email text, display_name text, deleted boolean, label text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_person();
  if cardinality(p_users) > private.email_batch_cap() then
    raise exception 'at most % people at once', private.email_batch_cap() using errcode = '54000';
  end if;
  return query
    with mine as (
      select m.vault_id from public.vault_members m
       where m.user_id = private.uid() and private.role_in(m.vault_id) is not null
    ), seen as (
      select u.id, pr.display_name as name,
             case when private.email_hidden(u.id) then null else lower(au.email::text) end as email
        from (select distinct x as id from unnest(coalesce(p_users, '{}')) x where x is not null) u
        left join auth.users au on au.id = u.id
        left join public.profiles pr on pr.user_id = u.id
       where (au.email is not null or pr.display_name is not null)
         and (u.id = private.uid()
              or exists (select 1 from public.vault_members theirs
                          where theirs.user_id = u.id and theirs.vault_id in (select vault_id from mine)))
    )
    select s.id, s.email, s.name, false,
           case when s.email is not null and s.name is not null then s.name || ' (' || s.email || ')'
                when s.email is not null then s.email
                when s.name is not null then s.name || ' · ' || left(s.id::text, 8)
                else left(s.id::text, 8) end
      from seen s
    union all
    select d.user_id, null, null, true, 'a deleted account'
      from private.deleted_accounts d
     where d.user_id = any(coalesce(p_users, '{}'));
end $$;

-- co_member_emails (20260925160000_membership_polish.sql), with the rule.
create or replace function public.co_member_emails(p_users uuid[])
returns table (user_id uuid, email text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if cardinality(p_users) > private.email_batch_cap() then
    raise exception 'at most % people at once', private.email_batch_cap() using errcode = '54000';
  end if;
  return query
    select u.id, lower(au.email::text)
      from (select distinct x as id from unnest(coalesce(p_users, '{}')) x where x is not null) u
      join auth.users au on au.id = u.id
     where au.email is not null
       and not private.email_hidden(u.id)
       and (u.id = private.uid()
            or exists (select 1 from public.vault_members mine
                         join public.vault_members theirs on theirs.vault_id = mine.vault_id
                        where mine.user_id = private.uid() and theirs.user_id = u.id));
end $$;

-- list_members (20260925140000_invites.sql), with the rule; hidden emails
-- sort as no email, so the order gives nothing away.
create or replace function public.list_members(p_vault uuid)
returns table (user_id uuid, email text, role text, added_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  return query
    select x.user_id, x.email, x.role, x.added_at
      from (select m.user_id, m.role, m.added_at,
                   case when private.email_hidden(m.user_id) then null else private.email_of(m.user_id) end as email
              from public.vault_members m
             where m.vault_id = p_vault) x
     order by case x.role when 'owner' then 0 when 'editor' then 1 else 2 end,
              x.email nulls last, x.user_id;
end $$;

-- my_invites (20260926140000_inbox_join.sql), with the rule for the inviter.
create or replace function public.my_invites()
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
    select i.id, v.name, i.role,
           case when private.email_hidden(i.created_by) then null else private.email_of(i.created_by) end,
           i.created_at, i.expires_at
      from private.vault_invites i
      join public.vaults v on v.id = i.vault_id
     where i.email = v_email
       and private.invite_state(i.accepted_at, i.revoked_at, i.expires_at) = 'pending'
       and not exists (select 1 from public.vault_members m where m.vault_id = i.vault_id and m.user_id = private.uid())
     order by i.created_at desc
     limit 50;
end $$;

-- my_deletion_notices (20260926100000_shell_inbox.sql), with the rule for
-- whoever deleted the vault.
create or replace function public.my_deletion_notices()
returns table (vault_name text, deleted_by_email text, deleted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  return query
    select n.vault_name,
           case when private.email_hidden(n.deleted_by) then null else private.email_of(n.deleted_by) end,
           n.deleted_at
      from private.vault_deletion_notices n
     where n.user_id = private.uid()
       and n.deleted_at >= now() - make_interval(days => private.notice_days())
     order by n.deleted_at desc
     limit 50;
end $$;

-- take_deletion_notices (20260925160000_membership_polish.sql), likewise.
create or replace function public.take_deletion_notices()
returns table (vault_name text, deleted_by_email text, deleted_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  return query
    with gone as (
      delete from private.vault_deletion_notices n where n.user_id = private.uid()
      returning n.vault_name, n.deleted_by, n.deleted_at
    )
    select g.vault_name,
           case when private.email_hidden(g.deleted_by) then null else private.email_of(g.deleted_by) end,
           g.deleted_at from gone g
     where g.deleted_at >= now() - make_interval(days => private.notice_days())
     order by g.deleted_at desc;
end $$;

-- shell_summary (20260926180000_welcome_tour.sql) with the caller's choice
-- added as show_email, so Account settings still costs no query of its
-- own; nothing else changes.
create or replace function public.shell_summary(p_items int default 5)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_me uuid := private.uid();
  v_n int := least(greatest(coalesce(p_items, 5), 0), 20);
  v_out jsonb;
begin
  if v_me is null or private.agent() is not null then
    raise exception 'only you, signed in to the web app, can read your inbox' using errcode = '42501';
  end if;
  with review as (
    select p.id, p.vault_id, v.name as vault, p.kind, p.path, p.created_at as at, (f.id is null) as new_file
      from public.proposals p
      join public.vaults v on v.id = p.vault_id
      join public.vault_members m on m.vault_id = p.vault_id and m.user_id = v_me and m.role in ('owner', 'editor')
      left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
     where p.status = 'open'
       and not exists (select 1 from public.approvals a
                        where a.proposal_id = p.id and a.user_id = v_me and a.revision = p.revision)
       and not exists (select 1 from public.active_snoozes s where s.proposal_id = p.id and s.user_id = v_me)
  ), revise as (
    select p.id, p.vault_id, v.name as vault, p.path,
           coalesce((select max(a.at) from public.approvals a
                      where a.proposal_id = p.id and a.decision = 'request_changes'), p.created_at) as at
      from public.proposals p
      join public.vaults v on v.id = p.vault_id
     where p.status = 'changes_requested' and p.proposed_by = v_me
  ), imports as (
    select i.id, i.vault_id, v.name as vault, cardinality(i.names) as names, i.environments, i.created_at as at
      from public.env_imports i
      join public.vaults v on v.id = i.vault_id
     where i.source = 'cli' and i.status = 'pending' and i.expires_at > now()
       and (private.role_in(i.vault_id) = 'owner'
            or (private.role_in(i.vault_id) = 'editor'
                and not exists (select 1 from public.environments e
                                 where e.vault_id = i.vault_id and e.name = any(i.environments) and e.owners_only)))
  ), invites as (
    select * from public.my_invites()
  ), notices as (
    select * from public.my_deletion_notices()
  ), items as (
    select 'review' as kind, r.at, jsonb_build_object('kind', 'review', 'id', r.id, 'vault_id', r.vault_id,
             'vault', r.vault, 'path', r.path, 'verb', case when r.kind = 'delete' then 'Delete'
                                                            when r.new_file then 'Create' else 'Change' end,
             'at', r.at) as j
      from review r
    union all
    select 'revise', x.at, jsonb_build_object('kind', 'revise', 'id', x.id, 'vault_id', x.vault_id,
             'vault', x.vault, 'path', x.path, 'at', x.at)
      from revise x
    union all
    select 'import', i.at, jsonb_build_object('kind', 'import', 'id', i.id, 'vault_id', i.vault_id,
             'vault', i.vault, 'names', i.names, 'environments', to_jsonb(i.environments), 'at', i.at)
      from imports i
    union all
    select 'invite', iv.created_at, jsonb_build_object('kind', 'invite', 'vault', iv.vault_name, 'role', iv.role,
             'by', iv.invited_by_email, 'expires_at', iv.expires_at, 'at', iv.created_at)
      from invites iv
    union all
    select 'notice', n.deleted_at, jsonb_build_object('kind', 'notice', 'vault', n.vault_name,
             'by', n.deleted_by_email, 'at', n.deleted_at)
      from notices n
  ), mine as (
    select v.id, v.name, m.role
      from public.vaults v
      join public.vault_members m on m.vault_id = v.id and m.user_id = v_me
  )
  select jsonb_build_object(
    'me', coalesce((select jsonb_build_object('email', p.email, 'name', p.display_name)
                      from public.co_member_people(array[v_me]) p), jsonb_build_object('email', null, 'name', null)),
    'vaults', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'role', s.role) order by s.name, s.id)
                          from (select * from mine order by name, id limit 50) s), '[]'::jsonb),
    'more_vaults', (select count(*) > 50 from mine),
    'counts', jsonb_build_object(
      'review', (select count(*) from review),
      'revise', (select count(*) from revise),
      'imports', (select count(*) from imports),
      'invites', (select count(*) from invites),
      'notices', (select count(*) from notices)),
    'items', coalesce((select jsonb_agg(t.j order by t.at desc)
                         from (select j, at from items order by at desc limit v_n) t), '[]'::jsonb))
    into v_out;
  return v_out || jsonb_build_object('total',
    (select sum(value::int) from jsonb_each_text(v_out -> 'counts')),
    'welcome_unseen', not exists (select 1 from public.welcome_seen w where w.user_id = v_me),
    'show_email', coalesce((select d.show_email from public.display_preferences d where d.user_id = v_me), true));
end $$;

revoke all on function private.email_hidden(uuid)
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
revoke all on function public.set_email_shown(boolean), public.set_require_emails(uuid, boolean),
  public.consent_to_show_email(uuid), public.email_consent_needed(uuid), public.co_member_people(uuid[])
  from public, anon;
grant execute on function public.set_email_shown(boolean), public.set_require_emails(uuid, boolean),
  public.consent_to_show_email(uuid), public.email_consent_needed(uuid), public.co_member_people(uuid[])
  to authenticated;
