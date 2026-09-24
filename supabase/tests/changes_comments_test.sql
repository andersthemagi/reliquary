-- Hostile tests for comments and review notes in the feed
-- (20260924200000_changes_comments). Ana owner, Ben editor, Cal viewer, Dee
-- outsider with her own vault.

insert into t.ids select 'v1', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
select t.run('ana', format($q$select public.set_member(%L, %L, 'editor')$q$, t.id('v1'), t.id('ben')));
select t.run('ana', format($q$select public.set_member(%L, %L, 'viewer')$q$, t.id('v1'), t.id('cal')));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('v1')));
insert into t.ids select 'v2', t.run('dee', $q$select public.create_vault('Other')$q$)::uuid;
insert into t.ids select 'dp', t.run('dee',
  format($q$select public.propose(%L, 'x.md', 'Dee''s', 'mine')$q$, t.id('v2')))::uuid;
select t.run('dee', format($q$select public.comment_on_proposal(%L, 'Dee secret remark')$q$, t.id('dp')));

create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;
select t.run('ana', format($q$select public.create_access_token('team-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('v1')));
select t.run('ana', format($q$select public.create_access_token('team-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('v1')));
select t.run('ana', format($q$select public.create_access_token('side-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('side')));
select t.run('ana', format($q$select public.create_access_token('revoked', 30, array[%L]::uuid[], 'write')$q$, t.id('v1')));
update public.access_tokens set revoked_at = now() where name = 'revoked';

-- A whole review: Ben's agent proposes, Ana comments and requests changes,
-- the agent replies and revises, Ana edits and approves. A second proposal
-- gets a request for changes from Ana and a rejection from Ben on the same
-- revision.
insert into t.ids select 'p1', t.run('ben',
  format($q$select public.propose(%L, 'canon/rate.md', 'Rate 900', 'raise')$q$, t.id('v1')), 'Hermes')::uuid;
select t.run('ana', format($q$select public.comment_on_proposal(%L, 'Why 900?')$q$, t.id('p1')));
select t.run('ana', format($q$select public.decide(%L, 'request_changes', 'Say 850.')$q$, t.id('p1')));
select t.run('ben', format($q$select public.comment_on_proposal(%L, 'Market rate went up.')$q$, t.id('p1')), 'Hermes');
select t.run('ben', format($q$select public.revise_proposal(%L, 'Rate 850', 'Lowered to 850.')$q$, t.id('p1')), 'Hermes');
select t.run('ana', format($q$select public.edit_and_approve(%L, 'Rate: 850', 'Fixed the colon.')$q$, t.id('p1')));
insert into t.ids select 'p2', t.run('ben',
  format($q$select public.propose(%L, 'canon/terms.md', 'Net 60', 'terms')$q$, t.id('v1')), 'Hermes')::uuid;
select t.run('ana', format($q$select public.decide(%L, 'request_changes', 'Net 30, please.')$q$, t.id('p2')));
select t.run('ben', format($q$select public.decide(%L, 'reject', 'We have terms already.')$q$, t.id('p2')));
-- A third, revised twice, so each revise event must find its own revision.
insert into t.ids select 'p3', t.run('ben',
  format($q$select public.propose(%L, 'canon/fee.md', 'Fee 10', 'fee')$q$, t.id('v1')), 'Hermes')::uuid;
select t.run('ben', format($q$select public.revise_proposal(%L, 'Fee 12', 'First try.')$q$, t.id('p3')), 'Hermes');
select t.run('ben', format($q$select public.revise_proposal(%L, 'Fee 15', 'Second try.')$q$, t.id('p3')), 'Hermes');

create function t.notes(p_user text, p_vault text, p_agent text default null) returns text language sql as $$
  select t.run(p_user, format($q$select string_agg(kind || ':' || coalesce(body, '-'), ' | ' order by seq)
    from public.change_notes(%L, 0, 1000000)$q$, t.id(p_vault)), p_agent)
$$;

-- ---------------------------------------------------------------------------
-- The feed has the events, and change_notes has what each one said

select t.expect('feed: changes_since returns every discussion event, in order',
  t.run('ana', format($q$select string_agg(event, ',' order by seq) from public.changes_since(%L, 0)
    where event like 'proposal.%%' and event not in ('proposal.open', 'proposal.approve')$q$, t.id('v1'))),
  'proposal.comment,proposal.request_changes,proposal.comment,proposal.revise,proposal.edit,proposal.request_changes,proposal.reject,proposal.revise,proposal.revise');
select t.expect('notes: each discussion event has exactly its own note, oldest first',
  t.notes('ana', 'v1'),
  'comment:Why 900? | request_changes:Say 850. | comment:Market rate went up. | revise:Lowered to 850. | edit:Fixed the colon. | request_changes:Net 30, please. | reject:We have terms already. | revise:First try. | revise:Second try.');
select t.expect('notes: two people deciding the same revision each get their own note',
  t.run('ana', format($q$select string_agg(n.kind || '=' || (n.author = l.actor)::text, ',' order by n.seq)
    from public.change_notes(%L, 0, 1000000) n join public.log l on l.seq = n.seq
   where n.proposal_id = %L$q$, t.id('v1'), t.id('p2'))),
  'request_changes=true,reject=true');
select t.expect('notes: a note is tied to its log event, proposal, path, revision and author',
  t.run('ana', format($q$select n.path || ' r' || n.revision || ' ' || (n.author = %L)::text || ' ' || n.agent
    from public.change_notes(%L, 0, 1000000) n where n.kind = 'revise' and n.proposal_id = %L$q$, t.id('ben'), t.id('v1'), t.id('p1'))),
  'canon/rate.md r2 true Hermes');
select t.expect('notes: no event gets more than one note',
  t.run('ana', format($q$select count(*) - count(distinct seq) from public.change_notes(%L, 0, 1000000)$q$, t.id('v1'))), '0');
select t.expect('notes: events that write no note (open, approve, file writes) have none',
  t.run('ana', format($q$select count(*) from public.change_notes(%L, 0, 1000000) n
    join public.log l on l.seq = n.seq where l.event not in ('proposal.comment', 'proposal.request_changes',
      'proposal.reject', 'proposal.revise', 'proposal.edit')$q$, t.id('v1'))), '0');
select t.expect('notes: the window is (after, upto]',
  t.run('ana', format($q$select count(*) from public.change_notes(%L,
      (select min(seq) from public.log where event = 'proposal.comment' and vault_id = %L),
      (select min(seq) from public.log where event = 'proposal.revise' and vault_id = %L))$q$,
    t.id('v1'), t.id('v1'), t.id('v1'))), '3');
select t.expect('notes: a null window returns nothing, not everything',
  t.run('ana', format($q$select count(*) from public.change_notes(%L, null, null)$q$, t.id('v1'))), '0');

-- ---------------------------------------------------------------------------
-- Bodies stay out of the log

select t.expect('log: no note text is in the log',
  (select count(*)::text from public.log
    where detail::text ~ '(Why 900|Say 850|Market rate|Lowered to|Fixed the colon|Net 30|terms already)'), '0');

-- ---------------------------------------------------------------------------
-- Members only, as the caller

select t.expect('members: an editor''s agent sees the notes',
  t.notes('ben', 'v1', 'Hermes'),
  t.notes('ana', 'v1'));
select t.expect('members: a viewer reads them too, the same as the thread',
  t.run('cal', format($q$select count(*) from public.change_notes(%L, 0, 1000000)$q$, t.id('v1'))), '9');
select t.expect('outsider: a non-member gets nothing for another vault',
  t.run('dee', format($q$select count(*) from public.change_notes(%L, 0, 1000000)$q$, t.id('v1'))), '0');
select t.expect('outsider: nor from the feed',
  t.run('dee', format($q$select count(*) from public.changes_since(%L, 0)$q$, t.id('v1'))), '0');
select t.expect('outsider: a member of Team can''t read Dee''s comments',
  t.run('ana', format($q$select count(*) from public.change_notes(%L, 0, 1000000)$q$, t.id('v2'))), '0');
select t.expect('outsider: asking with your own vault id doesn''t reach another vault''s notes',
  t.run('dee', format($q$select coalesce(string_agg(body, ','), '') from public.change_notes(%L, 0, 1000000)$q$, t.id('v2'))),
  'Dee secret remark');
select t.expect('anonymous: can''t call it',
  t.run(null, format($q$select count(*) from public.change_notes(%L, 0, 1000000)$q$, t.id('v1'))), 'ERR 42501');

select t.expect('token: a read-only token for Team sees Team''s notes',
  t.run_tok('ana', 'team-ro', format($q$select count(*) from public.change_notes(%L, 0, 1000000)$q$, t.id('v1'))), '9');
select t.expect('token: a token scoped to another vault sees none of Team''s',
  t.run_tok('ana', 'side-rw', format($q$select count(*) from public.change_notes(%L, 0, 1000000)$q$, t.id('v1'))), '0');
select t.expect('token: a revoked token sees none',
  t.run_tok('ana', 'revoked', format($q$select count(*) from public.change_notes(%L, 0, 1000000)$q$, t.id('v1'))), '0');

-- ---------------------------------------------------------------------------
-- Erasure

select t.run('ana', format($q$select public.erase_file(%L, 'canon/rate.md')$q$, t.id('v1')));
select t.expect('erased: the erased file''s notes come back erased, without text',
  t.run('ana', format($q$select string_agg(kind || ':' || coalesce(body, '-') || ':' || erased, ' | ' order by seq)
    from public.change_notes(%L, 0, 1000000) where path = 'canon/rate.md'$q$, t.id('v1'))),
  'comment:-:true | request_changes:-:true | comment:-:true | revise:-:true | edit:-:true');
select t.expect('erased: other files'' notes are untouched',
  t.run('ana', format($q$select string_agg(body, ' | ' order by seq)
    from public.change_notes(%L, 0, 1000000) where path = 'canon/terms.md'$q$, t.id('v1'))),
  'Net 30, please. | We have terms already.');
select t.expect('erased: the events stay in the feed',
  t.run('ana', format($q$select count(*) from public.changes_since(%L, 0) where path = 'canon/rate.md'
    and event in ('proposal.comment', 'proposal.request_changes', 'proposal.revise', 'proposal.edit')$q$, t.id('v1'))), '5');
