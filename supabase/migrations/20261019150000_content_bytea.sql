-- Content columns become bytea (#462, step 2 of #238; docs/design.md,
-- "Encryption at rest: the content key"). File text, proposed text, notes
-- and thread messages keep their bytes as they are (UTF-8, still readable),
-- so nothing is sealed yet: this is the type change alone, with every path
-- that reads a body as text converting it, so the sealing step changes
-- only what it must. Search vectors change type with the search move (#463).
--
-- Writes keep taking text: every function that stores a body converts it
-- with convert_to(..., 'UTF8') (20261019190000_writers_convert). This file
-- first shipped with an assignment cast (text as bytea) doing that for
-- them, which hosted Supabase refused ("must be owner of type text or type
-- bytea": a cast between built-in types needs their owner), so v0.27.0's
-- deploy stopped here and the file was edited before it had applied
-- anywhere but CI. The one edit of a shipped migration: docs/progress.md,
-- 2026-10-19.

-- A message's character limit is private.thread_body's to check; the table
-- keeps a byte ceiling no UTF-8 text within it can pass, and a sealed body
-- fits too. A note's stays a character count on the text, until sealing
-- moves it into the functions that write notes.
alter table public.thread_messages drop constraint thread_messages_body_check;
alter table public.proposal_notes drop constraint proposal_notes_body_size;

-- Triggers declared on the column block its type change; they come back
-- as they were, below, once it is bytea.
drop trigger file_versions_words on public.file_versions;
drop trigger embeddings_follow_erasure on public.file_versions;
drop trigger proposals_fit on public.proposals;

alter table public.file_versions   alter column body type bytea using convert_to(body, 'UTF8');
alter table public.proposals       alter column body type bytea using convert_to(body, 'UTF8');
alter table public.proposal_notes  alter column body type bytea using convert_to(body, 'UTF8');
alter table public.thread_messages alter column body type bytea using convert_to(body, 'UTF8');

create trigger embeddings_follow_erasure after update of body on public.file_versions
  for each row when (new.body is null) execute function private.embeddings_follow_erasure();
create trigger proposals_fit before insert or update of body on public.proposals
  for each row execute function private.proposal_fits();

alter table public.thread_messages add constraint thread_messages_body_check
  check (body <> '' and octet_length(body) <= 4 * private.thread_message_max_chars() + 64);
alter table public.proposal_notes add constraint proposal_notes_body_size
  check (length(convert_from(body, 'UTF8')) <= 4000) not valid;

-- Approving a proposal copies its body (now bytes) into a version: the write
-- helper takes bytes, and its text form (write_file's) converts.
create function private.apply_write(p_vault uuid, p_path text, p_body bytea,
  p_author uuid, p_agent text, p_proposal uuid)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_file uuid;
  v_version uuid;
begin
  insert into public.files (vault_id, path) values (p_vault, p_path)
  on conflict (vault_id, path) do update set deleted_at = null, updated_at = now()
  returning id into v_file;
  insert into public.file_versions (file_id, vault_id, body, author, agent)
  values (v_file, p_vault, p_body, p_author, p_agent)
  returning id into v_version;
  update public.files set current_version_id = v_version, updated_at = now()
  where id = v_file;
  insert into public.log (vault_id, actor, agent, event, path, version_id, proposal_id)
  values (p_vault, p_author, p_agent, 'file.write', p_path, v_version, p_proposal);
  return v_version;
end $$;
revoke all on function private.apply_write(uuid, text, bytea, uuid, text, uuid) from public, anon, authenticated;

create or replace function private.apply_write(p_vault uuid, p_path text, p_body text,
  p_author uuid, p_agent text, p_proposal uuid)
returns uuid
language sql volatile security definer set search_path = '' as $$
  select private.apply_write(p_vault, p_path, convert_to(p_body, 'UTF8'), p_author, p_agent, p_proposal)
$$;

-- ---------------------------------------------------------------------------
-- Reads: every place SQL treats a body as text converts it.

create or replace function private.version_words() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.body_tsv := case when new.body is null then null
                         else to_tsvector('simple', convert_from(new.body, 'UTF8')) end;
  elsif new.body is null then
    new.body_tsv := null;
  end if;
  return new;
end $$;
create trigger file_versions_words before insert or update of body on public.file_versions
  for each row execute function private.version_words();

create or replace function private.keep_file_references() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.file_references where vault_id = new.vault_id and source_path = new.path;
  if new.deleted_at is null and new.current_version_id is not null then
    insert into public.file_references (vault_id, source_path, target_path)
    select new.vault_id, new.path, r
      from public.file_versions v
      cross join lateral private.references_in(new.path, convert_from(v.body, 'UTF8')) r
     where v.id = new.current_version_id;
  end if;
  return null;
end $$;

create or replace function private.embedding_pending(p_vault uuid, p_max int)
returns table (file_id uuid, version_id uuid, body text)
language sql stable security definer set search_path = '' as $$
  select q.file_id, q.version_id, convert_from(v.body, 'UTF8')
    from private.embedding_queue q
    join public.file_versions v on v.id = q.version_id
   where q.vault_id = p_vault
     and p_vault in (select private.readable_vaults())
     and v.body is not null
   order by q.queued_at
   limit least(greatest(coalesce(p_max, 8), 1), 50)
$$;

create or replace function public.change_notes(p_vault uuid, p_after bigint, p_upto bigint)
returns table (seq bigint, note_id uuid, proposal_id uuid, path text, kind text,
  revision int, author uuid, agent text, body text, erased boolean, at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select l.seq, n.id, n.proposal_id, l.path, n.kind, n.revision, n.author, n.agent,
         case when n.erased_at is null then convert_from(n.body, 'UTF8') end, n.erased_at is not null, n.at
    from public.log l
    join public.proposal_notes n
      on n.proposal_id = l.proposal_id
     and n.vault_id = l.vault_id
     and case l.event
           when 'proposal.comment' then
             n.kind = 'comment' and n.id::text = l.detail ->> 'note'
           when 'proposal.request_changes' then
             n.kind = 'request_changes' and n.revision::text = l.detail ->> 'revision' and n.author = l.actor
           when 'proposal.reject' then
             n.kind = 'reject' and n.revision::text = l.detail ->> 'revision' and n.author = l.actor
           when 'proposal.revise' then
             n.kind = 'revise' and n.revision::text = l.detail ->> 'revision' and n.author = l.actor
           when 'proposal.edit' then
             n.kind = 'edit' and n.revision::text = l.detail ->> 'revision' and n.author = l.actor
           else false
         end
   where l.vault_id = p_vault
     and l.seq > coalesce(p_after, 0)
     and l.seq <= coalesce(p_upto, 0)
   order by l.seq
   limit 500
$$;

create or replace function public.export_files(p_vault uuid, p_after text default '', p_limit int default 200,
                                               p_export uuid default null)
returns table (path text, body text, updated_at timestamptz, version_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_export uuid;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners export a vault' using errcode = '42501';
  end if;
  select e.id into v_export from private.vault_exports e
   where e.vault_id = p_vault and e.started_by = private.uid()
     and (p_export is null or e.id = p_export)
     and e.started_at > now() - interval '2 hours'
   order by e.started_at desc limit 1;
  if v_export is null then
    raise exception 'this export has expired or was never started: start it again' using errcode = '55000';
  end if;
  return query
    select x.path, convert_from(fv.body, 'UTF8'), x.updated_at, fv.id
      from private.vault_export_files x join public.file_versions fv on fv.id = x.version_id
     where x.export_id = v_export and fv.body is not null
       and x.path > coalesce(p_after, '')
     order by x.path
     limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;

create or replace function public.export_messages(p_vault uuid, p_export uuid, p_thread uuid,
                                                  p_after bigint default 0, p_limit int default 500)
returns table (id bigint, author uuid, agent text, at timestamptz, body text,
               redacted_at timestamptz, redacted_by uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_started boolean;
  v_last bigint;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners export a vault' using errcode = '42501';
  end if;
  select true, e.last_message_id into v_started, v_last from private.vault_exports e
   where e.id = p_export and e.vault_id = p_vault and e.started_by = private.uid()
     and e.started_at > now() - interval '2 hours';
  if v_started is null then
    raise exception 'this export has expired or was never started: start it again' using errcode = '55000';
  end if;
  return query
    select m.id, m.author, m.agent, m.at, convert_from(m.body, 'UTF8'), m.redacted_at, m.redacted_by
      from public.thread_messages m
     where m.vault_id = p_vault and m.thread_id = p_thread
       and m.id <= v_last and m.id > coalesce(p_after, 0)
     order by m.id
     limit least(greatest(coalesce(p_limit, 500), 1), 500);
end $$;

create or replace function public.read_thread(p_thread uuid, p_after bigint default null, p_limit int default 100)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_thread jsonb;
  v_messages jsonb;
  v_n int;
begin
  select to_jsonb(s) into v_thread from public.thread_summaries s where s.id = p_thread;
  if v_thread is null then
    raise exception 'no such thread' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'author', m.author, 'agent', m.agent, 'at', m.at,
           'body', convert_from(m.body, 'UTF8'), 'redacted_at', m.redacted_at, 'redacted_by', m.redacted_by) order by m.id)
           filter (where m.n <= v_limit), '[]'::jsonb),
         count(*)
    into v_messages, v_n
    from (select x.*, row_number() over (order by x.id) as n
            from public.thread_messages x
           where x.vault_id = (v_thread ->> 'vault_id')::uuid and x.thread_id = p_thread
             and x.id > coalesce(p_after, 0)
           order by x.id
           limit v_limit + 1) m;
  return jsonb_build_object('thread', v_thread, 'messages', v_messages, 'more', v_n > v_limit);
end $$;

create or replace function public.search(p_vault uuid, p_query text, p_limit int default 20,
                                         p_embedding extensions.vector default null,
                                         p_min_similarity real default 0.78)
returns table (path text, policy text, body text, updated_at timestamptz,
               author uuid, agent text, rank real, line int)
language plpgsql stable security invoker set search_path = ''
set hnsw.iterative_scan = relaxed_order
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
    select f.path, convert_from(v.body, 'UTF8') as body, f.updated_at, v.author, v.agent, b.rank, b.line, b.word_pos
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
end $$;
