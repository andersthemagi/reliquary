-- Asking for work, saying when the answer only repeats the last (issue
-- #488). request_work answers an agent back before its own gap from one
-- read, writing nothing (private.take_step, "Asked again too soon"), but
-- the answer looks like any other wait, so the MCP server listed every
-- unfinished step and what holds it up again, recomputing the whole plan's
-- status each time: the cost the capacity model says an early ask doesn't
-- have (docs/research/server-load.md, "Waiting in line through the MCP
-- server, simulated").
--
-- public.ask_for_work is request_work with one more column, o_repeat: true
-- when the answer is a wait whose place this call didn't write. A wait
-- that takes or refreshes a place always sets its next_allowed_at from the
-- clock, so an unchanged one means take_step evaluated nothing and the
-- answer is the last one's. That is read from what take_step did, not
-- decided again here. request_work stays as it is.

create function public.ask_for_work(p_vault uuid, p_path text, p_label text default null, p_ttl_minutes int default null)
returns table (o_state text, o_key text, o_fence int, o_secret text, o_expires timestamptz,
               o_place int, o_ready int, o_wait_seconds int, o_repeat boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me uuid := private.uid();
  v_before timestamptz;
  v_after timestamptz;
  r record;
begin
  select pl.next_allowed_at into v_before
    from public.work_plans wp
    join public.work_plan_places pl on pl.plan_id = wp.id and pl.holder = v_me
   where wp.vault_id = p_vault and wp.path = p_path;
  select * into r from private.take_step(p_vault, p_path, p_label, p_ttl_minutes, null);
  if r.o_state = 'wait' and r.o_place is not null then
    select pl.next_allowed_at into v_after
      from public.work_plans wp
      join public.work_plan_places pl on pl.plan_id = wp.id and pl.holder = v_me
     where wp.vault_id = p_vault and wp.path = p_path;
  end if;
  return query select r.o_state, r.o_key, r.o_fence, r.o_secret, r.o_expires, r.o_place, r.o_ready, r.o_wait_seconds,
    coalesce(v_before is not null and v_after = v_before, false);
end $$;

revoke all on function public.ask_for_work(uuid, text, text, int) from public, anon;
grant execute on function public.ask_for_work(uuid, text, text, int) to authenticated;
