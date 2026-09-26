-- A plan for Reliquary's own staff and contributors, and a way for the
-- operator to give one vault extra storage on top of its tier or plan.
--
-- 1. The `staff` plan: no limit on how many vaults an account owns (the web
--    UI shows that as "no limit" once max_vaults reaches
--    NO_LIMIT_COUNT, web/src/plans.ts); each vault it owns still gets the
--    same per-vault numbers as `alpha_tester` (25 people, 1 GB) unless the
--    operator also gives that vault a tier or a grant. Set it with
--    `scripts/plan.sh user <email> staff`, same as any other plan.
-- 2. A storage grant (`private.vault_storage_grants`): the operator adds
--    bytes to one vault's storage limit, on top of whatever its tier or
--    plan already allows, with `scripts/plan.sh grant-storage <vault-id>
--    <amount>` (e.g. `500mb`, `2gb`, or `0` to take it back). This is for
--    a vault that outgrew its plan without needing a whole new tier.
--    `private.vault_limits` folds the grant into `max_bytes`, so every
--    check and every display (Usage, Plan and usage, the storage refusal)
--    already uses it; the label names it when it's more than zero.

insert into private.plans (id, name, max_vaults, max_members, max_storage_bytes) values
  ('staff', 'Reliquary staff', 1000000000, 25, 1000000000);

create table private.vault_storage_grants (
  vault_id   uuid primary key references public.vaults on delete cascade,
  extra_bytes bigint not null check (extra_bytes >= 0),
  set_at     timestamptz not null default now(),
  set_by     text not null default session_user
);

alter table private.vault_storage_grants enable row level security;
revoke all on private.vault_storage_grants from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;

-- A vault's limits, now also folding in any storage grant. Same columns,
-- same callers (private.storage_refusal, private.add_storage,
-- public.vault_usage, create_invite, accept_invite, set_vault_tier,
-- set_account_plan's cousins): only the numbers and, when a grant is
-- active, the label change.
create or replace function private.vault_limits(p_vault uuid,
  out plan_id text, out plan_name text, out tier_id text, out tier_name text,
  out max_members int, out max_bytes bigint, out label text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, t.id, t.name,
         coalesce(t.max_members, p.max_members),
         coalesce(t.max_storage_bytes, p.max_storage_bytes) + coalesce(g.extra_bytes, 0),
         case when t.id = 'standard' then 'the ' || p.name || ' plan' else 'the ' || t.name || ' tier' end
           || case when coalesce(g.extra_bytes, 0) > 0
                then ', plus ' || private.size_text(g.extra_bytes) || ' the operator added'
                else '' end
    from public.vaults v
    cross join lateral private.plan_of(v.created_by) p
    join private.vault_tiers t
      on t.id = coalesce((select o.tier_id from private.vault_tier_overrides o where o.vault_id = v.id), 'standard')
    left join private.vault_storage_grants g on g.vault_id = v.id
   where v.id = p_vault
$$;

-- Gives a vault p_extra_bytes on top of its tier or plan; 0 takes a grant
-- back. Operator only, like set_vault_tier.
create function private.grant_vault_storage(p_vault uuid, p_extra_bytes bigint) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text;
  v_before bigint;
  v_after bigint;
begin
  select name into v_name from public.vaults where id = p_vault;
  if v_name is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if p_extra_bytes is null or p_extra_bytes < 0 then
    raise exception 'the extra amount must be zero or more' using errcode = '22023';
  end if;
  -- Read the total before and after, rather than restating the tier's own
  -- label plus the new amount: correct whether this sets a first grant,
  -- replaces one, or takes it back, with nothing counted twice.
  v_before := (private.vault_limits(p_vault)).max_bytes;
  if p_extra_bytes = 0 then
    delete from private.vault_storage_grants where vault_id = p_vault;
  else
    insert into private.vault_storage_grants (vault_id, extra_bytes) values (p_vault, p_extra_bytes)
    on conflict (vault_id) do update set extra_bytes = excluded.extra_bytes, set_at = now(), set_by = session_user;
  end if;
  v_after := (private.vault_limits(p_vault)).max_bytes;
  return format('%s: %s storage limit now (was %s)%s', v_name, private.size_text(v_after), private.size_text(v_before),
    case when p_extra_bytes = 0 then ', the grant is gone' else '' end);
end $$;

revoke all on function private.grant_vault_storage(uuid, bigint) from public, anon, authenticated, reliquary_web, reliquary_mcp;
grant execute on function private.grant_vault_storage(uuid, bigint) to reliquary_ops;
