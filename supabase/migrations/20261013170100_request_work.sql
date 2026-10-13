-- request_work: ask for any ready step of a plan, in one call that never
-- blocks (CL-3.9, issue #74; docs/design.md "Claims and work plans" item
-- 11, with items 3, 8 and 12). Ported from spikes/claims/guard.sql's
-- agent_request_work onto work_plan_steps, the claim rules and
-- 20261013170000_waiting_in_line.sql's places.
--
-- The answer is one of: granted (the step, its fence, its secret once and
-- its lease, as claim_step gives them), wait (the caller's place in line,
-- how many steps are ready, and seconds until it should ask again),
-- at_capacity, blocked_by_cancelled, plan_complete, refused (too many
-- places in line already) or no_such_plan. A state is an answer, not an
-- error: only "you can't" (42501, the same as claim_step) and a bad
-- argument (22023) raise.
--
-- The rule (item 11): the k-th oldest live place may claim only if at
-- least k steps are ready. A caller with no live place counts as the back
-- of the line. The claim itself is claim_step's update, taking the first
-- ready step with FOR UPDATE SKIP LOCKED, so a crowd never queues on one
-- row and never gets one step twice; the place and the count of ready
-- steps it was granted against are in step.claim's log entry.
--
-- A place lives for the rule's place-in-line time from the caller's last
-- full evaluation; one that lapsed is deleted by the next call to the plan
-- (queue.expire), and its holder, coming back, starts at the back. A
-- caller that asks again before its time gets its last answer from the
-- place it already has, with no write (item 12d); that time is the
-- suggested wait, never more than the rule's minimum gap. The suggested
-- wait is the earliest claimed step's lease end, never more than the
-- rule's longest hint.
--
-- Caps: the rule's claims per connection and per person count the steps
-- they hold in the vault; 3 places in line per person in a vault (item 8,
-- confirmed 2026-10-02), a constant until a rule needs it.
--
-- Concurrency. One person's requests to a vault take turns (an advisory
-- lock), so two at once, from one connection or two, both answer and
-- leave one place. Lock order: the vault's row first (see
-- 20261013170000_waiting_in_line.sql), then the caller's own place, then
-- others' lapsed places and the step with SKIP LOCKED, which never wait.

-- The claim rule for a plan's path, every setting request_work reads:
-- claim_rule_for's five and the five waiting ones, with the Org preset
-- (design item 3) when no rule covers the path.
create function private.queue_rule_for(p_vault uuid, p_path text,
  out lease_minutes int, out max_lease_minutes int, out connection_cap int, out person_cap int,
  out place_in_line_minutes int, out check_again_minutes int, out min_gap_seconds int,
  out free_lapses int, out cooldown_cap_minutes int)
language sql stable security definer set search_path = '' as $$
  select coalesce(cr.lease_minutes, 48 * 60), coalesce(cr.max_lease_minutes, 48 * 60),
         coalesce(cr.connection_cap, 1), coalesce(cr.person_cap, 5),
         coalesce(cr.place_in_line_minutes, 6 * 60), coalesce(cr.check_again_minutes, 60),
         coalesce(cr.min_gap_seconds, 15 * 60), coalesce(cr.free_lapses, 1),
         coalesce(cr.cooldown_cap_minutes, 48 * 60)
  from (select 1) x
  left join lateral (
    select * from public.claim_rules cr
     where cr.vault_id = p_vault
       and (cr.path = ''
            or cr.path = p_path
            or (right(cr.path, 1) = '/'
                and p_path like replace(replace(cr.path, '%', '\%'), '_', '\_') || '%' escape '\'))
     order by (cr.path = p_path) desc, length(cr.path) desc
     limit 1
  ) cr on true
$$;
revoke all on function private.queue_rule_for(uuid, text) from public, anon, authenticated;

-- A place that ended without its holder giving it up, logged as theirs.
create function private.place_ended(p_vault uuid, p_holder uuid, p_agent text, p_path text, p_plan uuid, p_reason text)
returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.log (vault_id, actor, agent, event, path, detail)
  values (p_vault, p_holder, p_agent, 'queue.expire', p_path, jsonb_build_object('plan', p_plan, 'reason', p_reason))
$$;
revoke all on function private.place_ended(uuid, uuid, text, text, uuid, text) from public, anon, authenticated;

create function public.request_work(p_vault uuid, p_path text, p_label text default null, p_ttl_minutes int default null)
returns table (o_state text, o_key text, o_fence int, o_secret text, o_expires timestamptz,
               o_place int, o_ready int, o_wait_seconds int)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me uuid := private.uid();
  v_tok uuid := private.token_id();
  v_label text := nullif(trim(coalesce(p_label, '')), '');
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_now timestamptz;
  v_plan uuid;
  v_place public.work_plan_places;
  f record;
  r record;
  v_key text;
  v_fence int;
  v_expires timestamptz;
  v_ttl interval;
  v_rank int;
  v_ready int;
  v_conn int;
  v_person int;
  v_next timestamptz;
  v_wait int;
  v_new boolean;
  x record;
begin
  perform private.require_person();
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if v_label is not null and length(v_label) > 200 then
    raise exception 'a label is at most 200 characters' using errcode = '22023';
  end if;
  if p_ttl_minutes is not null and p_ttl_minutes < 1 then
    raise exception 'a claim lasts at least one minute' using errcode = '22023';
  end if;

  -- Asked again too soon: the last answer, from one read, writing nothing.
  v_now := clock_timestamp();
  select wp.id as plan, pl.expires_at, pl.next_allowed_at, pl.last_place, pl.last_ready into f
    from public.work_plans wp
    left join public.work_plan_places pl on pl.plan_id = wp.id and pl.holder = v_me
   where wp.vault_id = p_vault and wp.path = p_path;
  v_plan := f.plan;
  if v_plan is null then
    return query select 'no_such_plan', null::text, null::int, null::text, null::timestamptz, null::int, null::int, null::int;
    return;
  end if;
  if f.expires_at > v_now and f.next_allowed_at > v_now then
    return query select 'wait', null::text, null::int, null::text, null::timestamptz, f.last_place, f.last_ready,
      greatest(1, ceil(extract(epoch from f.next_allowed_at - v_now)))::int;
    return;
  end if;

  perform 1 from public.vaults where id = p_vault for key share;
  if not found then
    return query select 'no_such_plan', null::text, null::int, null::text, null::timestamptz, null::int, null::int, null::int;
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('reliquary.queue:' || p_vault::text || ':' || v_me::text, 0));
  v_now := clock_timestamp();
  select * into r from private.queue_rule_for(p_vault, p_path);

  -- Nothing left to wait for: everyone waiting stops, and gives up their place.
  if not exists (select 1 from public.work_plan_steps st where st.plan_id = v_plan and st.status in ('open', 'claimed')) then
    for x in delete from public.work_plan_places pl where pl.id in (
               select l.id from public.work_plan_places l where l.plan_id = v_plan order by l.id for update skip locked)
             returning pl.holder, pl.agent loop
      perform private.place_ended(p_vault, x.holder, x.agent, p_path, v_plan, 'plan_complete');
    end loop;
    return query select 'plan_complete', null::text, null::int, null::text, null::timestamptz, null::int, null::int, null::int;
    return;
  end if;

  select count(*) filter (where st.holder_token is not distinct from v_tok), count(*)
    into v_conn, v_person
    from public.work_plan_steps st
   where st.vault_id = p_vault and st.holder = v_me and st.status = 'claimed' and st.expires_at > v_now;
  if v_conn >= r.connection_cap or v_person >= r.person_cap then
    return query select 'at_capacity', null::text, null::int, null::text, null::timestamptz, null::int, null::int, null::int;
    return;
  end if;

  -- The caller's own place first (the only place row this may wait on),
  -- then everyone else's lapsed ones, skipping any another call holds.
  select * into v_place from public.work_plan_places pl where pl.plan_id = v_plan and pl.holder = v_me for update;
  if v_place.id is not null and v_place.expires_at <= v_now then
    delete from public.work_plan_places where id = v_place.id;
    perform private.place_ended(p_vault, v_me, v_place.agent, p_path, v_plan, 'lapsed');
    v_place := null;
  end if;
  for x in delete from public.work_plan_places pl where pl.id in (
             select l.id from public.work_plan_places l
              where l.plan_id = v_plan and l.expires_at <= v_now order by l.id for update skip locked)
           returning pl.holder, pl.agent loop
    perform private.place_ended(p_vault, x.holder, x.agent, p_path, v_plan, 'lapsed');
  end loop;

  if v_place.id is not null then
    select count(*) + 1 into v_rank from public.work_plan_places pl
     where pl.plan_id = v_plan and pl.expires_at > v_now and (pl.created_at, pl.id) < (v_place.created_at, v_place.id);
  else
    select count(*) + 1 into v_rank from public.work_plan_places pl where pl.plan_id = v_plan and pl.expires_at > v_now;
  end if;

  -- Ready steps, counted only as far as the caller's place.
  select count(*) into v_ready from (
    select 1 from public.work_plan_steps st
     where st.plan_id = v_plan and st.status = 'open' and st.open_blockers = 0 limit v_rank) x;
  if v_ready < v_rank then
    select v_ready + count(*) into v_ready from (
      select 1 from public.work_plan_steps st
       where st.plan_id = v_plan and st.status = 'claimed' and st.expires_at <= v_now and st.open_blockers = 0
       limit v_rank - v_ready) x;
  end if;

  if v_rank <= v_ready then
    v_ttl := least(coalesce(p_ttl_minutes, r.lease_minutes), r.max_lease_minutes) * interval '1 minute';
    with pick as (
      select st.id from public.work_plan_steps st
       where st.plan_id = v_plan and st.open_blockers = 0
         and (st.status = 'open' or (st.status = 'claimed' and st.expires_at <= clock_timestamp()))
       order by st.id
       for update skip locked
       limit 1)
    update public.work_plan_steps st
       set status = 'claimed', fence = st.fence + 1, holder = v_me, holder_token = v_tok,
           holder_label = v_label, secret_hash = private.token_hash(v_secret),
           claimed_at = clock_timestamp(), expires_at = clock_timestamp() + v_ttl
      from pick where st.id = pick.id
    returning st.key, st.fence, st.expires_at into v_key, v_fence, v_expires;
    if found then
      delete from public.work_plan_places where plan_id = v_plan and holder = v_me;
      perform private.log_event(p_vault, 'step.claim', p_path, null, null,
        jsonb_build_object('plan', v_plan, 'step', v_key, 'fence', v_fence, 'place', v_rank, 'ready', v_ready));
      return query select 'granted', v_key, v_fence, v_secret, v_expires, v_rank, v_ready, null::int;
      return;
    end if;
  end if;

  -- Nothing ready, nobody working, and a step cancelled: only a person can move this plan.
  if v_ready = 0
     and not exists (select 1 from public.work_plan_steps st where st.plan_id = v_plan and st.status = 'claimed' and st.expires_at > v_now)
     and exists (select 1 from public.work_plan_steps st where st.plan_id = v_plan and st.status = 'cancelled') then
    return query select 'blocked_by_cancelled', null::text, null::int, null::text, null::timestamptz, null::int, 0, null::int;
    return;
  end if;

  if v_place.id is null
     and (select count(*) from public.work_plan_places pl
           where pl.vault_id = p_vault and pl.holder = v_me and pl.expires_at > v_now) >= 3 then
    return query select 'refused', null::text, null::int, null::text, null::timestamptz, null::int, null::int, null::int;
    return;
  end if;

  select min(st.expires_at) into v_next from public.work_plan_steps st
   where st.plan_id = v_plan and st.status = 'claimed' and st.expires_at > v_now;
  v_wait := greatest(1, ceil(extract(epoch from
              least(coalesce(v_next - v_now, r.check_again_minutes * interval '1 minute'), r.check_again_minutes * interval '1 minute'))))::int;

  insert into public.work_plan_places as pl (plan_id, vault_id, holder, label, agent, created_at, expires_at, next_allowed_at, last_place, last_ready)
  values (v_plan, p_vault, v_me, v_label, private.agent(), v_now, v_now + r.place_in_line_minutes * interval '1 minute',
          v_now + least(r.min_gap_seconds, v_wait) * interval '1 second', v_rank, v_ready)
  on conflict (plan_id, holder) do update
     set expires_at = excluded.expires_at, next_allowed_at = excluded.next_allowed_at,
         last_place = excluded.last_place, last_ready = excluded.last_ready,
         label = excluded.label, agent = excluded.agent
  returning (xmax = 0) into v_new;
  if v_new then
    perform private.log_event(p_vault, 'queue.join', p_path, null, null, jsonb_build_object('plan', v_plan, 'place', v_rank));
  end if;
  return query select 'wait', null::text, null::int, null::text, null::timestamptz, v_rank, v_ready, v_wait;
end $$;

revoke all on function public.request_work(uuid, text, text, int) from public, anon;
grant execute on function public.request_work(uuid, text, text, int) to authenticated;
