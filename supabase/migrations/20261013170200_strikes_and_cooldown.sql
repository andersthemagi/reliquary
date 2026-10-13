-- Strikes and the cooldown (CL-3.9, issue #74; docs/design.md "Claims and
-- work plans" item 12e), from spikes/claims/guard.sql. A claim that lapses
-- unfinished is a strike against its person in that vault, counted when
-- request_work hands the lapsed step to someone else. The rule's free
-- lapses (1 by default) cost nothing; each one after earns a cooldown,
-- the rule's lease and then double the last, never more than the rule's
-- cooldown cap. A person cooling down is answered cooling_down, with how
-- long, and gives up every place they hold in the vault's lines, so a
-- place they can't use holds up nobody behind it. Finishing a step
-- (complete_step) clears the count.
--
-- claim_step is unchanged: naming a step to claim neither counts a strike
-- nor waits out a cooldown. It is the direct primitive request_work wraps
-- (20261002200000_work_plans.sql); whether an agent should keep it at
-- all, and under which caps, is the MCP tools' question (#75).
--
-- Lock order: the step (request_work's SKIP LOCKED pick, or complete_step's
-- row), then the strike, then places with SKIP LOCKED, which never wait.

-- Ends every place p_person holds in the vault's lines, each logged as theirs.
create function private.give_up_places(p_vault uuid, p_person uuid, p_reason text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare x record;
begin
  for x in delete from public.work_plan_places pl where pl.id in (
             select l.id from public.work_plan_places l where l.vault_id = p_vault and l.holder = p_person
              order by l.id for update skip locked)
           returning pl.holder, pl.agent, pl.plan_id loop
    perform private.place_ended(p_vault, x.holder, x.agent, (select wp.path from public.work_plans wp where wp.id = x.plan_id),
      x.plan_id, p_reason);
  end loop;
end $$;
revoke all on function private.give_up_places(uuid, uuid, text) from public, anon, authenticated;

-- A lapse against p_person, and the cooldown it earns past the free ones.
create function private.strike(p_vault uuid, p_person uuid, p_lease_minutes int, p_free_lapses int, p_cap_minutes int)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_n int;
begin
  insert into private.work_plan_strikes as s (vault_id, person, strikes, last_at)
  values (p_vault, p_person, 1, clock_timestamp())
  on conflict (vault_id, person) do update set strikes = s.strikes + 1, last_at = excluded.last_at
  returning s.strikes into v_n;
  if v_n <= p_free_lapses then
    return;
  end if;
  -- The exponent stops at 20: past that the cap has long since won, and the
  -- interval would overflow.
  update private.work_plan_strikes
     set cooldown_until = clock_timestamp()
       + least(p_lease_minutes * power(2, least(v_n - p_free_lapses - 1, 20)), p_cap_minutes) * interval '1 minute'
   where vault_id = p_vault and person = p_person;
  perform private.give_up_places(p_vault, p_person, 'cooling_down');
end $$;
revoke all on function private.strike(uuid, uuid, int, int, int) from public, anon, authenticated;

create or replace function public.request_work(p_vault uuid, p_path text, p_label text default null, p_ttl_minutes int default null)
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
  v_cool timestamptz;
  v_prev_status text;
  v_prev_holder uuid;
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

  select s.cooldown_until into v_cool from private.work_plan_strikes s where s.vault_id = p_vault and s.person = v_me;
  if v_cool > v_now then
    perform private.give_up_places(p_vault, v_me, 'cooling_down');
    return query select 'cooling_down', null::text, null::int, null::text, null::timestamptz, null::int, null::int,
      greatest(1, ceil(extract(epoch from v_cool - v_now)))::int;
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
      select st.id, st.status as prev_status, st.holder as prev_holder from public.work_plan_steps st
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
    returning st.key, st.fence, st.expires_at, pick.prev_status, pick.prev_holder
      into v_key, v_fence, v_expires, v_prev_status, v_prev_holder;
    if found then
      if v_prev_status = 'claimed' and v_prev_holder is not null then
        perform private.strike(p_vault, v_prev_holder, r.lease_minutes, r.free_lapses, r.cooldown_cap_minutes);
      end if;
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

-- As 20261013160000_work_plan_gains_steps.sql, plus: finishing a step
-- clears its person's strikes in the vault.
create or replace function public.complete_step(p_vault uuid, p_path text, p_key text, p_fence int, p_secret text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_plan_id uuid; v_row public.work_plan_steps;
begin
  perform private.require_person();
  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
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

  update public.work_plan_steps set status = 'done', done_at = clock_timestamp() where id = v_row.id;
  perform private.unblock_dependents(v_row.id);
  delete from private.work_plan_strikes where vault_id = p_vault and person = private.uid();
  perform private.log_event(p_vault, 'step.complete', p_path, null, null,
    jsonb_build_object('plan', v_plan_id, 'step', p_key, 'fence', p_fence));
end $$;
