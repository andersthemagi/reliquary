-- Hostile tests for threads in a vault's export
-- (20261013150000_export_threads.sql). Ana owns Main (Ben edits, Cal views)
-- and Other; Dee is an outsider. Exporting stays an owner's, in person: the
-- rest of that rule is vault_admin_test.sql's and membership_polish_test.sql's.

create table t.vals (name text primary key, val text);
create function t.save(p_name text, p_val text) returns text language sql as $$
  insert into t.vals values (p_name, p_val) on conflict (name) do update set val = excluded.val returning val
$$;
create function t.val(p_name text) returns text language sql as $$ select val from t.vals where name = p_name $$;

insert into t.ids select 'v1', t.run('ana', $q$select public.create_vault('Main')$q$)::uuid;
insert into t.ids select 'v2', t.run('ana', $q$select public.create_vault('Other')$q$)::uuid;
select test_support.add_member(t.id('v1'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('v1'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.create_access_token('ana-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('v1')));

select t.run('ben', format($q$select public.write_file(%L, 'plans/launch.md', 'plan')::text$q$, t.id('v1')));
select t.run('ben', format($q$select public.register_work_plan(%L, 'plans/launch.md', %L, '[{"key":"copy","title":"Write the copy"}]')::text$q$,
  t.id('v1'), (select current_version_id from public.files where vault_id = t.id('v1') and path = 'plans/launch.md')));

-- Launch plan: vault-wide, about a file, opened by Ben's agent.
insert into t.ids select 'wide', t.run('ben', format($q$select public.open_thread(%L, 'Launch plan', 'Who takes the copy?',
  p_anchor_path => 'notes/a.md')::text$q$, t.id('v1')), 'Hermes')::uuid;
select t.save('m2', t.run('ana', format($q$select public.post_message(%L, 'I will.')::text$q$, t.id('wide'))));
select t.save('secret', t.run('ben', format($q$select public.post_message(%L, 'Door code: 4417-pelican')::text$q$, t.id('wide')), 'Hermes'));
select t.run('ana', format($q$select public.redact_message(%s)::text$q$, t.val('secret')));
select t.save('m4', t.run('ana', format($q$select public.post_message(%L, 'Thanks.')::text$q$, t.id('wide'))));
-- For Cal: a side thread about a task, resolved.
insert into t.ids select 'side', t.run('ana', format($q$select public.open_thread(%L, 'For Cal', 'Cal, see the copy step',
  array[%L]::uuid[], p_anchor_step => %s)::text$q$, t.id('v1'), t.id('cal'),
  (select s.id from public.work_plan_steps s where s.vault_id = t.id('v1') and s.key = 'copy')))::uuid;
select t.run('ana', format($q$select public.resolve_thread(%L)::text$q$, t.id('side')));
-- Another vault's thread.
insert into t.ids select 'far', t.run('ana', format($q$select public.open_thread(%L, 'Elsewhere', 'Not for Main')::text$q$, t.id('v2')))::uuid;

select t.save('h', t.run('ana', format($q$select public.export_vault(%L)::text$q$, t.id('v1'))));
select t.save('h2', t.run('ana', format($q$select public.export_vault(%L)::text$q$, t.id('v2'))));
select t.save('x', t.val('h')::jsonb ->> 'export');

-- What the export sees, as SQL: export_messages for a thread.
create function t.msgs_sql(p_thread text, p_export text default null, p_vault text default 'v1') returns text language sql as $$
  select format($q$select coalesce(string_agg(coalesce(body, '<redacted>'), ' | ' order by id), '') from public.export_messages(%L, %L, %L)$q$,
    t.id(p_vault), coalesce(p_export, t.val('x')), t.id(p_thread))
$$;

-- The header ----------------------------------------------------------------

select t.expect('export threads: the header lists the vault''s threads in the order they opened, never another vault''s',
  (select string_agg(x ->> 'title', ', ') from jsonb_array_elements(t.val('h')::jsonb -> 'threads') x),
  'Launch plan, For Cal');
select t.expect('export threads: a vault-wide thread says so, what it is about, who opened it and that it is open',
  (select format('%s %s %s %s %s %s %s', x ->> 'scope', x -> 'addressees', x -> 'anchor', x ->> 'opened_by' = t.id('ben')::text,
     x ->> 'agent', x -> 'resolved_at', x ->> 'messages')
     from jsonb_array_elements(t.val('h')::jsonb -> 'threads') x where x ->> 'id' = t.id('wide')::text),
  'vault [] {"kind": "path", "path": "notes/a.md"} t Hermes null 4');
select t.expect('export threads: a side thread names its addressees, a task anchor reads as its plan''s path and step key, and a resolved thread says who resolved it',
  (select format('%s %s %s %s %s', x ->> 'scope', x -> 'addressees' = jsonb_build_array(t.id('cal')), x -> 'anchor',
     x ->> 'resolved_by' = t.id('ana')::text, x ->> 'resolved_at' is not null)
     from jsonb_array_elements(t.val('h')::jsonb -> 'threads') x where x ->> 'id' = t.id('side')::text),
  'side t {"kind": "task", "step_key": "copy", "plan_path": "plans/launch.md"} t t');
select t.expect('export threads: the header names everyone its threads name, and holds no message''s text',
  (t.val('h')::jsonb -> 'people' = jsonb_build_array(t.id('ana'), t.id('ben'), t.id('cal')))::text
  || ' ' || (t.val('h') like '%Door code%' or t.val('h') like '%I will%' or t.val('h') like '%Not for Main%')::text,
  'true false');

-- Messages ------------------------------------------------------------------

select t.expect('export threads: a thread''s messages come in order, with author, agent and time',
  t.run('ana', format($q$select string_agg(format('%%s/%%s/%%s', author = %L, coalesce(agent, '-'), at is not null), ' ' order by id)
    from public.export_messages(%L, %L, %L)$q$, t.id('ben'), t.id('v1'), t.val('x'), t.id('wide'))),
  't/Hermes/t f/-/t t/Hermes/t f/-/t');
select t.expect('export threads: a redacted message keeps its place, author, agent and time, with no body, saying who redacted it',
  t.run('ana', format($q$select format('%%s %%s %%s %%s', body is null, author = %L, agent, redacted_by = %L)
    from public.export_messages(%L, %L, %L) where id = %s$q$, t.id('ben'), t.id('ana'), t.id('v1'), t.val('x'), t.id('wide'), t.val('secret'))),
  't t Hermes t');
select t.expect('export threads: no redacted text comes back',
  t.run('ana', t.msgs_sql('wide')), 'Who takes the copy? | I will. | <redacted> | Thanks.');
select t.expect('export threads: messages page after an id, with a limit',
  t.run('ana', format($q$select string_agg(coalesce(body, '<redacted>'), ' | ' order by id) from public.export_messages(%L, %L, %L, %s, 1)$q$,
    t.id('v1'), t.val('x'), t.id('wide'), t.val('m2'))),
  '<redacted>');
select t.expect('export threads: another vault''s thread has no messages through this export',
  t.run('ana', t.msgs_sql('far')), '');

-- One moment: what changes after the export started ---------------------------

select t.run('ana', format($q$select public.post_message(%L, 'Posted after the export began')::text$q$, t.id('wide')));
select t.run('ana', format($q$select public.redact_message(%s)::text$q$, t.val('m4')));
select t.expect('export threads: a message posted after the export started is left out, and a redaction made meanwhile wins',
  t.run('ana', t.msgs_sql('wide')), 'Who takes the copy? | I will. | <redacted> | <redacted>');

-- Who may read an export's messages -------------------------------------------

select t.expect('export threads: an editor can''t read an export''s messages',
  t.run('ben', t.msgs_sql('wide')), 'ERR 42501');
select t.expect('export threads: nor a viewer',
  t.run('cal', t.msgs_sql('wide')), 'ERR 42501');
select t.expect('export threads: nor an outsider',
  t.run('dee', t.msgs_sql('wide')), 'ERR 42501');
select t.expect('export threads: nor anonymous',
  t.run(null, t.msgs_sql('wide')), 'ERR 42501');
select t.expect('export threads: nor the owner''s agent',
  t.run('ana', t.msgs_sql('wide'), 'Claude Code'), 'ERR 42501');
select t.expect('export threads: nor the owner''s read-write connection',
  t.run_tok('ana', 'ana-rw', t.msgs_sql('wide')), 'ERR 42501');
select t.expect('export threads: an export of another vault reaches nothing here',
  t.run('ana', t.msgs_sql('wide', t.val('h2')::jsonb ->> 'export')), 'ERR 55000');
select t.expect('export threads: nor does an export that was never started',
  t.run('ana', t.msgs_sql('wide', gen_random_uuid()::text)), 'ERR 55000');
select test_support.add_member(t.id('v1'), t.id('dee'), 'owner', t.id('ana'));
select t.expect('export threads: another owner can''t read an export they didn''t start',
  t.run('dee', t.msgs_sql('wide')), 'ERR 55000');
update private.vault_exports set started_at = now() - interval '3 hours' where id = t.val('x')::uuid;
select t.expect('export threads: nor can its owner, 2 hours on',
  t.run('ana', t.msgs_sql('wide')), 'ERR 55000');
