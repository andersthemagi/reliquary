-- Rules refuse paths outside the vault.
--
-- public.set_policy stored any path it was given: the Rules form saved
-- "../x" ("../x is now canon.") and listed a rule that can never match a
-- file. A rule's path now follows the same rules as a file's path
-- (private.valid_path, 20260925110000_hardening.sql), except that a folder
-- rule ends in one "/":
--   - not empty, and not starting with "/" (paths are inside the vault);
--   - no empty segment ("a//b"), no "." or ".." segment;
--   - no control characters, at most 1024 characters.
-- Backslashes are allowed, as they are in file paths: a rule must be able to
-- name any file that can exist.
--
-- Each refusal says which path and why, in words for people (SQLSTATE
-- 22023). The path is quoted back only when it has no control characters,
-- so a log line never carries one.
--
-- Existing rows: left as they are. A rule whose path breaks these rules
-- never matched a file (no file path can start with "../" or "/", or
-- contain "//"), so it changed nothing; removing it stays possible, since
-- removing a rule that exists is not checked. The constraint below is NOT
-- VALID, so it holds for every new or changed row without failing on old
-- ones.

create or replace function private.rule_path_problem(p_path text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_body text;
  v_shown text;
begin
  if p_path is null or p_path = '' then
    return 'A rule needs a path: a folder ending in / (like clients/) or a file (like notes/plan.md)';
  end if;
  if p_path ~ '[[:cntrl:]]' then
    return 'A rule''s path can''t contain control characters (tabs, line breaks and the like): type the folder or file name as it appears in the vault';
  end if;
  if length(p_path) > 1024 then
    return 'A rule''s path can be at most 1024 characters; this one has ' || length(p_path);
  end if;
  v_shown := '"' || p_path || '"';
  if left(p_path, 1) = '/' then
    return 'The rule on ' || v_shown || ' starts with /: paths in a vault are relative, so write clients/ rather than /clients/';
  end if;
  -- A folder rule is the folder's path and one trailing "/".
  v_body := case when right(p_path, 1) = '/' then left(p_path, -1) else p_path end;
  if v_body = '' or v_body ~ '//' or right(v_body, 1) = '/' then
    return 'The rule on ' || v_shown || ' has an empty folder name (two / in a row): write each folder once, like clients/acme/';
  end if;
  if v_body ~ '(^|/)\.\.(/|$)' then
    return 'The rule on ' || v_shown || ' has a .. segment, which points outside the vault: name the folder or file inside the vault, like clients/';
  end if;
  if v_body ~ '(^|/)\.(/|$)' then
    return 'The rule on ' || v_shown || ' has a . segment: leave it out, so ./clients/ is written clients/';
  end if;
  return null;
end $$;

revoke all on function private.rule_path_problem(text) from public, anon, authenticated;

create or replace function public.set_policy(p_vault uuid, p_path text, p_policy text, p_quorum int default 1)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_problem text;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners set policies' using errcode = '42501';
  end if;
  -- Removing a rule that exists is never refused, so an owner can remove
  -- one saved before paths were checked.
  if p_policy is null and exists (select 1 from public.path_policies
                                  where vault_id = p_vault and path = p_path) then
    v_problem := null;
  else
    v_problem := private.rule_path_problem(p_path);
  end if;
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;
  if p_policy is null then
    delete from public.path_policies where vault_id = p_vault and path = p_path;
  else
    insert into public.path_policies (vault_id, path, policy, quorum)
    values (p_vault, p_path, p_policy, p_quorum)
    on conflict (vault_id, path) do update set policy = excluded.policy, quorum = excluded.quorum;
  end if;
  perform private.log_event(p_vault, 'policy.set', p_path, null, null,
    jsonb_build_object('policy', p_policy, 'quorum', p_quorum));
end $$;

-- The same shape at the table, for any writer that isn't set_policy.
alter table public.path_policies add constraint path_policies_path_inside
  check (path <> '' and path !~ '^/' and path !~ '//' and path !~ '(^|/)\.\.?(/|$)') not valid;
