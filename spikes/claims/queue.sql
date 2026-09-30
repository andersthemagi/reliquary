-- Third spike: claim rules, waiting tickets and check-again hints. Loaded
-- after schema.sql and plan.sql.
--
-- An agent that finds nothing to do takes a ticket (its place in line), is told
-- when to check again, and stops until then. Ticket rule, in one line: the k-th
-- oldest live ticket may claim only if at least k steps are ready. It is
-- first-come first-served, and it never leaves a step idle while fewer agents
-- are waiting than steps are ready. A ticket stays live only while its holder
-- keeps checking in, so an agent that disappears drops out of line by itself.

drop table if exists claim_rules, tickets, calls cascade;

create table claim_rules (
  vault_id uuid not null,
  prefix text not null,
  lease interval not null,       -- how long a claim is exclusive after each check-in
  max_lease interval not null,   -- the most a caller may ask for
  ticket_ttl interval not null,  -- how long a place in line survives without a check
  poll_cap interval not null,    -- the longest "check again in" hint
  primary key (vault_id, prefix)
);
create table tickets (
  id bigint generated always as identity primary key,
  vault_id uuid not null,
  plan text not null,
  holder_token uuid not null,
  label text,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  member uuid   -- null in the third spike's design, where the connection is the unit
);
-- The third spike keys a place in line by connection. The fourth keys it by person
-- (guard.sql adds its own unique index), so this one covers only rows without a person.
create unique index tickets_legacy on tickets (vault_id, plan, holder_token) where member is null;
create index on tickets (vault_id, plan, created_at, id);
create table calls (at timestamptz not null default clock_timestamp(), state text not null);

-- Longest matching prefix wins, like a folder rule. Defaults are the org preset.
create function rule_for(p_vault uuid, p_plan text,
  out lease interval, out max_lease interval, out ticket_ttl interval, out poll_cap interval)
language plpgsql stable as $$
begin
  select r.lease, r.max_lease, r.ticket_ttl, r.poll_cap
    into lease, max_lease, ticket_ttl, poll_cap
    from claim_rules r
   where r.vault_id = p_vault and p_plan like r.prefix || '%'
   order by length(r.prefix) desc limit 1;
  if not found then
    lease := interval '48 hours'; max_lease := interval '30 days';
    ticket_ttl := interval '6 hours'; poll_cap := interval '1 hour';
  end if;
end $$;

create function request_work_core(p_vault uuid, p_plan text, p_token uuid, p_label text, p_lease interval default null)
returns table (o_state text, o_id bigint, o_key text, o_fence bigint, o_secret text,
               o_expires timestamptz, o_rank int, o_ready int, o_check_ms bigint)
language plpgsql volatile as $$
declare
  r record; g record;
  v_lease interval;
  v_secret text := gen_random_uuid()::text || gen_random_uuid()::text;
  v_total int; v_done int; v_rank int; v_ready int; v_claimed int; v_cancelled int;
  v_next timestamptz; v_ms bigint;
begin
  select * into r from rule_for(p_vault, p_plan);
  v_lease := least(coalesce(p_lease, r.lease), r.max_lease);

  select count(*), count(*) filter (where status = 'done') into v_total, v_done
    from plan_steps where vault_id = p_vault and plan = p_plan;
  if v_total = 0 then
    return query select 'no_such_plan', null::bigint, null::text, null::bigint, null::text, null::timestamptz, null::int, null::int, null::bigint;
    return;
  end if;
  if v_done = v_total then   -- nothing left to wait for: tell the agent to stop
    delete from tickets where vault_id = p_vault and plan = p_plan and holder_token = p_token;
    return query select 'plan_complete', null::bigint, null::text, null::bigint, null::text, null::timestamptz, null::int, null::int, null::bigint;
    return;
  end if;

  -- Take or refresh a ticket. A ticket that lapsed loses its place.
  delete from tickets where vault_id = p_vault and plan = p_plan and expires_at <= clock_timestamp();
  insert into tickets (vault_id, plan, holder_token, label, expires_at)
  values (p_vault, p_plan, p_token, p_label, clock_timestamp() + r.ticket_ttl)
  on conflict (vault_id, plan, holder_token) where member is null do update
     set expires_at = excluded.expires_at, label = excluded.label;

  select count(*) + 1 into v_rank from tickets t
   where t.vault_id = p_vault and t.plan = p_plan
     and (t.created_at, t.id) < (select m.created_at, m.id from tickets m
                                  where m.vault_id = p_vault and m.plan = p_plan and m.holder_token = p_token);

  select count(*) into v_ready from plan_steps s
   where s.vault_id = p_vault and s.plan = p_plan
     and (s.status = 'open' or (s.status = 'claimed' and s.lease_expires_at <= clock_timestamp()))
     and not exists (select 1 from plan_step_deps d join plan_steps b on b.id = d.blocker_id
                      where d.step_id = s.id and b.status <> 'done');

  if v_rank <= v_ready then
    for g in
      with pick as (
        select s.id from plan_steps s
         where s.vault_id = p_vault and s.plan = p_plan
           and (s.status = 'open' or (s.status = 'claimed' and s.lease_expires_at <= clock_timestamp()))
           and not exists (select 1 from plan_step_deps d join plan_steps b on b.id = d.blocker_id
                            where d.step_id = s.id and b.status <> 'done')
         order by s.id
         for update of s skip locked
         limit 1),
      upd as (
        update plan_steps s
           set status = 'claimed', fence = s.fence + 1, holder_token = p_token, holder_label = p_label,
               secret_hash = h(v_secret), lease_expires_at = clock_timestamp() + v_lease
          from pick where s.id = pick.id
        returning s.id, s.key, s.fence, s.lease_expires_at),
      lg as (
        insert into log (vault_id, event, path, actor, detail)
        select p_vault, 'step.claimed', p_plan, p_token,
               jsonb_build_object('step', upd.id, 'fence', upd.fence, 'rank', v_rank, 'ready', v_ready)
          from upd)
      select upd.id, upd.key, upd.fence, upd.lease_expires_at from upd
    loop
      delete from tickets where vault_id = p_vault and plan = p_plan and holder_token = p_token;
      return query select 'granted', g.id, g.key, g.fence, v_secret, g.lease_expires_at, v_rank, v_ready, null::bigint;
      return;
    end loop;
  end if;

  -- Nothing for this agent yet.
  select count(*) filter (where status = 'claimed' and lease_expires_at > clock_timestamp()),
         count(*) filter (where status = 'cancelled')
    into v_claimed, v_cancelled from plan_steps where vault_id = p_vault and plan = p_plan;
  if v_ready = 0 and v_claimed = 0 and v_cancelled > 0 then   -- only a person can move this
    return query select 'blocked_by_cancelled', null::bigint, null::text, null::bigint, null::text, null::timestamptz, v_rank, v_ready, null::bigint;
    return;
  end if;
  select min(lease_expires_at) into v_next from plan_steps
   where vault_id = p_vault and plan = p_plan and status = 'claimed' and lease_expires_at > clock_timestamp();
  v_ms := greatest(50, floor(1000 * extract(epoch from
            least(coalesce(v_next - clock_timestamp(), r.poll_cap), r.poll_cap)))::bigint);
  return query select 'wait', null::bigint, null::text, null::bigint, null::text, null::timestamptz, v_rank, v_ready, v_ms;
end $$;

-- The public face: same answer, and the spike records every call so the
-- comparison can count them.
create function request_work(p_vault uuid, p_plan text, p_token uuid, p_label text, p_lease interval default null)
returns table (o_state text, o_id bigint, o_key text, o_fence bigint, o_secret text,
               o_expires timestamptz, o_rank int, o_ready int, o_check_ms bigint)
language plpgsql volatile as $$
declare x record;
begin
  select * into x from request_work_core(p_vault, p_plan, p_token, p_label, p_lease);
  insert into calls (state) values (x.o_state);
  return query select x.o_state, x.o_id, x.o_key, x.o_fence, x.o_secret, x.o_expires, x.o_rank, x.o_ready, x.o_check_ms;
end $$;

create function leave_queue(p_vault uuid, p_plan text, p_token uuid) returns boolean language sql volatile as $$
  with d as (delete from tickets where vault_id = p_vault and plan = p_plan and holder_token = p_token returning 1)
  select exists (select 1 from d) $$;

-- Give a step back without finishing it. The next ticket in line can have it.
create function release_step(p_id bigint, p_fence bigint, p_secret text) returns boolean language sql volatile as $$
  with u as (
    update plan_steps set status = 'open', holder_token = null, secret_hash = null, lease_expires_at = null
     where id = p_id and status = 'claimed' and fence = p_fence
       and secret_hash = h(p_secret) and lease_expires_at > clock_timestamp()
    returning 1)
  select exists (select 1 from u) $$;

-- "Checked in and updated often": each check-in restarts the lease, so a working
-- agent keeps its claim and a silent one loses it after one lease.
create function checkin_step(p_id bigint, p_fence bigint, p_secret text) returns timestamptz language plpgsql volatile as $$
declare v_exp timestamptz;
begin
  update plan_steps s
     set lease_expires_at = clock_timestamp() + (select rf.lease from rule_for(s.vault_id, s.plan) rf)
   where s.id = p_id and s.status = 'claimed' and s.fence = p_fence
     and s.secret_hash = h(p_secret) and s.lease_expires_at > clock_timestamp()
  returning s.lease_expires_at into v_exp;
  return v_exp;
end $$;
