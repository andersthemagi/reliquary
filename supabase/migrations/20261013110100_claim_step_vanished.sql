-- claim_step refuses a step that went away while it waited (CL-3.3, issue
-- #72) the way it refuses one that never existed: 'no such step', P0002.
-- A claim that queues on a step's row while delete_vault holds it (see
-- 20261013110000_work_plans_lock_order.sql) finds the row gone once the
-- deletion commits; its update then matches nothing, and the re-read
-- found nothing either, so it fell through to "blocked: <NULL>
-- blocker(s) not finished". Only that branch is new.
create or replace function public.claim_step(p_vault uuid, p_path text, p_key text, p_label text default null, p_ttl_minutes int default null)
returns table (o_secret text, o_fence int, o_expires timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_label text := nullif(trim(coalesce(p_label, '')), '');
  v_rule record;
  v_ttl interval;
  v_plan_id uuid;
  v_fence int;
  v_expires timestamptz;
  v_cur public.work_plan_steps;
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

  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.work_plan_steps where plan_id = v_plan_id and key = p_key) then
    raise exception 'no such step' using errcode = 'P0002';
  end if;

  select * into v_rule from private.claim_rule_for(p_vault, p_path);
  v_ttl := least(coalesce(p_ttl_minutes, v_rule.lease_minutes), v_rule.max_lease_minutes) * interval '1 minute';

  update public.work_plan_steps st
     set status = 'claimed', fence = st.fence + 1, holder = private.uid(), holder_token = private.token_id(),
         holder_label = v_label, secret_hash = private.token_hash(v_secret),
         claimed_at = clock_timestamp(), expires_at = clock_timestamp() + v_ttl
   where st.plan_id = v_plan_id and st.key = p_key and st.open_blockers = 0
     and (st.status = 'open' or (st.status = 'claimed' and st.expires_at <= clock_timestamp()))
  returning st.fence, st.expires_at into v_fence, v_expires;

  if v_fence is null then
    select * into v_cur from public.work_plan_steps where plan_id = v_plan_id and key = p_key;
    if v_cur.id is null then
      raise exception 'no such step' using errcode = 'P0002';
    elsif v_cur.status in ('done', 'cancelled') then
      raise exception 'step "%" is already %', p_key, v_cur.status using errcode = 'RLW02';
    elsif v_cur.status = 'claimed' then
      raise exception 'step "%" is already claimed by % until %', p_key, coalesce(v_cur.holder_label, 'someone'), v_cur.expires_at
        using errcode = 'RLW01';
    else
      raise exception 'step "%" is blocked: % blocker(s) not finished', p_key, v_cur.open_blockers using errcode = 'RLW02';
    end if;
  end if;

  perform private.log_event(p_vault, 'step.claim', p_path, null, null,
    jsonb_build_object('plan', v_plan_id, 'step', p_key, 'fence', v_fence));
  return query select v_secret, v_fence, v_expires;
end $$;
