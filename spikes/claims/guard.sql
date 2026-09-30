-- Fourth spike: assume the agent is hostile. Loaded after schema.sql, plan.sql
-- and queue.sql. Nothing here relies on an agent behaving, and none of it needs
-- a model: every rule is a predicate the database checks.
--
-- 1. ONE way in. Agents may execute only the agent_* functions below. The
--    earlier claim_ready_step and request_work, which do not know about the
--    queue, are not executable by an agent, and no table is readable or
--    writable by one.
-- 2. Identity comes from the session (app.token = the connection, app.member =
--    the person it acts for), never from an argument. In Reliquary these are the
--    verified token id and user id in the request's claims.
-- 3. Every rule is a predicate in the same statement as the change: the step is
--    open or expired, every blocker is done, this person is next in line (the
--    k-th oldest live place needs k ready steps), and neither the connection nor
--    the person holds more than the rule allows.
-- 4. Cheap refusal. A caller who comes back before its time gets the last answer
--    from one indexed read, with no write. A place in line is written at most once
--    per min_poll however often the caller asks.
-- 5. Cheap to run. Readiness is a stored count of unfinished blockers, kept in
--    step when a blocker completes (in lock order), so "is anything ready" is a
--    partial-index lookup that never joins and never looks at another plan. A
--    place in line is refreshed in place (no indexed column changes, spare room
--    in the table), so hammering does not grow the indexes.
-- 6. Bounded damage. The unit of fairness is the person, not the connection:
--    one place in line per person per plan, one cap on what a person's agents
--    hold together, and a cooldown that grows each time that person lets a claim
--    lapse unfinished (the first is free, and finishing a step clears the
--    count). A claim can also not be held longer than max_hold however often it
--    is checked in.

alter table claim_rules
  add column if not exists min_poll interval not null default interval '15 minutes',
  add column if not exists max_active int not null default 1,
  add column if not exists max_hold interval not null default interval '7 days',
  add column if not exists max_tickets int not null default 10,
  add column if not exists max_active_member int not null default 5,
  add column if not exists free_strikes int not null default 1,
  add column if not exists cooldown_cap interval not null default interval '48 hours';
alter table plan_steps add column if not exists claimed_at timestamptz;
alter table plan_steps add column if not exists open_blockers int not null default 0;
alter table plan_steps add column if not exists holder_member uuid;
alter table tickets
  add column if not exists next_allowed_at timestamptz not null default clock_timestamp(),
  add column if not exists last_rank int,
  add column if not exists last_ready int,
  add column if not exists member uuid;
create table claim_strikes (
  vault_id uuid not null,
  member uuid not null,
  strikes int not null default 0,
  cooldown_until timestamptz,
  last_at timestamptz not null default clock_timestamp(),
  primary key (vault_id, member)
);
create index plan_steps_plan_status on plan_steps (vault_id, plan, status);
create index plan_steps_holder on plan_steps (holder_token) where status = 'claimed';
create index plan_steps_member on plan_steps (vault_id, holder_member) where status = 'claimed';
create index plan_steps_ready on plan_steps (vault_id, plan, id) where status = 'open' and open_blockers = 0;
create index plan_steps_lease on plan_steps (vault_id, plan, lease_expires_at) where status = 'claimed';
create index plan_steps_unfinished on plan_steps (vault_id, plan) where status <> 'done';
create unique index tickets_person on tickets (vault_id, plan, member);
create index tickets_member on tickets (vault_id, member);
-- Refreshing a place in line changes no indexed column and leaves room on the page,
-- so the update happens in place and the indexes do not grow with every poll.
alter table tickets set (fillfactor = 70);

-- Registration also fills each step's count of unfinished blockers.
alter function register_plan(uuid, text, jsonb) rename to register_plan_base;
create function register_plan(p_vault uuid, p_plan text, p_steps jsonb) returns int
language plpgsql volatile as $$
declare n int;
begin
  n := register_plan_base(p_vault, p_plan, p_steps);
  update plan_steps s set open_blockers = (select count(*) from plan_step_deps d where d.step_id = s.id)
   where s.vault_id = p_vault and s.plan = p_plan;
  return n;
end $$;

-- For tests: every step's stored count must equal its real number of unfinished blockers.
create function counter_drift() returns bigint language sql stable as $$
  select count(*) from plan_steps s
   where s.open_blockers <> (select count(*) from plan_step_deps d join plan_steps b on b.id = d.blocker_id
                              where d.step_id = s.id and b.status <> 'done') $$;

drop function if exists rule_for(uuid, text);
create function rule_for(p_vault uuid, p_plan text,
  out lease interval, out max_lease interval, out ticket_ttl interval, out poll_cap interval,
  out min_poll interval, out max_active int, out max_hold interval, out max_tickets int,
  out max_active_member int, out free_strikes int, out cooldown_cap interval)
language plpgsql stable as $$
begin
  select r.lease, r.max_lease, r.ticket_ttl, r.poll_cap, r.min_poll, r.max_active, r.max_hold, r.max_tickets,
         r.max_active_member, r.free_strikes, r.cooldown_cap
    into lease, max_lease, ticket_ttl, poll_cap, min_poll, max_active, max_hold, max_tickets,
         max_active_member, free_strikes, cooldown_cap
    from claim_rules r
   where r.vault_id = p_vault and p_plan like r.prefix || '%'
   order by length(r.prefix) desc limit 1;
  if not found then
    lease := interval '48 hours'; max_lease := interval '30 days';
    ticket_ttl := interval '6 hours'; poll_cap := interval '1 hour';
    min_poll := interval '15 minutes'; max_active := 1; max_hold := interval '7 days'; max_tickets := 10;
    max_active_member := 5; free_strikes := 1; cooldown_cap := interval '48 hours';
  end if;
end $$;

-- ------------------------------------------------------------ request
create function agent_request_work(p_vault uuid, p_plan text, p_label text default null, p_lease interval default null)
returns table (o_state text, o_id bigint, o_key text, o_fence bigint, o_secret text,
               o_expires timestamptz, o_rank int, o_ready int, o_check_ms bigint)
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_token uuid := nullif(current_setting('app.token', true), '')::uuid;
  v_member uuid := nullif(current_setting('app.member', true), '')::uuid;
  v_now timestamptz;
  r record; g record; tk record;
  v_lease interval;
  v_secret text := gen_random_uuid()::text || gen_random_uuid()::text;
  v_rank int; v_ready int; v_conn int; v_person int; v_live int;
  v_next timestamptz; v_hint bigint; v_mine timestamptz; v_have boolean; v_cool timestamptz;
begin
  if v_token is null or v_member is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  v_now := clock_timestamp();

  -- Fast path: one indexed read, no write. Coming back early gets the last answer.
  select t.next_allowed_at, t.last_rank, t.last_ready into tk
    from tickets t
   where t.vault_id = p_vault and t.plan = p_plan and t.member = v_member and t.expires_at > v_now;
  if found and tk.next_allowed_at > v_now then
    return query select 'wait', null::bigint, null::text, null::bigint, null::text, null::timestamptz,
                        tk.last_rank, tk.last_ready,
                        greatest(1, ceil(1000 * extract(epoch from (tk.next_allowed_at - v_now))))::bigint;
    return;
  end if;

  select * into r from rule_for(p_vault, p_plan);

  -- Cooldown after repeated claims that lapsed unfinished: one primary-key read.
  select c.cooldown_until into v_cool from claim_strikes c where c.vault_id = p_vault and c.member = v_member;
  if v_cool is not null and v_cool > v_now then
    return query select 'cooling_down', null::bigint, null::text, null::bigint, null::text, null::timestamptz,
                        null::int, null::int, ceil(1000 * extract(epoch from (v_cool - v_now)))::bigint;
    return;
  end if;

  -- Hoarding guard, one indexed lookup: this connection and this person each hold a bounded number.
  select count(*) filter (where s.holder_token = v_token), count(*), min(s.lease_expires_at)
    into v_conn, v_person, v_mine
    from plan_steps s
   where s.vault_id = p_vault and s.holder_member = v_member and s.status = 'claimed' and s.lease_expires_at > v_now;
  if v_conn >= r.max_active or v_person >= r.max_active_member then
    return query select 'at_capacity', null::bigint, null::text, null::bigint, null::text, null::timestamptz,
                        null::int, null::int,
                        greatest(1000 * extract(epoch from r.min_poll),
                                 1000 * extract(epoch from (v_mine - v_now)))::bigint;
    return;
  end if;

  v_lease := least(coalesce(p_lease, r.lease), r.max_lease);

  -- Plan-level facts as index probes, not a scan of every step.
  if not exists (select 1 from plan_steps where vault_id = p_vault and plan = p_plan) then
    return query select 'no_such_plan', null::bigint, null::text, null::bigint, null::text, null::timestamptz, null::int, null::int, null::bigint;
    return;
  end if;
  if not exists (select 1 from plan_steps where vault_id = p_vault and plan = p_plan and status <> 'done') then
    delete from tickets where vault_id = p_vault and plan = p_plan and member = v_member;
    return query select 'plan_complete', null::bigint, null::text, null::bigint, null::text, null::timestamptz, null::int, null::int, null::bigint;
    return;
  end if;

  -- Lapsed places in line go; then find this person's place, or the back of the line.
  delete from tickets where vault_id = p_vault and plan = p_plan and expires_at <= v_now;
  select t.created_at, t.id into tk from tickets t
   where t.vault_id = p_vault and t.plan = p_plan and t.member = v_member;
  v_have := found;
  if v_have then
    select count(*) + 1 into v_rank from tickets t
     where t.vault_id = p_vault and t.plan = p_plan and (t.created_at, t.id) < (tk.created_at, tk.id);
  else
    select count(*) + 1 into v_rank from tickets t where t.vault_id = p_vault and t.plan = p_plan;
  end if;

  -- How many steps are ready, counted only up to this caller's rank.
  select count(*) into v_ready from (
    select 1 from plan_steps s
     where s.vault_id = p_vault and s.plan = p_plan and s.status = 'open' and s.open_blockers = 0
     limit v_rank) x;
  if v_ready < v_rank then
    select v_ready + count(*) into v_ready from (
      select 1 from plan_steps s
       where s.vault_id = p_vault and s.plan = p_plan and s.status = 'claimed'
         and s.lease_expires_at <= v_now and s.open_blockers = 0
       limit v_rank - v_ready) x;
  end if;

  if v_rank <= v_ready then
    for g in
      with pick as (
        select s.id, s.status as prev_status, s.holder_member as prev_member
          from plan_steps s
         where s.vault_id = p_vault and s.plan = p_plan and s.open_blockers = 0
           and (s.status = 'open' or (s.status = 'claimed' and s.lease_expires_at <= clock_timestamp()))
         order by s.id
         for update of s skip locked
         limit 1),
      upd as (
        update plan_steps s
           set status = 'claimed', fence = s.fence + 1, holder_token = v_token, holder_member = v_member,
               holder_label = p_label, secret_hash = h(v_secret), claimed_at = clock_timestamp(),
               lease_expires_at = clock_timestamp() + v_lease
          from pick where s.id = pick.id
        returning s.id, s.key, s.fence, s.lease_expires_at),
      -- Taking over a lapsed claim is a strike against the person who let it lapse.
      strike as (
        insert into claim_strikes (vault_id, member, strikes, cooldown_until, last_at)
        select p_vault, pick.prev_member, 1,
               case when 1 > r.free_strikes then v_now + least(r.lease, r.cooldown_cap) end, v_now
          from pick where pick.prev_status = 'claimed' and pick.prev_member is not null
        on conflict (vault_id, member) do update
           set strikes = claim_strikes.strikes + 1, last_at = excluded.last_at,
               cooldown_until = case when claim_strikes.strikes + 1 > r.free_strikes
                   then v_now + least(r.lease * power(2, claim_strikes.strikes + 1 - r.free_strikes - 1), r.cooldown_cap)
                   else claim_strikes.cooldown_until end
        returning member, cooldown_until),
      -- A person in cooldown gives up their places in line, so they do not hold up others.
      leave as (
        delete from tickets t using strike st
         where t.vault_id = p_vault and t.member = st.member and st.cooldown_until > v_now),
      lg as (
        insert into log (vault_id, event, path, actor, detail)
        select p_vault, 'step.claimed', p_plan, v_token,
               jsonb_build_object('step', upd.id, 'fence', upd.fence, 'rank', v_rank, 'ready', v_ready, 'member', v_member)
          from upd)
      select upd.id, upd.key, upd.fence, upd.lease_expires_at from upd
    loop
      delete from tickets where vault_id = p_vault and plan = p_plan and member = v_member;
      return query select 'granted', g.id, g.key, g.fence, v_secret, g.lease_expires_at, v_rank, v_ready, null::bigint;
      return;
    end loop;
  end if;

  if v_ready = 0
     and not exists (select 1 from plan_steps where vault_id = p_vault and plan = p_plan and status = 'claimed' and lease_expires_at > v_now)
     and exists (select 1 from plan_steps where vault_id = p_vault and plan = p_plan and status = 'cancelled') then
    return query select 'blocked_by_cancelled', null::bigint, null::text, null::bigint, null::text, null::timestamptz, v_rank, v_ready, null::bigint;
    return;
  end if;

  select min(lease_expires_at) into v_next from plan_steps
   where vault_id = p_vault and plan = p_plan and status = 'claimed' and lease_expires_at > v_now;
  v_hint := greatest(50, floor(1000 * extract(epoch from
              least(coalesce(v_next - v_now, r.poll_cap), r.poll_cap)))::bigint);

  -- A new place in line is capped per person across the vault.
  if not v_have then
    select count(*) into v_live from tickets t
     where t.vault_id = p_vault and t.member = v_member and t.expires_at > v_now;
    if v_live >= r.max_tickets then
      return query select 'refused_too_many_places', null::bigint, null::text, null::bigint, null::text, null::timestamptz, null::int, null::int, null::bigint;
      return;
    end if;
  end if;

  insert into tickets (vault_id, plan, holder_token, member, label, expires_at, next_allowed_at, last_rank, last_ready)
  values (p_vault, p_plan, v_token, v_member, p_label, v_now + r.ticket_ttl,
          v_now + least(r.min_poll, make_interval(secs => v_hint / 1000.0)), v_rank, v_ready)
  on conflict (vault_id, plan, member) do update
     set expires_at = excluded.expires_at, next_allowed_at = excluded.next_allowed_at,
         last_rank = excluded.last_rank, last_ready = excluded.last_ready, label = excluded.label;
  return query select 'wait', null::bigint, null::text, null::bigint, null::text, null::timestamptz, v_rank, v_ready, v_hint;
end $$;

-- ------------------------------------------------ everything after a claim
-- Each one needs the secret, the fence, the same connection AND the same person
-- that holds the claim, so a leaked secret alone is not enough.
create function agent_complete_step(p_id bigint, p_fence bigint, p_secret text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_id bigint; v_vault uuid; v_member uuid := nullif(current_setting('app.member', true), '')::uuid;
begin
  update plan_steps set status = 'done', done_at = clock_timestamp(), done_fence = p_fence
   where id = p_id and status = 'claimed' and fence = p_fence and secret_hash = h(p_secret)
     and holder_token = nullif(current_setting('app.token', true), '')::uuid
     and holder_member = v_member
     and lease_expires_at > clock_timestamp()
  returning id, vault_id into v_id, v_vault;
  if v_id is null then return false; end if;
  -- Finishing a step clears the person's strikes.
  delete from claim_strikes where vault_id = v_vault and member = v_member;
  -- Tell the steps waiting on this one. Lock them in id order first: two steps that
  -- finish at once and share dependents would otherwise take the same rows in
  -- opposite orders and deadlock.
  perform 1 from plan_steps s
   where s.id in (select d.step_id from plan_step_deps d where d.blocker_id = p_id)
   order by s.id for update;
  update plan_steps s set open_blockers = s.open_blockers - 1
   where s.id in (select d.step_id from plan_step_deps d where d.blocker_id = p_id);
  return true;
end $$;

create function agent_release_step(p_id bigint, p_fence bigint, p_secret text)
returns boolean language sql volatile security definer set search_path = public, pg_temp as $$
  with u as (
    update plan_steps set status = 'open', holder_token = null, holder_member = null, secret_hash = null, lease_expires_at = null
     where id = p_id and status = 'claimed' and fence = p_fence and secret_hash = h(p_secret)
       and holder_token = nullif(current_setting('app.token', true), '')::uuid
       and holder_member = nullif(current_setting('app.member', true), '')::uuid
       and lease_expires_at > clock_timestamp()
    returning 1)
  select exists (select 1 from u) $$;

-- A check-in restarts the lease but never past max_hold: however often an
-- agent checks in, a claim cannot be held longer than the rule allows.
create function agent_checkin_step(p_id bigint, p_fence bigint, p_secret text)
returns timestamptz language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare v_exp timestamptz; r record; v_vault uuid; v_plan text;
begin
  select s.vault_id, s.plan into v_vault, v_plan from plan_steps s where s.id = p_id;
  select * into r from rule_for(v_vault, v_plan);
  update plan_steps s
     set lease_expires_at = least(clock_timestamp() + r.lease, s.claimed_at + r.max_hold)
   where s.id = p_id and s.status = 'claimed' and s.fence = p_fence and s.secret_hash = h(p_secret)
     and s.holder_token = nullif(current_setting('app.token', true), '')::uuid
     and s.holder_member = nullif(current_setting('app.member', true), '')::uuid
     and s.lease_expires_at > clock_timestamp() and s.claimed_at + r.max_hold > clock_timestamp()
  returning s.lease_expires_at into v_exp;
  return v_exp;
end $$;

create function agent_leave_queue(p_vault uuid, p_plan text)
returns boolean language sql volatile security definer set search_path = public, pg_temp as $$
  with d as (delete from tickets
              where vault_id = p_vault and plan = p_plan
                and member = nullif(current_setting('app.member', true), '')::uuid
              returning 1)
  select exists (select 1 from d) $$;

-- --------------------------------------------------------------- privileges
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'agent_api') then create role agent_api nologin; end if;
end $$;
revoke all on all tables in schema public from public, agent_api;
revoke execute on all functions in schema public from public;
grant usage on schema public to agent_api;
grant execute on function
  agent_request_work(uuid, text, text, interval),
  agent_complete_step(bigint, bigint, text),
  agent_release_step(bigint, bigint, text),
  agent_checkin_step(bigint, bigint, text),
  agent_leave_queue(uuid, text)
  to agent_api;
