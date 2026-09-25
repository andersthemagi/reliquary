-- Admission: invite-only accounts (supabase/tests/admission_test.sql).
--
-- With Supabase sign-ups on (so invitees can make their
-- accounts), anyone can call Auth's /signup directly and get an account.
-- Such an account signs in, but while Reliquary is invite-only it can't
-- create a vault: create_vault needs an admitted account, and refuses
-- with SQLSTATE RLP02 otherwise. An account is admitted when
-- - it accepted any invite (accept_invite admits it), or
-- - the operator put it on a plan (set_account_plan admits it), or
-- - the operator admitted it (private.admit_account; scripts/plan.sh
--   admit <email>), or
-- - it had a vault, or had accepted an invite or been given a plan,
--   when this migration ran.
-- Admission is kept per account id in private.admissions, so an account
-- deleted in Supabase and made again with the same email starts
-- un-admitted. The operator can take it back
-- (private.revoke_admission; plan.sh revoke-admission): the account keeps
-- its vaults and memberships and can't create another until admitted
-- again. private.settings.invite_only (on) is the switch for after the
-- alpha (private.set_invite_only; plan.sh invite-only on|off): off,
-- every account may create vaults, within its plan. An un-admitted
-- account sees nothing: it belongs to no vault, and every table's policy
-- is membership. People and their agents read their own admission with
-- public.my_admission().

create table private.settings (
  id          boolean primary key default true check (id),
  invite_only boolean not null default true,
  set_at      timestamptz not null default now(),
  set_by      text not null default session_user
);
insert into private.settings default values;

create table private.admissions (
  user_id     uuid primary key,
  via         text not null check (via in ('invite', 'plan', 'operator', 'existing')),
  admitted_at timestamptz not null default now(),
  admitted_by text not null default session_user
);

alter table private.settings enable row level security;
alter table private.admissions enable row level security;
revoke all on private.settings, private.admissions
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;

-- Everyone who had something when invites became the only way in.
insert into private.admissions (user_id, via)
select user_id, 'plan' from private.account_plans
on conflict do nothing;
insert into private.admissions (user_id, via)
select accepted_by, 'invite' from private.vault_invites where accepted_by is not null
on conflict do nothing;
insert into private.admissions (user_id, via)
select u, 'existing' from (select user_id as u from public.vault_members
                             union select created_by from public.vaults) x
on conflict do nothing;

create function private.invite_only() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.invite_only from private.settings s), true)
$$;

create function private.is_admitted(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null
     and (not private.invite_only()
          or exists (select 1 from private.admissions a where a.user_id = p_user))
$$;

-- Records an admission; an account already admitted keeps its first.
create function private.admit(p_user uuid, p_via text) returns void
language sql volatile security definer set search_path = '' as $$
  insert into private.admissions (user_id, via) values (p_user, p_via) on conflict (user_id) do nothing
$$;

create function private.admission_refusal() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  raise exception 'your account can''t create vaults yet: Reliquary is invite-only during alpha. Open an invite link someone sent you and join their vault (that admits your account), or ask the operator to admit you'
    using errcode = 'RLP02',
          detail = jsonb_build_object('limit', 'admission', 'invite_only', true)::text;
end $$;

-- The caller's admission: whether they may create vaults (within their
-- plan), and whether Reliquary is invite-only. People and their agents.
create function public.my_admission()
returns table (admitted boolean, invite_only boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_person();
  return query select private.is_admitted(private.uid()), private.invite_only();
end $$;

-- As in 20260925230000_plans, plus: an admitted account only.
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
  if not private.is_admitted(private.uid()) then
    perform private.admission_refusal();
  end if;
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

-- As in 20260925230000_plans, plus: accepting admits the account.
create or replace function public.accept_invite(p_token text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  i private.vault_invites;
  v_state text;
begin
  perform private.require_human();
  select * into i from private.vault_invites where token_hash = private.token_hash(p_token) for update;
  if i.id is null or coalesce(p_token, '') !~ '^rli_[0-9a-f]{64}$' then
    raise exception 'this invite link is not valid: check you copied all of it' using errcode = 'P0002';
  end if;
  v_state := private.invite_state(i.accepted_at, i.revoked_at, i.expires_at);
  if v_state = 'accepted' then
    raise exception 'this invite has already been used' using errcode = '55000';
  elsif v_state = 'revoked' then
    raise exception 'this invite was withdrawn' using errcode = '55000';
  elsif v_state = 'expired' then
    raise exception 'this invite has expired' using errcode = '55000';
  end if;
  if private.email_of(private.uid()) is distinct from i.email then
    raise exception 'this invite is for a different email address' using errcode = '42501';
  end if;
  perform 1 from public.vaults where id = i.vault_id for update;
  if not exists (select 1 from public.vault_members where vault_id = i.vault_id and user_id = private.uid()) then
    perform private.require_people_room(i.vault_id, false);
  end if;
  insert into public.vault_members (vault_id, user_id, role)
  values (i.vault_id, private.uid(), i.role)
  on conflict (vault_id, user_id) do nothing;
  update private.vault_invites set accepted_at = now(), accepted_by = private.uid() where id = i.id;
  perform private.admit(private.uid(), 'invite');
  perform private.log_event(i.vault_id, 'invite.accept', null, null, null,
    jsonb_build_object('invite', i.id, 'role', i.role));
  return i.vault_id;
end $$;

-- As in 20260925230000_plans, plus: a plan admits the account.
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
  insert into private.account_plans (user_id, plan_id) values (p_user, v_plan.id)
  on conflict (user_id) do update set plan_id = excluded.plan_id, set_at = now(), set_by = session_user;
  perform private.admit(p_user, 'plan');
  select count(*) into v_owned from public.vaults where created_by = p_user;
  return format('%s plan: %s of %s vaults%s', v_plan.name, v_owned, v_plan.max_vaults,
    case when v_owned > v_plan.max_vaults then ' (over: they can''t create more until under)' else '' end);
end $$;

-- The operator admits an account, or takes admission back. Returns a
-- summary.
create function private.admit_account(p_user uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_user is null or not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'no such account' using errcode = 'P0002';
  end if;
  insert into private.admissions (user_id, via) values (p_user, 'operator')
  on conflict (user_id) do nothing;
  return (select format('admitted (%s, %s)', a.via, to_char(a.admitted_at, 'YYYY-MM-DD'))
            from private.admissions a where a.user_id = p_user);
end $$;

create function private.revoke_admission(p_user uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_owned int;
begin
  if p_user is null or not exists (select 1 from auth.users u where u.id = p_user) then
    raise exception 'no such account' using errcode = 'P0002';
  end if;
  delete from private.admissions where user_id = p_user;
  select count(*) into v_owned from public.vaults where created_by = p_user;
  return format('not admitted: they keep their %s %s and memberships, and can''t create a vault until they accept an invite or are admitted again',
    v_owned, case when v_owned = 1 then 'vault' else 'vaults' end);
end $$;

create function private.set_invite_only(p_on boolean) returns text
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_on is null then
    raise exception 'invite-only is on or off' using errcode = '22023';
  end if;
  update private.settings set invite_only = p_on, set_at = now(), set_by = session_user;
  return case when p_on then 'invite-only: only admitted accounts create vaults'
              else 'open: every account creates vaults, within its plan' end;
end $$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.invite_only(), private.is_admitted(uuid), private.admit(uuid, text),
  private.admission_refusal(), private.admit_account(uuid), private.revoke_admission(uuid),
  private.set_invite_only(boolean)
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
grant execute on function private.admit_account(uuid), private.revoke_admission(uuid),
  private.set_invite_only(boolean)
  to reliquary_ops;

revoke all on function public.my_admission() from public, anon;
grant execute on function public.my_admission() to authenticated;
