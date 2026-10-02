-- private.imports_swept_by_cron() (20260925130000_efficiency_2.sql) and
-- private.rate_limits_pruned_by_cron() (20260925200000_rate_limits.sql) are
-- the same 14-line check -- does pg_cron have an active job by this name --
-- differing only in the job-name literal. Pulled the shared body into
-- private.cron_job_active(p_jobname) and redefined both as one-line wrappers
-- around it. Neither original migration is edited; this only changes what
-- the two function names resolve to.

create function private.cron_job_active(p_jobname text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v boolean;
begin
  if to_regclass('cron.job') is null then
    return false;
  end if;
  execute 'select exists (select 1 from cron.job where jobname = $1 and active)'
    into v using p_jobname;
  return coalesce(v, false);
exception when others then
  return false;
end $$;

create or replace function private.imports_swept_by_cron() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.cron_job_active('reliquary-expired-imports')
$$;

create or replace function private.rate_limits_pruned_by_cron() returns boolean
language sql stable security definer set search_path = '' as $$
  select private.cron_job_active('reliquary-rate-limits')
$$;

revoke all on function private.cron_job_active(text) from public, anon, authenticated;
