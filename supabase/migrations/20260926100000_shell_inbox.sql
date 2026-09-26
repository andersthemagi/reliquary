-- The web app's shell (web/src/html.ts, web/src/inbox.ts; hostile tests in
-- supabase/tests/shell_inbox_test.sql):
--
-- 1. Display names. A person may give themself a name, shown next to their
--    email wherever the web app already shows the email (co-members and
--    themself). Profile management is the person's, in person: an agent,
--    token, OAuth client or CLI grant is refused (docs/parity.md). RLS
--    keeps each row its person's; co-members read names only through
--    public.co_member_people, which has co_member_emails' rule.
-- 2. The header's one call, public.shell_summary: who you are, your vaults
--    (for the vault switcher), and your inbox, as counts and the newest few
--    items. One round trip per page, replacing the Review count's.
-- 3. What the inbox shows beyond proposals: invites waiting for your address
--    (public.my_invites) and vault deletion notices, peeked without taking
--    them (public.my_deletion_notices; Home and the Inbox page still take
--    them with public.take_deletion_notices).

-- ---------------------------------------------------------------------------
-- 1. Display names

-- Characters a name may not start or end with: ASCII white space and the
-- Unicode spaces (no-break, ogham, en to hair, line and paragraph
-- separators, narrow no-break, medium mathematical, ideographic). As a
-- regular expression bracket expression, built from code points so this
-- file holds no invisible characters.
create function private.name_spaces() returns text
language sql immutable set search_path = '' as $$
  select '[[:space:]' || chr(160) || chr(5760) || chr(8192) || '-' || chr(8202)
      || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || ']'
$$;

-- Characters a name may not hold anywhere: the soft hyphen, the Arabic
-- letter mark, the Mongolian vowel separator, zero-width spaces, joiners
-- and direction marks (U+200B to U+200F), bidi embeddings and overrides
-- (U+202A to U+202E), word joiners, invisible operators and bidi isolates
-- (U+2060 to U+206F), and the byte-order mark.
create function private.name_invisibles() returns text
language sql immutable set search_path = '' as $$
  select '[' || chr(173) || chr(1564) || chr(6158) || chr(8203) || '-' || chr(8207)
      || chr(8234) || '-' || chr(8238) || chr(8288) || '-' || chr(8303) || chr(65279) || ']'
$$;

-- A name as the database takes it: 1 to 80 characters, no space at either
-- end, no control characters, none of the invisible or direction-changing
-- characters above, and no "@", so a name can't pass for an address next
-- to the real one.
create function private.display_name_ok(p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select p_name is not null
     and char_length(p_name) between 1 and 80
     and p_name !~ ('^' || private.name_spaces() || '|' || private.name_spaces() || '$')
     and p_name !~ '[[:cntrl:]]'
     and p_name !~ private.name_invisibles()
     and strpos(p_name, '@') = 0
$$;

create table public.profiles (
  user_id      uuid primary key,
  display_name text not null check (private.display_name_ok(display_name)),
  updated_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;
revoke all on public.profiles from public, anon, authenticated;
grant select, insert, update, delete on public.profiles to authenticated;

-- Your own row, and only in person. Everyone else's names come through
-- co_member_people.
create policy own_profile_read on public.profiles for select to authenticated
  using (user_id = (select private.uid()) and (select private.agent()) is null);
create policy own_profile_insert on public.profiles for insert to authenticated
  with check (user_id = (select private.uid()) and (select private.agent()) is null);
create policy own_profile_update on public.profiles for update to authenticated
  using (user_id = (select private.uid()) and (select private.agent()) is null)
  with check (user_id = (select private.uid()) and (select private.agent()) is null);
create policy own_profile_delete on public.profiles for delete to authenticated
  using (user_id = (select private.uid()) and (select private.agent()) is null);

-- Sets (or, given nothing but spaces, clears) the caller's display name.
-- Security invoker: the policies above decide, and this only says why a
-- name is refused in words a person can act on. Returns the name kept, or
-- null when cleared. (private.require_human isn't the signed-in role's to
-- call, so the same check is written out here.)
create function public.set_display_name(p_name text) returns text
language plpgsql volatile security invoker set search_path = '' as $$
declare
  -- Spaces at either end go, Unicode ones included.
  v_name text := regexp_replace(coalesce(p_name, ''),
    '^' || private.name_spaces() || '+|' || private.name_spaces() || '+$', '', 'g');
begin
  if private.uid() is null or private.agent() is not null then
    raise exception 'only you, signed in to the web app, can set your display name' using errcode = '42501';
  end if;
  if v_name = '' then
    delete from public.profiles where user_id = private.uid();
    return null;
  end if;
  if char_length(v_name) > 80 then
    raise exception 'a display name is at most 80 characters' using errcode = '22023';
  end if;
  if strpos(v_name, '@') > 0 then
    raise exception 'a display name can''t contain "@", so it never looks like an email address' using errcode = '22023';
  end if;
  if not private.display_name_ok(v_name) then
    raise exception 'a display name can''t contain control characters, invisible characters or text-direction marks'
      using errcode = '22023';
  end if;
  insert into public.profiles (user_id, display_name) values (private.uid(), v_name)
  on conflict (user_id) do update set display_name = excluded.display_name, updated_at = now();
  return v_name;
end $$;

-- co_member_emails (20260925160000_membership_polish.sql) with each
-- person's display name: the same people, by the same rule (the caller, and
-- whoever shares a vault with them now), for a person in person only.
-- Someone with a name and no email is shown by name.
create function public.co_member_people(p_users uuid[])
returns table (user_id uuid, email text, display_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if cardinality(p_users) > private.email_batch_cap() then
    raise exception 'at most % people at once', private.email_batch_cap() using errcode = '54000';
  end if;
  return query
    select u.id, lower(au.email::text), pr.display_name
      from (select distinct x as id from unnest(coalesce(p_users, '{}')) x where x is not null) u
      left join auth.users au on au.id = u.id
      left join public.profiles pr on pr.user_id = u.id
     where (au.email is not null or pr.display_name is not null)
       and (u.id = private.uid()
            or exists (select 1 from public.vault_members mine
                         join public.vault_members theirs on theirs.vault_id = mine.vault_id
                        where mine.user_id = private.uid() and theirs.user_id = u.id));
end $$;

-- ---------------------------------------------------------------------------
-- 3. Invites for your address, and deletion notices without taking them

-- Pending invites to the caller's address, in person only: the vault's
-- name, the role, who invited them and until when. Never the token (only
-- its hash is stored) or the invite's id: joining still needs the link.
create function public.my_invites()
returns table (vault_name text, role text, invited_by_email text, created_at timestamptz, expires_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_email text;
begin
  perform private.require_human();
  v_email := private.email_of(private.uid());
  if v_email is null then
    return;
  end if;
  return query
    select v.name, i.role, private.email_of(i.created_by), i.created_at, i.expires_at
      from private.vault_invites i
      join public.vaults v on v.id = i.vault_id
     where i.email = v_email
       and private.invite_state(i.accepted_at, i.revoked_at, i.expires_at) = 'pending'
       and not exists (select 1 from public.vault_members m where m.vault_id = i.vault_id and m.user_id = private.uid())
     order by i.created_at desc
     limit 50;
end $$;

-- The caller's deletion notices, left in place (take_deletion_notices shows
-- and deletes them): for the header's count and list.
create function public.my_deletion_notices()
returns table (vault_name text, deleted_by_email text, deleted_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  return query
    select n.vault_name, private.email_of(n.deleted_by), n.deleted_at
      from private.vault_deletion_notices n
     where n.user_id = private.uid()
       and n.deleted_at >= now() - make_interval(days => private.notice_days())
     order by n.deleted_at desc
     limit 50;
end $$;

-- ---------------------------------------------------------------------------
-- 2. The header's one call

-- Everything the top bar shows, as one JSON object, for a person in person:
--   me:     {email, name}
--   vaults: [{id, name, role}], by name, at most 50 (the vault switcher)
--   more_vaults: whether there are more than 50
--   counts: {review, revise, imports, invites, notices}, and total
--   items:  the newest p_items (0 to 20) of all of them, newest first
-- Security invoker: proposals, imports and vaults are read under their RLS
-- as the caller; invites and notices through the two functions above.
-- The review count is the Review inbox's: open proposals in vaults where
-- the caller is an owner or editor, not yet decided by them at this
-- revision, and not snoozed by them.
create function public.shell_summary(p_items int default 5)
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
    (select sum(value::int) from jsonb_each_text(v_out -> 'counts')));
end $$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.display_name_ok(text), private.name_spaces(), private.name_invisibles()
  from public, anon, authenticated;
-- The table's check constraint and set_display_name call them as the writer.
grant execute on function private.display_name_ok(text), private.name_spaces(), private.name_invisibles()
  to authenticated;

revoke all on function public.set_display_name(text), public.co_member_people(uuid[]),
  public.my_invites(), public.my_deletion_notices(), public.shell_summary(int)
  from public, anon;
grant execute on function public.set_display_name(text), public.co_member_people(uuid[]),
  public.my_invites(), public.my_deletion_notices(), public.shell_summary(int)
  to authenticated;
