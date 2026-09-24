-- Membership and export, polished and hardened (docs/parity.md, docs/design.md
-- "Deleting a vault"). Everything here is a person's, in person
-- (require_human): managing members, leaving, exporting and deleting are in
-- the delegation ceiling (AGENTS.md), and the emails and notices below are
-- for a person's eyes, never a model's.
--
-- 1. Invites only. set_member changes a member's role or removes them; it
--    no longer adds anyone. A new person joins a vault only by accepting an
--    invite sent to their address (accept_invite), or by creating the vault.
--    So nobody, not even an owner, can put someone in a vault (and in front
--    of its canon and its variable names) without that person's own act.
--
-- 2. Invite rate. An owner creates at most 20 invites an hour, across all
--    their vaults (on top of the 50 waiting per vault): each invite is a
--    link that may be emailed to a stranger.
--
-- 3. Leaving. leave_vault: any member removes themself, in person. The last
--    owner can't (make someone else an owner, or delete the vault). Logged
--    as member.leave with the person's id and former role.
--
-- 4. Emails where people are shown. co_member_emails(ids) answers, in one
--    call, the emails of those ids that share a vault with the caller now
--    (and the caller's own). Anyone else, including a former co-member, gets
--    no row: the web UI shows a short id instead.
--
-- 5. Deletion notices. When an owner deletes a vault, each other member gets
--    one notice (vault name, who deleted it, when) that the web UI shows
--    once, on Home, within 30 days; showing it deletes it. The name is kept
--    on purpose: every recipient already had it, and "a vault you were in"
--    tells someone in several vaults nothing. It goes only to the people who
--    could read it the moment before, never into private.vault_deletions
--    (which stays nameless), and lives at most 30 days. The delete page says
--    so before the owner confirms.
--
-- 6. Export. export_vault fixes the export's contents when it starts: in one
--    statement (one snapshot) it reads the header and records each live
--    file's current version id. export_files then serves those versions a
--    page at a time, whatever is written meanwhile, so the archive is one
--    consistent moment without a long transaction on a pooled connection.
--    Versions are immutable except erasure, and erasure wins: a file erased
--    mid-export is left out. An export can be continued for 2 hours. At most
--    10 exports of a vault an hour.

-- ---------------------------------------------------------------------------
-- 1. set_member: change or remove, never add

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
  if p_role is null and p_user = private.uid() then
    raise exception 'owners cannot remove themselves' using errcode = '42501';
  end if;
  if v_old is null then
    if p_role is null then
      raise exception 'not a member of this vault' using errcode = 'P0002';
    end if;
    raise exception 'not a member of this vault: invite them instead' using errcode = 'P0002';
  end if;
  if v_old = 'owner' and p_role is distinct from 'owner'
     and (select count(*) from public.vault_members where vault_id = p_vault and role = 'owner') <= 1 then
    raise exception 'a vault needs at least one owner: make someone else an owner first' using errcode = '55000';
  end if;
  if p_role is null then
    delete from public.vault_members where vault_id = p_vault and user_id = p_user;
  else
    update public.vault_members set role = p_role where vault_id = p_vault and user_id = p_user;
  end if;
  perform private.log_event(p_vault, 'member.set', null, null, null,
    jsonb_build_object('user', p_user, 'role', p_role));
end $$;

-- ---------------------------------------------------------------------------
-- 2. Invite rate

create index vault_invites_created_by_idx on private.vault_invites (created_by, created_at);

-- How many invites one person may create in an hour, across their vaults.
create function private.invite_rate() returns int
language sql immutable set search_path = '' as $$ select 20 $$;

create or replace function public.create_invite(p_vault uuid, p_email text, p_role text)
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
  -- One person's invites, counted one call at a time, whichever vault.
  perform pg_advisory_xact_lock(hashtextextended('reliquary.invite_rate:' || private.uid()::text, 0));
  if (select count(*) from private.vault_invites
       where created_by = private.uid() and created_at > now() - interval '1 hour') >= private.invite_rate() then
    raise exception 'you have created % invites in the last hour: try again later', private.invite_rate()
      using errcode = '54000';
  end if;
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

-- ---------------------------------------------------------------------------
-- 3. Leaving

create function public.leave_vault(p_vault uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_role text;
begin
  perform private.require_human();
  -- The owners first, in set_member's order, so a leave and a demotion at
  -- once can't leave the vault with none.
  perform 1 from public.vault_members
   where vault_id = p_vault and role = 'owner' order by user_id for update;
  select role into v_role from public.vault_members
   where vault_id = p_vault and user_id = private.uid() for update;
  if v_role is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if v_role = 'owner'
     and (select count(*) from public.vault_members where vault_id = p_vault and role = 'owner') <= 1 then
    raise exception 'you are this vault''s only owner: make someone else an owner first, or delete the vault'
      using errcode = '55000';
  end if;
  delete from public.vault_members where vault_id = p_vault and user_id = private.uid();
  perform private.log_event(p_vault, 'member.leave', null, null, null,
    jsonb_build_object('user', private.uid(), 'role', v_role));
end $$;

-- ---------------------------------------------------------------------------
-- 4. Co-members' emails, in one call

-- How many ids one call may ask about (a page shows far fewer).
create function private.email_batch_cap() returns int
language sql immutable set search_path = '' as $$ select 500 $$;

create function public.co_member_emails(p_users uuid[])
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
       and (u.id = private.uid()
            or exists (select 1 from public.vault_members mine
                         join public.vault_members theirs on theirs.vault_id = mine.vault_id
                        where mine.user_id = private.uid() and theirs.user_id = u.id));
end $$;

-- ---------------------------------------------------------------------------
-- 5. Deletion notices

create table private.vault_deletion_notices (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  vault_name text not null,
  deleted_by uuid not null,
  deleted_at timestamptz not null default now()
);
create index on private.vault_deletion_notices (user_id);
create index on private.vault_deletion_notices (deleted_at);
alter table private.vault_deletion_notices enable row level security;
revoke all on private.vault_deletion_notices from public, anon, authenticated;

-- How long a notice waits to be seen.
create function private.notice_days() returns int
language sql immutable set search_path = '' as $$ select 30 $$;

-- delete_vault as before (20260925120000_vault_admin.sql), plus a notice for
-- every other member, and notices past their 30 days cleared.
create or replace function public.delete_vault(p_vault uuid, p_confirm_name text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.vaults;
  v_counts jsonb;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners delete a vault' using errcode = '42501';
  end if;
  select * into v from public.vaults where id = p_vault for update;
  if p_confirm_name is null or trim(p_confirm_name) <> v.name then
    raise exception 'type the vault''s name exactly to delete it' using errcode = '22023';
  end if;

  v_counts := jsonb_build_object(
    'members',   (select count(*) from public.vault_members where vault_id = p_vault),
    'files',     (select count(*) from public.files where vault_id = p_vault),
    'versions',  (select count(*) from public.file_versions where vault_id = p_vault),
    'proposals', (select count(*) from public.proposals where vault_id = p_vault),
    'variables', (select count(*) from public.variables where vault_id = p_vault),
    'log',       (select count(*) from public.log where vault_id = p_vault));

  -- The marker the append-only triggers look for, and the only record kept.
  insert into private.vault_deletions (vault_id, deleted_by, txid, counts)
  values (p_vault, private.uid(), txid_current(), v_counts);

  -- What the other members are told, once (see the top of this file).
  delete from private.vault_deletion_notices
   where deleted_at < now() - make_interval(days => private.notice_days());
  insert into private.vault_deletion_notices (user_id, vault_name, deleted_by)
  select m.user_id, v.name, private.uid() from public.vault_members m
   where m.vault_id = p_vault and m.user_id <> private.uid();

  -- Tokens whose only vault this was reach nothing now; revoke them.
  update public.access_tokens set revoked_at = now()
   where revoked_at is null and not all_vaults and vault_ids <@ array[p_vault];

  -- Approvals hang off proposals, not the vault: delete them while their
  -- proposals still say which vault they're in. Then the vault, and with it
  -- everything else (on delete cascade), ciphertexts included.
  delete from public.approvals a using public.proposals p
   where p.id = a.proposal_id and p.vault_id = p_vault;
  delete from public.vaults where id = p_vault;
  return v_counts;
end $$;

-- The caller's notices, once: returned and deleted in one call. Expired
-- ones are deleted unseen.
create function public.take_deletion_notices()
returns table (vault_name text, deleted_by_email text, deleted_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  return query
    with gone as (
      delete from private.vault_deletion_notices n where n.user_id = private.uid()
      returning n.vault_name, n.deleted_by, n.deleted_at
    )
    select g.vault_name, private.email_of(g.deleted_by), g.deleted_at from gone g
     where g.deleted_at >= now() - make_interval(days => private.notice_days())
     order by g.deleted_at desc;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Export: a snapshot, and a rate

create table private.vault_exports (
  id         uuid primary key default gen_random_uuid(),
  vault_id   uuid not null references public.vaults on delete cascade,
  started_by uuid not null,
  started_at timestamptz not null default now()
);
create index on private.vault_exports (vault_id, started_at);
create index on private.vault_exports (started_at);
alter table private.vault_exports enable row level security;
revoke all on private.vault_exports from public, anon, authenticated;

create table private.vault_export_files (
  export_id  uuid not null references private.vault_exports on delete cascade,
  path       text not null,
  version_id uuid not null,
  updated_at timestamptz not null,
  primary key (export_id, path)
);
alter table private.vault_export_files enable row level security;
revoke all on private.vault_export_files from public, anon, authenticated;

-- Exports of one vault per hour.
create function private.export_rate() returns int
language sql immutable set search_path = '' as $$ select 10 $$;

create or replace function public.export_vault(p_vault uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_export uuid := gen_random_uuid();
  v_header jsonb;
  v_files int;
  v_bytes bigint;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners export a vault' using errcode = '42501';
  end if;
  -- One export starts at a time per vault, so the rate counts exactly.
  perform pg_advisory_xact_lock(hashtextextended('reliquary.export:' || p_vault::text, 0));
  if (select count(*) from private.vault_exports
       where vault_id = p_vault and started_at > now() - interval '1 hour') >= private.export_rate() then
    raise exception 'this vault has been exported % times in the last hour: try again later', private.export_rate()
      using errcode = '54000';
  end if;
  delete from private.vault_exports where started_at < now() - interval '1 day';
  insert into private.vault_exports (id, vault_id, started_by) values (v_export, p_vault, private.uid());

  -- One statement, so one snapshot: the file list and the header agree.
  with live as (
    select f.path, fv.id as version_id, f.updated_at, octet_length(fv.body) as bytes
      from public.files f join public.file_versions fv on fv.id = f.current_version_id
     where f.vault_id = p_vault and f.deleted_at is null and fv.body is not null
  ), kept as (
    insert into private.vault_export_files (export_id, path, version_id, updated_at)
    select v_export, l.path, l.version_id, l.updated_at from live l
    returning 1
  )
  select (select count(*) from kept)::int,
         (select coalesce(sum(l.bytes), 0) from live l)::bigint,
         jsonb_build_object(
           'vault', (select jsonb_build_object('id', v.id, 'name', v.name, 'default_policy', v.default_policy,
                                               'created_at', v.created_at)
                       from public.vaults v where v.id = p_vault),
           'rules', coalesce((select jsonb_agg(jsonb_build_object('path', pp.path, 'policy', pp.policy,
                                                                  'quorum', pp.quorum) order by pp.path)
                                from public.path_policies pp where pp.vault_id = p_vault), '[]'),
           'variables', coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'environments', x.envs)
                                                   order by x.name)
                                    from (select va.name,
                                                 coalesce((select jsonb_agg(vv.environment order by vv.environment)
                                                             from public.variable_values vv
                                                            where vv.variable_id = va.id), '[]') as envs
                                            from public.variables va where va.vault_id = p_vault) x), '[]'))
    into v_files, v_bytes, v_header;

  if v_bytes > private.export_cap() then
    raise exception 'this vault holds % MiB of text, over the export limit of % MiB',
      ceil(v_bytes / 1048576.0), private.export_cap() / 1048576 using errcode = '54000';
  end if;
  perform private.log_event(p_vault, 'vault.export', null, null, null,
    jsonb_build_object('files', v_files, 'bytes', v_bytes));
  return v_header || jsonb_build_object(
    'export', v_export,
    'exported_at', now(),
    'exported_by', private.uid(),
    'files', v_files,
    'bytes', v_bytes);
end $$;

-- The export's files a page at a time, in path order: p_export, or the
-- caller's latest export of the vault. Only its owner, in person, who
-- started it, within 2 hours.
drop function public.export_files(uuid, text, int);
create function public.export_files(p_vault uuid, p_after text default '', p_limit int default 200,
                                    p_export uuid default null)
returns table (path text, body text, updated_at timestamptz, version_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_export uuid;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners export a vault' using errcode = '42501';
  end if;
  select e.id into v_export from private.vault_exports e
   where e.vault_id = p_vault and e.started_by = private.uid()
     and (p_export is null or e.id = p_export)
     and e.started_at > now() - interval '2 hours'
   order by e.started_at desc limit 1;
  if v_export is null then
    raise exception 'this export has expired or was never started: start it again' using errcode = '55000';
  end if;
  return query
    select x.path, fv.body, x.updated_at, fv.id
      from private.vault_export_files x join public.file_versions fv on fv.id = x.version_id
     where x.export_id = v_export and fv.body is not null
       and x.path > coalesce(p_after, '')
     order by x.path
     limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.invite_rate(), private.email_batch_cap(), private.notice_days(),
  private.export_rate() from public, anon, authenticated;

revoke all on function public.leave_vault(uuid), public.co_member_emails(uuid[]),
  public.take_deletion_notices(), public.export_files(uuid, text, int, uuid)
  from public, anon;
grant execute on function public.leave_vault(uuid), public.co_member_emails(uuid[]),
  public.take_deletion_notices(), public.export_files(uuid, text, int, uuid)
  to authenticated;
