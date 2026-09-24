-- Hostile tests for the core migration. Every access rule gets an attack.
-- Synthetic users only. Run with supabase/tests/run.sh.


-- ---------------------------------------------------------------------------
-- Setup, through the API

insert into t.ids select 'v1', t.run('ana', $q$select public.create_vault('Team', 'open')$q$)::uuid;
insert into t.ids select 'v2', t.run('dee', $q$select public.create_vault('Dee''s', 'open')$q$)::uuid;
select t.run('ana', format($q$select public.set_member(%L, %L, 'editor')$q$, t.id('v1'), t.id('ben')));
select t.run('ana', format($q$select public.set_member(%L, %L, 'viewer')$q$, t.id('v1'), t.id('cal')));

-- Identity

select t.expect('identity: anonymous cannot create a vault',
  t.run(null, $q$select public.create_vault('x')$q$), 'ERR 42501');
select t.expect('identity: an authenticated request with no sub is refused',
  t.run_claims('{"role": "authenticated"}', $q$select public.create_vault('x')$q$), 'ERR 28000');
select t.expect('identity: a malformed sub is refused',
  t.run_claims('{"sub": "not-a-uuid"}', $q$select public.create_vault('x')$q$), 'ERR 22P02');
select t.expect('identity: an agent cannot create a vault',
  t.run('ana', $q$select public.create_vault('x')$q$, 'Claude Code'), 'ERR 42501');

-- Reading

select t.expect('read: outsider sees no trace of the vault',
  t.run('dee', format($q$select count(*) from public.vaults where id = %L$q$, t.id('v1'))), '0');
select t.expect('read: outsider sees none of its log',
  t.run('dee', format($q$select count(*) from public.log where vault_id = %L$q$, t.id('v1'))), '0');
select t.expect('read: outsider feed is empty',
  t.run('dee', format($q$select count(*) from public.changes_since(%L, 0)$q$, t.id('v1'))), '0');
select t.expect('read: viewer sees the vault',
  t.run('cal', format($q$select count(*) from public.vaults where id = %L$q$, t.id('v1'))), '1');

-- Open files

select t.expect_ok('open: editor writes directly',
  t.run('ben', format($q$select public.write_file(%L, 'notes/standup.md', 'Standup at 10')$q$, t.id('v1'))));
select t.expect_ok('open: editor''s agent writes directly',
  t.run('ben', format($q$select public.write_file(%L, 'notes/standup.md', 'Standup at 10:30')$q$, t.id('v1')), 'Claude Code'));
select t.expect('open: the agent is attributed in the log',
  (select agent from public.log where path = 'notes/standup.md' and event = 'file.write' order by seq desc limit 1),
  'Claude Code');
select t.expect('open: viewer cannot write',
  t.run('cal', format($q$select public.write_file(%L, 'notes/x.md', 'x')$q$, t.id('v1'))), 'ERR 42501');
select t.expect('open: outsider cannot write',
  t.run('dee', format($q$select public.write_file(%L, 'notes/x.md', 'x')$q$, t.id('v1'))), 'ERR 42501');
select t.expect('open: path traversal refused',
  t.run('ben', format($q$select public.write_file(%L, 'notes/../secret.md', 'x')$q$, t.id('v1'))), 'ERR 22023');
select t.expect('open: viewer reads the latest version',
  t.run('cal', $q$select v.body from public.files f join public.file_versions v on v.id = f.current_version_id where f.path = 'notes/standup.md'$q$),
  'Standup at 10:30');

-- Policies

select t.expect('policy: owner''s agent cannot set policy',
  t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 2)$q$, t.id('v1')), 'Claude Code'), 'ERR 42501');
select t.expect('policy: editor cannot set policy',
  t.run('ben', format($q$select public.set_policy(%L, 'canon/', 'canon', 2)$q$, t.id('v1'))), 'ERR 42501');
select t.expect_ok('policy: owner sets canon/ to canon, quorum 2',
  t.run('ana', format($q$select coalesce(public.set_policy(%L, 'canon/', 'canon', 2)::text, 'ok')$q$, t.id('v1'))));
select t.expect('policy: editor cannot write a canon file directly',
  t.run('ben', format($q$select public.write_file(%L, 'canon/pricing.md', 'x')$q$, t.id('v1'))), 'ERR 42501');
select t.expect('policy: owner cannot either; canon means proposals',
  t.run('ana', format($q$select public.write_file(%L, 'canon/pricing.md', 'x')$q$, t.id('v1'))), 'ERR 42501');
select t.expect('policy: nested paths inherit the folder',
  t.run('ben', format($q$select public.write_file(%L, 'canon/deep/x.md', 'x')$q$, t.id('v1'))), 'ERR 42501');
select t.run('ana', format($q$select public.set_policy(%L, 'canon/scratch.md', 'open')$q$, t.id('v1')));
select t.expect_ok('policy: a file-level open overrides its canon folder',
  t.run('ben', format($q$select public.write_file(%L, 'canon/scratch.md', 'x')$q$, t.id('v1'))));

-- Proposals and quorum

insert into t.ids select 'p1', t.run('ben',
  format($q$select public.propose(%L, 'canon/pricing.md', 'Day rate 800', 'new rate')$q$, t.id('v1')), 'Claude Code')::uuid;
select t.expect('quorum: an agent cannot approve',
  t.run('ben', format($q$select public.decide(%L, 'approve')$q$, t.id('p1')), 'Claude Code'), 'ERR 42501');
select t.expect('quorum: a viewer cannot approve',
  t.run('cal', format($q$select public.decide(%L, 'approve')$q$, t.id('p1'))), 'ERR P0002');
select t.expect('quorum: an outsider cannot approve',
  t.run('dee', format($q$select public.decide(%L, 'approve')$q$, t.id('p1'))), 'ERR P0002');
select t.expect('quorum: one approval of two leaves it open',
  t.run('ben', format($q$select public.decide(%L, 'approve')$q$, t.id('p1'))), 'open');
select t.expect('quorum: the same person cannot approve twice',
  t.run('ben', format($q$select public.decide(%L, 'approve')$q$, t.id('p1'))), 'ERR 23505');
select t.expect('quorum: nothing is written before quorum',
  (select count(*)::text from public.files where path = 'canon/pricing.md'), '0');
select t.expect('quorum: a second person applies it',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p1'))), 'applied');
select t.expect('quorum: the applied file has the proposed text',
  (select v.body from public.files f join public.file_versions v on v.id = f.current_version_id where f.path = 'canon/pricing.md'),
  'Day rate 800');
select t.expect('quorum: the write is attributed to the proposer''s agent',
  (select actor::text || ' ' || agent from public.log
   where path = 'canon/pricing.md' and event = 'file.write' and proposal_id = t.id('p1')),
  t.id('ben')::text || ' Claude Code');
select t.expect('quorum: a decided proposal cannot be decided again',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p1'))), 'ERR 55000');

-- Stale and reject

insert into t.ids select 'p2', t.run('ben', format($q$select public.propose(%L, 'canon/pricing.md', 'Day rate 900')$q$, t.id('v1')))::uuid;
insert into t.ids select 'p3', t.run('ana', format($q$select public.propose(%L, 'canon/pricing.md', 'Day rate 1000')$q$, t.id('v1')))::uuid;
select t.run('ben', format($q$select public.decide(%L, 'approve')$q$, t.id('p2')));
select t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p2')));
select t.run('ben', format($q$select public.decide(%L, 'approve')$q$, t.id('p3')));
select t.expect('stale: a proposal based on an old version goes stale, not applied',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p3'))), 'stale');
select t.expect('stale: the file keeps the version that won',
  (select v.body from public.files f join public.file_versions v on v.id = f.current_version_id where f.path = 'canon/pricing.md'),
  'Day rate 900');
insert into t.ids select 'p4', t.run('ben', format($q$select public.propose(%L, 'canon/pricing.md', 'Free!')$q$, t.id('v1')))::uuid;
select t.expect('reject: one rejection closes it',
  t.run('ana', format($q$select public.decide(%L, 'reject', 'not free')$q$, t.id('p4'))), 'rejected');
select t.expect('reject: nothing changed',
  (select v.body from public.files f join public.file_versions v on v.id = f.current_version_id where f.path = 'canon/pricing.md'),
  'Day rate 900');

-- Tables are closed to direct writes

select t.expect('tables: no direct insert into files',
  t.run('ana', format($q$insert into public.files (vault_id, path) values (%L, 'x.md') returning 'x'$q$, t.id('v1'))), 'ERR 42501');
select t.expect('tables: no direct role change',
  t.run('ben', $q$update public.vault_members set role = 'owner' returning 'x'$q$), 'ERR 42501');
select t.expect('tables: no direct log insert',
  t.run('ana', format($q$insert into public.log (vault_id, event) values (%L, 'forged') returning 'x'$q$, t.id('v1'))), 'ERR 42501');
select t.expect('tables: the unchecked write helper is not callable',
  t.run('ben', format($q$select private.apply_write(%L, 'canon/pricing.md', 'x', %L, null, null)$q$, t.id('v1'), t.id('ben'))),
  'ERR 42501');
select t.expect('tables: the log helper is not callable',
  t.run('ben', format($q$select private.log_event(%L, 'forged', null, null, null)$q$, t.id('v1'))), 'ERR 42501');

-- Append-only, even for the table owner

select t.owner_error('append-only: log update refused', 'update public.log set event = ''x''');
select t.owner_error('append-only: log delete refused', 'delete from public.log');
select t.owner_error('append-only: log truncate refused', 'truncate public.log');
select t.owner_error('append-only: approvals update refused', 'update public.approvals set decision = ''reject''');
select t.owner_error('append-only: a version''s text cannot be rewritten', 'update public.file_versions set body = ''rewritten''');
select t.owner_error('append-only: versions cannot be deleted', 'delete from public.file_versions');

-- Members

select t.expect('members: an editor cannot add members',
  t.run('ben', format($q$select public.set_member(%L, %L, 'owner')$q$, t.id('v1'), t.id('dee'))), 'ERR 42501');
select t.expect('members: the owner''s agent cannot add members',
  t.run('ana', format($q$select public.set_member(%L, %L, 'editor')$q$, t.id('v1'), t.id('dee')), 'Claude Code'), 'ERR 42501');
select t.expect('members: an owner cannot remove themselves',
  t.run('ana', format($q$select public.set_member(%L, %L, null)$q$, t.id('v1'), t.id('ana'))), 'ERR 42501');
select t.expect('cross-vault: Ben cannot propose into Dee''s vault',
  t.run('ben', format($q$select public.propose(%L, 'x.md', 'x')$q$, t.id('v2'))), 'ERR 42501');

-- Erasure

select t.expect('erase: an editor cannot erase',
  t.run('ben', format($q$select public.erase_file(%L, 'notes/standup.md')$q$, t.id('v1'))), 'ERR 42501');
select t.expect('erase: the owner''s agent cannot erase',
  t.run('ana', format($q$select public.erase_file(%L, 'notes/standup.md')$q$, t.id('v1')), 'Claude Code'), 'ERR 42501');
create temp table log_before as select count(*) n, max(seq) m from public.log;
select t.expect('erase: the owner erases both versions',
  t.run('ana', format($q$select public.erase_file(%L, 'notes/standup.md')$q$, t.id('v1'))), '2');
select t.expect('erase: no version keeps its text',
  (select count(*)::text from public.file_versions v join public.files f on f.id = v.file_id
   where f.path = 'notes/standup.md' and v.body is not null), '0');
select t.expect('erase: the log keeps every row and adds one',
  (select (count(*) - (select n from log_before))::text from public.log), '1');
select t.expect('erase: the text appears nowhere in the log',
  (select count(*)::text from public.log l where l::text like '%Standup%'), '0');

-- Membership removal takes effect immediately

select t.run('ana', format($q$select public.set_member(%L, %L, null)$q$, t.id('v1'), t.id('ben')));
select t.expect('removal: Ben reads nothing afterwards',
  t.run('ben', format($q$select count(*) from public.files where vault_id = %L$q$, t.id('v1'))), '0');
select t.expect('removal: Ben''s agent cannot write',
  t.run('ben', format($q$select public.write_file(%L, 'notes/y.md', 'y')$q$, t.id('v1')), 'Claude Code'), 'ERR 42501');

-- Feed

select t.expect('feed: cursor returns only later events, in order',
  t.run('ana', format($q$select string_agg(event, ',' order by seq) from public.changes_since(%L, %s)$q$,
    t.id('v1'), (select max(seq) - 2 from public.log where vault_id = t.id('v1')))),
  (select string_agg(event, ',' order by seq) from (select event, seq from public.log where vault_id = t.id('v1') order by seq desc limit 2) x));

-- ---------------------------------------------------------------------------

