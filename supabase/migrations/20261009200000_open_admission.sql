-- Open admission: invite-only off, and a waiting line let in steadily
-- (supabase/tests/admission_test.sql, "open:" and "line:").
--
-- With invite-only off, sign-in makes an account for any address
-- (web/src/signin.ts). An account costs a row; a vault costs storage,
-- members and requests. So an account nobody admitted waits in a line,
-- in the order it confirmed its address (the first sign-in code or link),
-- and private.let_in_from_line() admits ('open') the front of the line,
-- private.settings.open_per_day accounts a UTC day (pg_cron runs it every
-- 10 minutes, so a raised pace shows soon). Only a confirmed address is in
-- line: an address a bot made up never signs in, so never queues. Nobody
-- is ever told to come back tomorrow: they wait, and can see their place
-- (public.my_place_in_line). Null means no line, everyone straight in (the
-- test databases). An admission, once made, stays when invite-only goes
-- back on. The operator sets the pace with private.set_open_per_day
-- (scripts/plan.sh open-per-day <n|none>), and can let anyone in at once
-- (plan.sh admit).

alter table private.admissions drop constraint admissions_via_check;
alter table private.admissions add constraint admissions_via_check
  check (via in ('invite', 'plan', 'operator', 'existing', 'open'));
alter table private.settings add column open_per_day int default 25 check (open_per_day >= 0);

-- Without a line (no pace), invite-only off lets every account in, as
-- before.
create or replace function private.is_admitted(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null
     and (exists (select 1 from private.admissions a where a.user_id = p_user)
          or (not private.invite_only()
              and (select s.open_per_day is null from private.settings s)))
$$;

-- Accounts waiting: confirmed, not admitted, in the order they confirmed.
create function private.line() returns table (user_id uuid, place bigint)
language sql stable security definer set search_path = '' as $$
  select u.id, row_number() over (order by u.email_confirmed_at, u.id)
    from auth.users u
   where u.email_confirmed_at is not null
     and not exists (select 1 from private.admissions a where a.user_id = u.id)
$$;

-- The caller's place in line (1 is next), or null when not waiting:
-- admitted, invite-only, or no line.
create function public.my_place_in_line() returns bigint
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_person();
  if private.invite_only() or private.is_admitted(private.uid()) then
    return null;
  end if;
  return (select l.place from private.line() l where l.user_id = private.uid());
end $$;

-- Lets in the front of the line, up to open_per_day less who it let in
-- since midnight UTC. Returns how many it let in.
create function private.let_in_from_line() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_per_day int;
  v_due int;
  v_n int;
begin
  select s.open_per_day into v_per_day from private.settings s;
  if private.invite_only() or v_per_day is null then
    return 0;
  end if;
  -- One run at a time, so two can't both spend the same places.
  perform pg_advisory_xact_lock(hashtextextended('reliquary.let_in_from_line', 0));
  v_due := v_per_day - (select count(*)::int from private.admissions a
               where a.via = 'open' and a.admitted_at >= date_trunc('day', now(), 'UTC'));
  if v_due <= 0 then
    return 0;
  end if;
  insert into private.admissions (user_id, via)
  select l.user_id, 'open' from private.line() l order by l.place limit v_due
  on conflict (user_id) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- create_vault's gate: admitted, or let in at once when there's no line.
create function private.require_admission() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_place bigint;
begin
  if exists (select 1 from private.admissions a where a.user_id = private.uid()) then
    return;
  end if;
  if private.invite_only() then
    perform private.admission_refusal();
  end if;
  if (select s.open_per_day is null from private.settings s) then
    insert into private.admissions (user_id, via) values (private.uid(), 'open') on conflict (user_id) do nothing;
    return;
  end if;
  select l.place into v_place from private.line() l where l.user_id = private.uid();
  raise exception 'your account can''t create vaults yet: Reliquary is letting people in steadily as usage grows, and you''re %. It may take a while; if it''s taking too long, write to the operator, or open an invite link someone sent you and join their vault (that lets you in now)',
      case when v_place is null then 'in line once your address is confirmed' else 'number ' || v_place || ' in line' end
    using errcode = 'RLP02',
          detail = jsonb_build_object('limit', 'admission', 'invite_only', false, 'place', v_place)::text;
end $$;

-- As in 20260925240000_admission, but gated by private.require_admission.
create or replace function public.create_vault(p_name text, p_default_policy text default 'open')
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v uuid;
  v_name text := trim(coalesce(p_name, ''));
  v_plan private.plans;
  v_owned int;
begin
  perform private.require_person();
  if not coalesce(private.may_create_vault(), false) then
    raise exception 'creating a vault needs a connection that reaches all your vaults with read-write access'
      using errcode = '42501';
  end if;
  perform private.require_admission();
  if length(v_name) not between 1 and 100 then
    raise exception 'a vault name is 1 to 100 characters' using errcode = '22023';
  end if;
  if p_default_policy is null or p_default_policy not in ('canon', 'open') then
    raise exception 'the default policy is canon or open' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('reliquary.vaults_owned:' || private.uid()::text, 0));
  v_plan := private.plan_of(private.uid());
  select count(*) into v_owned from public.vaults where created_by = private.uid();
  if v_owned >= v_plan.max_vaults then
    raise exception 'you''re at your %-vault limit on the % plan (you own %): delete a vault you no longer need, or ask for a bigger plan',
        v_plan.max_vaults, v_plan.name, v_owned
      using errcode = 'RLP01',
            detail = jsonb_build_object('limit', 'vaults', 'used', v_owned, 'max', v_plan.max_vaults,
                       'plan', v_plan.id)::text;
  end if;
  insert into public.vaults (name, default_policy, created_by)
  values (v_name, p_default_policy, private.uid()) returning id into v;
  insert into public.vault_members (vault_id, user_id, role) values (v, private.uid(), 'owner');
  perform private.log_event(v, 'vault.create', null, null, null,
    jsonb_build_object('name', v_name, 'default_policy', p_default_policy));
  return v;
end $$;

create function private.set_open_per_day(p_n int) returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_n < 0 then
    raise exception 'the pace is a whole number of accounts a day from 0, or none' using errcode = '22023';
  end if;
  update private.settings set open_per_day = p_n, set_at = now(), set_by = session_user;
  return case when p_n is null then 'open admission: no line, every account straight in'
              else format('open admission: %s accounts a day from the line (%s waiting)', p_n,
                          (select count(*) from private.line())) end;
end $$;

revoke all on function private.line(), private.let_in_from_line(), private.require_admission(),
  private.set_open_per_day(int)
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
grant execute on function private.set_open_per_day(int) to reliquary_ops;
revoke all on function public.my_place_in_line() from public, anon;
grant execute on function public.my_place_in_line() to authenticated;
-- Sign-in asks whether to make accounts for any address.
grant execute on function private.invite_only() to reliquary_web;

-- pg_cron, where the platform has it (Supabase does; plain Postgres, as in
-- the tests, doesn't): the line moves every 10 minutes.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      perform cron.schedule('reliquary-let-in-from-line', '*/10 * * * *',
        'select private.let_in_from_line()');
    exception when others then
      raise notice 'pg_cron is not usable here (%); the line only moves when the operator runs private.let_in_from_line()', sqlerrm;
    end;
  end if;
end $$;
