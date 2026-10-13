-- Deleting an account while owning vaults, and orphaned vaults (issue #381;
-- hostile tests in supabase/tests/orphaned_vaults_test.sql; the model is
-- docs/design.md, "Deleting an account").
--
-- delete_account (20260926140200_delete_account.sql) no longer refuses an
-- account that is the only owner of a vault. Each vault the person is in
-- goes one of three ways, in the same transaction:
--
--  - no other member: it is erased with the account, exactly as
--    delete_vault erases one (private.erase_vault, shared by both), leaving
--    its row in private.vault_deletions;
--  - another owner: the person just leaves, as before;
--  - other members but no other owner: the person leaves and the vault is
--    orphaned. Its waiting invites are withdrawn (an owner invite accepted
--    later would hand the vault an owner no plan pays for).
--
-- Orphaned is not a stored state: it is a vault with members and no owner,
-- which nothing but delete_account can produce (leave_vault and set_member
-- keep an owner). Members keep reading, writing and proposing as their roles
-- allow; what only an owner may do is refused as it always was, because
-- nobody holds the role.
--
-- Any member may take an orphaned vault (public.take_vault): the first to
-- take it is its owner. Taking counts against the taker's plan, refused in
-- words at their vault limit, and the vault's created_by becomes the taker.
-- created_by is already what "counts against" means everywhere
-- (create_vault and my_plan count it, vault_limits reads the plan from it,
-- delete_account repoints it), so repointing it, rather than adding a second
-- column every one of those would have to learn, is what makes the vault
-- count against and take its limits from the taker from then on. Until
-- someone takes it, it counts against the deleted account, whose plan is
-- gone, so it has the Free plan's limits: orphaning never lets a vault keep
-- a bigger plan's room, or count against nobody once it has an owner again.
--
-- Taking is behind the ceiling: it charges a plan, so only the person, in
-- person, through no token of any kind (docs/public/concepts/agents.md).
--
-- Lock order: take_vault locks the vault's row, then the taker's membership
-- (accept_invite's order: the vault first). leave_vault, in a vault with no
-- owner, locks the vault's row before the leaver's membership, so the last
-- two members leaving at once can't both go and leave a vault nobody can
-- reach or delete; the last member is refused instead.

-- ---------------------------------------------------------------------------
-- 1. Erasing a vault: delete_vault's body, for delete_account too

-- Locks, records and deletes p_vault (see 20261013110000_work_plans_lock_order
-- for why the rows are locked in this order). The caller has already
-- decided it may. Returns the counts kept in private.vault_deletions.
create function private.erase_vault(p_vault uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.vaults;
  v_counts jsonb;
begin
  perform 1 from public.files where vault_id = p_vault order by id for update;
  perform 1 from public.variable_values where vault_id = p_vault order by variable_id, environment for update;
  delete from public.path_claims where vault_id = p_vault;
  perform 1 from public.work_plan_steps where vault_id = p_vault order by id for update;
  select * into v from public.vaults where id = p_vault for update;

  v_counts := jsonb_build_object(
    'members',   (select count(*) from public.vault_members where vault_id = p_vault),
    'files',     (select count(*) from public.files where vault_id = p_vault),
    'versions',  (select count(*) from public.file_versions where vault_id = p_vault),
    'proposals', (select count(*) from public.proposals where vault_id = p_vault),
    'variables', (select count(*) from public.variables where vault_id = p_vault),
    'log',       (select count(*) from public.log where vault_id = p_vault));

  -- The marker the append-only triggers look for, and the only record kept.
  insert into private.vault_deletions (vault_id, deleted_by, txid, counts)
  values (p_vault, private.uid(), txid_current(), v_counts);

  -- What the other members are told, once (see 20260925160000).
  delete from private.vault_deletion_notices
   where deleted_at < now() - make_interval(days => private.notice_days());
  insert into private.vault_deletion_notices (user_id, vault_name, deleted_by)
  select m.user_id, v.name, private.uid() from public.vault_members m
   where m.vault_id = p_vault and m.user_id <> private.uid();

  -- Tokens whose only vault this was reach nothing now; revoke them.
  update public.access_tokens set revoked_at = now()
   where revoked_at is null and not all_vaults and vault_ids <@ array[p_vault];

  -- Approvals hang off proposals, not the vault: delete them while their
  -- proposals still say which vault they're in. Then the vault, and with it
  -- everything else (on delete cascade), ciphertexts included.
  delete from public.approvals a using public.proposals p
   where p.id = a.proposal_id and p.vault_id = p_vault;
  delete from public.vaults where id = p_vault;
  return v_counts;
end $$;

-- As in 20261013110000_work_plans_lock_order, with the erasure moved to
-- private.erase_vault. The name is checked before anything is locked, then
-- erase_vault locks the vault's rows in the same order as before.
create or replace function public.delete_vault(p_vault uuid, p_confirm_name text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners delete a vault' using errcode = '42501';
  end if;
  if p_confirm_name is null
     or trim(p_confirm_name) <> (select v.name from public.vaults v where v.id = p_vault) then
    raise exception 'type the vault''s name exactly to delete it' using errcode = '22023';
  end if;
  return private.erase_vault(p_vault);
end $$;

-- ---------------------------------------------------------------------------
-- 2. What deleting an account does to each vault

-- The caller's vaults and what deleting their account would do to each:
-- 'delete' (nobody else is in it), 'leave' (another owner stays, or it
-- already has no owner) or 'orphan' (other members, no other owner).
create function private.account_vault_fates()
returns table (id uuid, name text, role text, fate text)
language sql stable security definer set search_path = '' as $$
  select v.id, v.name, m.role,
         case when not exists (select 1 from public.vault_members o
                                where o.vault_id = v.id and o.user_id <> m.user_id) then 'delete'
              when m.role = 'owner'
               and not exists (select 1 from public.vault_members o
                                where o.vault_id = v.id and o.role = 'owner' and o.user_id <> m.user_id) then 'orphan'
              else 'leave' end
    from public.vaults v
    join public.vault_members m on m.vault_id = v.id and m.user_id = private.uid()
   order by v.name, v.id
$$;

-- What deleting the caller's account would do, for the confirm page:
--   email:       the address to type (null: type "delete my account")
--   vaults:      [{id, name, role, fate}] every vault they are in (fate as
--                in private.account_vault_fates)
--   connections: live connections that would be deleted
--   invites:     invites they made that are waiting
drop function public.account_deletion_summary();
create function public.account_deletion_summary() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_account_owner();
  return jsonb_build_object(
    'email', private.email_of(private.uid()),
    'vaults', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'role', f.role, 'fate', f.fate)
                                         order by f.name, f.id)
                          from private.account_vault_fates() f), '[]'::jsonb),
    'connections', (select count(*) from public.access_tokens t
                     where t.user_id = private.uid() and t.revoked_at is null
                       and (t.expires_at is null or t.expires_at > now())),
    'invites', (select count(*) from private.vault_invites i
                 where i.created_by = private.uid()
                   and private.invite_state(i.accepted_at, i.revoked_at, i.expires_at) = 'pending'));
end $$;

-- As in 20260926140200_delete_account, but never refused for owning
-- vaults (see the top of this file). Returns counts: {vaults (left),
-- orphaned (of those), deleted, connections, invites}.
create or replace function public.delete_account(p_confirm text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me uuid := private.uid();
  v_email text;
  v_row record;
  v_vaults int := 0;
  v_orphaned int := 0;
  v_deleted int := 0;
  v_connections int;
  v_invites int := 0;
  v_orphan uuid[];
begin
  perform private.require_account_owner();
  v_email := private.email_of(v_me);
  if v_email is not null then
    if p_confirm is null or private.email_key(p_confirm) <> v_email then
      raise exception 'type your email address exactly to delete your account' using errcode = '22023';
    end if;
  elsif lower(trim(coalesce(p_confirm, ''))) <> 'delete my account' then
    raise exception 'type "delete my account" to delete your account' using errcode = '22023';
  end if;

  -- The vaults' rows, by id, then each vault's owners, as before: a role
  -- change, a leave, a take or an invite accepted at the same time waits
  -- for this or this for it, so each vault's fate below can't be outrun.
  perform 1 from public.vaults
   where id in (select vault_id from public.vault_members where user_id = v_me)
      or created_by = v_me
   order by id for update;
  perform 1 from public.vault_members
   where role = 'owner' and vault_id in (select vault_id from public.vault_members where user_id = v_me)
   order by vault_id, user_id for update;

  -- Vaults nobody else is in go with the account. erase_vault locks their
  -- files, values and steps after the vault's row here, the reverse of
  -- delete_vault's order; only the person's own agents could be writing
  -- there, and if one is, one of the two fails whole (40P01).
  for v_row in select f.id from private.account_vault_fates() f where f.fate = 'delete' order by f.id loop
    perform private.erase_vault(v_row.id);
    v_deleted := v_deleted + 1;
  end loop;
  select coalesce(array_agg(f.id), '{}') into v_orphan from private.account_vault_fates() f where f.fate = 'orphan';

  -- Vaults they created count against the longest-standing other owner.
  update public.vaults v
     set created_by = (select o.user_id from public.vault_members o
                        where o.vault_id = v.id and o.role = 'owner' and o.user_id <> v_me
                        order by o.added_at, o.user_id limit 1)
   where v.created_by = v_me
     and exists (select 1 from public.vault_members o
                  where o.vault_id = v.id and o.role = 'owner' and o.user_id <> v_me);

  -- Connections go first, so leaving vaults narrows nothing that is about
  -- to be deleted anyway.
  with gone as (
    delete from public.access_tokens t
     where t.user_id = v_me
    returning t.revoked_at is null and (t.expires_at is null or t.expires_at > now()) as live
  )
  select count(*) filter (where live) into v_connections from gone;

  for v_row in select m.vault_id, m.role from public.vault_members m where m.user_id = v_me order by m.vault_id loop
    perform private.log_event(v_row.vault_id, 'member.leave', null, null, null,
      jsonb_build_object('user', v_me, 'role', v_row.role, 'account_deleted', true)
      || case when v_row.vault_id = any(v_orphan) then '{"orphaned": true}'::jsonb else '{}'::jsonb end);
    v_vaults := v_vaults + 1;
  end loop;
  delete from public.vault_members where user_id = v_me;
  v_orphaned := cardinality(v_orphan);

  for v_row in
    update private.vault_invites set revoked_at = now(), revoked_by = v_me
     where (created_by = v_me or vault_id = any(v_orphan))
       and private.invite_state(accepted_at, revoked_at, expires_at) = 'pending'
    returning id, vault_id, created_by = v_me as mine
  loop
    perform private.log_event(v_row.vault_id, 'invite.revoke', null, null, null,
      jsonb_build_object('invite', v_row.id, 'account_deleted', true));
    if v_row.mine then
      v_invites := v_invites + 1;
    end if;
  end loop;
  delete from private.vault_invites where accepted_by = v_me;

  delete from public.env_imports where created_by = v_me and source = 'web' and status = 'pending';
  delete from public.review_snoozes where user_id = v_me;
  delete from public.profiles where user_id = v_me;
  delete from private.vault_deletion_notices where user_id = v_me;
  delete from private.account_plans where user_id = v_me;
  delete from private.admissions where user_id = v_me;
  delete from private.session_cutoffs where user_id = v_me;

  delete from auth.users where id = v_me;
  insert into private.deleted_accounts (user_id) values (v_me);

  return jsonb_build_object('vaults', v_vaults, 'orphaned', v_orphaned, 'deleted', v_deleted,
    'connections', v_connections, 'invites', v_invites);
end $$;

-- Nothing refuses on it any more.
drop function private.sole_owned();

-- ---------------------------------------------------------------------------
-- 3. Taking an orphaned vault

-- Whether a vault has members and no owner. For a non-member, false: it
-- reads only what RLS lets the caller see.
create function public.vault_orphaned(p_vault uuid) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.vault_members m where m.vault_id = p_vault)
     and not exists (select 1 from public.vault_members m where m.vault_id = p_vault and m.role = 'owner')
$$;

-- The caller, a member of an orphaned vault, becomes its owner, and the
-- vault counts against their plan from now on. Returns the vault's name.
create function public.take_vault(p_vault uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text;
  v_role text;
  v_plan private.plans;
  v_owned int;
begin
  perform private.require_person();
  if private.agent() is not null or private.token_kind() is not null then
    raise exception 'only you, signed in to the web app, can become a vault''s owner: it counts against your plan'
      using errcode = '42501';
  end if;
  select v.name into v_name from public.vaults v where v.id = p_vault for update;
  select m.role into v_role from public.vault_members m
   where m.vault_id = p_vault and m.user_id = private.uid() for update;
  if v_name is null or v_role is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.vault_members m where m.vault_id = p_vault and m.role = 'owner') then
    raise exception '% has an owner, so there is no owner''s place to take: ask an owner if you need another role', v_name
      using errcode = '55000';
  end if;
  -- create_vault's count, under the same per-person lock.
  perform pg_advisory_xact_lock(hashtextextended('reliquary.vaults_owned:' || private.uid()::text, 0));
  v_plan := private.plan_of(private.uid());
  select count(*) into v_owned from public.vaults where created_by = private.uid();
  if v_owned >= v_plan.max_vaults then
    raise exception 'you''re at your %-vault limit on the % plan (you own %), and becoming the owner of % would count it against your plan: delete a vault you no longer need, or ask for a bigger plan',
        v_plan.max_vaults, v_plan.name, v_owned, v_name
      using errcode = 'RLP01',
            detail = jsonb_build_object('limit', 'vaults', 'used', v_owned, 'max', v_plan.max_vaults,
                       'plan', v_plan.id)::text;
  end if;
  update public.vault_members set role = 'owner' where vault_id = p_vault and user_id = private.uid();
  update public.vaults set created_by = private.uid() where id = p_vault;
  perform private.log_event(p_vault, 'vault.take', null, null, null,
    jsonb_build_object('user', private.uid(), 'role', v_role));
  return v_name;
end $$;

-- As in 20260925160000_membership_polish, plus: in a vault with no owner,
-- the last member can't leave (nobody could reach or delete it after).
create or replace function public.leave_vault(p_vault uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_role text;
begin
  perform private.require_human();
  -- The owners first, in set_member's order, so a leave and a demotion at
  -- once can't leave the vault with none.
  perform 1 from public.vault_members
   where vault_id = p_vault and role = 'owner' order by user_id for update;
  if not found then
    perform 1 from public.vaults where id = p_vault for update;
  end if;
  select role into v_role from public.vault_members
   where vault_id = p_vault and user_id = private.uid() for update;
  if v_role is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if v_role = 'owner'
     and (select count(*) from public.vault_members where vault_id = p_vault and role = 'owner') <= 1 then
    raise exception 'you are this vault''s only owner: make someone else an owner first, or delete the vault'
      using errcode = '55000';
  end if;
  if v_role <> 'owner'
     and not exists (select 1 from public.vault_members where vault_id = p_vault and role = 'owner')
     and not exists (select 1 from public.vault_members where vault_id = p_vault and user_id <> private.uid()) then
    raise exception 'you are the last member of this vault, and it has no owner: become its owner, then delete it'
      using errcode = '55000';
  end if;
  delete from public.vault_members where vault_id = p_vault and user_id = private.uid();
  perform private.log_event(p_vault, 'member.leave', null, null, null,
    jsonb_build_object('user', private.uid(), 'role', v_role));
end $$;

revoke all on function private.erase_vault(uuid), private.account_vault_fates()
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
revoke all on function public.account_deletion_summary(), public.take_vault(uuid), public.vault_orphaned(uuid)
  from public, anon;
grant execute on function public.account_deletion_summary(), public.take_vault(uuid), public.vault_orphaned(uuid)
  to authenticated;
