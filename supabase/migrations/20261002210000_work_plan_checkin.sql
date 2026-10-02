-- checkin_step (CL-3.2, tracking issue #52): restarts a claimed work plan
-- step's lease without finishing it, the same check-in-restarts-the-lease
-- shape renew_claim already gives path claims (design item 3: "every
-- check-in restarts the lease").
--
-- 20261002200000_work_plans.sql shipped without this on purpose, its own
-- header explaining why: CL-3.2's issue text doesn't name it, and the
-- lease/fairness machinery it would matter most to is CL-3.9's, not
-- CL-3.2's. Revisited since: design item 12(a) lists agent_checkin_step
-- as its own agent-facing primitive, a peer of agent_complete_step and
-- agent_release_step, and #74 (the candidate "it belongs there instead"
-- issue) turns out to be scoped to the waiting queue's own ticket
-- (refreshed by calling request_work again), never a claimed step's
-- lease. Flagged as a gap on #70 rather than silently decided either way;
-- the maintainer's call to add it, on that basis
-- (https://github.com/andersthemagi/reliquary/issues/70#issuecomment-5948900892).
--
-- Needs the secret, the fence, and the same connection and person as
-- claim_step, plus an unlapsed lease -- the same reasoning complete_step
-- uses, since checking in on a step nobody still credits you for would be
-- worse than the refusal. No amount of checking in holds a step past the
-- claim rule's hold limit, counted from the original claim_step grant
-- (claimed_at), not the last check-in, the same shape renew_claim already
-- uses for path claims.
create function public.checkin_step(p_vault uuid, p_path text, p_key text, p_fence int, p_secret text, p_ttl_minutes int default null)
returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_plan_id uuid;
  v_rule record;
  v_ttl interval;
  v_expires timestamptz;
  v_row public.work_plan_steps;
begin
  perform private.require_person();
  if p_ttl_minutes is not null and p_ttl_minutes < 1 then
    raise exception 'a claim lasts at least one minute' using errcode = '22023';
  end if;

  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  end if;
  select * into v_row from public.work_plan_steps where plan_id = v_plan_id and key = p_key for update;
  if v_row.id is null then
    raise exception 'no such step' using errcode = 'P0002';
  end if;
  if v_row.status <> 'claimed' or v_row.fence <> p_fence or v_row.secret_hash is distinct from private.token_hash(p_secret)
     or v_row.holder is distinct from private.uid() or v_row.holder_token is distinct from private.token_id()
     or v_row.expires_at <= clock_timestamp()
  then
    raise exception 'this step is no longer yours to check in on (wrong secret or fence, a different connection, or the lease lapsed)'
      using errcode = 'RLW03';
  end if;

  select * into v_rule from private.claim_rule_for(p_vault, p_path);
  v_ttl := least(coalesce(p_ttl_minutes, v_rule.lease_minutes), v_rule.max_lease_minutes) * interval '1 minute';
  v_expires := least(clock_timestamp() + v_ttl, v_row.claimed_at + v_rule.hold_limit_minutes * interval '1 minute');
  if v_expires <= clock_timestamp() then
    raise exception 'this step is past its hold limit; release it and claim again' using errcode = 'RLW04';
  end if;

  update public.work_plan_steps set expires_at = v_expires where id = v_row.id;
  perform private.log_event(p_vault, 'step.checkin', p_path, null, null,
    jsonb_build_object('plan', v_plan_id, 'step', p_key, 'fence', p_fence));
  return v_expires;
end $$;

revoke all on function public.checkin_step(uuid, text, text, int, text, int) from public, anon;
grant execute on function public.checkin_step(uuid, text, text, int, text, int) to authenticated;
