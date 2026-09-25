-- The operator's changes serialise with what they limit
-- (web/test/races.test.mjs, "races, the operator waits").
-- set_vault_tier locks the vault's row and its counter, and
-- set_account_plan takes the account's vault-creation lock and locks the
-- counters of the vaults it created, before changing anything. So a
-- write or an acceptance in flight finishes first and is counted in the
-- summary the operator reads, and anything after is checked against the
-- new limits: nothing checked against the old plan commits after the new
-- one.

-- As in 20260925240000_admission, plus: the account's vault creations and its
-- vaults' counters are locked first.
create or replace function private.set_account_plan(p_user uuid, p_plan text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_plan private.plans;
  v_owned int;
begin
  select * into v_plan from private.plans where id = p_plan;
  if v_plan.id is null then
    raise exception 'no plan named %; see private.plans', coalesce(p_plan, 'null') using errcode = 'P0002';
  end if;
  if p_user is null or not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'no such account' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('reliquary.vaults_owned:' || p_user::text, 0));
  perform 1 from private.vault_storage s
   where s.vault_id in (select v.id from public.vaults v where v.created_by = p_user)
   order by s.vault_id for update;
  insert into private.account_plans (user_id, plan_id) values (p_user, v_plan.id)
  on conflict (user_id) do update set plan_id = excluded.plan_id, set_at = now(), set_by = session_user;
  perform private.admit(p_user, 'plan');
  select count(*) into v_owned from public.vaults where created_by = p_user;
  return format('%s plan: %s of %s vaults%s', v_plan.name, v_owned, v_plan.max_vaults,
    case when v_owned > v_plan.max_vaults then ' (over: they can''t create more until under)' else '' end);
end $$;

-- As in 20260925230000_plans, plus: the vault's row (invites, acceptances)
-- and its counter (writes) are locked first, so the summary counts what
-- was in flight.
create or replace function private.set_vault_tier(p_vault uuid, p_tier text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  l record;
  v_members int;
  v_bytes bigint;
begin
  if p_vault is null or not exists (select 1 from public.vaults where id = p_vault) then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if p_tier is null or not exists (select 1 from private.vault_tiers where id = p_tier) then
    raise exception 'no tier named %; see private.vault_tiers', coalesce(p_tier, 'null') using errcode = 'P0002';
  end if;
  perform 1 from public.vaults where id = p_vault for update;
  perform 1 from private.vault_storage where vault_id = p_vault for update;
  if p_tier = 'standard' then
    delete from private.vault_tier_overrides where vault_id = p_vault;
  else
    insert into private.vault_tier_overrides (vault_id, tier_id) values (p_vault, p_tier)
    on conflict (vault_id) do update set tier_id = excluded.tier_id, set_at = now(), set_by = session_user;
  end if;
  select * into l from private.vault_limits(p_vault);
  select count(*) into v_members from public.vault_members where vault_id = p_vault;
  select s.bytes into v_bytes from private.vault_storage s where s.vault_id = p_vault;
  return format('%s: %s of %s people, %s of %s%s',
    case when l.tier_id = 'standard' then 'Standard (' || l.plan_name || ')' else l.tier_name end,
    v_members, l.max_members, private.size_text(v_bytes), private.size_text(l.max_bytes),
    case when v_members > l.max_members or v_bytes > l.max_bytes then ' (over: read-mostly until under)' else '' end);
end $$;
