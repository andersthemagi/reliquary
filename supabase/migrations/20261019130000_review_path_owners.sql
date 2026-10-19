-- Waiting on you, on a path with named owners (issue #196, the last of
-- 20260928150000_flags.sql's "path owners in category 3"): a proposal on
-- such a path is flagged, and listed in the Inbox's review set, to its
-- named owners only, whatever their role (a viewer included), and not to
-- the vault's owners and editors, whose approval doesn't count there
-- (decide(), 20260928130000_path_ownership.sql: with named owners, only
-- their approvals reach the quorum). A path with no named owners is as
-- before: owners and editors. One predicate, private.reviews, so the Inbox
-- and list_flags can't drift apart again; the two functions are otherwise
-- as 20261014150000_display_preferences.sql and
-- 20261014120000_flag_review_approvers.sql left them.

create function private.reviews(p_vault uuid, p_path text, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when exists (select 1 from private.path_owner_ids(p_vault, p_path))
              then exists (select 1 from private.path_owner_ids(p_vault, p_path) o where o = p_user)
              else exists (select 1 from public.vault_members m
                            where m.vault_id = p_vault and m.user_id = p_user and m.role in ('owner', 'editor'))
         end
$$;
-- shell_summary runs as the caller (security invoker), so the caller's
-- role needs this one function; the table it reads stays closed.
revoke all on function private.reviews(uuid, text, uuid) from public, anon, authenticated;
grant execute on function private.reviews(uuid, text, uuid) to authenticated;

create or replace function public.list_flags(p_vault uuid, p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c record;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_mark bigint;
  v_head bigint;
  v_flags jsonb;
  v_n int;
  v_last bigint;
begin
  select * into c from private.flag_caller(p_vault);
  select w.last_seq into v_mark from public.flag_watermarks w
   where w.user_id = c.person and w.vault_id = p_vault and w.token_id is not distinct from c.token;
  v_mark := coalesce(v_mark, 0);
  select coalesce(max(l.seq), 0) into v_head from public.log l where l.vault_id = p_vault;

  with thread as (
    -- A thread opened, or a message posted, in a thread still open: to
    -- every member when it is addressed to no one. A side thread's opening
    -- goes to its addressees, and a message in it to its participants.
    select l.seq, 1 as rank, 'thread' as category,
           case when a.vault_wide then 'vault' else 'side' end as reason,
           l.event, null::text as path, null::uuid as proposal_id, l.actor, l.agent, l.at, null::text as watching,
           th.id as thread_id, (l.detail ->> 'message')::bigint as message_id, null::text as plan,
           null::text as step, null::text as step_title
      from public.log l
      join public.threads th on th.vault_id = l.vault_id and th.id = (l.detail ->> 'thread')::uuid
      cross join lateral (
        select not exists (select 1 from public.thread_addressees x
                            where x.vault_id = th.vault_id and x.thread_id = th.id) as vault_wide,
               exists (select 1 from public.thread_addressees x
                        where x.vault_id = th.vault_id and x.thread_id = th.id and x.user_id = c.person)
               or (l.event = 'thread.post'
                   and exists (select 1 from public.thread_messages m
                                where m.vault_id = th.vault_id and m.thread_id = th.id and m.author = c.person
                                  and m.id <= (l.detail ->> 'message')::bigint)) as to_me) a
     where l.vault_id = p_vault and l.seq > v_mark and l.at >= c.began
       and l.event in ('thread.open', 'thread.post')
       and th.resolved_at is null
       and (a.vault_wide or a.to_me)
  ), review as (
    -- shell_summary's review set, and the latest event that put each
    -- proposal in front of reviewers or moved its discussion on.
    select distinct on (p.id)
           l.seq, 2, 'responsibility', 'review',
           l.event, l.path, p.id, l.actor, l.agent, l.at, null::text, null::uuid, null::bigint, null::text,
           null::text, null::text
      from public.proposals p
      join public.vault_members m on m.vault_id = p.vault_id and m.user_id = c.person
                               and private.reviews(p.vault_id, p.path, c.person)
      join public.log l on l.vault_id = p.vault_id and l.path = p.path and l.proposal_id = p.id
                       and l.event in ('proposal.open', 'proposal.revise', 'proposal.edit', 'proposal.comment')
     where p.vault_id = p_vault
       and p.status = 'open'
       and not exists (select 1 from public.approvals a
                        where a.proposal_id = p.id and a.user_id = c.person and a.revision = p.revision)
       and not exists (select 1 from public.active_snoozes s where s.proposal_id = p.id and s.user_id = c.person)
     order by p.id, l.seq desc
  ), step_review as (
    -- A step awaiting review, to whoever can approve it, from its latest
    -- completion until it is decided.
    select distinct on (s.id)
           l.seq, 2, 'responsibility', 'step_review',
           l.event, l.path, null::uuid, l.actor, l.agent, l.at, null::text, null::uuid, null::bigint, p.path,
           s.key, s.title
      from public.work_plan_steps s
      join public.work_plans p on p.id = s.plan_id
      join public.log l on l.vault_id = p.vault_id and l.path = p.path and l.event = 'step.complete'
                       and l.detail ->> 'plan' = p.id::text and l.detail ->> 'step' = s.key
     where s.vault_id = p_vault and s.status = 'review'
       and private.can_write_path(p_vault, p.path)
     order by s.id, l.seq desc
  ), own as (
    select l.seq, 3, 'working_set', 'proposal', l.event, l.path, l.proposal_id, l.actor, l.agent, l.at, null::text,
           null::uuid, null::bigint, null::text, null::text, null::text
      from public.log l
      join public.proposals p on p.id = l.proposal_id and p.vault_id = p_vault and p.proposed_by = c.person
     where l.vault_id = p_vault and l.seq > v_mark and l.at >= c.began
  ), base as (
    select l.seq, 3, 'working_set', 'base_changed', l.event, l.path, p.id, l.actor, l.agent, l.at, null::text,
           null::uuid, null::bigint, null::text, null::text, null::text
      from public.proposals p
      join public.log o on o.vault_id = p.vault_id and o.path = p.path and o.proposal_id = p.id
                       and o.event = 'proposal.open'
      join public.log l on l.vault_id = p.vault_id and l.path = p.path and l.seq > o.seq
                       and l.event in ('file.write', 'file.delete', 'file.erase')
                       and l.proposal_id is distinct from p.id
     where p.vault_id = p_vault and p.proposed_by = c.person and p.status in ('open', 'changes_requested')
       and l.seq > v_mark and l.at >= c.began
  ), watched as (
    select distinct on (l.seq)
           l.seq, 4, 'subscription', 'path', l.event, l.path, l.proposal_id, l.actor, l.agent, l.at, s.target,
           null::uuid, null::bigint, null::text, null::text, null::text
      from public.subscriptions s
      join public.log l on l.vault_id = s.vault_id and l.path is not null
                       and l.seq > v_mark and l.at >= s.created_at and l.at >= c.began
                       and (l.path = s.target or (right(s.target, 1) = '/' and starts_with(l.path, s.target)))
     where s.user_id = c.person and s.vault_id = p_vault and s.kind = 'path'
     order by l.seq, length(s.target) desc
  ), moved as (
    -- A new version of a file that an open or claimed step cites at another
    -- version, written after the plan was registered: to whoever registered
    -- the plan, and to whoever holds the step. One flag per event, naming
    -- the first such plan by path.
    select distinct on (l.seq)
           l.seq, 3, 'working_set', 'cite_moved', l.event, l.path, null::uuid, l.actor, l.agent, l.at, null::text,
           null::uuid, null::bigint, p.path as plan, null::text, null::text
      from public.work_plans p
      join public.work_plan_steps s on s.plan_id = p.id and s.status in ('open', 'claimed')
      join public.work_plan_step_cites ct on ct.step_id = s.id
      join public.files f on f.vault_id = p.vault_id and f.path = ct.path
      join public.file_versions fv on fv.id = ct.version and fv.file_id = f.id
      join public.log reg on reg.vault_id = p.vault_id and reg.path = p.path and reg.event = 'work_plan.register'
      join public.log l on l.vault_id = p.vault_id and l.path = ct.path and l.event = 'file.write'
                       and l.version_id is distinct from ct.version
                       and l.seq > v_mark and l.at >= c.began and l.seq > reg.seq
     where p.vault_id = p_vault and (p.registered_by = c.person or s.holder = c.person)
     order by l.seq, p.path
  ), raised as (
    select * from thread
    union all select * from review where seq > v_mark
    union all select * from step_review where seq > v_mark
    union all select * from own
    union all select * from base
    union all select * from watched
    union all select * from moved
  ), kept as (
    select distinct on (r.seq) r.*
      from raised r
     where not (r.actor is not distinct from c.person and r.agent is not distinct from c.agent)
     order by r.seq, r.rank, r.reason
  ), page as (
    select * from kept order by seq limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'seq', p.seq, 'category', p.category, 'reason', p.reason, 'event', p.event, 'path', p.path,
           'proposal_id', p.proposal_id, 'actor', p.actor, 'agent', p.agent, 'at', p.at, 'watching', p.watching,
           'thread_id', p.thread_id, 'message_id', p.message_id, 'plan', p.plan,
           'step', p.step, 'step_title', p.step_title)
           order by p.seq) filter (where p.n <= v_limit), '[]'::jsonb),
         count(*),
         max(p.seq) filter (where p.n <= v_limit)
    into v_flags, v_n, v_last
    from (select pg.*, row_number() over (order by pg.seq) as n from page pg) p;

  return jsonb_build_object(
    'watermark', v_mark,
    'through', case when v_n > v_limit then v_last else greatest(v_head, v_mark) end,
    'more', v_n > v_limit,
    'flags', v_flags);
end $$;

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
    'show_email', coalesce((select d.show_email from public.display_preferences d where d.user_id = v_me), true));
end $$;
