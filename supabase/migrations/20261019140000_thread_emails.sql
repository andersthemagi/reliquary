-- Thread emails (issue #260; web/src/threademails.ts; hostile tests in
-- supabase/tests/thread_emails_test.sql): a member who hasn't connected an
-- agent never learned that a thread needed them, because flags reach only
-- an agent that asks. Now the members a thread reaches are emailed about
-- it, through the web app, batched: one email per thread per member for
-- every message queued while the thread was quiet.
--
-- Who is queued is who is flagged (20261005100000_thread_flags.sql): every
-- member for a thread addressed to no one; a side thread's addressees and
-- everyone who has posted in it; never the message's own author. The queue
-- is filled by a trigger on thread_messages, so the web app and the MCP
-- server (both post through open_thread and post_message) fill it alike.
--
-- The claim is the signup notices' (20261012120000_signup_notices.sql):
-- only the web app's role claims, for 10 minutes, at most 5 tries; a
-- group (a member, a thread) is claimed only once its newest message is
-- two minutes old, so a busy thread sends one email, not one per message.
-- The web app marks a group sent through the last message it named; a
-- message queued after that waits for the next email. Nothing is claimed
-- for a resolved thread, or for a member who turned these emails off.
--
-- What leaves the database: the member's own address, the thread's title
-- and the names (profiles, else nothing) of who wrote. Never a message's
-- text: the email says a thread needs reading and links to it.

-- ---------------------------------------------------------------------------
-- 1. The choice: on unless the person turns it off, in person

create table public.notification_preferences (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  thread_emails boolean not null,
  updated_at    timestamptz not null default now()
);
alter table public.notification_preferences enable row level security;
revoke all on public.notification_preferences from public, anon, authenticated;
grant select on public.notification_preferences to authenticated;
create policy own_notification_read on public.notification_preferences for select to authenticated
  using (user_id = (select private.uid()) and (select private.agent()) is null);

create function public.set_thread_emails(p_on boolean) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if private.uid() is null or private.agent() is not null then
    raise exception 'only you, signed in to the web app, can choose which emails you get' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'choose to get emails about threads or not' using errcode = '22023';
  end if;
  insert into public.notification_preferences (user_id, thread_emails) values (private.uid(), p_on)
  on conflict (user_id) do update set thread_emails = excluded.thread_emails, updated_at = now();
  return p_on;
end $$;
revoke all on function public.set_thread_emails(boolean) from public, anon;
grant execute on function public.set_thread_emails(boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The queue

create table private.thread_emails (
  vault_id   uuid not null,
  thread_id  uuid not null,
  message_id bigint not null,
  user_id    uuid not null,
  queued_at  timestamptz not null default now(),
  claimed_at timestamptz,
  attempts   int not null default 0 check (attempts between 0 and 5),
  sent_at    timestamptz,
  primary key (thread_id, message_id, user_id),
  foreign key (vault_id, thread_id) references public.threads (vault_id, id) on delete cascade,
  foreign key (vault_id, user_id) references public.vault_members (vault_id, user_id) on delete cascade
);
create index on private.thread_emails (user_id, thread_id) where sent_at is null;
create index on private.thread_emails (vault_id, thread_id);
create index on private.thread_emails (vault_id, user_id);
alter table private.thread_emails enable row level security;
revoke all on private.thread_emails
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;

create function private.queue_thread_emails() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.thread_emails (vault_id, thread_id, message_id, user_id)
  select new.vault_id, new.thread_id, new.id, r.user_id
    from (select m.user_id from public.vault_members m
           where m.vault_id = new.vault_id
             and not exists (select 1 from public.thread_addressees a
                              where a.vault_id = new.vault_id and a.thread_id = new.thread_id)
          union
          select a.user_id from public.thread_addressees a
           where a.vault_id = new.vault_id and a.thread_id = new.thread_id
          union
          select m.author from public.thread_messages m
           where m.vault_id = new.vault_id and m.thread_id = new.thread_id and m.id < new.id) r
   where r.user_id <> new.author
     and exists (select 1 from public.vault_members m where m.vault_id = new.vault_id and m.user_id = r.user_id);
  return null;
end $$;
create trigger thread_messages_queue_emails after insert on public.thread_messages
  for each row execute function private.queue_thread_emails();

-- ---------------------------------------------------------------------------
-- 3. The web app's claim

-- Up to p_limit groups (a member, a thread) to email, claimed for 10
-- minutes: the member's address, the vault and thread by name, whether the
-- batch opens the thread (holds its first message), how many messages it
-- holds, who wrote them (display names, in order of first writing; a
-- writer with no name is left out), and the last message it covers, for
-- private.thread_emails_sent. Sent rows older than a day are dropped first.
create function private.claim_thread_emails(p_limit int)
returns table (user_id uuid, email text, vault_id uuid, vault text, thread_id uuid, title text,
               opened boolean, messages int, writers text, through bigint)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
begin
  delete from private.thread_emails e where e.sent_at < now() - interval '1 day';
  return query
    with g as (
      select e.user_id, e.thread_id
        from private.thread_emails e
        join public.threads th on th.vault_id = e.vault_id and th.id = e.thread_id
        join auth.users u on u.id = e.user_id
       where e.sent_at is null and e.attempts < 5
         and th.resolved_at is null
         and u.email is not null
         and not exists (select 1 from public.notification_preferences np
                          where np.user_id = e.user_id and np.thread_emails = false)
       group by e.user_id, e.thread_id
      having max(e.queued_at) < now() - interval '2 minutes'
         and bool_and(e.claimed_at is null or e.claimed_at < now() - interval '10 minutes')
       order by min(e.queued_at)
       limit greatest(1, least(coalesce(p_limit, 5), 20))
    ), up as (
      update private.thread_emails e set claimed_at = now(), attempts = e.attempts + 1
        from g where e.user_id = g.user_id and e.thread_id = g.thread_id and e.sent_at is null
      returning e.user_id, e.thread_id, e.message_id, e.vault_id
    )
    select up.user_id, u.email::text, up.vault_id, v.name, up.thread_id, th.title,
           bool_or(up.message_id = (select min(m.id) from public.thread_messages m
                                     where m.vault_id = up.vault_id and m.thread_id = up.thread_id)),
           count(*)::int,
           (select string_agg(w.display_name, ', ' order by w.first)
              from (select pr.display_name, min(m.id) as first
                      from public.thread_messages m
                      join public.profiles pr on pr.user_id = m.author
                     where m.vault_id = up.vault_id and m.thread_id = up.thread_id
                       and m.id = any(array_agg(up.message_id))
                     group by pr.display_name) w),
           max(up.message_id)
      from up
      join auth.users u on u.id = up.user_id
      join public.vaults v on v.id = up.vault_id
      join public.threads th on th.vault_id = up.vault_id and th.id = up.thread_id
     group by up.user_id, u.email, up.vault_id, v.name, up.thread_id, th.title
     order by min(up.message_id);
end $$;

create function private.thread_emails_sent(p_user uuid, p_thread uuid, p_through bigint) returns void
language sql volatile security definer set search_path = '' as $$
  update private.thread_emails set sent_at = now()
   where user_id = p_user and thread_id = p_thread and message_id <= p_through and sent_at is null
$$;

revoke all on function private.claim_thread_emails(int), private.thread_emails_sent(uuid, uuid, bigint),
  private.queue_thread_emails()
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
grant execute on function private.claim_thread_emails(int), private.thread_emails_sent(uuid, uuid, bigint) to reliquary_web;

-- ---------------------------------------------------------------------------
-- 4. The top bar's summary carries the choice (thread_emails), so Account
-- settings shows it without a query of its own (web/test/shell.test.mjs,
-- "cost"). Otherwise as 20261019130000_review_path_owners.sql left it.

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
      join public.vault_members m on m.vault_id = p.vault_id and m.user_id = v_me
                               and private.reviews(p.vault_id, p.path, v_me)
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
    'show_email', coalesce((select d.show_email from public.display_preferences d where d.user_id = v_me), true),
    'thread_emails', coalesce((select np.thread_emails from public.notification_preferences np where np.user_id = v_me), true));
end $$;
