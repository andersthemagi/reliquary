-- Review-gated steps (issue #78, CL-3.7; docs/design.md "Claims and work
-- plans", item 7): a step marked `gate: review` holds its dependents until
-- a person approves it directly, or its linked proposal is applied.
--
-- A new stored status, 'review' (awaiting review). complete_step on a
-- gated step stores it instead of 'done' and decrements nothing, so every
-- dependent keeps its stored count of unfinished blockers and stays
-- unclaimable through request_work and claim_step alike: both grant only
-- at open_blockers = 0 (private.take_step), unchanged. The count drops in
-- exactly two places, each through private.unblock_dependents, once per
-- step: approve_step, and the trigger below when a linked proposal is
-- applied. A step awaiting review is neither open nor claimed, so it is
-- never handed out, holds no lease, counts against no cap and is never
-- "context moved".
--
-- Approving is on the ceiling, like cancel, skip and reopen: the gate is
-- a person's judgement, so an agent that could approve would be the gate
-- approving itself. approve_step is require_human and checks the plan's
-- path the way cancel_step does.
--
-- The linked proposal. The design names one but not what links it, so
-- the smallest link that keeps the gate a person's: the agent completing
-- the step names a proposal (complete_step's p_proposal) as the step's
-- output, and the step is approved when that proposal is applied, which
-- only a person can do (decide and edit_and_approve are require_human).
-- The proposal must be in the vault, made by the completing step's own
-- person since the step was claimed, and still undecided (open or changes
-- requested). Undecided, because a proposal already applied was judged
-- without the step in view: linking one after the fact would let an agent
-- pass the gate with any applied proposal it made. A proposal rejected or
-- gone stale leaves the step awaiting review, for a person to approve or
-- cancel. Only a gated step takes one.
--
-- Not inside decide(): a trigger on the proposal's status reaching
-- 'applied', so decide and edit_and_approve (which calls decide) are
-- unchanged and every way a proposal is applied is covered.
-- decide_apply_test.sql pins what decide does around it.
--
-- Lock order. decide holds the path lock, the file's row and the
-- proposal's row when the trigger fires, which then takes the plan's
-- shared advisory lock and the step's row. complete_step with a proposal
-- locks the proposal's row (key share) before the plan's lock and the
-- step's, the same order, so the two can't deadlock, and a proposal
-- applied while a completion links it either commits first (the
-- completion then reads it applied and refuses) or waits for the link and
-- then approves the step.

alter table public.work_plan_steps drop constraint work_plan_steps_status_check;
alter table public.work_plan_steps add constraint work_plan_steps_status_check
  check (status in ('open', 'claimed', 'review', 'done', 'cancelled'));
alter table public.work_plan_steps add column proposal_id uuid references public.proposals on delete set null;
create index on public.work_plan_steps (proposal_id);
grant select (proposal_id) on public.work_plan_steps to authenticated;

-- As 20261013170200_strikes_and_cooldown.sql, plus p_proposal and the
-- gate. The old signature is dropped so a five-argument call stays
-- unambiguous.
drop function public.complete_step(uuid, text, text, int, text);
create function public.complete_step(p_vault uuid, p_path text, p_key text, p_fence int, p_secret text,
  p_proposal uuid default null)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_plan_id uuid; v_row public.work_plan_steps; v_prop public.proposals;
begin
  perform private.require_person();
  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  end if;
  if p_proposal is not null then
    select * into v_prop from public.proposals where id = p_proposal and vault_id = p_vault for key share;
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('reliquary.work_plan:' || v_plan_id::text, 0));
  select * into v_row from public.work_plan_steps where plan_id = v_plan_id and key = p_key for update;
  if v_row.id is null then
    raise exception 'no such step' using errcode = 'P0002';
  end if;
  if v_row.status <> 'claimed' or v_row.fence <> p_fence or v_row.secret_hash is distinct from private.token_hash(p_secret)
     or v_row.holder is distinct from private.uid() or v_row.holder_token is distinct from private.token_id()
     or v_row.expires_at <= clock_timestamp()
  then
    raise exception 'this step is no longer yours to complete (wrong secret or fence, a different connection, or the lease lapsed)'
      using errcode = 'RLW03';
  end if;
  if p_proposal is not null then
    if v_row.gate is distinct from 'review' then
      raise exception 'step "%" has no review gate, so it takes no proposal: complete it without one', p_key using errcode = '22023';
    end if;
    if v_prop.id is null or v_prop.proposed_by <> private.uid() or v_prop.created_at < v_row.claimed_at then
      raise exception 'proposal % can''t be this step''s: link a proposal your person made in this vault since claiming the step', p_proposal
        using errcode = '22023';
    end if;
    if v_prop.status not in ('open', 'changes_requested') then
      raise exception 'proposal % is already %, so applying it can''t be the review: complete the step without it, and a person approves the step on the Tasks page',
        p_proposal, v_prop.status using errcode = '22023';
    end if;
  end if;

  delete from private.work_plan_strikes where vault_id = p_vault and person = private.uid();
  if v_row.gate = 'review' then
    update public.work_plan_steps set status = 'review', proposal_id = p_proposal where id = v_row.id;
    perform private.log_event(p_vault, 'step.complete', p_path, null, null,
      jsonb_build_object('plan', v_plan_id, 'step', p_key, 'fence', p_fence, 'gate', 'review')
      || case when p_proposal is null then '{}'::jsonb else jsonb_build_object('proposal', p_proposal) end);
    return;
  end if;
  update public.work_plan_steps set status = 'done', done_at = clock_timestamp() where id = v_row.id;
  perform private.unblock_dependents(v_row.id);
  perform private.log_event(p_vault, 'step.complete', p_path, null, null,
    jsonb_build_object('plan', v_plan_id, 'step', p_key, 'fence', p_fence));
end $$;
revoke all on function public.complete_step(uuid, text, text, int, text, uuid) from public, anon;
grant execute on function public.complete_step(uuid, text, text, int, text, uuid) to authenticated;

-- Shared by approve_step and the trigger: done, then what waits on it.
-- The proposal goes in the entry's detail, not its proposal_id, so the
-- proposal's own trail and its flags stay decide()'s.
create function private.approve_step(p_step bigint, p_proposal uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare v public.work_plan_steps; v_path text;
begin
  select * into v from public.work_plan_steps where id = p_step;
  perform pg_advisory_xact_lock_shared(hashtextextended('reliquary.work_plan:' || v.plan_id::text, 0));
  update public.work_plan_steps set status = 'done', done_at = clock_timestamp()
   where id = p_step and status = 'review'
  returning * into v;
  if v.id is null then
    return false;
  end if;
  perform private.unblock_dependents(v.id);
  select path into v_path from public.work_plans where id = v.plan_id;
  perform private.log_event(v.vault_id, 'step.approve', v_path, null, null,
    jsonb_build_object('plan', v.plan_id, 'step', v.key) || case when p_proposal is null then '{}'::jsonb else jsonb_build_object('proposal', p_proposal) end);
  return true;
end $$;
revoke all on function private.approve_step(bigint, uuid) from public, anon, authenticated;

-- A person approves a step awaiting review, whoever can write the plan's
-- path (as cancel_step). Not an agent: on the ceiling.
create function public.approve_step(p_vault uuid, p_path text, p_key text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_plan_id uuid; v_row public.work_plan_steps;
begin
  perform private.require_human();
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  end if;
  select * into v_row from public.work_plan_steps where plan_id = v_plan_id and key = p_key;
  if v_row.id is null then
    raise exception 'no such step' using errcode = 'P0002';
  end if;
  if not private.approve_step(v_row.id, null) then
    raise exception 'step "%" is not awaiting review; only a review-gated step its holder completed is approved', p_key using errcode = 'RLW02';
  end if;
end $$;
revoke all on function public.approve_step(uuid, text, text) from public, anon;
grant execute on function public.approve_step(uuid, text, text) to authenticated;

create function private.proposal_applied_approves_steps() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
declare s bigint;
begin
  for s in select st.id from public.work_plan_steps st
            where st.proposal_id = new.id and st.status = 'review' order by st.id loop
    perform private.approve_step(s, new.id);
  end loop;
  return null;
end $$;
revoke all on function private.proposal_applied_approves_steps() from public, anon, authenticated;
create trigger proposal_applied_approves_steps after update of status on public.proposals
  for each row when (new.status = 'applied' and old.status is distinct from 'applied')
  execute function private.proposal_applied_approves_steps();

-- As 20261013100000_canon_moved.sql, plus awaiting_review.
create or replace function public.work_plan_status(p_vault uuid, p_path text)
returns table (o_key text, o_title text, o_state text, o_holder_label text, o_expires_at timestamptz, o_moved text[])
language sql stable set search_path = '' as $$
  select s.key, s.title,
    case
      when s.status = 'done' then 'done'
      when s.status = 'cancelled' then 'cancelled'
      when s.status = 'review' then 'awaiting_review'
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

-- As 20261003100000_list_work_plans.sql, plus o_review.
drop function public.list_work_plans(uuid);
create function public.list_work_plans(p_vault uuid)
returns table (
  o_path text,
  o_registered_version uuid,
  o_registered_at timestamptz,
  o_registered_by uuid,
  o_file text,
  o_current_version uuid,
  o_ready int,
  o_blocked int,
  o_claimed int,
  o_done int,
  o_cancelled int,
  o_review int
)
language sql stable set search_path = '' as $$
  select p.path, p.version_id, p.registered_at, p.registered_by,
    case
      when f.id is null or f.deleted_at is not null then 'deleted'
      when f.current_version_id is distinct from p.version_id then 'changed'
      else 'unchanged'
    end,
    f.current_version_id,
    (count(st.o_key) filter (where st.o_state = 'ready'))::int,
    (count(st.o_key) filter (where st.o_state in ('blocked', 'blocked_by_cancelled')))::int,
    (count(st.o_key) filter (where st.o_state = 'claimed'))::int,
    (count(st.o_key) filter (where st.o_state = 'done'))::int,
    (count(st.o_key) filter (where st.o_state = 'cancelled'))::int,
    (count(st.o_key) filter (where st.o_state = 'awaiting_review'))::int
  from public.work_plans p
  left join public.files f on f.vault_id = p.vault_id and f.path = p.path
  left join lateral public.work_plan_status(p.vault_id, p.path) st on true
  where p.vault_id = p_vault
  group by p.id, f.id
  order by p.path
$$;
revoke all on function public.list_work_plans(uuid) from public, anon;
grant execute on function public.list_work_plans(uuid) to authenticated;

-- As 20261013220000_claim_step_follows_the_line.sql, plus a refusal that
-- names a step awaiting review rather than calling it claimed by someone.
create or replace function public.claim_step(p_vault uuid, p_path text, p_key text, p_label text default null, p_ttl_minutes int default null)
returns table (o_secret text, o_fence int, o_expires timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_plan_id uuid;
  v_rule record;
  a record;
  v_cur public.work_plan_steps;
  v_ahead int;
begin
  perform private.require_person();
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.work_plan_steps where plan_id = v_plan_id and key = p_key) then
    raise exception 'no such step' using errcode = 'P0002';
  end if;

  select * into a from private.take_step(p_vault, p_path, p_label, p_ttl_minutes, p_key);
  if a.o_state = 'granted' then
    return query select a.o_secret, a.o_fence, a.o_expires;
    return;
  elsif a.o_state = 'no_such_plan' then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  elsif a.o_state = 'cooling_down' then
    raise exception 'you are cooling down after letting step claims lapse unfinished, and can claim again in % seconds', a.o_wait_seconds
      using errcode = 'RLW06';
  elsif a.o_state = 'at_capacity' then
    select * into v_rule from private.queue_rule_for(p_vault, p_path);
    raise exception 'you already hold as many steps as this vault''s claim rule allows (% per connection, % per person); complete or release one first',
      v_rule.connection_cap, v_rule.person_cap using errcode = 'RLW06';
  end if;

  -- Not granted, and not for the caller's own reasons: say why the named
  -- step itself isn't free first, as before; else it is the line.
  select * into v_cur from public.work_plan_steps where plan_id = v_plan_id and key = p_key;
  if v_cur.id is null then
    raise exception 'no such step' using errcode = 'P0002';
  elsif v_cur.status in ('done', 'cancelled') then
    raise exception 'step "%" is already %', p_key, v_cur.status using errcode = 'RLW02';
  elsif v_cur.status = 'review' then
    raise exception 'step "%" is done and awaiting a person''s review; what waits on it can be claimed once a person approves it', p_key
      using errcode = 'RLW02';
  elsif v_cur.status = 'claimed' and v_cur.expires_at > clock_timestamp() then
    raise exception 'step "%" is already claimed by % until %', p_key, coalesce(v_cur.holder_label, 'someone'), v_cur.expires_at
      using errcode = 'RLW01';
  elsif v_cur.open_blockers > 0 then
    raise exception 'step "%" is blocked: % blocker(s) not finished', p_key, v_cur.open_blockers using errcode = 'RLW02';
  elsif a.o_state = 'wait' and a.o_place <= a.o_ready then
    raise exception 'step "%" is being claimed by someone else right now', p_key using errcode = 'RLW01';
  end if;
  v_ahead := case when a.o_state = 'wait' then a.o_place - 1
                  else (select count(*) from public.work_plan_places pl where pl.plan_id = v_plan_id and pl.expires_at > clock_timestamp()) end;
  -- Nobody ahead: the step changed between the check and this read (its
  -- blocker finished, or its claim lapsed), so it wasn't free when checked.
  if v_ahead = 0 then
    raise exception 'step "%" was not ready when checked', p_key using errcode = 'RLW02';
  elsif a.o_state = 'wait' then
    raise exception 'step "%" is not yours to take yet: % waiting in line ahead of you for % ready step(s). Call request_work to wait your turn',
      p_key, v_ahead, a.o_ready using errcode = 'RLW05';
  else
    raise exception 'step "%" is not yours to take yet: % waiting in line ahead of you. Call request_work to wait your turn',
      p_key, v_ahead using errcode = 'RLW05';
  end if;
end $$;
