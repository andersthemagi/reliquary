-- Hostile tests for the content backfill and rotation
-- (20261022100000_seal_content.sql): only the operator's role reads or
-- seals stored content, the swap changes the body and nothing else, and the
-- append-only tables still refuse any other change. A "sealed" body here is
-- an envelope around a marker (the marker byte, a key id, a nonce), not
-- real ciphertext: SQL never holds the key.

create function t.sealed(p_key text, p_tag text) returns bytea language sql as $$
  select '\x00'::bytea || set_byte('\x00'::bytea, 0, length(p_key)) || convert_to(p_key, 'UTF8')
         || decode(repeat('ab', 12), 'hex') || convert_to('SEALED-' || p_tag, 'UTF8')
$$;
create function t.item(p_ref text, p_vault text, p_old bytea, p_new bytea) returns jsonb language sql as $$
  select jsonb_build_object('ref', p_ref, 'vault', t.id(p_vault), 'old', encode(sha256(p_old), 'hex'),
    'body', encode(p_new, 'base64'))
$$;
create function t.seal_sql(p_content text, p_items jsonb) returns text language sql as
$$ select format($q$select private.seal_content(%L, %L::jsonb)$q$, p_content, jsonb_build_array(p_items)) $$;
create function t.version(p_vault text, p_path text) returns public.file_versions language sql as $$
  select v.* from public.file_versions v join public.files f on f.current_version_id = v.id
   where f.vault_id = t.id(p_vault) and f.path = p_path
$$;

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team', 'canon')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
insert into t.ids select 'priv', t.run('dee', $q$select public.create_vault('Private')$q$)::uuid;
select t.run('ana', format($q$select public.write_file(%L, 'notes/a.md', 'plain text a')$q$, t.id('side')));
select t.run('dee', format($q$select public.write_file(%L, 'mine.md', 'plain text dee')$q$, t.id('priv')));
insert into t.ids select 'prop', t.run('ana', format($q$select public.propose(%L, 'canon.md', convert_to('proposed', 'UTF8'), 'why')$q$, t.id('team')))::uuid;
insert into t.ids select 'note', t.run('ana', format($q$select public.comment_on_proposal(%L, convert_to('a comment', 'UTF8'))$q$, t.id('prop')))::uuid;
insert into t.ids select 'thread', t.run('ana', format($q$select public.open_thread(%L, 'Topic', convert_to('first message', 'UTF8'), 13, null, null, null, null)$q$, t.id('team')))::uuid;

-- ---------------------------------------------------------------------------
-- Who may run it

select t.expect('operator: only reliquary_ops counts, reads or seals stored content; people, agents, anonymous, the MCP role and the web app''s role are refused',
  t.run('ana', 'select count(*) from private.content_key_ids()')
  || ',' || t.run('ana', $q$select count(*) from private.content_to_seal('file_versions', 'c1', '', 10)$q$)
  || ',' || t.run('ana', t.seal_sql('file_versions', '{}'))
  || ',' || t.run('ana', $q$select count(*) from private.content_to_seal('file_versions', 'c1', '', 10)$q$, 'Claude')
  || ',' || t.run(null, 'select count(*) from private.content_key_ids()')
  || ',' || t.run_role('reliquary_mcp', 'select count(*) from private.content_key_ids()')
  || ',' || t.run_role('reliquary_mcp', $q$select count(*) from private.content_to_seal('file_versions', 'c1', '', 10)$q$)
  || ',' || t.run_role('reliquary_mcp', t.seal_sql('file_versions', '{}'))
  || ',' || t.run_role('reliquary_web', 'select count(*) from private.content_key_ids()')
  || ',' || t.run_role('reliquary_web', $q$select count(*) from private.content_to_seal('file_versions', 'c1', '', 10)$q$)
  || ',' || t.run_role('reliquary_web', t.seal_sql('file_versions', '{}')),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501');

select t.expect('operator: no role that serves requests can mark its own transaction as sealing',
  t.run_role('reliquary_web', $q$insert into private.content_sealings values (txid_current()) returning 1$q$)
  || ',' || t.run_role('reliquary_mcp', $q$insert into private.content_sealings values (txid_current()) returning 1$q$)
  || ',' || t.run('ana', $q$insert into private.content_sealings values (txid_current()) returning 1$q$),
  'ERR 42501,ERR 42501,ERR 42501');

-- ---------------------------------------------------------------------------
-- Counting and reading

select t.expect('seal: content_key_ids counts each table''s plain bodies, with no key id',
  t.run_role('reliquary_ops', $q$select string_agg(content || '=' || n, ',' order by content) from private.content_key_ids() where key_id is null$q$),
  'file_versions=2,proposal_notes=1,proposals=1,thread_messages=1');

select t.expect('seal: content_to_seal walks a table in key order after the last ref it gave',
  t.run_role('reliquary_ops', format($q$select count(*) from private.content_to_seal('file_versions', 'c1', %L, 10)$q$,
    (select id::text from public.file_versions order by id limit 1))),
  '1');

-- ---------------------------------------------------------------------------
-- The swap

create table t.before as select * from t.version('side', 'notes/a.md');
create table t.log_before as select count(*) as n from public.log where vault_id = t.id('side');

select t.expect('seal: a plain body is swapped for a sealed one',
  t.run_role('reliquary_ops', t.seal_sql('file_versions',
    t.item((select id::text from t.before), 'side', (select body from t.before), t.sealed('c1', 'a')))),
  '1');
select t.expect('seal: ...and nothing else about the version changes, and the log is untouched',
  (select (to_jsonb(v) - 'body')::text from t.version('side', 'notes/a.md') v)
  || ' ' || (select private.content_key_id(body) from t.version('side', 'notes/a.md'))
  || ' ' || (select count(*) from public.log where vault_id = t.id('side')),
  (select (to_jsonb(b) - 'body')::text from t.before b) || ' c1 ' || (select n from t.log_before));

select t.expect('seal: a row whose body changed since it was read is left alone',
  t.run_role('reliquary_ops', t.seal_sql('file_versions',
    t.item((select id::text from t.before), 'side', (select body from t.before), t.sealed('c2', 'a')))),
  '0');
select t.expect('seal: a row named with another vault is left alone',
  t.run_role('reliquary_ops', t.seal_sql('file_versions',
    t.item((select id::text from t.version('priv', 'mine.md')), 'team', (select body from t.version('priv', 'mine.md')), t.sealed('c1', 'x')))),
  '0');
select t.expect('seal: only a sealed body can replace a stored one',
  t.run_role('reliquary_ops', t.seal_sql('file_versions',
    t.item((select id::text from t.version('priv', 'mine.md')), 'priv', (select body from t.version('priv', 'mine.md')), convert_to('other plain', 'UTF8')))),
  'ERR 22023');

select t.expect('seal: a note, a thread message and a proposal are swapped the same way',
  t.run_role('reliquary_ops', t.seal_sql('proposal_notes',
    t.item(t.id('note')::text, 'team', convert_to('a comment', 'UTF8'), t.sealed('c1', 'note'))))
  || ',' || t.run_role('reliquary_ops', t.seal_sql('thread_messages',
    t.item((select id::text from public.thread_messages where thread_id = t.id('thread')), 'team', convert_to('first message', 'UTF8'), t.sealed('c1', 'msg'))))
  || ',' || t.run_role('reliquary_ops', t.seal_sql('proposals',
    t.item(t.id('prop')::text, 'team', convert_to('proposed', 'UTF8'), t.sealed('c1', 'prop')))),
  '1,1,1');

-- The marker is the swap's own: outside it the tables refuse as before.
select t.owner_error('seal: outside the operator''s swap, a version''s body still can''t be replaced, even by a sealed one',
  format($q$update public.file_versions set body = %L where id = %L$q$, t.sealed('c1', 'b'), (select id from t.version('priv', 'mine.md'))));
select t.owner_error('seal: outside the operator''s swap, a note''s body still can''t be replaced',
  format($q$update public.proposal_notes set body = %L where id = %L$q$, t.sealed('c1', 'b'), t.id('note')));
select t.owner_error('seal: outside the operator''s swap, a thread message''s body still can''t be replaced',
  format($q$update public.thread_messages set body = %L where thread_id = %L$q$, t.sealed('c1', 'b'), t.id('thread')));

-- A vault at its storage limit: the envelope's bytes would take it over.
update private.vault_storage set bytes = (private.vault_limits(t.id('priv'))).max_bytes where vault_id = t.id('priv');
select t.expect('seal: a vault at its storage limit is still sealed',
  t.run_role('reliquary_ops', t.seal_sql('file_versions',
    t.item((select id::text from t.version('priv', 'mine.md')), 'priv', (select body from t.version('priv', 'mine.md')), t.sealed('c1', 'dee')))),
  '1');

select t.expect('seal: afterwards nothing is plain and every body names c1',
  t.run_role('reliquary_ops', $q$select string_agg(content || '=' || coalesce(key_id, 'plain') || ':' || n, ',' order by content) from private.content_key_ids()$q$),
  'file_versions=c1:2,proposal_notes=c1:1,proposals=c1:1,thread_messages=c1:1');
