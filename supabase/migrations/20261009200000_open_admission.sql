-- Open admission: invite-only off, with a daily quota
-- (supabase/tests/admission_test.sql, "open:").
--
-- With invite-only off, sign-in makes an account for any address
-- (web/src/signin.ts). An account costs a row; a vault costs storage,
-- members and requests, so the quota sits on the first vault: an account
-- nobody admitted is admitted ('open') by its first create_vault, while
-- fewer than private.settings.open_per_day accounts were let in that way
-- since midnight UTC. Past that, create_vault refuses with RLP02 until the
-- next day. That bounds what a surge of people, or a botnet making
-- accounts, can add in a day, without the operator awake. Null is no quota
-- (the test databases). An admission, once made, stays when invite-only
-- goes back on: closing the door doesn't lock out who came in. The
-- operator sets the quota with private.set_open_per_day (scripts/plan.sh
-- open-per-day <n|none>).

alter table private.admissions drop constraint admissions_via_check;
alter table private.admissions add constraint admissions_via_check
  check (via in ('invite', 'plan', 'operator', 'existing', 'open'));
alter table private.settings add column open_per_day int default 25 check (open_per_day >= 0);

-- Places left today; null when there's no quota.
create function private.open_places_left() returns int
language sql stable security definer set search_path = '' as $$
  -- Not greatest() alone: it skips a null, and would read no quota as full.
  select case when s.open_per_day is not null then
           greatest(s.open_per_day - (select count(*)::int from private.admissions a
                                       where a.via = 'open' and a.admitted_at >= date_trunc('day', now(), 'UTC')), 0) end
    from private.settings s
$$;

-- Whether the account may create a vault now: admitted, or open with a
-- place left today.
create or replace function private.is_admitted(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null
     and (exists (select 1 from private.admissions a where a.user_id = p_user)
          or (not private.invite_only() and coalesce(private.open_places_left() > 0, true)))
$$;

-- create_vault's gate: the caller admitted, or admitted now ('open') if
-- invite-only is off and today has a place.
create function private.require_admission() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_per_day int;
begin
  if exists (select 1 from private.admissions a where a.user_id = private.uid()) then
    return;
  end if;
  if private.invite_only() then
    perform private.admission_refusal();
  end if;
  select s.open_per_day into v_per_day from private.settings s;
  if v_per_day is not null then
    -- One open admission at a time, so two first vaults can't both take
    -- the last place.
    perform pg_advisory_xact_lock(hashtextextended('reliquary.open_admission', 0));
    if private.open_places_left() <= 0 then
      raise exception 'your account can''t create vaults yet: during the pre-alpha Reliquary lets in % new accounts a day, and today''s are taken. Try again after midnight UTC, or open an invite link someone sent you and join their vault (that lets you in now)', v_per_day
        using errcode = 'RLP02',
              detail = jsonb_build_object('limit', 'admission', 'invite_only', false, 'per_day', v_per_day)::text;
    end if;
  end if;
  insert into private.admissions (user_id, via) values (private.uid(), 'open') on conflict (user_id) do nothing;
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
    raise exception 'the daily quota is a whole number from 0, or none' using errcode = '22023';
  end if;
  update private.settings set open_per_day = p_n, set_at = now(), set_by = session_user;
  return case when p_n is null then 'open admission: no daily quota'
              else format('open admission: %s new accounts a day (%s left today)', p_n, private.open_places_left()) end;
end $$;

revoke all on function private.open_places_left(), private.require_admission(), private.set_open_per_day(int)
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
grant execute on function private.set_open_per_day(int) to reliquary_ops;
-- Sign-in asks whether to make accounts for any address.
grant execute on function private.invite_only() to reliquary_web;
