-- Listing and reading threads. Who reads is the tables' row level security
-- (20261004100000_threads.sql): every member of the vault, every thread.
-- These run as the caller (security invoker), so they can only ever return
-- what that policy already lets the caller select, and they add no filter
-- of who may read, only of what to show.
--
-- public.thread_summaries is one row per thread with what a list needs:
-- whether it is vault-wide or a side thread, who it is addressed to and
-- whether that includes the caller's person, what it is about (a task
-- anchor with its plan's path and the step's key, so a surface can link to
-- it without another read), its message count and its latest message.
-- list_threads and read_thread both return it, so a thread reads the same
-- in a list and on its own.
--
-- list_threads' default is the owner's decision of 2026-10-02: vault-wide
-- threads and side threads addressed to the caller's person; p_all adds
-- the side threads addressed to others. Newest activity first, paged by
-- the latest message's id (message ids are one sequence, so they order
-- activity across threads).

create view public.thread_summaries with (security_invoker = true) as
  select th.id, th.vault_id, th.title,
         case when ad.ids is null then 'vault' else 'side' end as scope,
         coalesce(ad.ids, '{}') as addressees,
         coalesce((select private.uid()) = any (ad.ids), false) as addressed_to_me,
         case when th.anchor_path is not null then 'path'
              when th.anchor_step is not null then 'task'
              when th.anchor_proposal is not null then 'proposal' end as anchor_kind,
         th.anchor_path, th.anchor_step, wp.path as anchor_plan_path, st.key as anchor_step_key,
         th.anchor_proposal,
         th.opened_by, th.agent, th.opened_at, th.resolved_at, th.resolved_by, th.resolved_agent,
         ms.messages, ms.last_message_id, ms.last_message_at
    from public.threads th
   cross join lateral (
     select array_agg(a.user_id order by a.user_id) as ids
       from public.thread_addressees a where a.vault_id = th.vault_id and a.thread_id = th.id) ad
   cross join lateral (
     select count(*)::int as messages, max(m.id) as last_message_id, max(m.at) as last_message_at
       from public.thread_messages m where m.vault_id = th.vault_id and m.thread_id = th.id) ms
    left join public.work_plan_steps st on st.vault_id = th.vault_id and st.id = th.anchor_step
    left join public.work_plans wp on wp.id = st.plan_id;

revoke all on public.thread_summaries from public, anon, authenticated;
grant select on public.thread_summaries to authenticated;

-- p_state: open, resolved or all. p_before: a last_message_id from the
-- previous page, for the threads less recently active than it.
create function public.list_threads(p_vault uuid, p_all boolean default false, p_state text default 'all',
  p_limit int default 50, p_before bigint default null)
returns setof public.thread_summaries
language plpgsql stable security invoker set search_path = '' as $$
begin
  if private.role_in(p_vault) is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if p_state is null or p_state not in ('open', 'resolved', 'all') then
    raise exception 'list open, resolved or all threads' using errcode = '22023';
  end if;
  return query
    select s.* from public.thread_summaries s
     where s.vault_id = p_vault
       and (coalesce(p_all, false) or s.scope = 'vault' or s.addressed_to_me)
       and (p_state = 'all' or (p_state = 'open') = (s.resolved_at is null))
       and (p_before is null or s.last_message_id < p_before)
     order by s.last_message_id desc nulls last
     limit least(greatest(coalesce(p_limit, 50), 1), 200);
end $$;

-- The thread, as list_threads lists it, and its messages oldest first:
-- p_after, the last message id already read; at most p_limit, with
-- `more` when there are others after them. A redacted message keeps its
-- place, author and time, with no body.
create function public.read_thread(p_thread uuid, p_after bigint default null, p_limit int default 100)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_thread jsonb;
  v_messages jsonb;
  v_n int;
begin
  select to_jsonb(s) into v_thread from public.thread_summaries s where s.id = p_thread;
  if v_thread is null then
    raise exception 'no such thread' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'author', m.author, 'agent', m.agent, 'at', m.at,
           'body', m.body, 'redacted_at', m.redacted_at, 'redacted_by', m.redacted_by) order by m.id)
           filter (where m.n <= v_limit), '[]'::jsonb),
         count(*)
    into v_messages, v_n
    from (select x.*, row_number() over (order by x.id) as n
            from public.thread_messages x
           where x.vault_id = (v_thread ->> 'vault_id')::uuid and x.thread_id = p_thread
             and x.id > coalesce(p_after, 0)
           order by x.id
           limit v_limit + 1) m;
  return jsonb_build_object('thread', v_thread, 'messages', v_messages, 'more', v_n > v_limit);
end $$;

revoke all on function public.list_threads(uuid, boolean, text, int, bigint), public.read_thread(uuid, bigint, int)
  from public, anon;
grant execute on function public.list_threads(uuid, boolean, text, int, bigint), public.read_thread(uuid, bigint, int)
  to authenticated;
