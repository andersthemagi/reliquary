-- Plans and limits (docs/public/concepts/plans-and-limits.md;
-- docs/research/positioning.md, "Pricing").
--
-- The model, like Supabase's organisations and projects:
--
-- 1. An account plan limits how many vaults a person owns. A vault counts
--    against the account that created it (vaults.created_by), whoever else
--    later becomes an owner. Everyone is on `free` until the operator
--    assigns another plan (private.account_plans).
-- 2. Each vault has a tier that limits its people and storage. `standard`
--    takes those limits from its account's plan; another tier (`pro`)
--    overrides them for that one vault (private.vault_tier_overrides).
-- 3. The numbers live in private.plans and private.vault_tiers, so they
--    change without a release. Seeded:
--                        vaults  people per vault  storage per vault
--      free (default)         5                10             100 MB
--      alpha_tester          25                25               1 GB
--      pro (a vault tier)     -                50               5 GB
--    Sizes are decimal: 1 MB = 1,000,000 bytes.
--
-- There are no payments: only the operator changes plans and tiers, through
-- private.set_account_plan and private.set_vault_tier (postgres, or
-- reliquary_ops; scripts/plan.sh). No API role (anon, authenticated, the
-- web app's, the MCP server's) can read or write these tables or call
-- those functions. People and their agents read their own plan and their
-- vaults' usage through public.my_plan() and public.vault_usage(vault).
--
-- What counts:
-- - People: a vault's members, plus (when inviting) its invites still
--   waiting, so a vault can't hand out more links than it has room for.
--   Accepting counts members only: the invite was counted when it was made.
-- - Storage: every stored version of every file (history included, since
--   it takes the same space as the current text; erasing a file frees it,
--   deleting keeps it), every variable's ciphertext, and the ciphertext of
--   imports waiting to be applied. Proposals count when applied (they
--   become a version); proposing refuses text that couldn't be applied now.
--   Comments, notes and the log don't count.
--   private.vault_storage keeps each vault's total, maintained by statement
--   triggers on the three tables that hold those bytes, so no request ever
--   scans a vault to know its size (private.storage_scan does, for tests
--   and the operator).
--
-- Enforcement, in the database:
-- - create_vault refuses at the account's vault limit;
-- - create_invite refuses when members plus waiting invites reach the
--   vault's people limit; accept_invite when members do;
-- - anything that adds bytes (a write, an approval that applies one, a set
--   or larger rotation of a variable, an import made) is refused by the
--   storage triggers when the vault would pass its storage limit; a
--   proposal or revision whose text wouldn't fit is refused when made.
-- - Removing is always allowed: deleting and erasing files, deleting
--   variables, removing members, rejecting imports, delete_vault. Applying
--   an import adds nothing (its ciphertext was counted when it was made),
--   so it only fails in a vault already over its limit.
-- Every refusal is SQLSTATE RLP01 with a message naming the vault, the
-- limit, the plan or tier and the usage, and a DETAIL of
-- {"limit", "used", "max", ...} for programs.
--
-- Downgrades never delete anything. A vault over a limit becomes
-- read-mostly: nothing that adds storage, and nobody new, until it is back
-- under; everything else, including deleting it, works as before.

-- ---------------------------------------------------------------------------
-- 1. Tables

create table private.plans (
  id                text primary key check (id ~ '^[a-z][a-z0-9_]{0,31}$'),
  name              text not null check (length(name) between 1 and 40),
  max_vaults        int not null check (max_vaults >= 0),
  max_members       int not null check (max_members >= 1),
  max_storage_bytes bigint not null check (max_storage_bytes >= 0)
);

-- A tier's null limit comes from the vault's account plan. `standard` is
-- all nulls; it is never stored as an override.
create table private.vault_tiers (
  id                text primary key check (id ~ '^[a-z][a-z0-9_]{0,31}$'),
  name              text not null check (length(name) between 1 and 40),
  max_members       int check (max_members >= 1),
  max_storage_bytes bigint check (max_storage_bytes >= 0)
);

create table private.account_plans (
  user_id uuid primary key,
  plan_id text not null references private.plans,
  set_at  timestamptz not null default now(),
  set_by  text not null default session_user
);

create table private.vault_tier_overrides (
  vault_id uuid primary key references public.vaults on delete cascade,
  tier_id  text not null references private.vault_tiers check (tier_id <> 'standard'),
  set_at   timestamptz not null default now(),
  set_by   text not null default session_user
);

create table private.vault_storage (
  vault_id uuid primary key references public.vaults on delete cascade,
  bytes    bigint not null default 0
);

-- The ciphertext tables name their vault on each row, so a row deleted by
-- a cascade (its variable or import already gone) is still counted out.
-- Set from the parent on insert (private.secret_vault, below), never from
-- what the caller passed.
alter table private.variable_secrets add column vault_id uuid;
update private.variable_secrets s set vault_id = vv.vault_id
  from public.variable_values vv where vv.variable_id = s.variable_id and vv.environment = s.environment;
alter table private.variable_secrets alter column vault_id set not null;

alter table private.env_import_secrets add column vault_id uuid;
update private.env_import_secrets s set vault_id = i.vault_id
  from public.env_imports i where i.id = s.import_id;
alter table private.env_import_secrets alter column vault_id set not null;

insert into private.plans (id, name, max_vaults, max_members, max_storage_bytes) values
  ('free', 'Free', 5, 10, 100000000),
  ('alpha_tester', 'Alpha tester', 25, 25, 1000000000);
insert into private.vault_tiers (id, name, max_members, max_storage_bytes) values
  ('standard', 'Standard', null, null),
  ('pro', 'Pro', 50, 5000000000);

create index vaults_created_by_idx on public.vaults (created_by);

alter table private.plans enable row level security;
alter table private.vault_tiers enable row level security;
alter table private.account_plans enable row level security;
alter table private.vault_tier_overrides enable row level security;
alter table private.vault_storage enable row level security;
revoke all on private.plans, private.vault_tiers, private.account_plans,
  private.vault_tier_overrides, private.vault_storage
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;

-- ---------------------------------------------------------------------------
-- 2. Limits

-- A size as people read it, in decimal units: "950 bytes", "12.3 MB", "1 GB".
create function private.size_text(p_bytes bigint) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_bytes is null then 'unknown'
    when abs(p_bytes) = 1 then p_bytes || ' byte'
    when abs(p_bytes) < 1000 then p_bytes || ' bytes'
    when abs(p_bytes) < 1000000 then trim_scale(round(p_bytes / 1e3, 1)) || ' KB'
    when abs(p_bytes) < 1000000000 then trim_scale(round(p_bytes / 1e6, 1)) || ' MB'
    else trim_scale(round(p_bytes / 1e9, 1)) || ' GB'
  end
$$;

-- A person's plan: their assignment, else free.
create function private.plan_of(p_user uuid) returns private.plans
language sql stable security definer set search_path = '' as $$
  select p.* from private.plans p
   where p.id = coalesce((select a.plan_id from private.account_plans a where a.user_id = p_user), 'free')
$$;

-- A vault's limits: its tier's, where the tier sets them, else its
-- account's plan's. label: how a message names where the limit comes from
-- ("the Free plan", "the Pro tier").
create function private.vault_limits(p_vault uuid,
  out plan_id text, out plan_name text, out tier_id text, out tier_name text,
  out max_members int, out max_bytes bigint, out label text)
language sql stable security definer set search_path = '' as $$
  select p.id, p.name, t.id, t.name,
         coalesce(t.max_members, p.max_members), coalesce(t.max_storage_bytes, p.max_storage_bytes),
         case when t.id = 'standard' then 'the ' || p.name || ' plan' else 'the ' || t.name || ' tier' end
    from public.vaults v
    cross join lateral private.plan_of(v.created_by) p
    join private.vault_tiers t
      on t.id = coalesce((select o.tier_id from private.vault_tier_overrides o where o.vault_id = v.id), 'standard')
   where v.id = p_vault
$$;

-- A vault's bytes counted the slow way, from the rows themselves. The
-- triggers below keep private.vault_storage equal to this.
create function private.storage_scan(p_vault uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select (select coalesce(sum(octet_length(v.body)), 0) from public.file_versions v where v.vault_id = p_vault)
       + (select coalesce(sum(length(s.ciphertext)), 0) from private.variable_secrets s where s.vault_id = p_vault)
       + (select coalesce(sum(length(s.ciphertext)), 0) from private.env_import_secrets s where s.vault_id = p_vault)
$$;

-- The storage refusal. p_used: the vault's bytes before; p_adding: what the
-- change would add.
create function private.storage_refusal(p_vault uuid, p_used bigint, p_adding bigint) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  l record;
begin
  select * into l from private.vault_limits(p_vault);
  raise exception '% has % of its % storage limit on %, and this needs % more. Erase files you no longer need (deleting a file keeps its history) or delete variables, then try again',
      (select v.name from public.vaults v where v.id = p_vault), private.size_text(p_used),
      private.size_text(l.max_bytes), l.label, private.size_text(p_adding)
    using errcode = 'RLP01',
          detail = jsonb_build_object('limit', 'storage', 'used', p_used, 'max', l.max_bytes,
                     'adding', p_adding, 'plan', l.plan_id, 'tier', l.tier_id)::text;
end $$;

-- Adds p_delta to a vault's count. A change that adds bytes and takes the
-- vault past its limit is refused (the whole statement rolls back); one
-- that removes bytes never is. A vault being deleted has no row left, and
-- nothing happens.
create function private.add_storage(p_vault uuid, p_delta bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_now bigint;
  v_max bigint;
begin
  update private.vault_storage set bytes = bytes + p_delta where vault_id = p_vault
  returning bytes into v_now;
  if not found or p_delta <= 0 then
    return;
  end if;
  v_max := (private.vault_limits(p_vault)).max_bytes;
  if v_now > v_max then
    perform private.storage_refusal(p_vault, v_now - p_delta, p_delta);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Counting storage

-- Every vault gets its counter when it is made.
create function private.new_vault_storage() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into private.vault_storage (vault_id) values (new.id) on conflict do nothing;
  return null;
end $$;
create trigger vaults_storage after insert on public.vaults
  for each row execute function private.new_vault_storage();

create function private.secret_vault() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    new.vault_id := old.vault_id;
  elsif tg_table_name = 'variable_secrets' then
    new.vault_id := (select vv.vault_id from public.variable_values vv
                      where vv.variable_id = new.variable_id and vv.environment = new.environment);
  else
    new.vault_id := (select i.vault_id from public.env_imports i where i.id = new.import_id);
  end if;
  return new;
end $$;
create trigger variable_secrets_vault before insert or update on private.variable_secrets
  for each row execute function private.secret_vault();
create trigger env_import_secrets_vault before insert or update on private.env_import_secrets
  for each row execute function private.secret_vault();

-- One function per table (each measures its own column), each on three
-- statement triggers with transition tables: one update per vault a
-- statement touched, however many rows.
create function private.count_version_bytes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.add_storage(d.vault_id, d.b)
       from (select vault_id, sum(coalesce(octet_length(body), 0))::bigint as b
               from new_rows group by vault_id) d where d.b <> 0;
  elsif tg_op = 'DELETE' then
    perform private.add_storage(d.vault_id, -d.b)
       from (select vault_id, sum(coalesce(octet_length(body), 0))::bigint as b
               from old_rows group by vault_id) d where d.b <> 0;
  else
    perform private.add_storage(d.vault_id, d.b)
       from (select vault_id, sum(x)::bigint as b from (
               select vault_id, coalesce(octet_length(body), 0) as x from new_rows
               union all
               select vault_id, -coalesce(octet_length(body), 0) from old_rows) y
              group by vault_id) d where d.b <> 0;
  end if;
  return null;
end $$;

create function private.count_secret_bytes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    perform private.add_storage(d.vault_id, d.b)
       from (select vault_id, sum(length(ciphertext))::bigint as b
               from new_rows group by vault_id) d where d.b <> 0;
  elsif tg_op = 'DELETE' then
    perform private.add_storage(d.vault_id, -d.b)
       from (select vault_id, sum(length(ciphertext))::bigint as b
               from old_rows group by vault_id) d where d.b <> 0;
  else
    perform private.add_storage(d.vault_id, d.b)
       from (select vault_id, sum(x)::bigint as b from (
               select vault_id, length(ciphertext) as x from new_rows
               union all
               select vault_id, -length(ciphertext) from old_rows) y
              group by vault_id) d where d.b <> 0;
  end if;
  return null;
end $$;

create trigger file_versions_bytes_insert after insert on public.file_versions
  referencing new table as new_rows for each statement execute function private.count_version_bytes();
create trigger file_versions_bytes_update after update on public.file_versions
  referencing old table as old_rows new table as new_rows for each statement execute function private.count_version_bytes();
create trigger file_versions_bytes_delete after delete on public.file_versions
  referencing old table as old_rows for each statement execute function private.count_version_bytes();

create trigger variable_secrets_bytes_insert after insert on private.variable_secrets
  referencing new table as new_rows for each statement execute function private.count_secret_bytes();
create trigger variable_secrets_bytes_update after update on private.variable_secrets
  referencing old table as old_rows new table as new_rows for each statement execute function private.count_secret_bytes();
create trigger variable_secrets_bytes_delete after delete on private.variable_secrets
  referencing old table as old_rows for each statement execute function private.count_secret_bytes();

create trigger env_import_secrets_bytes_insert after insert on private.env_import_secrets
  referencing new table as new_rows for each statement execute function private.count_secret_bytes();
create trigger env_import_secrets_bytes_update after update on private.env_import_secrets
  referencing old table as old_rows new table as new_rows for each statement execute function private.count_secret_bytes();
create trigger env_import_secrets_bytes_delete after delete on private.env_import_secrets
  referencing old table as old_rows for each statement execute function private.count_secret_bytes();

-- Every existing vault, counted once.
insert into private.vault_storage (vault_id, bytes)
select v.id, private.storage_scan(v.id) from public.vaults v
on conflict (vault_id) do update set bytes = excluded.bytes;

-- A proposal counts when it is applied, but one whose text couldn't be
-- applied now is refused when it is made or revised, not left for a
-- reviewer to find. Erasure (body set to null) and decisions pass.
create function private.proposal_fits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_used bigint;
  v_add bigint := coalesce(octet_length(new.body), 0);
begin
  if new.kind <> 'write' or v_add = 0 or new.status not in ('open', 'changes_requested') then
    return new;
  end if;
  select s.bytes into v_used from private.vault_storage s where s.vault_id = new.vault_id;
  if v_used + v_add > (private.vault_limits(new.vault_id)).max_bytes then
    perform private.storage_refusal(new.vault_id, v_used, v_add);
  end if;
  return new;
end $$;
create trigger proposals_fit before insert or update of body on public.proposals
  for each row execute function private.proposal_fits();

-- ---------------------------------------------------------------------------
-- 4. Vaults per account

-- As in 20260924230000_agent_create_vault, plus the account's vault limit.
-- One person's creations are counted one at a time.
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

-- ---------------------------------------------------------------------------
-- 5. People per vault

-- Refuses when a vault has no room for one more person. p_with_invites:
-- count invites still waiting too (inviting), or members only (accepting).
create function private.require_people_room(p_vault uuid, p_with_invites boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  l record;
  v_members int;
  v_invites int := 0;
begin
  select * into l from private.vault_limits(p_vault);
  select count(*) into v_members from public.vault_members where vault_id = p_vault;
  if p_with_invites then
    select count(*) into v_invites from private.vault_invites
     where vault_id = p_vault and private.invite_state(accepted_at, revoked_at, expires_at) = 'pending';
  end if;
  if v_members + v_invites < l.max_members then
    return;
  end if;
  if p_with_invites then
    raise exception '% is at its %-person limit on % (% and %): revoke an invite or remove someone first',
        (select v.name from public.vaults v where v.id = p_vault), l.max_members, l.label,
        v_members || case when v_members = 1 then ' member' else ' members' end,
        v_invites || case when v_invites = 1 then ' invite waiting' else ' invites waiting' end
      using errcode = 'RLP01',
            detail = jsonb_build_object('limit', 'people', 'used', v_members + v_invites, 'members', v_members,
                       'invites', v_invites, 'max', l.max_members, 'plan', l.plan_id, 'tier', l.tier_id)::text;
  end if;
  raise exception '% is at its %-person limit on % (% members): ask an owner to make room, then open this link again',
      (select v.name from public.vaults v where v.id = p_vault), l.max_members, l.label, v_members
    using errcode = 'RLP01',
          detail = jsonb_build_object('limit', 'people', 'used', v_members, 'members', v_members,
                     'max', l.max_members, 'plan', l.plan_id, 'tier', l.tier_id)::text;
end $$;

-- As in 20260925160000_membership_polish, plus the vault's people limit,
-- counted after a replaced invite to the same address is revoked.
create or replace function public.create_invite(p_vault uuid, p_email text, p_role text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_token text := 'rli_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_email text := lower(trim(coalesce(p_email, '')));
  v_id uuid;
  v_old uuid;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners invite people' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('owner', 'editor', 'viewer') then
    raise exception 'a role is owner, editor or viewer' using errcode = '22023';
  end if;
  if length(v_email) > 254
     or v_email !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$' then
    raise exception 'enter an email address, like name@example.com' using errcode = '22023';
  end if;
  perform 1 from public.vaults where id = p_vault for update;
  -- One person's invites, counted one call at a time, whichever vault.
  perform pg_advisory_xact_lock(hashtextextended('reliquary.invite_rate:' || private.uid()::text, 0));
  if (select count(*) from private.vault_invites
       where created_by = private.uid() and created_at > now() - interval '1 hour') >= private.invite_rate() then
    raise exception 'you have created % invites in the last hour: try again later', private.invite_rate()
      using errcode = '54000';
  end if;
  if exists (select 1 from public.vault_members m
              where m.vault_id = p_vault and private.email_of(m.user_id) = v_email) then
    raise exception 'that address already belongs to a member of this vault' using errcode = '23505';
  end if;
  for v_old in
    update private.vault_invites set revoked_at = now(), revoked_by = private.uid()
     where vault_id = p_vault and email = v_email
       and private.invite_state(accepted_at, revoked_at, expires_at) = 'pending'
    returning id
  loop
    perform private.log_event(p_vault, 'invite.revoke', null, null, null,
      jsonb_build_object('invite', v_old, 'replaced', true));
  end loop;
  if (select count(*) from private.vault_invites
       where vault_id = p_vault and private.invite_state(accepted_at, revoked_at, expires_at) = 'pending')
     >= private.invite_cap() then
    raise exception 'this vault has % invites waiting: revoke some first', private.invite_cap() using errcode = '54000';
  end if;
  perform private.require_people_room(p_vault, true);
  insert into private.vault_invites (vault_id, email, role, token_hash, created_by, expires_at)
  values (p_vault, v_email, p_role, private.token_hash(v_token), private.uid(), now() + interval '7 days')
  returning id into v_id;
  perform private.log_event(p_vault, 'invite.create', null, null, null,
    jsonb_build_object('invite', v_id, 'role', p_role));
  return v_token;
end $$;

-- As in 20260925140000_invites, plus the vault's people limit (members
-- only), with the vault locked so two acceptances can't both take the last
-- place. A refusal doesn't use the invite up.
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
  perform private.log_event(i.vault_id, 'invite.accept', null, null, null,
    jsonb_build_object('invite', i.id, 'role', i.role));
  return i.vault_id;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Applying an import adds nothing

-- As in 20260925100000_env_imports, but the import's values are taken out
-- of private.env_import_secrets before they are written as variables, so
-- the count goes down before it goes up: an import that fit when it was
-- made still fits. Only a vault already over its limit (a smaller plan
-- since) is refused, as {"ok": false, "error": "storage_limit", "message"},
-- with nothing changed: reject the import, or make room first.
create or replace function public.apply_env_import(p_import uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  i public.env_imports;
  v_role text;
  v_env text;
  v_n int := 0;
  v_items jsonb;
  r record;
  refused jsonb := jsonb_build_object('attempt', 'apply', 'import', p_import);
begin
  if private.uid() is null then
    return '{"ok": false, "error": "unauthorized"}';
  end if;
  if private.agent() is not null or session_user::text = 'reliquary_mcp' then
    select * into i from public.env_imports where id = p_import;
    if found then
      perform private.env_log(i.vault_id, 'refused', null, i.names,
        refused || '{"reason": "an agent can''t apply an import; a person does, in the web UI"}');
    end if;
    return '{"ok": false, "error": "forbidden"}';
  end if;
  perform private.sweep_env_imports();
  select * into i from public.env_imports where id = p_import for update;
  if not found then
    return '{"ok": false, "error": "not_found"}';
  end if;
  v_role := private.role_in(i.vault_id);
  if v_role is null or (i.source = 'web' and i.created_by <> private.uid()) then
    return '{"ok": false, "error": "not_found"}';
  end if;
  if i.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', i.status);
  end if;
  if i.expires_at <= now() then
    return '{"ok": false, "error": "expired"}';
  end if;
  foreach v_env in array i.environments loop
    if not private.env_allows(i.vault_id, v_env, v_role) then
      perform private.env_log(i.vault_id, 'refused', v_env, i.names, refused || jsonb_build_object('reason', 'role ' || v_role));
      return '{"ok": false, "error": "forbidden"}';
    end if;
  end loop;

  begin
  with gone as (
    delete from private.env_import_secrets s where s.import_id = i.id
    returning s.name, s.environment, s.key_id, s.nonce, s.ciphertext
  )
  select coalesce(jsonb_agg(jsonb_build_object('name', g.name, 'environment', g.environment, 'key_id', g.key_id,
           'nonce', encode(g.nonce, 'base64'), 'ciphertext', encode(g.ciphertext, 'base64'))
           order by g.name, private.env_order(g.environment), g.environment), '[]')
    into v_items
    from gone g;
  for r in
    select e.item ->> 'name' as name, e.item ->> 'environment' as environment, e.item ->> 'key_id' as key_id,
           decode(e.item ->> 'nonce', 'base64') as nonce, decode(e.item ->> 'ciphertext', 'base64') as ciphertext
      from jsonb_array_elements(v_items) with ordinality as e(item, n)
     order by e.n
  loop
    perform private.put_variable(i.vault_id, r.name, r.environment, r.key_id, r.nonce, r.ciphertext,
      jsonb_build_object('import', i.id, 'source', i.source, 'by', i.created_by));
    v_n := v_n + 1;
  end loop;
  exception when sqlstate 'RLP01' then
    return jsonb_build_object('ok', false, 'error', 'storage_limit', 'message', sqlerrm);
  end;
  if v_n = 0 then
    raise exception 'this import has no values left' using errcode = 'P0002';
  end if;
  update public.env_imports set status = 'applied', decided_by = private.uid(), decided_at = now()
   where id = i.id;
  return jsonb_build_object('ok', true, 'applied', v_n, 'names', to_jsonb(i.names),
    'environments', to_jsonb(i.environments));
end $$;

-- ---------------------------------------------------------------------------
-- 7. Reading usage: people and their agents, their own

-- The caller's plan and how many vaults they own.
create function public.my_plan()
returns table (plan text, plan_name text, vaults_owned int, max_vaults int)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_person();
  return query
    select p.id, p.name, (select count(*)::int from public.vaults v where v.created_by = private.uid()), p.max_vaults
      from private.plan_of(private.uid()) p;
end $$;

-- A vault's tier, limits and usage, for its members (and their agents,
-- within their token's scope). Invites waiting are counted for owners only
-- (only they see invites); null for everyone else.
create function public.vault_usage(p_vault uuid)
returns table (tier text, tier_name text, plan text, plan_name text, members int, invites int,
               max_members int, bytes bigint, max_bytes bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text;
begin
  perform private.require_person();
  v_role := private.role_in(p_vault);
  if v_role is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  return query
    select l.tier_id, l.tier_name, l.plan_id, l.plan_name,
           (select count(*)::int from public.vault_members m where m.vault_id = p_vault),
           case when v_role = 'owner' then
             (select count(*)::int from private.vault_invites i
               where i.vault_id = p_vault and private.invite_state(i.accepted_at, i.revoked_at, i.expires_at) = 'pending')
           end,
           l.max_members,
           coalesce((select s.bytes from private.vault_storage s where s.vault_id = p_vault), 0),
           l.max_bytes
      from private.vault_limits(p_vault) l;
end $$;

-- ---------------------------------------------------------------------------
-- 8. The operator's controls: postgres and reliquary_ops only

-- An account by its email (case-insensitive), or an error naming the
-- problem. Never lists other accounts.
create function private.user_by_email(p_email text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v uuid[];
begin
  select array_agg(u.id) into v from auth.users u where lower(u.email::text) = lower(trim(coalesce(p_email, '')));
  if v is null then
    raise exception 'no account with that email' using errcode = 'P0002';
  end if;
  if cardinality(v) > 1 then
    raise exception 'more than one account has that email; use its id' using errcode = '21000';
  end if;
  return v[1];
end $$;

-- Puts a person on a plan. Nothing is deleted when it is smaller: over a
-- limit, they can't add more until they are under it. Returns a summary.
create function private.set_account_plan(p_user uuid, p_plan text) returns text
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
  select count(*) into v_owned from public.vaults where created_by = p_user;
  return format('%s plan: %s of %s vaults%s', v_plan.name, v_owned, v_plan.max_vaults,
    case when v_owned > v_plan.max_vaults then ' (over: they can''t create more until under)' else '' end);
end $$;

-- Sets a vault's tier; 'standard' takes it back to its account's plan.
-- Nothing is deleted when the limits are smaller. Returns a summary.
create function private.set_vault_tier(p_vault uuid, p_tier text) returns text
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

-- ---------------------------------------------------------------------------
-- 9. Grants

revoke all on function private.size_text(bigint), private.plan_of(uuid), private.vault_limits(uuid),
  private.storage_scan(uuid), private.storage_refusal(uuid, bigint, bigint), private.add_storage(uuid, bigint),
  private.new_vault_storage(), private.secret_vault(), private.count_version_bytes(),
  private.count_secret_bytes(), private.proposal_fits(), private.require_people_room(uuid, boolean),
  private.user_by_email(text), private.set_account_plan(uuid, text), private.set_vault_tier(uuid, text)
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
grant execute on function private.user_by_email(text), private.set_account_plan(uuid, text),
  private.set_vault_tier(uuid, text)
  to reliquary_ops;

revoke all on function public.my_plan(), public.vault_usage(uuid) from public, anon;
grant execute on function public.my_plan(), public.vault_usage(uuid) to authenticated;
