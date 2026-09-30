-- Compare-and-swap writes (milestone exception logged 2026-09-30, tracking
-- issue #52, phase 1). write_file and delete_file take an optional
-- p_expected_version: given, the write only goes through if the file's
-- current version still matches, so an agent working from a stale read
-- can't silently clobber someone else's edit. Given nothing, behaviour is
-- unchanged (the parameter defaults to null).
--
-- The old signatures are dropped first, as 20260924150000_review.sql does
-- for decide(), so a three-argument write_file call is never ambiguous
-- between an old and new overload.
--
-- The file's row is locked (`for update`) before its version is compared,
-- in the lock order 20260925240100_lock_order.sql established (the file's
-- row first): otherwise a write could slip in between the check and the
-- change, defeating the whole point of checking.
--
-- The refusal is a new SQLSTATE, RLF01, not 40001 (serialization_failure):
-- some drivers and poolers auto-retry 40001 on the assumption that trying
-- again with the same statement will succeed, which is true for a real
-- serialization conflict but not for a stale version -- retrying verbatim
-- would just fail the same way forever, hiding a refusal a caller needs to
-- see and act on (re-read, then decide whether to overwrite).

drop function public.write_file(uuid, text, text);
drop function public.delete_file(uuid, text);

create or replace function public.write_file(p_vault uuid, p_path text, p_body text, p_expected_version uuid default null)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_current uuid;
  v_author uuid;
begin
  perform private.require_person();
  perform private.valid_path(p_path);
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if (private.policy_for(p_vault, p_path)).policy <> 'open' then
    raise exception '% is canon: use propose()', p_path using errcode = '42501';
  end if;
  if p_expected_version is not null then
    perform 1 from public.files where vault_id = p_vault and path = p_path for update;
    select f.current_version_id, fv.author into v_current, v_author
      from public.files f left join public.file_versions fv on fv.id = f.current_version_id
      where f.vault_id = p_vault and f.path = p_path;
    if v_current is distinct from p_expected_version then
      raise exception 'this file changed since you read it (you had version %); the current version is % by %',
        p_expected_version, coalesce(v_current::text, 'no file yet'), coalesce(v_author::text, 'nobody')
        using errcode = 'RLF01';
    end if;
  end if;
  return private.apply_write(p_vault, p_path, p_body, private.uid(), private.agent(), null);
end $$;

create or replace function public.delete_file(p_vault uuid, p_path text, p_expected_version uuid default null)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_current uuid;
  v_author uuid;
begin
  perform private.require_person();
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if (private.policy_for(p_vault, p_path)).policy <> 'open' then
    raise exception '% is canon: use propose()', p_path using errcode = '42501';
  end if;
  if p_expected_version is not null then
    perform 1 from public.files where vault_id = p_vault and path = p_path for update;
    select f.current_version_id, fv.author into v_current, v_author
      from public.files f left join public.file_versions fv on fv.id = f.current_version_id
      where f.vault_id = p_vault and f.path = p_path;
    if v_current is distinct from p_expected_version then
      raise exception 'this file changed since you read it (you had version %); the current version is % by %',
        p_expected_version, coalesce(v_current::text, 'no file yet'), coalesce(v_author::text, 'nobody')
        using errcode = 'RLF01';
    end if;
  end if;
  update public.files set deleted_at = now(), updated_at = now()
  where vault_id = p_vault and path = p_path and deleted_at is null;
  if not found then
    raise exception 'no such file' using errcode = 'P0002';
  end if;
  perform private.log_event(p_vault, 'file.delete', p_path, null, null);
end $$;

revoke all on function public.write_file(uuid, text, text, uuid), public.delete_file(uuid, text, uuid)
  from public, anon;
grant execute on function public.write_file(uuid, text, text, uuid), public.delete_file(uuid, text, uuid)
  to authenticated;
