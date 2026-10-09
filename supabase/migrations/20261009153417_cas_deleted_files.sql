-- A deleted file is "no file yet" to the compare-and-swap check. The check in
-- 20260930100000_compare_and_swap.sql read files.current_version_id without
-- looking at deleted_at, and delete_file only sets deleted_at, so a writer
-- who read version V before someone deleted the file still held the file's
-- "current" version: write_file(expected = V) passed, and apply_write
-- un-deleted the file with the stale writer's text. That is the lost update
-- the check exists to refuse, with a person's deletion as the thing lost.
--
-- The rule lives in one helper, which write_file and delete_file both call,
-- instead of in the twelve lines each carried a copy of. The row is still
-- locked whether or not it is deleted: apply_write upserts onto that same
-- row, so the lock has to cover it, in the order 20260925240100_lock_order.sql
-- set (the file's row first).
--
-- The refusal for a file that isn't there says so instead of naming a
-- current version and a last writer that don't exist ("the current version
-- is no file yet by nobody"). Same SQLSTATE, RLF01.
--
-- The helper is private and revoked from every API role: called directly it
-- would answer "is this still the current version" for any vault and path,
-- and take a row lock, with none of write_file's access checks in front.

create function private.check_expected_version(p_vault uuid, p_path text, p_expected uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_current uuid;
  v_author uuid;
begin
  if p_expected is null then
    return;
  end if;
  perform 1 from public.files where vault_id = p_vault and path = p_path for update;
  select f.current_version_id, fv.author into v_current, v_author
    from public.files f left join public.file_versions fv on fv.id = f.current_version_id
    where f.vault_id = p_vault and f.path = p_path and f.deleted_at is null;
  if v_current is distinct from p_expected then
    raise exception 'this file changed since you read it (you had version %); %',
      p_expected,
      case when v_current is null then 'it no longer exists at this path, so there is no current version'
           else format('the current version is %s by %s', v_current, coalesce(v_author::text, 'nobody')) end
      using errcode = 'RLF01';
  end if;
end $$;

revoke all on function private.check_expected_version(uuid, text, uuid) from public, anon, authenticated;

-- write_file and delete_file as 20260930100000_compare_and_swap.sql left
-- them, the inline check replaced by the helper call.
create or replace function public.write_file(p_vault uuid, p_path text, p_body text, p_expected_version uuid default null)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_person();
  perform private.valid_path(p_path);
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if (private.policy_for(p_vault, p_path)).policy <> 'open' then
    raise exception '% is canon: use propose()', p_path using errcode = '42501';
  end if;
  perform private.check_expected_version(p_vault, p_path, p_expected_version);
  return private.apply_write(p_vault, p_path, p_body, private.uid(), private.agent(), null);
end $$;

create or replace function public.delete_file(p_vault uuid, p_path text, p_expected_version uuid default null)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_person();
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if (private.policy_for(p_vault, p_path)).policy <> 'open' then
    raise exception '% is canon: use propose()', p_path using errcode = '42501';
  end if;
  perform private.check_expected_version(p_vault, p_path, p_expected_version);
  update public.files set deleted_at = now(), updated_at = now()
  where vault_id = p_vault and path = p_path and deleted_at is null;
  if not found then
    raise exception 'no such file' using errcode = 'P0002';
  end if;
  perform private.log_event(p_vault, 'file.delete', p_path, null, null);
end $$;
