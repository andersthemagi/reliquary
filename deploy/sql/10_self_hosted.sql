-- Self-hosted instances: no plan limits. Applied by deploy/bin/migrate.sh
-- after every migration, on every run (idempotent). Not a migration: the
-- hosted service never runs it.
--
-- Plans and limits (supabase/migrations/20260925230000_plans.sql) are for
-- the hosted service. Here everyone is on `self_hosted`, whose limits are
-- the largest the columns hold, which the web UI shows as "no limit"
-- (web/src/plans.ts). Vault tiers stay `standard`, so they take these.
--
-- How: private.plan_of() defaults to `free` for anyone without a row in
-- private.account_plans, so each account gets a row. Existing accounts are
-- backfilled below; new ones get theirs from a trigger on auth.users, the
-- moment Supabase Auth creates them. An operator can still move someone to
-- another plan (scripts/plan.sh with PLAN_DB_CONTAINER); this file never
-- changes a row that is already there.

set client_min_messages = warning;

insert into private.plans (id, name, max_vaults, max_members, max_storage_bytes)
values ('self_hosted', 'Self-hosted', 2147483647, 2147483647, 9223372036854775807)
on conflict (id) do update
  set name = excluded.name, max_vaults = excluded.max_vaults,
      max_members = excluded.max_members, max_storage_bytes = excluded.max_storage_bytes;

create or replace function private.self_hosted_plan() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.account_plans (user_id, plan_id, set_by)
  values (new.id, 'self_hosted', 'self-hosted default')
  on conflict (user_id) do nothing;
  -- Invite-only (20260925240000_admission.sql) holds here too, since Auth's
  -- sign-up is open so invitees can make accounts. The instance's first
  -- account (deploy/bin/owner.mjs) is admitted, so its owner can create
  -- vaults; everyone after gets in by an invite or `plan.sh admit`.
  if not exists (select 1 from private.admissions) then
    insert into private.admissions (user_id, via, admitted_by)
    values (new.id, 'operator', 'self-hosted first account')
    on conflict (user_id) do nothing;
  end if;
  return new;
end $$;
revoke all on function private.self_hosted_plan() from public;

drop trigger if exists reliquary_self_hosted_plan on auth.users;
create trigger reliquary_self_hosted_plan after insert on auth.users
  for each row execute function private.self_hosted_plan();

insert into private.account_plans (user_id, plan_id, set_by)
select u.id, 'self_hosted', 'self-hosted default' from auth.users u
on conflict (user_id) do nothing;
