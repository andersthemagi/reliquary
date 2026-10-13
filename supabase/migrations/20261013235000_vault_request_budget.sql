-- Each vault's request budget (CL-3.13, issue #80; docs/design.md "Claims
-- and work plans" item 8; the model: docs/public/reference/limits.md,
-- "What asking for work costs"). The MCP server limits asking for work per
-- token (30 a minute, mcp/src/ratelimit.ts), but a vault's people can hold
-- many tokens between them, and every evaluation is the same database's
-- work, so one busy vault could crowd out the others. This adds one budget
-- per vault, all its people and agents together, counted here rather than
-- in the MCP server's memory: serverless instances share nothing, and the
-- database is the one place every caller of request_work and claim_step
-- goes through, whichever server (or a direct API call) sends it.
--
-- 1. private.request_budget: the budget, 300 evaluations a minute per vault.
--    One row, so an operator (and the load tests, as RATE_LIMIT_SCALE does
--    for the apps' limits) can change it with one update; no API role can
--    read or write it. 300 is the model's: a Pro vault's 50 people, one
--    place in line each, each asking at the 10 second floor, 6 a minute.
-- 2. private.request_budget_hit(vault): counts one evaluation against the
--    vault in private.rate_limits (the apps' counters: fixed one minute
--    windows, a refused hit counts nothing), keyed by a hash of the vault's
--    id. 0, or the seconds until the vault's minute ends.
-- 3. private.take_step counts every full evaluation, after the cheap
--    refusal (a caller back before its own gap is answered from one read,
--    writing nothing, and is bounded by the per-token limit) and after the
--    write check, so nobody who can't ask for work in a vault can use up
--    its budget. Over budget, the answer is `wait` with no place and no
--    ready count, and the seconds to return; nothing else is written and
--    the caller's place, if it has one, is kept as it was. Same body as
--    20261013220000_claim_step_follows_the_line.sql otherwise (the newest
--    take_step; 20261013233000_review_gate.sql doesn't redefine it).
-- 4. public.claim_step refuses the same case as RLW06, with the budget and
--    the seconds. A claim_step refused for any reason rolls back, its count
--    with it, as a refused request counts nothing anywhere. Same body as
--    20261013233000_review_gate.sql otherwise, its refusal for a step
--    awaiting review included.
--
-- The counter row is the vault's: a full evaluation holds its lock until
-- its transaction ends, so a vault's evaluations take turns on it. It is
-- taken before the vault's row and the person's lock, and no other path
-- takes it, so it adds no lock cycle. At the budget that is 5 short
-- transactions a second per vault.
-- ponytail: one counter row per vault; split it across a few keys if one
-- vault's evaluations ever queue on it.

-- ---------------------------------------------------------------------------
-- 1. The budget

create table private.request_budget (
  id         boolean primary key default true check (id),
  per_minute int not null check (per_minute between 1 and 1000000)
);
alter table private.request_budget enable row level security;
revoke all on private.request_budget from public, anon, authenticated, reliquary_web, reliquary_mcp;
insert into private.request_budget (per_minute) values (300);

-- ---------------------------------------------------------------------------
-- 2. Counting an evaluation

create function private.request_budget_hit(p_vault uuid) returns int
language sql volatile security definer set search_path = '' as $$
  select private.rate_limit_hit(array['vault_request_work_minute'],
    array[encode(sha256(convert_to('vault:' || p_vault::text, 'UTF8')), 'hex')],
    array[60], array[(select b.per_minute from private.request_budget b)], array[1])
$$;
revoke all on function private.request_budget_hit(uuid) from public, anon, authenticated, reliquary_web, reliquary_mcp;

-- ---------------------------------------------------------------------------
-- 3. take_step counts it

create or replace function private.take_step(p_vault uuid, p_path text, p_label text, p_ttl_minutes int, p_key text)
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

  -- The vault's budget: over it, come back when its minute ends.
  v_wait := private.request_budget_hit(p_vault);
  if v_wait > 0 then
    return query select 'wait', null::text, null::int, null::text, null::timestamptz, null::int, null::int, v_wait;
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
       where st.plan_id = v_plan and st.open_blockers = 0 and (p_key is null or st.key = p_key)
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
revoke all on function private.take_step(uuid, text, text, int, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. claim_step refuses it in words

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
  elsif a.o_state = 'wait' and a.o_place is null then
    raise exception 'this vault''s people and agents together have asked for work % times this minute, its budget; ask again in % seconds',
      (select b.per_minute from private.request_budget b), a.o_wait_seconds using errcode = 'RLW06';
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
