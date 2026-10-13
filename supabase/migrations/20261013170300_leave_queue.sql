-- leave_queue: give up your place in a plan's line (CL-3.9, issue #74;
-- docs/design.md "Claims and work plans" items 11 and 12a). The place is
-- the caller's person's, from the session, never an argument, so nobody
-- can take someone else out of line. Whoever may ask (request_work's own
-- check, writing the plan's path) may leave; a read-only connection or one
-- scoped to another vault is refused, as it is refused a place. True if
-- there was a place to give up, logged as queue.leave; false if not.
--
-- The vault's row first, before the place's, as request_work takes them
-- (20261013170000_waiting_in_line.sql says why).
create function public.leave_queue(p_vault uuid, p_path text)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_plan uuid;
  v_place public.work_plan_places;
begin
  perform private.require_person();
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  perform 1 from public.vaults where id = p_vault for key share;
  select id into v_plan from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan is null then
    return false;
  end if;
  delete from public.work_plan_places where plan_id = v_plan and holder = private.uid()
  returning * into v_place;
  if v_place.id is null then
    return false;
  end if;
  perform private.log_event(p_vault, 'queue.leave', p_path, null, null, jsonb_build_object('plan', v_plan));
  return true;
end $$;

revoke all on function public.leave_queue(uuid, text) from public, anon;
grant execute on function public.leave_queue(uuid, text) to authenticated;
