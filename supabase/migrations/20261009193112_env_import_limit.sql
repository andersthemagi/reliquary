-- Which import limit a person has reached.
--
-- create_env_import and env_import_precheck answer {"ok": false, "error":
-- "rate_limited"} for two limits (private.env_imports_rate_limited): 20
-- pending imports of the caller's in a vault, and 60 made in an hour. Only the
-- first clears by applying or rejecting imports, so the env API asks which one
-- it was, to tell the CLI to apply or reject some instead of waiting. A CLI
-- grant can't read env_imports (row-level security shows it nothing), hence a
-- function. It counts only the caller's own imports, so it tells a caller
-- nothing about anyone else, and the numbers match
-- private.env_imports_rate_limited (supabase/tests/efficiency_2_test.sql
-- checks each edge against the precheck).

create function public.env_import_limit(p_vault uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when private.uid() is null then null
    when (select count(*) from public.env_imports
           where created_by = private.uid() and vault_id = p_vault
             and status = 'pending' and expires_at > now()) >= 20 then 'pending'
    when (select count(*) from public.env_imports
           where created_by = private.uid() and created_at > now() - interval '1 hour') >= 60 then 'hourly'
  end
$$;

revoke all on function public.env_import_limit(uuid) from public, anon;
grant execute on function public.env_import_limit(uuid) to authenticated;
