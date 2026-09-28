-- New file paths are paths every system reads the same way.
--
-- private.valid_path allowed a backslash, a colon and names Windows treats
-- specially. On Linux and macOS they are ordinary characters, but a vault's
-- export (web/src/export.ts) writes each path as a tar entry, and Windows
-- extractors (tar.exe, 7-Zip, Explorer) read them otherwise:
--   - "\" is a folder separator, so "..\x" or "a\..\..\x" climbs out of
--     the folder the archive is extracted into;
--   - ":" names a drive ("C:x") or an NTFS alternate stream ("a:b");
--   - a name ending in "." or " " loses it, so ".. " or "..." can read
--     as "..";
--   - CON, PRN, AUX, NUL, COM1-9, LPT1-9 (with any extension) are devices;
--   - * ? " < > | can't be in a Windows name at all.
--
-- So a path that doesn't exist yet in the vault is refused when it has any
-- of these (SQLSTATE 22023), with a message for people that names the
-- problem and never quotes the path back (an agent's path is data).
--
-- Existing rows: left as they are. A file whose path already exists (live
-- or deleted) can still be written, proposed and deleted, so nothing
-- already in a vault is stranded; the export renames such a path instead
-- of writing it as given (export.ts, "renamed/" and the manifest's
-- "renamed" list). Rule paths are unchanged: a rule must be able to name
-- any file that exists.
--
-- Where: a trigger on public.files and public.proposals, so every writer
-- (write_file, propose, a template, anything later) goes through it.

create or replace function private.portable_path_problem(p_path text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_seg text;
  v_stem text;
begin
  if p_path is null then
    return null;
  end if;
  if strpos(p_path, '\') > 0 then
    return 'A file path can''t contain a backslash (\): Windows reads it as a folder separator, '
        || 'so an exported copy could land outside its folder. Use / between folders, like clients/acme/brief.md';
  end if;
  if p_path ~ '[:*?"<>|]' then
    return 'A file path can''t contain any of : * ? " < > | (this one has '
        || (select string_agg(c, ' ' order by n)
              from unnest(array[':', '*', '?', '"', '<', '>', '|']) with ordinality as r(c, n)
             where strpos(p_path, c) > 0)
        || '): Windows can''t hold them in a name, and a colon can name a drive. '
        || 'Use a dash instead, like "Meeting - notes.md"';
  end if;
  foreach v_seg in array string_to_array(p_path, '/') loop
    if v_seg ~ '[. ]$' then
      return 'A file or folder name can''t end in a dot or a space: Windows drops them, '
          || 'so the name would read as another one. Remove the trailing dot or space';
    end if;
    -- The name before its first dot, as Windows compares it.
    v_stem := upper(rtrim(split_part(v_seg, '.', 1), ' '));
    if v_stem ~ '^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$' then
      return 'A file or folder can''t be named ' || v_stem
          || ', with or without an extension: Windows reserves the name for a device. '
          || 'Add a word, like ' || lower(v_stem) || '-notes.md';
    end if;
  end loop;
  return null;
end $$;

revoke all on function private.portable_path_problem(text) from public, anon, authenticated;

create or replace function private.refuse_unportable_path() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_problem text;
begin
  if tg_op = 'UPDATE' and new.path is not distinct from old.path then
    return new;
  end if;
  v_problem := private.portable_path_problem(new.path);
  if v_problem is null then
    return new;
  end if;
  -- A path already in the vault keeps working (see the top of this file).
  -- On public.files an INSERT ... ON CONFLICT reaches here before the
  -- conflict, so the row it would update counts as existing.
  if tg_op = 'INSERT' and exists (select 1 from public.files f
                                   where f.vault_id = new.vault_id and f.path = new.path) then
    return new;
  end if;
  raise exception '%', v_problem using errcode = '22023';
end $$;

revoke all on function private.refuse_unportable_path() from public, anon, authenticated;

create trigger files_portable_path before insert or update of path on public.files
  for each row execute function private.refuse_unportable_path();
create trigger proposals_portable_path before insert or update of path on public.proposals
  for each row execute function private.refuse_unportable_path();
