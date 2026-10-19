-- Search runs in the server (#463, part of #238; docs/design.md,
-- "Encryption at rest: the content key", section 4).
--
-- Postgres can't match words or rank vectors it can't read, so both halves
-- of search leave SQL. public.search_files keeps RLS and returns a vault's
-- live files with their current bodies, newest first, up to a cap of 2,000;
-- the server that holds the content key opens them and does the word match,
-- the cosine scoring and the blend (web/src/search.ts, the same file as
-- mcp/src/search.ts). With that, the stored words (body_tsv, its triggers
-- and backfill) and the HNSW index go, and a vector is bytes the writer
-- will seal: 384 float4s in network order (float4send), the layout
-- store_embeddings takes as base64. Stored vectors are recomputed: every
-- live file is queued again, and the next search of its vault embeds it.
--
-- note_missed_search used to run the search itself to refuse words that
-- find a file. It can't read a body any more, so it trusts its caller, the
-- two servers, which call it only after a search found nothing; the list
-- is advice for owners, and a member could already fill it with any words.

drop function public.search(uuid, text, int, extensions.vector, real);

-- ---------------------------------------------------------------------------
-- 1. Stored words go

drop trigger file_versions_words on public.file_versions;
drop trigger files_clear_superseded_words on public.files;
drop function private.version_words();
drop function private.clear_superseded_words();
drop function private.clear_history_words();
alter table public.file_versions drop column body_tsv;

-- file_versions is insert-only except for erasure (20260925120000_vault_admin.sql);
-- the one derived change, clearing a version's words, is gone with them.
create or replace function private.versions_erase_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if private.purging(old.vault_id) then
      return old;
    end if;
    raise exception 'file_versions rows are never deleted' using errcode = '42501';
  end if;
  if new.body is not null or new.erased_at is null
     or new.id <> old.id or new.file_id <> old.file_id or new.author <> old.author
     or new.created_at <> old.created_at then
    raise exception 'file_versions rows can only be erased' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Vectors as bytes

drop index public.file_embeddings_embedding_idx;
delete from public.file_embeddings;
alter table public.file_embeddings drop column embedding;
alter table public.file_embeddings add column embedding bytea not null;

insert into private.embedding_queue (file_id, vault_id, version_id)
select f.id, f.vault_id, f.current_version_id
  from public.files f join public.file_versions v on v.id = f.current_version_id
 where f.deleted_at is null and v.body is not null
on conflict (file_id) do update set version_id = excluded.version_id, queued_at = now();

-- As 20261017110000_semantic_search.sql, the vector decoded from base64.
create or replace function private.store_embeddings(p_file uuid, p_version uuid, p_chunks jsonb)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
  n int;
begin
  select f.vault_id into v_vault
    from public.files f
   where f.id = p_file and f.current_version_id = p_version and f.deleted_at is null
     and f.vault_id in (select private.readable_vaults())
     for share;
  if v_vault is null
     or not exists (select 1 from public.file_versions v where v.id = p_version and v.body is not null) then
    return 0;
  end if;
  if jsonb_typeof(p_chunks) is distinct from 'array' or jsonb_array_length(p_chunks) > 8 then
    raise exception 'at most 8 chunks of a file are stored' using errcode = '22023';
  end if;
  delete from public.file_embeddings e
   where e.file_id = p_file and e.chunk >= jsonb_array_length(p_chunks);
  insert into public.file_embeddings (file_id, version_id, vault_id, chunk, line, embedding)
  select p_file, p_version, v_vault, (c->>'chunk')::smallint, (c->>'line')::int,
         decode(c->>'embedding', 'base64')
    from jsonb_array_elements(p_chunks) c
  on conflict (file_id, chunk) do update
     set version_id = excluded.version_id, line = excluded.line, embedding = excluded.embedding;
  get diagnostics n = row_count;
  delete from private.embedding_queue where file_id = p_file and version_id = p_version;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 3. What a search reads

-- A vault's live files with their current bodies, newest first, at most
-- p_cap (2,000 at most, the servers' cap), each with the vault's count of
-- live files so the caller can say when it searched only the newest.
-- Security invoker: RLS on files and file_versions, and rules_for's
-- membership check, decide what a caller gets; an outsider gets nothing.
create function public.search_files(p_vault uuid, p_cap int default 2000)
returns table (path text, policy text, body bytea, updated_at timestamptz,
               author uuid, agent text, total bigint)
language plpgsql stable security invoker set search_path = ''
set plan_cache_mode = force_custom_plan as $$
#variable_conflict use_column
begin
  return query
  with cand as (
    select f.path, v.body, f.updated_at, v.author, v.agent, count(*) over () as total
      from public.files f
      join public.file_versions v on v.id = f.current_version_id
     where f.vault_id = p_vault
       and v.vault_id = p_vault
       and f.deleted_at is null
       and v.body is not null
     order by f.updated_at desc, f.path
     limit least(greatest(coalesce(p_cap, 2000), 1), 2000))
  select c.path, r.policy, c.body, c.updated_at, c.author, c.agent, c.total
    from cand c
    join private.rules_for(p_vault, array(select cand.path from cand)) r on r.path = c.path
   order by c.updated_at desc, c.path;
end $$;
revoke all on function public.search_files(uuid, int) from public, anon;
grant execute on function public.search_files(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. A miss is the caller's word

create or replace function private.note_missed_search(p_vault uuid, p_words text)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_words text := left(trim(coalesce(p_words, '')), 200);
  v_days smallint;
  c_keep constant int := 500;
begin
  if v_words = '' or private.role_in(p_vault) is null then
    return false;
  end if;
  select missed_search_days into v_days from public.vaults where id = p_vault;
  delete from public.missed_searches
   where vault_id = p_vault and searched_at < now() - make_interval(days => v_days);
  insert into public.missed_searches (vault_id, words, by_agent)
  values (p_vault, v_words, private.agent() is not null);
  delete from public.missed_searches
   where vault_id = p_vault
     and id <= (select id from public.missed_searches where vault_id = p_vault
                 order by id desc offset c_keep limit 1);
  return true;
end $$;
