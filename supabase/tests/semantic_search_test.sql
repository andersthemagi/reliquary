-- Hostile tests for search by meaning (20261017110000_semantic_search.sql):
-- vectors are read exactly as file text is, written only through
-- private.store_embeddings, and follow a file's current version.

-- A unit vector along dimension i, as the servers store one: 384 float4s
-- in network order (float4send), base64 for store_embeddings.
create function t.vec(i int) returns text language sql as $$
  select encode(string_agg(float4send(case when g = i then 1 else 0 end::float4), ''::bytea order by g), 'base64') from generate_series(0, 383) g
$$;
create function t.chunks(i int) returns text language sql as $$
  select jsonb_build_array(jsonb_build_object('chunk', 0, 'line', 1, 'embedding', t.vec(i)))::text
$$;
create function t.file(p_vault text, p_path text) returns uuid language sql as $$
  select id from public.files where vault_id = t.id(p_vault) and path = p_path
$$;
create function t.cur(p_vault text, p_path text) returns uuid language sql as $$
  select current_version_id from public.files where vault_id = t.id(p_vault) and path = p_path
$$;
-- Stores dimension i as the file's only chunk, as p_user.
create function t.store(p_user text, p_vault text, p_path text, i int) returns text language sql as $$
  select t.run(p_user, format($q$select private.store_embeddings(%L, %L, %L::jsonb)$q$,
    t.file(p_vault, p_path), t.cur(p_vault, p_path), t.chunks(i)))
$$;

insert into t.ids select 'v1', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
select test_support.add_member(t.id('v1'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.write_file(%L, 'decisions/pricing.md', 'Seats and plans: priced per seat.')$q$, t.id('v1')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/garden.md', 'Tomatoes need sun.')$q$, t.id('v1')));
insert into t.ids select 'v2', t.run('dee', $q$select public.create_vault('Private')$q$)::uuid;
select t.run('dee', format($q$select public.write_file(%L, 'dee/pricing.md', 'Dee''s own seats and plans.')$q$, t.id('v2')));

-- Queue

select t.expect('queue: a write queues the file at its current version',
  (select version_id::text from private.embedding_queue where file_id = t.file('v1', 'decisions/pricing.md')),
  t.cur('v1', 'decisions/pricing.md')::text);
select t.expect('queue: a member gets the vault''s queued files with their text',
  t.run('cal', format($q$select string_agg(body, '|' order by body) from private.embedding_pending(%L, 8)$q$, t.id('v1'))),
  'Seats and plans: priced per seat.|Tomatoes need sun.');
select t.expect('queue: an outsider gets nothing queued in another vault',
  t.run('dee', format($q$select count(*) from private.embedding_pending(%L, 8)$q$, t.id('v1'))), '0');
select t.expect('queue: anonymous can''t ask',
  t.run(null, format($q$select count(*) from private.embedding_pending(%L, 8)$q$, t.id('v1'))), 'ERR 42501');
select t.expect('queue: nobody reads the queue table',
  t.run('ana', $q$select count(*) from private.embedding_queue$q$), 'ERR 42501');

-- Storing

select t.expect('store: an outsider stores nothing for another vault''s file',
  t.store('dee', 'v1', 'decisions/pricing.md', 1), '0');
select t.expect_true('store: ...and nothing is there',
  not exists (select 1 from public.file_embeddings where file_id = t.file('v1', 'decisions/pricing.md')));
select t.expect('store: a reader stores the vectors of a file they can read', t.store('cal', 'v1', 'decisions/pricing.md', 1), '1');
select t.expect('store: a vector is kept as the bytes given, 384 float4s',
  (select octet_length(embedding)::text || ' ' || encode(substring(embedding from 5 for 4), 'hex') from public.file_embeddings where file_id = t.file('v1', 'decisions/pricing.md')),
  '1536 3f800000');
select t.expect('store: stored, the file leaves the queue',
  (select count(*)::text from private.embedding_queue where file_id = t.file('v1', 'decisions/pricing.md')), '0');
select t.store('ana', 'v1', 'notes/garden.md', 2);
select t.store('dee', 'v2', 'dee/pricing.md', 1);
select t.expect('store: a version that isn''t current stores nothing',
  t.run('ana', format($q$select private.store_embeddings(%L, gen_random_uuid(), %L::jsonb)$q$,
    t.file('v1', 'notes/garden.md'), t.chunks(3))), '0');
select t.expect('store: more than 8 chunks are refused',
  t.run('ana', format($q$select private.store_embeddings(%L, %L, (select jsonb_agg(c) from jsonb_array_elements(%L::jsonb) c, generate_series(1, 9)))$q$,
    t.file('v1', 'notes/garden.md'), t.cur('v1', 'notes/garden.md'), t.chunks(2))), 'ERR 22023');
select t.run('ana', format($q$select public.write_file(%L, 'notes/blank.md', E'\n  \n')$q$, t.id('v1')));
select t.expect('store: no chunks (a file with no text to embed) takes the file off the queue',
  t.run('ana', format($q$select private.store_embeddings(%L, %L, '[]')$q$, t.file('v1', 'notes/blank.md'), t.cur('v1', 'notes/blank.md')))
  || '/' || t.run('ana', format($q$select count(*) from private.embedding_pending(%L, 50)$q$, t.id('v1'))), '0/0');

-- Reading vectors

select t.expect('read: a member reads the vault''s vectors',
  t.run('cal', format($q$select count(*) from public.file_embeddings where vault_id = %L$q$, t.id('v1'))), '2');
select t.expect('read: an outsider reads no vector of another vault',
  t.run('dee', format($q$select count(*) from public.file_embeddings where vault_id = %L$q$, t.id('v1'))), '0');
select t.expect('read: an outsider''s agent reads none either',
  t.run('dee', format($q$select count(*) from public.file_embeddings where vault_id = %L$q$, t.id('v1')), 'Claude Code'), '0');
select t.expect('read: anonymous reads none',
  t.run(null, $q$select count(*) from public.file_embeddings$q$), 'ERR 42501');
select t.expect('write: an owner can''t insert a vector directly',
  t.run('ana', format($q$insert into public.file_embeddings select file_id, version_id, vault_id, 5, 1, embedding from public.file_embeddings where vault_id = %L limit 1 returning 'x'$q$, t.id('v1'))),
  'ERR 42501');
select t.expect('write: an owner can''t change a vector directly',
  t.run('ana', $q$update public.file_embeddings set line = 2 returning 'x'$q$), 'ERR 42501');
select t.expect('write: an owner can''t delete a vector directly',
  t.run('ana', $q$delete from public.file_embeddings returning 'x'$q$), 'ERR 42501');

-- Searching by meaning is the servers' (web/test/search_unit.test.mjs,
-- mcp/test/semantic_search.test.mjs): SQL gives a reader the vectors above.

-- Following the file

select t.run('ana', format($q$select public.write_file(%L, 'notes/garden.md', 'Peppers need sun too.')$q$, t.id('v1')));
select t.expect('lifecycle: a new version removes the old version''s vectors',
  (select count(*)::text from public.file_embeddings where file_id = t.file('v1', 'notes/garden.md')), '0');
select t.expect('lifecycle: ...and queues the new one',
  (select version_id::text from private.embedding_queue where file_id = t.file('v1', 'notes/garden.md')),
  t.cur('v1', 'notes/garden.md')::text);

select t.run('ana', format($q$select 'ok' from public.delete_file(%L, 'decisions/pricing.md')$q$, t.id('v1')));
select t.expect('lifecycle: a deleted file has no vectors and isn''t queued',
  (select count(*)::text from public.file_embeddings e full join private.embedding_queue q using (file_id)
    where coalesce(e.file_id, q.file_id) = t.file('v1', 'decisions/pricing.md')), '0');

select t.store('ana', 'v1', 'notes/garden.md', 2);
select t.run('ana', format($q$select public.erase_file(%L, 'notes/garden.md')$q$, t.id('v1')));
select t.expect('lifecycle: erased text leaves no vector and nothing queued',
  (select count(*)::text from public.file_embeddings e full join private.embedding_queue q using (file_id)
    where coalesce(e.file_id, q.file_id) = t.file('v1', 'notes/garden.md')), '0');

select t.run('dee', format($q$select public.delete_vault(%L, 'Private')::text$q$, t.id('v2')));
select t.expect('lifecycle: deleting a vault leaves none of its vectors or queue',
  (select count(*)::text from public.file_embeddings e full join private.embedding_queue q using (file_id)
    where coalesce(e.vault_id, q.vault_id) = t.id('v2')), '0');
