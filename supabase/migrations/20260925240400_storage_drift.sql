-- Counter drift, and accounts gone from Auth (supabase/tests/
-- admission_test.sql, "drift:" and "gone:"). private.storage_drift()
-- compares each vault's counter with a full scan (scripts/plan.sh check). pg_cron runs
-- private.log_storage_drift() weekly, which records any vault whose
-- counter drifted in private.storage_drift_log. Nothing fixes a counter
-- by itself: the operator reads the log and recounts a vault on purpose
-- (private.recount_storage; plan.sh recount <vault-id>).
-- private.accounts_gone() lists members and vault creators whose account
-- no longer exists in Auth (deleted there): they still count as people
-- until an owner removes them.

-- Every vault whose counter isn't what a full scan counts (or that has no
-- counter). One snapshot: a write commits its rows and its count together,
-- so a write in flight is never drift.
create function private.storage_drift()
returns table (vault_id uuid, vault_name text, counted bigint, scanned bigint, drift bigint)
language sql stable security definer set search_path = '' as $$
  select v.id, v.name, s.bytes, x.scanned, x.scanned - coalesce(s.bytes, 0)
    from public.vaults v
    left join private.vault_storage s on s.vault_id = v.id
    cross join lateral (select private.storage_scan(v.id) as scanned) x
   where s.bytes is distinct from x.scanned
   order by abs(x.scanned - coalesce(s.bytes, 0)) desc, v.id
$$;

-- What the weekly check found: vault ids and byte counts, never names or
-- content, so a deleted vault leaves nothing here to erase. Nothing here
-- updates or deletes it; the operator prunes it by hand if ever needed.
create table private.storage_drift_log (
  id         bigint generated always as identity primary key,
  checked_at timestamptz not null default now(),
  vault_id   uuid not null,
  counted    bigint,
  scanned    bigint not null
);
create index on private.storage_drift_log (checked_at);
alter table private.storage_drift_log enable row level security;
revoke all on private.storage_drift_log
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;

-- Records every drifted vault; returns how many. Changes no counter.
create function private.log_storage_drift() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  insert into private.storage_drift_log (vault_id, counted, scanned)
  select d.vault_id, d.counted, d.scanned from private.storage_drift() d;
  get diagnostics n = row_count;
  if n > 0 then
    raise warning 'reliquary: % vault storage counter(s) drifted; see private.storage_drift_log (scripts/plan.sh check)', n;
  end if;
  return n;
end $$;

-- The operator sets one vault's counter to a full scan, on purpose. With
-- the counter's row locked, so writes in flight finish first. Returns a
-- summary.
create function private.recount_storage(p_vault uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old bigint;
  v_new bigint;
begin
  if p_vault is null or not exists (select 1 from public.vaults where id = p_vault) then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  insert into private.vault_storage (vault_id) values (p_vault) on conflict do nothing;
  select bytes into v_old from private.vault_storage where vault_id = p_vault for update;
  v_new := private.storage_scan(p_vault);
  update private.vault_storage set bytes = v_new where vault_id = p_vault;
  return format('counted %s, scanned %s: the counter is now %s', v_old, v_new, private.size_text(v_new));
end $$;

-- Members and vault creators whose account no longer exists in Auth.
create function private.accounts_gone()
returns table (kind text, vault_id uuid, vault_name text, user_id uuid, role text)
language sql stable security definer set search_path = '' as $$
  select 'member', v.id, v.name, m.user_id, m.role
    from public.vault_members m join public.vaults v on v.id = m.vault_id
   where not exists (select 1 from auth.users u where u.id = m.user_id)
  union all
  select 'creator', v.id, v.name, v.created_by, null
    from public.vaults v
   where not exists (select 1 from auth.users u where u.id = v.created_by)
   order by 3, 1, 4
$$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.storage_drift(), private.log_storage_drift(), private.recount_storage(uuid),
  private.accounts_gone()
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
grant execute on function private.storage_drift(), private.recount_storage(uuid), private.accounts_gone()
  to reliquary_ops;

-- pg_cron, where the platform has it (Supabase does; plain Postgres, as in
-- the tests, doesn't): the weekly drift check, Mondays 04:00 UTC.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      perform cron.schedule('reliquary-storage-drift', '0 4 * * 1',
        'select private.log_storage_drift()');
    exception when others then
      raise notice 'pg_cron is not usable here (%); run scripts/plan.sh check by hand', sqlerrm;
    end;
  end if;
end $$;
