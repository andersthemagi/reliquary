-- Search by meaning (#207; docs/design.md, "Search"). Vectors of each
-- file's current version, from gte-small in the `embed` Edge Function; a
-- queue of files waiting for them, which the MCP server drains for the
-- vault it searches; and public.search blending words and meaning.

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- 1. Vectors: one row per chunk of a file's current version

create table public.file_embeddings (
  file_id    uuid not null references public.files on delete cascade,
  version_id uuid not null references public.file_versions on delete cascade,
  vault_id   uuid not null references public.vaults on delete cascade,
  chunk      smallint not null check (chunk between 0 and 7),
  line       int not null check (line >= 1),
  embedding  extensions.vector(384) not null,
  primary key (file_id, chunk)
);
create index on public.file_embeddings (vault_id);
create index on public.file_embeddings (version_id);
create index on public.file_embeddings using hnsw (embedding extensions.vector_cosine_ops);

alter table public.file_embeddings enable row level security;
-- Whoever may read the file may read its vectors (the file_versions
-- predicate, 20260925110000_hardening). No write policy: only
-- private.store_embeddings writes.
create policy member_read on public.file_embeddings for select to authenticated
  using (vault_id in (select private.readable_vaults()));
revoke all on public.file_embeddings from anon, authenticated;
grant select on public.file_embeddings to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The queue: files whose current version has no vectors yet

create table private.embedding_queue (
  file_id    uuid primary key references public.files on delete cascade,
  vault_id   uuid not null references public.vaults on delete cascade,
  version_id uuid not null references public.file_versions on delete cascade,
  queued_at  timestamptz not null default now()
);
create index on private.embedding_queue (vault_id, queued_at);
create index on private.embedding_queue (version_id);
alter table private.embedding_queue enable row level security;

-- A new current version, a delete or a revival: the file's vectors go, and
-- a live file is queued for new ones.
create function private.embeddings_follow_file() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.file_embeddings where file_id = new.id;
  if new.deleted_at is null and new.current_version_id is not null then
    insert into private.embedding_queue (file_id, vault_id, version_id)
    values (new.id, new.vault_id, new.current_version_id)
    on conflict (file_id) do update set version_id = excluded.version_id, queued_at = now();
  else
    delete from private.embedding_queue where file_id = new.id;
  end if;
  return null;
end $$;
create trigger embeddings_follow_file after insert or update of current_version_id, deleted_at on public.files
  for each row execute function private.embeddings_follow_file();

-- Erasure blanks a version's text: its vectors and its place in the queue go.
create function private.embeddings_follow_erasure() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.file_embeddings where version_id = new.id;
  delete from private.embedding_queue where version_id = new.id;
  return null;
end $$;
create trigger embeddings_follow_erasure after update of body on public.file_versions
  for each row when (new.body is null) execute function private.embeddings_follow_erasure();

insert into private.embedding_queue (file_id, vault_id, version_id)
select f.id, f.vault_id, f.current_version_id
  from public.files f join public.file_versions v on v.id = f.current_version_id
 where f.deleted_at is null and v.body is not null;

-- Up to p_max queued files of a vault the caller may read, oldest first,
-- with their text (which the caller may read anyway). Takes no locks: a
-- search never makes a write wait, and two searches embedding the same
-- file store the same rows.
create function private.embedding_pending(p_vault uuid, p_max int)
returns table (file_id uuid, version_id uuid, body text)
language sql stable security definer set search_path = '' as $$
  select q.file_id, q.version_id, v.body
    from private.embedding_queue q
    join public.file_versions v on v.id = q.version_id
   where q.vault_id = p_vault
     and p_vault in (select private.readable_vaults())
     and v.body is not null
   order by q.queued_at
   limit least(greatest(coalesce(p_max, 8), 1), 50)
$$;

-- Stores a file's vectors, p_chunks = [{"chunk": 0, "line": 1,
-- "embedding": [384 numbers]}, ...], if the caller may read the file, it is
-- live and still at p_version; otherwise does nothing (the version moved on,
-- and is queued again). The share lock on the file's row makes a write,
-- delete or erasure in flight finish first; the check then sees its result.
-- Returns the number of chunks stored; none (a file with no text to embed)
-- just takes the file off the queue.
create function private.store_embeddings(p_file uuid, p_version uuid, p_chunks jsonb)
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
         (c->'embedding')::text::extensions.vector(384)
    from jsonb_array_elements(p_chunks) c
  on conflict (file_id, chunk) do update
     set version_id = excluded.version_id, line = excluded.line, embedding = excluded.embedding;
  get diagnostics n = row_count;
  delete from private.embedding_queue where file_id = p_file and version_id = p_version;
  return n;
end $$;

revoke all on function private.embeddings_follow_file(), private.embeddings_follow_erasure(),
  private.embedding_pending(uuid, int), private.store_embeddings(uuid, uuid, jsonb) from public, anon;
grant execute on function private.embedding_pending(uuid, int), private.store_embeddings(uuid, uuid, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Search: words, and meaning when the caller brings the query's vector

-- As in 20260925130000_efficiency_2 when p_embedding is null (same rows,
-- same order, rank = ts_rank). With it, the vault's nearest chunks of live
-- files at their current version join in, the best chunk per file at a
-- cosine similarity of at least p_min_similarity, and the two lists are
-- blended by reciprocal rank fusion (1 / (60 + position) in each). `line`
-- is the best chunk's first line, for a hit by meaning. The vault filter
-- applies after the HNSW index's ordering, so iterative scans keep going
-- until enough of the vault's rows pass.
drop function public.search(uuid, text, int);
create function public.search(p_vault uuid, p_query text, p_limit int default 20,
                              p_embedding extensions.vector default null, p_min_similarity real default 0.78)
returns table (path text, policy text, body text, updated_at timestamptz,
               author uuid, agent text, rank real, line int)
language sql stable security invoker set search_path = ''
set hnsw.iterative_scan = 'relaxed_order' as $$
  with lim as (select least(greatest(coalesce(p_limit, 20), 1), 100) as n),
  words as (
    select f.id, f.updated_at,
           ts_rank(v.body_tsv, websearch_to_tsquery('simple', p_query)) as score
      from public.files f
      join public.file_versions v on v.id = f.current_version_id
     where f.vault_id = p_vault
       and v.vault_id = p_vault
       and f.deleted_at is null
       and v.body is not null
       and (v.body_tsv @@ websearch_to_tsquery('simple', p_query)
            -- literal substring, no pattern syntax; an empty query matches nothing
            or (length(trim(coalesce(p_query, ''))) > 0
                and strpos(lower(f.path), lower(trim(p_query))) > 0))
     order by 3 desc, f.updated_at desc
     limit (select n from lim)
  ),
  near as (
    select e.file_id, e.line, e.embedding operator(extensions.<=>) p_embedding as d
      from public.file_embeddings e
      join public.files f on f.id = e.file_id and f.current_version_id = e.version_id and f.deleted_at is null
     where p_embedding is not null
       and e.vault_id = p_vault
     order by e.embedding operator(extensions.<=>) p_embedding
     limit (select n * 4 from lim)
  ),
  meaning as (
    select distinct on (near.file_id) near.file_id as id, near.line, near.d
      from near
     where 1 - near.d >= coalesce(p_min_similarity, 0.78)
     order by near.file_id, near.d
  ),
  blended as (
    select coalesce(w.id, m.id) as id, m.line, w.pos as word_pos,
           case when p_embedding is null then w.score
                else (coalesce(1.0 / (60 + w.pos), 0) + coalesce(1.0 / (60 + m.pos), 0))::real end as rank
      from (select words.id, words.score, row_number() over () as pos from words) w
      full join (select meaning.id, meaning.line, row_number() over (order by meaning.d) as pos
                   from meaning) m on m.id = w.id
  ),
  hit as (
    select f.path, v.body, f.updated_at, v.author, v.agent, b.rank, b.line, b.word_pos
      from blended b
      join public.files f on f.id = b.id
      join public.file_versions v on v.id = f.current_version_id
     where v.body is not null
     order by b.rank desc, f.updated_at desc, b.word_pos
     limit (select n from lim)
  )
  select h.path, r.policy, h.body, h.updated_at, h.author, h.agent, h.rank, h.line
    from hit h
    join private.rules_for(p_vault, array(select hit.path from hit)) r on r.path = h.path
   order by h.rank desc, h.updated_at desc, h.word_pos
$$;
revoke all on function public.search(uuid, text, int, extensions.vector, real) from public, anon;
grant execute on function public.search(uuid, text, int, extensions.vector, real) to authenticated;
