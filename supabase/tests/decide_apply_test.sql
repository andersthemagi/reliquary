-- What decide() and edit_and_approve() do when a decision ends a proposal:
-- the status it ends in, what it writes, and exactly which log entries it
-- adds, in order. Characterization for the review gate (issue #78), which
-- reacts to a proposal being applied: these pin decide()'s own behaviour
-- so a change to what happens around it can't quietly change it. Review
-- flow rules themselves are review_test.sql's.
--
-- Ana owns, Ben is an editor.

insert into t.ids select 'da', t.run('ana', $q$select public.create_vault('Decide')$q$)::uuid;
select test_support.add_member(t.id('da'), t.id('ben'), 'editor', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('da')));
select t.run('ana', format($q$select public.set_policy(%L, 'board/', 'canon', 2)$q$, t.id('da')));

-- Every log entry for a proposal, oldest first, as "event by actor".
create function t.trail(p_proposal uuid) returns text language sql as $$
  select string_agg(l.event || ' by ' || (select name from t.ids where id = l.actor), ', ' order by l.seq)
    from public.log l where l.proposal_id = p_proposal
$$;
create function t.propose(p_name text, p_path text, p_body text) returns void language sql as $$
  insert into t.ids select p_name, t.run('ben',
    format($q$select public.propose(%L, %L, %L, 'why')$q$, t.id('da'), p_path, p_body), 'Hermes')::uuid
$$;

-- Approved at quorum: applied, written, decided, and three entries.
select t.propose('a1', 'canon/a.md', 'A body');
select t.expect('decide characterization: an approval at quorum returns applied',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('a1'))), 'applied');
select t.expect_true('decide characterization: the proposal is applied and decided, and the file holds its text',
  (select status = 'applied' and decided_at is not null from public.proposals where id = t.id('a1'))
  and (select v.body from public.files f join public.file_versions v on v.id = f.current_version_id
        where f.vault_id = t.id('da') and f.path = 'canon/a.md') = 'A body');
select t.expect('decide characterization: an applied proposal logs open, approve, then the write, and nothing else',
  t.trail(t.id('a1')), 'proposal.open by ben, proposal.approve by ana, file.write by ben');

-- Short of quorum: open, nothing written.
select t.propose('a2', 'board/b.md', 'B body');
select t.expect('decide characterization: an approval short of quorum returns open',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('a2'))), 'open');
select t.expect('decide characterization: short of quorum, only the approval is logged and nothing is written',
  t.trail(t.id('a2')) || ' / ' || (select count(*) from public.files where vault_id = t.id('da') and path = 'board/b.md'),
  'proposal.open by ben, proposal.approve by ana / 0');

-- Edit and approve: the edit, the approval, the write.
select t.propose('a3', 'canon/c.md', 'C body');
select t.expect('decide characterization: edit and approve at quorum returns applied',
  t.run('ana', format($q$select public.edit_and_approve(%L, 'C edited')$q$, t.id('a3'))), 'applied');
select t.expect('decide characterization: edit and approve logs open, edit, approve, then the write by the editor',
  t.trail(t.id('a3')), 'proposal.open by ben, proposal.edit by ana, proposal.approve by ana, file.write by ana');

-- Stale: another proposal for the same file was applied first.
select t.propose('a4', 'canon/d.md', 'D body');
select t.propose('a4b', 'canon/d.md', 'moved');
select t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('a4b')));
select t.expect('decide characterization: an approval of a proposal whose file moved returns stale',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('a4'))), 'stale');
select t.expect('decide characterization: a stale proposal logs the approval and proposal.stale, and writes nothing',
  t.trail(t.id('a4')) || ' / ' || (select v.body from public.files f join public.file_versions v on v.id = f.current_version_id
                                    where f.vault_id = t.id('da') and f.path = 'canon/d.md'),
  'proposal.open by ben, proposal.approve by ana, proposal.stale by ana / moved');

-- Rejected: nothing written.
select t.propose('a5', 'canon/e.md', 'E body');
select t.expect('decide characterization: a rejection returns rejected',
  t.run('ana', format($q$select public.decide(%L, 'reject', 'no')$q$, t.id('a5'))), 'rejected');
select t.expect('decide characterization: a rejection logs only itself and writes nothing',
  t.trail(t.id('a5')) || ' / ' || (select count(*) from public.files where vault_id = t.id('da') and path = 'canon/e.md'),
  'proposal.open by ben, proposal.reject by ana / 0');
