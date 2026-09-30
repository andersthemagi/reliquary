-- Dependency-gated claims (second spike). Loaded after schema.sql, which
-- provides h(), the log table and the conventions.

drop table if exists plan_step_deps, plan_steps cascade;

create table plan_steps (
  id bigint generated always as identity primary key,
  vault_id uuid not null,
  plan text not null,
  key text not null,
  status text not null default 'open' check (status in ('open','claimed','done','cancelled')),
  fence bigint not null default 0,
  holder_token uuid,
  holder_label text,
  secret_hash bytea,
  lease_expires_at timestamptz,
  done_at timestamptz,
  done_fence bigint,
  unique (vault_id, plan, key)
);
create table plan_step_deps (
  step_id bigint not null references plan_steps (id) on delete cascade,
  blocker_id bigint not null references plan_steps (id) on delete cascade,
  primary key (step_id, blocker_id),
  check (step_id <> blocker_id)
);
create index on plan_step_deps (blocker_id);

-- ------------------------------------------------------------ register
-- p_steps: [{"key":"a","blocked_by":["b","c"]}, ...]. Refuses duplicate keys,
-- unknown blockers, self-dependencies and cycles (Kahn's algorithm: keep
-- removing steps that have no blocker left; anything remaining is a cycle).
create function register_plan(p_vault uuid, p_plan text, p_steps jsonb)
returns int language plpgsql volatile as $$
declare ready text[]; n int;
begin
  drop table if exists s; drop table if exists e;
  create temp table s (k text primary key) on commit drop;
  create temp table e (step text, blocker text) on commit drop;
  begin
    insert into s select x.key from jsonb_to_recordset(p_steps) as x(key text);
  exception when unique_violation then
    raise exception 'duplicate step key' using errcode = '22023';
  end;
  insert into e select x.key, b.k
    from jsonb_to_recordset(p_steps) as x(key text, blocked_by jsonb),
         jsonb_array_elements_text(coalesce(x.blocked_by, '[]'::jsonb)) as b(k);
  if exists (select 1 from e where blocker not in (select k from s)) then
    raise exception 'unknown blocker' using errcode = '22023';
  end if;
  loop
    select array_agg(k) into ready from s
     where not exists (select 1 from e where e.step = s.k and e.blocker in (select k from s));
    exit when ready is null;
    delete from s where k = any (ready);
  end loop;
  if exists (select 1 from s) then
    raise exception 'the plan has a cycle' using errcode = '22023';
  end if;
  insert into plan_steps (vault_id, plan, key)
    select p_vault, p_plan, x.key from jsonb_to_recordset(p_steps) as x(key text);
  insert into plan_step_deps (step_id, blocker_id)
    select st.id, bl.id from e
      join plan_steps st on st.vault_id = p_vault and st.plan = p_plan and st.key = e.step
      join plan_steps bl on bl.vault_id = p_vault and bl.plan = p_plan and bl.key = e.blocker;
  get diagnostics n = row_count;
  drop table s; drop table e;
  insert into log (vault_id, event, path, detail)
    values (p_vault, 'plan.register', p_plan, jsonb_build_object('steps', jsonb_array_length(p_steps), 'edges', n));
  return jsonb_array_length(p_steps);
end $$;

-- --------------------------------------------------------------- claim
-- Same shape as claim_next, plus one predicate: every blocker is done. The
-- check and the claim are one statement, so a step is never handed out on a
-- stale view of "ready". An expired claim on a blocker does not count as done.
create function claim_ready_step(p_vault uuid, p_plan text, p_token uuid, p_label text, p_ttl interval)
returns table (o_id bigint, o_key text, o_fence bigint, o_secret text, o_expires timestamptz)
language plpgsql volatile as $$
declare v_secret text := gen_random_uuid()::text || gen_random_uuid()::text;
begin
  return query
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
       set status = 'claimed', fence = s.fence + 1, holder_token = p_token,
           holder_label = p_label, secret_hash = h(v_secret),
           lease_expires_at = clock_timestamp() + p_ttl
      from pick where s.id = pick.id
    returning s.id, s.key, s.fence, s.lease_expires_at),
  lg as (
    insert into log (vault_id, event, path, actor, detail)
    select p_vault, 'step.claimed', p_plan, p_token, jsonb_build_object('step', upd.id, 'fence', upd.fence)
      from upd)
  select upd.id, upd.key, upd.fence, v_secret, upd.lease_expires_at from upd;
end $$;

create function complete_step(p_id bigint, p_fence bigint, p_secret text)
returns boolean language sql volatile as $$
  with u as (
    update plan_steps set status = 'done', done_at = clock_timestamp(), done_fence = p_fence
     where id = p_id and status = 'claimed' and fence = p_fence
       and secret_hash = h(p_secret) and lease_expires_at > clock_timestamp()
    returning 1)
  select exists (select 1 from u) $$;

-- A person's action. A cancelled blocker never counts as done, so its
-- dependents stay blocked until a person rewires or skips them.
create function cancel_step(p_id bigint) returns boolean language sql volatile as $$
  with u as (update plan_steps set status = 'cancelled', secret_hash = null, lease_expires_at = null
              where id = p_id and status <> 'done' returning 1)
  select exists (select 1 from u) $$;

-- Computed state, so nothing has to be kept in step with the graph.
create function plan_status(p_vault uuid, p_plan text)
returns table (o_key text, o_state text) language sql stable as $$
  select s.key,
    case
      when s.status = 'done' then 'done'
      when s.status = 'cancelled' then 'cancelled'
      when s.status = 'claimed' and s.lease_expires_at > clock_timestamp() then 'claimed'
      when exists (select 1 from plan_step_deps d join plan_steps b on b.id = d.blocker_id
                    where d.step_id = s.id and b.status = 'cancelled') then 'blocked_by_cancelled'
      when exists (select 1 from plan_step_deps d join plan_steps b on b.id = d.blocker_id
                    where d.step_id = s.id and b.status <> 'done') then 'blocked'
      else 'ready'
    end
  from plan_steps s where s.vault_id = p_vault and s.plan = p_plan order by s.id $$;
