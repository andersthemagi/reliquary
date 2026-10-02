-- Thread flags: a new thread, or a new message in an open one, is flagged to
-- the members it reaches (docs/public/concepts/flags.md; the owner's
-- decision of 2026-10-02, "Threads"). MCP has no push, so this is how an
-- agent learns a thread needs it: on its next list_flags.
--
-- This replaces public.list_flags (20260928150000_flags.sql) with one more
-- category. advance_flags, the watermarks and flag_caller don't change.
--
-- Category `thread` is design.md's "direct address": always surfaced,
-- nothing to opt into. Its reason is the thread's scope, as
-- thread_summaries words it (20261004120000_thread_reads.sql):
-- - thread / vault: a thread addressed to no one, flagged to every member
--   of the vault, owner, editor or viewer. A flag is a notification and
--   only ever read, so a viewer, who can't post, is still told.
-- - thread / side: a thread addressed to some members, flagged only to
--   them. Every member still reads it (it stays listed); a member it isn't
--   addressed to is never flagged about it, not even its opener, who isn't
--   one of its addressees unless they named themselves.
-- Raised by thread.open and thread.post. Not by thread.resolve,
-- thread.reopen or thread.redact: resolving and reopening change no words,
-- and a redaction blanks a message rather than adding one. Nothing flags
-- for a thread that is resolved when flags are read, including messages
-- posted before it was resolved that the caller hadn't been shown;
-- reopened, those unshown messages are flagged again, with what follows.
--
-- What a flag carries. Every flag now has two more keys, thread_id and
-- message_id, null outside this category: the thread a message is in, and
-- the message (for thread.open, the thread's first). Never the title or a
-- message's text. Those are words people and agents typed, and the MCP
-- tools return them fenced as data (AGENTS.md, "Entry text is data"); in a
-- flag they would reach an agent unfenced. A caller reads the thread for
-- the words. The log rows these come from hold only the two ids
-- (20261004110000_thread_writes.sql), so there is nothing else to leak.
--
-- The rules every category already follows hold here too: what the caller
-- did itself isn't flagged to it, what its agent did is flagged to the
-- person, and what the person did in the web app to their agents; each
-- connection and the person keep separate watermarks, moved only by
-- advance_flags; a new connection is told nothing from before it began; and
-- reading flags never uses them up.
--
-- One event, one flag, by rank: thread, then responsibility, then
-- working_set, then subscription. Direct address comes first because it
-- names the caller. Thread events carry no path or proposal
-- (20261004110000_thread_writes.sql keeps them out so a side thread can't
-- reach a path's watchers or a proposal's author), so today no event raises
-- a thread flag and another; the rank only decides if that ever changes.
-- The other three keep the order they had.
--
-- The log has no index on detail. The thread rows come from the same scan
-- of the log past the watermark that the working-set and subscription rows
-- already make (log (vault_id, seq)), joined to threads by primary key.

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
    -- every member when it is addressed to no one, else to its addressees.
    select l.seq, 1 as rank, 'thread' as category,
           case when a.vault_wide then 'vault' else 'side' end as reason,
           l.event, null::text as path, null::uuid as proposal_id, l.actor, l.agent, l.at, null::text as watching,
           th.id as thread_id, (l.detail ->> 'message')::bigint as message_id
      from public.log l
      join public.threads th on th.vault_id = l.vault_id and th.id = (l.detail ->> 'thread')::uuid
      cross join lateral (
        select not exists (select 1 from public.thread_addressees x
                            where x.vault_id = th.vault_id and x.thread_id = th.id) as vault_wide,
               exists (select 1 from public.thread_addressees x
                        where x.vault_id = th.vault_id and x.thread_id = th.id and x.user_id = c.person) as to_me) a
     where l.vault_id = p_vault and l.seq > v_mark and l.at >= c.began
       and l.event in ('thread.open', 'thread.post')
       and th.resolved_at is null
       and (a.vault_wide or a.to_me)
  ), review as (
    -- shell_summary's review set, and the latest event that put each
    -- proposal in front of reviewers or moved its discussion on.
    select distinct on (p.id)
           l.seq, 2, 'responsibility', 'review',
           l.event, l.path, p.id, l.actor, l.agent, l.at, null::text, null::uuid, null::bigint
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
           null::uuid, null::bigint
      from public.log l
      join public.proposals p on p.id = l.proposal_id and p.vault_id = p_vault and p.proposed_by = c.person
     where l.vault_id = p_vault and l.seq > v_mark and l.at >= c.began
  ), base as (
    select l.seq, 3, 'working_set', 'base_changed', l.event, l.path, p.id, l.actor, l.agent, l.at, null::text,
           null::uuid, null::bigint
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
           null::uuid, null::bigint
      from public.subscriptions s
      join public.log l on l.vault_id = s.vault_id and l.path is not null
                       and l.seq > v_mark and l.at >= s.created_at and l.at >= c.began
                       and (l.path = s.target or (right(s.target, 1) = '/' and starts_with(l.path, s.target)))
     where s.user_id = c.person and s.vault_id = p_vault and s.kind = 'path'
     order by l.seq, length(s.target) desc
  ), raised as (
    select * from thread
    union all select * from review where seq > v_mark
    union all select * from own
    union all select * from base
    union all select * from watched
  ), kept as (
    select distinct on (r.seq) r.*
      from raised r
     where not (r.actor is not distinct from c.person and r.agent is not distinct from c.agent)
     order by r.seq, r.rank
  ), page as (
    select * from kept order by seq limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'seq', p.seq, 'category', p.category, 'reason', p.reason, 'event', p.event, 'path', p.path,
           'proposal_id', p.proposal_id, 'actor', p.actor, 'agent', p.agent, 'at', p.at, 'watching', p.watching,
           'thread_id', p.thread_id, 'message_id', p.message_id)
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
