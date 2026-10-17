-- References between files (issue #393; hostile tests in
-- supabase/tests/file_references_test.sql; docs/public/concepts/vaults-and-files.md,
-- "References").
--
-- A file's text can point at other files in its vault: [[path]],
-- [[path|label]] and Markdown links to .md files. Each file's references
-- are kept in public.file_references, one row per (source, target), so a
-- reader goes from a file to what it points at and to what points at it in
-- one indexed lookup. Deterministic: no model, no outbound call. "Links"
-- already means an external MCP server, so these are "references".
--
-- Kept like a current version's search words (20260925150000_efficiency_3.sql,
-- section 4): a trigger on public.files replaces a file's rows whenever its
-- current version changes or it is deleted or restored. A target that
-- doesn't exist is kept, and shown as missing until someone writes it.
--
-- Read access: a reference is visible exactly when its vault is readable
-- (private.readable_vaults(), token scope included). Both ends are paths in
-- the row's own vault and files are read per vault, never per path, so a
-- reader who sees the row can read both ends. If a per-path read rule is
-- ever added, this policy has to apply it to both ends.

create table public.file_references (
  vault_id    uuid not null references public.vaults on delete cascade,
  source_path text not null,
  target_path text not null,
  primary key (vault_id, source_path, target_path)
);
create index on public.file_references (vault_id, target_path);

alter table public.file_references enable row level security;
create policy member_read on public.file_references for select to authenticated
  using (vault_id in (select private.readable_vaults()));
revoke all on public.file_references from public, anon, authenticated;
grant select on public.file_references to authenticated;

-- One reference as written, as a vault path, or null when it isn't one.
-- Wiki references ([[...]]) are from the vault's root, and one with no
-- extension means the .md file, as Obsidian reads them. Markdown links are
-- relative to the source's folder unless they start with "/", and only
-- links to .md files count. "#anchor" and "?query" are dropped; a URL (any
-- "scheme:"), an anchor alone, a path that climbs above the root and the
-- source itself are not references.
create function private.reference_target(p_source text, p_ref text, p_wiki boolean) returns text
language plpgsql immutable set search_path = '' as $$
declare
  t text := btrim(replace(split_part(split_part(p_ref, '#', 1), '?', 1), '%20', ' '));
  parts text[] := '{}';
  seg text;
begin
  if t = '' or t ~* '^[a-z][a-z0-9+.-]*:' then
    return null;
  end if;
  if p_wiki then
    if t !~ '\.[^/.]+$' then
      t := t || '.md';
    end if;
  elsif t !~* '\.md$' then
    return null;
  elsif left(t, 1) <> '/' then
    t := regexp_replace(p_source, '[^/]*$', '') || t;
  end if;
  foreach seg in array string_to_array(t, '/') loop
    if seg = '..' then
      if cardinality(parts) = 0 then
        return null;
      end if;
      parts := parts[1:cardinality(parts) - 1];
    elsif seg not in ('', '.') then
      parts := parts || seg;
    end if;
  end loop;
  t := array_to_string(parts, '/');
  if t = '' or t = p_source or length(t) > 1024 then
    return null;
  end if;
  return t;
end $$;
revoke all on function private.reference_target(text, text, boolean) from public, anon, authenticated;

-- The vault paths a file's text refers to, each once. "![[...]]" and
-- "![...](...)" are embedded images, not references.
-- ponytail: references inside code blocks count too; skip fenced code if
-- that turns out to mislead.
create function private.references_in(p_source text, p_body text) returns setof text
language sql immutable set search_path = '' as $$
  select distinct t from (
    select private.reference_target(p_source, m[1], true) as t
      from regexp_matches(coalesce(p_body, ''), '(?<!!)\[\[([^]|\n]*)(?:\|[^]\n]*)?\]\]', 'g') m
    union all
    select private.reference_target(p_source, coalesce(m[1], m[2]), false)
      from regexp_matches(coalesce(p_body, ''), '(?<!!)\[[^]\n]*\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"\n]*")?\)', 'g') m
  ) x
  where t is not null
$$;
revoke all on function private.references_in(text, text) from public, anon, authenticated;

create function private.keep_file_references() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.file_references where vault_id = new.vault_id and source_path = new.path;
  if new.deleted_at is null and new.current_version_id is not null then
    insert into public.file_references (vault_id, source_path, target_path)
    select new.vault_id, new.path, r
      from public.file_versions v cross join lateral private.references_in(new.path, v.body) r
     where v.id = new.current_version_id;
  end if;
  return null;
end $$;
revoke all on function private.keep_file_references() from public, anon, authenticated;
create trigger files_keep_references after update of current_version_id, deleted_at on public.files
  for each row when (old.current_version_id is distinct from new.current_version_id
                     or old.deleted_at is distinct from new.deleted_at)
  execute function private.keep_file_references();

-- What one path refers to and what refers to it, for a reader of the vault:
-- each other end's path, its rule's policy and whether a live file is
-- there. References first, then referenced-by, each by path. Security
-- invoker: RLS on file_references and files, and rules_for's membership
-- check, decide what a caller sees.
create function public.related_files(p_vault uuid, p_path text)
returns table (direction text, path text, policy text, missing boolean)
language sql stable set search_path = '' as $$
  with rel as (
    select 'references'::text as direction, r.target_path as path
      from public.file_references r where r.vault_id = p_vault and r.source_path = p_path
    union all
    select 'referenced_by', r.source_path
      from public.file_references r where r.vault_id = p_vault and r.target_path = p_path)
  select rel.direction, rel.path, p.policy,
         not exists (select 1 from public.files f
                      where f.vault_id = p_vault and f.path = rel.path and f.deleted_at is null)
    from rel join private.rules_for(p_vault, array(select distinct rel.path from rel)) p on p.path = rel.path
   order by rel.direction = 'references' desc, rel.path
$$;
revoke all on function public.related_files(uuid, text) from public, anon;
grant execute on function public.related_files(uuid, text) to authenticated;

-- Existing files, once.
insert into public.file_references (vault_id, source_path, target_path)
select f.vault_id, f.path, r
  from public.files f
  join public.file_versions v on v.id = f.current_version_id
  cross join lateral private.references_in(f.path, v.body) r
 where f.deleted_at is null;
