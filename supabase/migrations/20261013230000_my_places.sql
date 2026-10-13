-- my_places: where the caller's person stands in every line, in one call
-- (CL-3.12, issue #79; docs/design.md "Claims and work plans" items 11 and
-- 12d). An agent with places on ten plans otherwise asks request_work ten
-- times to learn that nothing changed.
--
-- One row per place the person holds, per step they hold, and per vault
-- they are cooling down in, across the vaults the caller can read (token
-- scope included, through readable_vaults). A place's state is what
-- request_work would answer it, checked in request_work's order:
-- plan_complete, cooling_down, at_capacity, then lapsed (the place ran out;
-- asking again starts at the back) or waiting, with the place's rank among
-- the live places and when to ask again. A held step is holding, with its
-- lease's end. A cooldown has its own row (no path) because entering one
-- gives up every place in the vault, so there may be no place to carry it.
--
-- Read only (stable: a write here would raise): the places and steps by
-- their (vault_id, holder) indexes, the rank and ready count by the line's
-- and the plan's indexes, nothing past the caller's rank. Of other people
-- it says how many wait ahead and nothing else. Security definer only to
-- read the caller's own strikes and the rule's waiting settings, both
-- private; every row is the caller's person's.
create function public.my_places()
returns table (o_vault uuid, o_path text, o_state text, o_place int, o_ready int, o_at timestamptz, o_step text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := private.uid();
  v_tok uuid := private.token_id();
  v_now timestamptz := clock_timestamp();
begin
  perform private.require_person();
  return query
  with vaults as (select v from private.readable_vaults() v),
  cool as (
    select s.vault_id, s.cooldown_until from private.work_plan_strikes s
     where s.person = v_me and s.vault_id in (select v from vaults) and s.cooldown_until > v_now),
  held as (
    select st.vault_id, st.plan_id, st.key, st.expires_at, st.holder_token from public.work_plan_steps st
     where st.holder = v_me and st.vault_id in (select v from vaults) and st.status = 'claimed' and st.expires_at > v_now),
  places as (
    select pl.*, wp.path,
           exists (select 1 from public.work_plan_steps st where st.plan_id = pl.plan_id and st.status in ('open', 'claimed')) as unfinished,
           (select c.cooldown_until from cool c where c.vault_id = pl.vault_id) as cool_until,
           r.connection_cap, r.person_cap, r.check_again_minutes,
           (select count(*) + 1 from public.work_plan_places o
             where o.plan_id = pl.plan_id and o.expires_at > v_now and (o.created_at, o.id) < (pl.created_at, pl.id))::int as rank
      from public.work_plan_places pl
      join public.work_plans wp on wp.id = pl.plan_id
      cross join lateral private.queue_rule_for(pl.vault_id, wp.path) r
     where pl.holder = v_me and pl.vault_id in (select v from vaults)),
  judged as (
    select p.*,
           case when not p.unfinished then 'plan_complete'
                when p.cool_until is not null then 'cooling_down'
                when (select count(*) from held h where h.vault_id = p.vault_id and h.holder_token is not distinct from v_tok) >= p.connection_cap
                  or (select count(*) from held h where h.vault_id = p.vault_id) >= p.person_cap then 'at_capacity'
                when p.expires_at <= v_now then 'lapsed'
                else 'waiting' end as state
      from places p)
  select j.vault_id, j.path, j.state,
         case when j.state = 'waiting' then j.rank end,
         rd.n,
         case j.state
           when 'cooling_down' then j.cool_until
           when 'lapsed' then j.expires_at
           -- request_work's suggestion: now if a step is free for this
           -- place, else the earliest lease end, never past the longest
           -- hint; and never before the place may ask again, since asking
           -- sooner only repeats the last answer.
           when 'waiting' then greatest(j.next_allowed_at,
             case when rd.n >= j.rank then v_now
                  else least(coalesce((select min(st.expires_at) from public.work_plan_steps st
                                        where st.plan_id = j.plan_id and st.status = 'claimed' and st.expires_at > v_now),
                                      'infinity'),
                             v_now + j.check_again_minutes * interval '1 minute') end)
         end,
         null::text
    from judged j
    left join lateral (
      select count(*)::int as n from (
        select 1 from public.work_plan_steps st
         where st.plan_id = j.plan_id and st.open_blockers = 0
           and (st.status = 'open' or (st.status = 'claimed' and st.expires_at <= v_now))
         limit j.rank) x
    ) rd on j.state = 'waiting'
  union all
  select h.vault_id, wp.path, 'holding', null::int, null::int, h.expires_at, h.key
    from held h join public.work_plans wp on wp.id = h.plan_id
  union all
  select c.vault_id, null::text, 'cooling_down', null::int, null::int, c.cooldown_until, null::text
    from cool c
  order by 1, 2 nulls first, 3, 7;
end $$;

revoke all on function public.my_places() from public, anon;
grant execute on function public.my_places() to authenticated;
