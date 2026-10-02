-- Hostile tests for threads inside a vault (20261004100000_threads and the
-- migrations after it). Not proposal threads: those are threads_test.sql.
-- Ana owner, Ben editor, Cal viewer, Dee outsider with a vault of her own.

insert into t.ids select 'v1', t.run('ana', $q$select public.create_vault('Threads')$q$)::uuid;
select test_support.add_member(t.id('v1'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('v1'), t.id('cal'), 'viewer', t.id('ana'));
insert into t.ids select 'v2', t.run('dee', $q$select public.create_vault('Elsewhere')$q$)::uuid;
select test_support.add_member(t.id('v2'), t.id('ana'), 'editor', t.id('dee'));

select t.run('ana', format($q$select public.create_access_token('ana-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('v1')));
select t.run('ana', format($q$select public.create_access_token('ana-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('v1')));
select t.run('ana', format($q$select public.create_access_token('ana-v2', 30, array[%L]::uuid[], 'write')$q$, t.id('v2')));
select t.run('ben', format($q$select public.create_access_token('ben-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('v1')));
select t.run('cal', format($q$select public.create_access_token('cal-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('v1')));

create function t.tok(p_name text) returns uuid language sql as $$ select id from public.access_tokens where name = p_name $$;
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;

-- Seeded as the table owner: a vault-wide thread, and a side thread
-- addressed to Ben only. The functions that open threads come later.
insert into t.ids values ('wide', gen_random_uuid()), ('side', gen_random_uuid()), ('far', gen_random_uuid());
insert into public.threads (id, vault_id, title, opened_by) values
  (t.id('wide'), t.id('v1'), 'Launch plan', t.id('ana')),
  (t.id('side'), t.id('v1'), 'For Ben', t.id('ana')),
  (t.id('far'), t.id('v2'), 'Dee''s own', t.id('dee'));
insert into public.thread_addressees (vault_id, thread_id, user_id) values (t.id('v1'), t.id('side'), t.id('ben'));
insert into public.thread_messages (thread_id, vault_id, author, body) values
  (t.id('wide'), t.id('v1'), t.id('ana'), 'Who takes the copy?'),
  (t.id('side'), t.id('v1'), t.id('ana'), 'Ben, the invoice is late'),
  (t.id('far'), t.id('v2'), t.id('dee'), 'Not for vault one');
create function t.msg(p_thread text) returns bigint language sql as $$
  select min(id) from public.thread_messages where thread_id = t.id(p_thread)
$$;

-- Never private: every member reads every thread -------------------------

select t.expect('read: a viewer who isn''t addressed reads the side thread and its message',
  t.run('cal', format($q$select count(*) || ' ' || max(m.body) from public.threads th
    join public.thread_messages m on m.thread_id = th.id where th.id = %L$q$, t.id('side'))),
  '1 Ben, the invoice is late');
select t.expect('read: so does the owner who isn''t addressed, through a read-only connection',
  t.run_tok('ana', 'ana-ro', format($q$select count(*) from public.thread_messages where thread_id = %L$q$, t.id('side'))),
  '1');
select t.expect('read: and anyone''s agent sees who a side thread is addressed to',
  t.run('cal', format($q$select user_id::text from public.thread_addressees where thread_id = %L$q$, t.id('side')), 'Hermes'),
  t.id('ben')::text);
select t.expect('read: every member sees every thread in the vault',
  t.run('ana', $q$select count(*) from public.threads$q$) || ' ' ||
  t.run('ben', format($q$select count(*) from public.threads where vault_id = %L$q$, t.id('v1'))) || ' ' ||
  t.run('cal', $q$select count(*) from public.threads$q$),
  '3 2 2');

select t.expect('outsider: sees no thread, message or addressee of a vault they''re not in',
  t.run('dee', format($q$select (select count(*) from public.threads where vault_id = %1$L) || ' '
    || (select count(*) from public.thread_messages where vault_id = %1$L) || ' '
    || (select count(*) from public.thread_addressees where vault_id = %1$L)$q$, t.id('v1'))),
  '0 0 0');
select t.expect('outsider: a connection scoped to another vault sees nothing of this one',
  t.run_tok('ana', 'ana-v2', format($q$select (select count(*) from public.threads where vault_id = %1$L) || ' '
    || (select count(*) from public.thread_messages where vault_id = %1$L)$q$, t.id('v1'))),
  '0 0');
select t.expect('outsider: a connection scoped to this vault sees nothing of another the person is in',
  t.run_tok('ana', 'ana-rw', format($q$select count(*) from public.thread_messages where vault_id = %L$q$, t.id('v2'))),
  '0');
select t.expect('outsider: anonymous can''t read threads at all',
  t.run(null, $q$select count(*) from public.threads$q$), 'ERR 42501');
select t.expect('outsider: anonymous can''t read messages at all',
  t.run(null, $q$select count(*) from public.thread_messages$q$), 'ERR 42501');

-- Nothing crosses vaults ----------------------------------------------------

select t.owner_error('cross-vault: a message can''t sit in a thread of another vault',
  format($q$insert into public.thread_messages (thread_id, vault_id, author, body) values ('%s', '%s', '%s', 'x')$q$,
    t.id('far'), t.id('v1'), t.id('ana')));
select t.owner_error('cross-vault: nor an addressee',
  format($q$insert into public.thread_addressees (vault_id, thread_id, user_id) values ('%s', '%s', '%s')$q$,
    t.id('v1'), t.id('far'), t.id('cal')));
insert into t.ids select 'dp', t.run('dee', format($q$select public.propose(%L, 'x.md', 'Dee''s', 'mine')$q$, t.id('v2')))::uuid;
select t.owner_error('cross-vault: a thread can''t anchor to another vault''s proposal',
  format($q$insert into public.threads (vault_id, title, opened_by, anchor_proposal) values ('%s', 'x', '%s', '%s')$q$,
    t.id('v1'), t.id('ana'), t.id('dp')));
select t.owner_error('cross-vault: a thread anchors to one thing at most',
  format($q$insert into public.threads (vault_id, title, opened_by, anchor_path, anchor_proposal) values ('%s', 'x', '%s', 'a.md', '%s')$q$,
    t.id('v2'), t.id('dee'), t.id('dp')));

-- Append-only ---------------------------------------------------------------

select t.expect('append-only: nobody signed in writes a thread directly, not even the owner',
  t.run('ana', format($q$insert into public.threads (vault_id, title, opened_by) values (%L, 'x', %L) returning 'x'$q$,
    t.id('v1'), t.id('ana'))), 'ERR 42501');
select t.expect('append-only: nor a message',
  t.run('ana', format($q$insert into public.thread_messages (thread_id, vault_id, author, body) values (%L, %L, %L, 'x') returning 'x'$q$,
    t.id('wide'), t.id('v1'), t.id('ana'))), 'ERR 42501');
select t.expect('append-only: the owner can''t rewrite a message',
  t.run('ana', format($q$update public.thread_messages set body = 'rewritten' where id = %s returning 'x'$q$, t.msg('wide'))), 'ERR 42501');
select t.expect('append-only: nor delete one',
  t.run('ana', format($q$delete from public.thread_messages where id = %s returning 'x'$q$, t.msg('wide'))), 'ERR 42501');
select t.expect('append-only: nor an addressee',
  t.run('ana', format($q$delete from public.thread_addressees where thread_id = %L returning 'x'$q$, t.id('side'))), 'ERR 42501');
select t.expect('append-only: nor a thread',
  t.run('ana', format($q$delete from public.threads where id = %L returning 'x'$q$, t.id('wide'))), 'ERR 42501');
select t.owner_error('append-only: not even the table owner rewrites a message',
  format($q$update public.thread_messages set body = 'rewritten' where id = %s$q$, t.msg('wide')));
select t.owner_error('append-only: nor deletes one',
  format($q$delete from public.thread_messages where id = %s$q$, t.msg('wide')));
select t.owner_error('append-only: nor changes who wrote one',
  format($q$update public.thread_messages set author = '%s' where id = %s$q$, t.id('ben'), t.msg('wide')));
select t.owner_error('append-only: nor blanks one without saying who and when',
  format($q$update public.thread_messages set body = null where id = %s$q$, t.msg('wide')));
select t.owner_error('append-only: nor truncates messages',
  $q$truncate public.thread_messages cascade$q$);
select t.owner_error('append-only: nor deletes a thread',
  format($q$delete from public.threads where id = '%s'$q$, t.id('wide')));
select t.owner_error('append-only: nor renames one',
  format($q$update public.threads set title = 'Renamed' where id = '%s'$q$, t.id('wide')));
select t.owner_error('append-only: nor moves one to another anchor',
  format($q$update public.threads set anchor_path = 'elsewhere.md' where id = '%s'$q$, t.id('wide')));
select t.owner_error('append-only: nor readdresses one',
  format($q$update public.thread_addressees set user_id = '%s' where thread_id = '%s'$q$, t.id('cal'), t.id('side')));
select t.owner_error('append-only: nor drops an addressee',
  format($q$delete from public.thread_addressees where thread_id = '%s'$q$, t.id('side')));

update public.thread_messages set body = null, redacted_at = now(), redacted_by = t.id('ana') where id = t.msg('side');
select t.expect('append-only: blanking a body once, saying who and when, is the one change a message takes',
  (select (body is null)::text || ' ' || redacted_by::text from public.thread_messages where id = t.msg('side')),
  'true ' || t.id('ana')::text);
select t.owner_error('append-only: a redacted message can''t be restored',
  format($q$update public.thread_messages set body = 'back', redacted_at = null, redacted_by = null where id = %s$q$, t.msg('side')));
select t.owner_error('append-only: nor redacted again by someone else',
  format($q$update public.thread_messages set redacted_at = now(), redacted_by = '%s' where id = %s$q$, t.id('ben'), t.msg('side')));
with resolved as (update public.threads set resolved_at = now(), resolved_by = t.id('ben')
                    where id = t.id('wide') returning 1)
select t.expect('append-only: resolving a thread is the one change a thread takes',
  (select count(*)::text from resolved), '1');

-- Membership doesn't touch the record ---------------------------------------

select t.run('ana', format($q$select public.set_member(%L, %L, null)$q$, t.id('v1'), t.id('ben')));
select t.expect('membership: removing an addressed member works, and the thread stays addressed to them',
  (select count(*)::text from public.vault_members where vault_id = t.id('v1') and user_id = t.id('ben')) || ' ' ||
  (select count(*)::text from public.thread_addressees where thread_id = t.id('side')),
  '0 1');
select t.expect('membership: and once removed, they read none of the vault''s threads',
  t.run('ben', format($q$select count(*) from public.thread_messages where vault_id = %L$q$, t.id('v1'))), '0');
select test_support.add_member(t.id('v1'), t.id('ben'), 'editor', t.id('ana'));

-- Deleting the vault clears its threads -------------------------------------

select t.expect_ok('delete vault: the owner deletes a vault holding threads',
  t.run('ana', format($q$select public.delete_vault(%L, 'Threads')::text$q$, t.id('v1'))));
select t.expect('delete vault: its threads, messages and addressees are gone',
  (select count(*)::text from public.threads where vault_id = t.id('v1')) || ' ' ||
  (select count(*)::text from public.thread_messages where vault_id = t.id('v1')) || ' ' ||
  (select count(*)::text from public.thread_addressees where vault_id = t.id('v1')),
  '0 0 0');
select t.expect('delete vault: another vault''s threads are untouched',
  (select count(*)::text from public.thread_messages where vault_id = t.id('v2')), '1');
