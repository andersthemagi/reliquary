-- The "canon moved" signal (CL-3.6, issue #73; tracking issue #52). A step
-- cites files at versions (work_plan_step_cites, 20261002200000_work_plans.sql).
-- When a cited file has a newer version than the one cited, the step's
-- context moved: work_plan_status says which cited files moved, and
-- list_flags flags the change to the people the step concerns.
--
-- Computed on read, never stored: a file's current version is already
-- the approved one (a proposal changes it only when applied), so "moved"
-- is a comparison of two ids that already exist. No trigger on writes,
-- nothing to keep in step with the files, and nothing to undo when a step
-- finishes: a done or cancelled step is never shown as moved, because only
-- open and claimed steps have context left to act on.
--
-- Moved means the cited version is one of that file's own versions and is
-- no longer its current one, so the current one is newer. A cite of a
-- version the file never had (the plan grammar checks only its shape) is
-- not called moved: there is no telling what it was older than. A deleted
-- cited file is not moved either: there is no newer version. A change made
-- before the plan was registered moves the step (work_plan_status) but
-- raises no flag: the flag is news, the status is the state.
--
-- Who is flagged (category working_set, reason cite_moved): whoever
-- registered the plan, and whoever holds a claimed step that cites the
-- file. Everyone else who reads the vault sees it on the plan, not as a
-- flag. Every flag gains one key, plan (the plan file's path, null outside
-- this category), so a caller knows which work_plan_status to read. The
-- rest of list_flags is 20261005100000_thread_flags.sql's, unchanged,
-- except that a tie in rank between the two working_set reasons on one
-- event goes to base_changed by name rather than by chance.

drop function public.work_plan_status(uuid, text);
create function public.work_plan_status(p_vault uuid, p_path text)
returns table (o_key text, o_title text, o_state text, o_holder_label text, o_expires_at timestamptz, o_moved text[])
language sql stable set search_path = '' as $$
  select s.key, s.title,
    case
      when s.status = 'done' then 'done'
      when s.status = 'cancelled' then 'cancelled'
      when s.status = 'claimed' and s.expires_at > clock_timestamp() then 'claimed'
      when exists (select 1 from public.work_plan_step_blockers d join public.work_plan_steps b on b.id = d.blocker_id
                    where d.step_id = s.id and b.status = 'cancelled') then 'blocked_by_cancelled'
      when s.open_blockers > 0 then 'blocked'
      else 'ready'
    end,
    s.holder_label, s.expires_at,
    array(select ct.path from public.work_plan_step_cites ct
            join public.files f on f.vault_id = s.vault_id and f.path = ct.path
           where ct.step_id = s.id and s.status in ('open', 'claimed')
             and f.deleted_at is null and f.current_version_id is distinct from ct.version
             and exists (select 1 from public.file_versions fv where fv.id = ct.version and fv.file_id = f.id)
           order by ct.path)
  from public.work_plan_steps s
  join public.work_plans p on p.id = s.plan_id
  where p.vault_id = p_vault and p.path = p_path
  order by s.id
$$;
revoke all on function public.work_plan_status(uuid, text) from public, anon;
grant execute on function public.work_plan_status(uuid, text) to authenticated;

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
           th.id as thread_id, (l.detail ->> 'message')::bigint as message_id, null::text as plan
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
           l.event, l.path, p.id, l.actor, l.agent, l.at, null::text, null::uuid, null::bigint, null::text
      from public.proposals p
      join public.vault_members m on m.vault_id = p.vault_id and m.user_id = c.person and m.role in ('owner', 'editor')
      join public.log l on l.vault_id = p.vault_id and l.path = p.path and l.proposal_id = p.id
                       and l.event in ('proposal.open', 'proposal.revise', 'proposal.edit', 'proposal.comment')
     where p.vault_id = p_vault
       and p.status = 'open'
       and not exists (select 1 from public.approvals a
                        where a.proposal_id = p.id and a.user_id = c.person and a.revision = p.revision)
       and not exists (select 1 from public.active_snoozes s where s.proposal_id = p.id and s.user_id = c.person)
     order by p.id, l.seq desc
  ), own as (
    select l.seq, 3, 'working_set', 'proposal', l.event, l.path, l.proposal_id, l.actor, l.agent, l.at, null::text,
           null::uuid, null::bigint, null::text
      from public.log l
      join public.proposals p on p.id = l.proposal_id and p.vault_id = p_vault and p.proposed_by = c.person
     where l.vault_id = p_vault and l.seq > v_mark and l.at >= c.began
  ), base as (
    select l.seq, 3, 'working_set', 'base_changed', l.event, l.path, p.id, l.actor, l.agent, l.at, null::text,
           null::uuid, null::bigint, null::text
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
           null::uuid, null::bigint, null::text
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
           null::uuid, null::bigint, p.path as plan
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
           'thread_id', p.thread_id, 'message_id', p.message_id, 'plan', p.plan)
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
