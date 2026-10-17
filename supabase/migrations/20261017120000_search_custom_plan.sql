-- Search plans for the vault it is asked about (#403). A SQL-language
-- function's statements get a generic plan that doesn't know p_vault, so
-- Postgres guessed a vault the size of the database and scanned every
-- vault's file_versions, history included: a 1k vault cost as much as the
-- whole server. In plpgsql with plan_cache_mode = force_custom_plan, each
-- call is planned with its own vault id and uses the vault's indexes.
--
-- Only the language and that setting change. The query is the one in
-- 20261017110000_semantic_search.sql, still security invoker under RLS, so
-- every call returns the same rows in the same order. Same signature, so
-- create or replace keeps that migration's revoke from public and anon and
-- its grant to authenticated. use_column: the result columns (path, line,
-- rank...) become plpgsql variables, and a name in the query means the column.
create or replace function public.search(p_vault uuid, p_query text, p_limit int default 20,
                              p_embedding extensions.vector default null, p_min_similarity real default 0.78)
returns table (path text, policy text, body text, updated_at timestamptz,
               author uuid, agent text, rank real, line int)
language plpgsql stable security invoker set search_path = ''
set hnsw.iterative_scan = 'relaxed_order'
set plan_cache_mode = force_custom_plan as $$
#variable_conflict use_column
begin
  return query
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
   order by h.rank desc, h.updated_at desc, h.word_pos;
end
$$;
