-- Hostile tests for deleting files: delete_file on open files and delete
-- proposals on canon ones. Ana owner, Ben editor, Cal viewer, Dee outsider.
-- Added by the regression-testing pass: delete had no positive test.

insert into t.ids select 'v1', t.run('ana', $q$select public.create_vault('Team', 'open')$q$)::uuid;
select test_support.add_member(t.id('v1'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('v1'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('v1')));
select t.run('ben', format($q$select public.write_file(%L, 'notes/a.md', 'A')$q$, t.id('v1')));
select t.run('ben', format($q$select public.write_file(%L, 'notes/b.md', 'B')$q$, t.id('v1')));
insert into t.ids select 'p1', t.run('ana', format($q$select public.propose(%L, 'canon/c.md', 'C', 'seed')$q$, t.id('v1')))::uuid;
select t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p1')));

create function t.live(p_path text) returns text language sql as $$
  select count(*)::text from public.files where vault_id = t.id('v1') and path = p_path and deleted_at is null
$$;

-- Who may delete

select t.expect('delete: a viewer cannot delete',
  t.run('cal', format($q$select 'ok' from public.delete_file(%L, 'notes/a.md')$q$, t.id('v1'))), 'ERR 42501');
select t.expect('delete: an outsider cannot delete',
  t.run('dee', format($q$select 'ok' from public.delete_file(%L, 'notes/a.md')$q$, t.id('v1'))), 'ERR 42501');
select t.expect('delete: anonymous cannot delete',
  t.run(null, format($q$select 'ok' from public.delete_file(%L, 'notes/a.md')$q$, t.id('v1'))), 'ERR 42501');
select t.expect('delete: a canon file cannot be deleted directly, even by the owner',
  t.run('ana', format($q$select 'ok' from public.delete_file(%L, 'canon/c.md')$q$, t.id('v1'))), 'ERR 42501');
select t.expect('delete: nothing was deleted by the refused calls',
  t.live('notes/a.md') || t.live('canon/c.md'), '11');

-- Open files

select t.expect('delete: an editor deletes an open file',
  t.run('ben', format($q$select 'ok' from public.delete_file(%L, 'notes/a.md')$q$, t.id('v1'))), 'ok');
select t.expect('delete: the file is gone from the vault',
  t.live('notes/a.md'), '0');
select t.expect('delete: its versions are kept (delete is not erase)',
  (select count(*)::text from public.file_versions v join public.files f on f.id = v.file_id
   where f.vault_id = t.id('v1') and f.path = 'notes/a.md' and v.body = 'A'), '1');
select t.expect('delete: deleting it again says there is no such file',
  t.run('ben', format($q$select 'ok' from public.delete_file(%L, 'notes/a.md')$q$, t.id('v1'))), 'ERR P0002');
select t.expect('delete: an editor''s agent deletes',
  t.run('ben', format($q$select 'ok' from public.delete_file(%L, 'notes/b.md')$q$, t.id('v1')), 'Claude Code'), 'ok');
select t.expect('delete: the agent is attributed in the log',
  (select actor::text || ' ' || agent from public.log where path = 'notes/b.md' and event = 'file.delete'),
  t.id('ben')::text || ' Claude Code');
select t.expect('delete: writing the path again brings the file back',
  t.run('ben', format($q$select 'ok' from public.write_file(%L, 'notes/a.md', 'A2')$q$, t.id('v1')))
  || t.live('notes/a.md'), 'ok1');

-- Canon files go through a proposal

insert into t.ids select 'p2', t.run('ben',
  format($q$select public.propose(%L, 'canon/c.md', null, 'retire it', true)$q$, t.id('v1')), 'Claude Code')::uuid;
select t.expect('delete proposal: the file stays until someone approves',
  t.live('canon/c.md'), '1');
select t.expect('delete proposal: the agent cannot approve its own delete',
  t.run('ben', format($q$select public.decide(%L, 'approve')$q$, t.id('p2')), 'Claude Code'), 'ERR 42501');
select t.expect('delete proposal: a person approves and it applies',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p2'))), 'applied');
select t.expect('delete proposal: the canon file is gone',
  t.live('canon/c.md'), '0');
