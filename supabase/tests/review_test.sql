-- Hostile tests for the review flow: request changes, revisions, edit &
-- approve, revision-bound approvals, and notes.

insert into t.ids select 'v1', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
select test_support.add_member(t.id('v1'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('v1'), t.id('cal'), 'editor', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('v1')));
select t.run('ana', format($q$select public.set_policy(%L, 'board/', 'canon', 2)$q$, t.id('v1')));
insert into t.ids select 'v2', t.run('dee', $q$select public.create_vault('Other')$q$)::uuid;

-- Request changes

insert into t.ids select 'p1', t.run('ben',
  format($q$select public.propose(%L, 'canon/rate.md', 'Rate 900', 'raise')$q$, t.id('v1')), 'Hermes')::uuid;
select t.expect('request changes: needs a note',
  t.run('ana', format($q$select public.decide(%L, 'request_changes')$q$, t.id('p1'))), 'ERR 22023');
select t.expect('reject: needs a note',
  t.run('ana', format($q$select public.decide(%L, 'reject', '  ')$q$, t.id('p1'))), 'ERR 22023');
select t.expect('request changes: an agent can''t',
  t.run('ben', format($q$select public.decide(%L, 'request_changes', 'x')$q$, t.id('p1')), 'Hermes'), 'ERR 42501');
select t.expect('request changes: keeps it alive, marked for the proposer',
  t.run('ana', format($q$select public.decide(%L, 'request_changes', 'Use 850, as agreed')$q$, t.id('p1'))),
  'changes_requested');
select t.expect('request changes: the note is readable by members',
  t.run('ben', format($q$select body from public.proposal_notes where proposal_id = %L and kind = 'request_changes'$q$, t.id('p1'))),
  'Use 850, as agreed');
select t.expect('request changes: can''t be approved until revised',
  t.run('cal', format($q$select public.decide(%L, 'approve')$q$, t.id('p1'))), 'ERR 55000');

-- Revise

select t.expect('revise: someone else can''t revise it',
  t.run('cal', format($q$select public.revise_proposal(%L, 'Rate 1', 'mine')$q$, t.id('p1'))), 'ERR P0002');
select t.expect('revise: the proposer''s agent revises it, reopening at revision 2',
  t.run('ben', format($q$select public.revise_proposal(%L, 'Rate 850', 'as agreed')$q$, t.id('p1')), 'Hermes'), '2');
select t.expect('revise: status is open again',
  (select status from public.proposals where id = t.id('p1')), 'open');
select t.expect('revise: approving the revision applies it',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p1'))), 'applied');
select t.expect('revise: the file has the revised text, credited to the agent',
  (select v.body || ' / ' || v.agent from public.files f join public.file_versions v on v.id = f.current_version_id
    where f.path = 'canon/rate.md'), 'Rate 850 / Hermes');

-- Revision-bound approvals (quorum 2)

insert into t.ids select 'p2', t.run('ben',
  format($q$select public.propose(%L, 'board/minutes.md', 'v1 minutes', 'minutes')$q$, t.id('v1')), 'Hermes')::uuid;
select t.expect('revision: first approval of two leaves it open',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p2'))), 'open');
select t.run('ben', format($q$select public.revise_proposal(%L, 'v2 minutes', 'typo')$q$, t.id('p2')), 'Hermes');
select t.expect('revision: after a revision, the old approval no longer counts',
  t.run('cal', format($q$select public.decide(%L, 'approve')$q$, t.id('p2'))), 'open');
select t.expect('revision: Ana can approve the new revision',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p2'))), 'applied');
select t.expect('revision: the applied text is the latest revision',
  (select v.body from public.files f join public.file_versions v on v.id = f.current_version_id
    where f.path = 'board/minutes.md'), 'v2 minutes');

-- Edit & approve

insert into t.ids select 'p3', t.run('ben',
  format($q$select public.propose(%L, 'canon/terms.md', 'Net 60', 'terms')$q$, t.id('v1')), 'Hermes')::uuid;
select t.expect('edit & approve: an agent can''t',
  t.run('ana', format($q$select public.edit_and_approve(%L, 'Net 30')$q$, t.id('p3')), 'Claude'), 'ERR 42501');
select t.expect('edit & approve: an outsider can''t',
  t.run('dee', format($q$select public.edit_and_approve(%L, 'Net 30')$q$, t.id('p3'))), 'ERR P0002');
select t.expect('edit & approve: a reviewer fixes it and it applies',
  t.run('ana', format($q$select public.edit_and_approve(%L, 'Net 30', 'we agreed 30')$q$, t.id('p3'))), 'applied');
select t.expect('edit & approve: the file is credited to the editor, not the agent',
  (select v.body || ' / ' || v.author || ' / ' || coalesce(v.agent, 'no agent')
     from public.files f join public.file_versions v on v.id = f.current_version_id where f.path = 'canon/terms.md'),
  'Net 30 / ' || t.id('ana') || ' / no agent');
select t.expect('edit & approve: the edit is on record as a note',
  (select kind || ': ' || body from public.proposal_notes where proposal_id = t.id('p3')), 'edit: we agreed 30');

insert into t.ids select 'p4', t.run('ben',
  format($q$select public.propose(%L, 'board/budget.md', '100k', 'budget')$q$, t.id('v1')), 'Hermes')::uuid;
select t.expect('edit & approve with quorum 2: waits for a second approval of the edit',
  t.run('ana', format($q$select public.edit_and_approve(%L, '90k')$q$, t.id('p4'))), 'open');
select t.expect('edit & approve with quorum 2: the second approval applies the edited text',
  t.run('cal', format($q$select public.decide(%L, 'approve')$q$, t.id('p4'))), 'applied');

-- Reject after changes requested

insert into t.ids select 'p5', t.run('ben',
  format($q$select public.propose(%L, 'canon/x.md', 'x', 'x')$q$, t.id('v1')), 'Hermes')::uuid;
select t.run('ana', format($q$select public.decide(%L, 'request_changes', 'unclear')$q$, t.id('p5')));
select t.expect('reject: allowed on a proposal waiting for changes',
  t.run('cal', format($q$select public.decide(%L, 'reject', 'abandon')$q$, t.id('p5'))), 'rejected');
select t.expect('revise: a rejected proposal can''t be revised',
  t.run('ben', format($q$select public.revise_proposal(%L, 'y')$q$, t.id('p5')), 'Hermes'), 'ERR 55000');

-- Notes are protected

select t.expect('notes: no direct inserts',
  t.run('ana', format($q$insert into public.proposal_notes (proposal_id, vault_id, author, revision, kind, body)
     values (%L, %L, %L, 1, 'reject', 'forged') returning 'x'$q$, t.id('p5'), t.id('v1'), t.id('ana'))), 'ERR 42501');
select t.expect('notes: the note helper isn''t callable',
  t.run('ana', format($q$select private.add_note((select p from public.proposals p where id = %L), 'reject', 'forged')$q$, t.id('p5'))),
  'ERR 42501');
select t.expect('notes: outsiders can''t read them',
  t.run('dee', format($q$select count(*) from public.proposal_notes where vault_id = %L$q$, t.id('v1'))), '0');
select t.owner_error('notes: text can''t be rewritten, even by the owner',
  'update public.proposal_notes set body = ''rewritten''');
select t.run('ana', format($q$select public.erase_file(%L, 'canon/x.md')$q$, t.id('v1')));
select t.expect('notes: erasing a file erases its proposals'' notes',
  (select count(*)::text from public.proposal_notes n join public.proposals p on p.id = n.proposal_id
    where p.path = 'canon/x.md' and n.body is not null), '0');
