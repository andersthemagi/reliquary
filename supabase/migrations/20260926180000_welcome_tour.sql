-- The Welcome tour (web/src/welcome.ts): a short slideshow shown once, right
-- after a person first signs in, and any time from the account menu.
-- Whether they have seen it is the person's own, in person only: an agent,
-- token, OAuth client or CLI grant reads and writes nothing here (RLS, as
-- for display names). Hostile tests: supabase/tests/welcome_test.sql.
--
-- A person is "unseen" when they have no row. Everyone who has an account
-- when this migration runs is marked seen below, so existing accounts are
-- never shown the tour by itself; accounts created afterwards (people an
-- owner invites, included) start unseen. The row goes with the account.
-- public.shell_summary (20260926100000_shell_inbox.sql) says which, in the
-- call every page already makes, as welcome_unseen.

create table public.welcome_seen (
  user_id uuid primary key references auth.users (id) on delete cascade,
  seen_at timestamptz not null default now()
);
alter table public.welcome_seen enable row level security;
revoke all on public.welcome_seen from public, anon, authenticated;
grant select, insert on public.welcome_seen to authenticated;

create policy own_welcome_read on public.welcome_seen for select to authenticated
  using (user_id = (select private.uid()) and (select private.agent()) is null);
create policy own_welcome_insert on public.welcome_seen for insert to authenticated
  with check (user_id = (select private.uid()) and (select private.agent()) is null);

insert into public.welcome_seen (user_id) select id from auth.users on conflict do nothing;

-- Marks the tour seen (finished or skipped) for the caller. Security
-- invoker: the policies decide; this says why in words. Doing it again is
-- harmless.
create function public.mark_welcome_seen() returns void
language plpgsql volatile security invoker set search_path = '' as $$
begin
  if private.uid() is null or private.agent() is not null then
    raise exception 'only you, signed in to the web app, can mark the welcome tour seen' using errcode = '42501';
  end if;
  insert into public.welcome_seen (user_id) values (private.uid()) on conflict do nothing;
end $$;
revoke all on function public.mark_welcome_seen() from public, anon;
grant execute on function public.mark_welcome_seen() to authenticated;

-- shell_summary with welcome_unseen added; nothing else changes.
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
    'welcome_unseen', not exists (select 1 from public.welcome_seen w where w.user_id = v_me));
end $$;
