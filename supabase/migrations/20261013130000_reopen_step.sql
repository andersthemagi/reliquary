-- Reopen a cancelled step (issue #76; the owner's decision of 2026-10-13
-- on the issue): a person's way back for when there is reason to, beside
-- cancel_step and skip_step (20261002200000_work_plans.sql). The nudge
-- toward a new task that names the old one lives in the docs and the MCP
-- descriptions, not here: the database only says who may and what it does.
--
-- On the ceiling, like cancel and skip: a cancel is a person's decision,
-- so undoing it is too, and an agent that could reopen could put back work
-- a person dropped on the word of text it read.
--
-- Nothing to recount. cancel_step never decrements a dependent's
-- open_blockers, so a cancelled step is still counted as unfinished by
-- everything waiting on it; and unblock_dependents decrements regardless
-- of status, so the cancelled step's own count stayed right while it sat
-- cancelled. Setting status back to open is the whole change:
-- work_plan_status then reads it ready or blocked from its own count, and
-- its dependents blocked (by an unfinished step) rather than
-- blocked_by_cancelled.
--
-- Only a cancelled step. A skipped step is stored as done, the same as a
-- completed one, and its dependents were already freed and may be claimed
-- or done; taking that back would mean re-blocking work in flight.
create function public.reopen_step(p_vault uuid, p_path text, p_key text)
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
  select * into v_row from public.work_plan_steps where plan_id = v_plan_id and key = p_key for update;
  if v_row.id is null then
    raise exception 'no such step' using errcode = 'P0002';
  end if;
  if v_row.status <> 'cancelled' then
    raise exception 'step "%" is not cancelled; only a cancelled step can be reopened', p_key using errcode = 'RLW02';
  end if;
  update public.work_plan_steps set status = 'open' where id = v_row.id;
  perform private.log_event(p_vault, 'step.reopen', p_path, null, null, jsonb_build_object('plan', v_plan_id, 'step', p_key));
end $$;

revoke all on function public.reopen_step(uuid, text, text) from public, anon;
grant execute on function public.reopen_step(uuid, text, text) to authenticated;
