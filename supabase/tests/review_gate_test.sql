-- Review-gated steps (20261013233000_review_gate, issue #78): completing a
-- `gate: review` step leaves it awaiting review; what waits on it can't be
-- claimed until a person approves it directly (approve_step, on the
-- ceiling) or the proposal its holder linked is applied; and the stored
-- blocker counts drop only then. The rest of work plans is
-- work_plans_test.sql's; decide() itself is decide_apply_test.sql's.
--
-- Ana owns, Ben is an editor, Cal a viewer, Dee not a member.

insert into t.ids select 'rg', t.run('ana', $q$select public.create_vault('Review gate')$q$)::uuid;
select test_support.add_member(t.id('rg'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('rg'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('rg')));
select t.run('ana', format($q$select public.create_access_token('rg-read', 30, array[%L]::uuid[], 'read')$q$, t.id('rg')));
select t.run('ana', format($q$select public.create_access_token('rg-write', 30, array[%L]::uuid[], 'write')$q$, t.id('rg')));
insert into t.ids select 'rg2', t.run('ana', $q$select public.create_vault('Review gate (other)')$q$)::uuid;
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('rg2')));
select test_support.add_member(t.id('rg2'), t.id('ben'), 'editor', t.id('ana'));

-- g is gated and d waits on it; h is gated (approved by a proposal) and e
-- waits on it; k is gated (cancelled while awaiting review) and m waits on
-- it; x is plain.
select t.run('ana', format($q$select public.write_file(%L, 'plans/p.md', 'a plan')::text$q$, t.id('rg')));
select t.run('ana', format($q$select public.register_work_plan(%L, 'plans/p.md', %L, %L::jsonb)::text$q$, t.id('rg'),
  (select current_version_id from public.files where vault_id = t.id('rg') and path = 'plans/p.md'),
  '[{"key":"g","title":"G","gate":"review"},{"key":"d","title":"D","blocked_by":["g"]},
    {"key":"h","title":"H","gate":"review"},{"key":"e","title":"E","blocked_by":["h"]},
    {"key":"k","title":"K","gate":"review"},{"key":"m","title":"M","blocked_by":["k"]},
    {"key":"x","title":"X"},{"key":"y","title":"Y"}]'));
-- A second plan, where nothing else is ready while its gated step awaits review.
select t.run('ana', format($q$select public.write_file(%L, 'plans/q.md', 'a plan')::text$q$, t.id('rg')));
select t.run('ana', format($q$select public.register_work_plan(%L, 'plans/q.md', %L, %L::jsonb)::text$q$, t.id('rg'),
  (select current_version_id from public.files where vault_id = t.id('rg') and path = 'plans/q.md'),
  '[{"key":"qg","title":"QG","gate":"review"},{"key":"qd","title":"QD","blocked_by":["qg"]}]'));

create table t.claims (key text primary key, fence int, secret text);
create function t.do(p_fn text, p_key text, p_path text default 'plans/p.md') returns text language sql as $$
  select format($q$select public.%s(%L, %L, %L)::text$q$, p_fn, t.id('rg'), p_path, p_key)
$$;
create function t.state(p_key text) returns text language sql as $$
  select o_state from public.work_plan_status(t.id('rg'), 'plans/p.md') where o_key = p_key
$$;
create function t.row(p_key text) returns public.work_plan_steps language sql as $$
  select s.* from public.work_plan_steps s join public.work_plans p on p.id = s.plan_id
   where p.vault_id = t.id('rg') and p.path = 'plans/p.md' and s.key = p_key
$$;
-- Ben claims p_key in person and keeps the fence and secret.
create function t.claim(p_key text) returns text language sql as $$
  insert into t.claims select p_key, nullif(split_part(r, ' ', 1), 'ERR')::int, split_part(r, ' ', 2)
    from (select t.run('ben', format($q$select o_fence || ' ' || o_secret from public.claim_step(%L, 'plans/p.md', %L)$q$,
                         t.id('rg'), p_key)) r) x
  on conflict (key) do update set fence = excluded.fence, secret = excluded.secret
  returning key
$$;
-- Ben completes his claim on p_key, naming p_proposal (or none).
create function t.complete(p_key text, p_proposal uuid default null) returns text language sql as $$
  select t.run('ben', format($q$select public.complete_step(%L, 'plans/p.md', %L, %s, %L, %L)::text$q$,
    t.id('rg'), p_key, c.fence, c.secret, p_proposal)) from t.claims c where c.key = p_key
$$;
create function t.propose(p_name text, p_user text, p_path text, p_vault text default 'rg') returns void language sql as $$
  insert into t.ids select p_name, t.run(p_user,
    format($q$select public.propose(%L, %L, 'the output', 'for the step')$q$, t.id(p_vault), p_path), 'Hermes')::uuid
$$;
-- Every step's stored count against the graph: its blockers not done.
create function t.counts_right() returns boolean language sql as $$
  select bool_and(s.open_blockers = (select count(*) from public.work_plan_step_blockers b
                                       join public.work_plan_steps bs on bs.id = b.blocker_id
                                      where b.step_id = s.id and bs.status <> 'done'))
    from public.work_plan_steps s where s.vault_id = t.id('rg')
$$;

-- ---------------------------------------------------------------------------
-- Completing a gated step

select t.claim('g');
select t.expect('gate: completing a review-gated step succeeds', t.complete('g'), '');
select t.expect('gate: it is awaiting review, not done', t.state('g'), 'awaiting_review');
select t.expect_true('gate: it has no finish time, and what waits on it still counts it',
  (t.row('g')).done_at is null and (t.row('d')).open_blockers = 1);
select t.expect('gate: what waits on it reads blocked', t.state('d'), 'blocked');
select t.expect('gate: logged as step.complete, marked as gated',
  (select l.detail->>'gate' from public.log l where l.vault_id = t.id('rg') and l.event = 'step.complete' and l.detail->>'step' = 'g'),
  'review');
select t.expect('gate: completing it again is refused', t.complete('g'), 'ERR RLW03');
select t.claim('x');
select t.expect('gate: a step with no gate is done when completed', t.complete('x') || t.state('x'), 'done');
select t.expect('gate: list_work_plans counts a step awaiting review as review, and in no other count',
  (select concat_ws(' ', o_review, o_ready, o_blocked, o_claimed, o_done, o_cancelled)
     from public.list_work_plans(t.id('rg')) where o_path = 'plans/p.md'),
  '1 3 3 0 1 0');

-- ---------------------------------------------------------------------------
-- What waits on it can't be claimed

select t.expect('claimable: claim_step refuses what waits on a step awaiting review',
  t.run('ben', format($q$select o_secret from public.claim_step(%L, 'plans/p.md', 'd')$q$, t.id('rg'))), 'ERR RLW02');
select t.expect('claimable: claim_step refuses the step awaiting review itself',
  t.run('ben', format($q$select o_secret from public.claim_step(%L, 'plans/p.md', 'g')$q$, t.id('rg'))), 'ERR RLW02');
select t.run('ana', format($q$select public.complete_step(%L, 'plans/q.md', 'qg', r.o_fence, r.o_secret)::text
                             from public.claim_step(%L, 'plans/q.md', 'qg') r$q$, t.id('rg'), t.id('rg')));
select t.expect('claimable: request_work only ever answers wait while the step awaits review, asked 20 times',
  t.run('ben', format($q$select string_agg(distinct r.o_state || ' ' || coalesce(r.o_key, '-'), ',')
    from generate_series(1, 20) n, lateral public.request_work(%L, 'plans/q.md') r$q$, t.id('rg'))),
  'wait -');
select t.expect('claimable: on that plan, claim_step refuses what waits on it too, as blocked',
  t.run('ana', format($q$select o_secret from public.claim_step(%L, 'plans/q.md', 'qd')$q$, t.id('rg'))), 'ERR RLW02');

-- ---------------------------------------------------------------------------
-- Who may approve

select t.expect('approve: an owner''s agent cannot approve a step',
  t.run('ana', t.do('approve_step', 'g'), 'Claude Code'), 'ERR 42501');
select t.expect('approve: a write connection cannot approve a step',
  t.run_tok('ana', 'rg-write', t.do('approve_step', 'g')), 'ERR 42501');
select t.expect('approve: a read-only connection cannot approve a step',
  t.run_tok('ana', 'rg-read', t.do('approve_step', 'g')), 'ERR 42501');
select t.expect('approve: a viewer cannot approve a step', t.run('cal', t.do('approve_step', 'g')), 'ERR 42501');
select t.expect('approve: a non-member cannot approve a step', t.run('dee', t.do('approve_step', 'g')), 'ERR 42501');
select t.expect('approve: an agent cannot run the private approval directly',
  t.run('ana', format($q$select private.approve_step(%s, null)::text$q$, (t.row('g')).id), 'Claude Code'), 'ERR 42501');
select t.expect_true('approve: none of the refused attempts approved it or logged anything',
  (t.row('g')).status = 'review' and (t.row('d')).open_blockers = 1
  and not exists (select 1 from public.log where vault_id = t.id('rg') and event = 'step.approve'));

-- ---------------------------------------------------------------------------
-- What may be approved

select t.expect('approve: an open step is refused', t.run('ana', t.do('approve_step', 'e')), 'ERR RLW02');
select t.expect('approve: a done step is refused', t.run('ana', t.do('approve_step', 'x')), 'ERR RLW02');
select t.expect('approve: an unknown step is refused', t.run('ana', t.do('approve_step', 'zzz')), 'ERR P0002');
select t.expect('approve: a path with no plan is refused', t.run('ana', t.do('approve_step', 'g', 'plans/none.md')), 'ERR P0002');

-- ---------------------------------------------------------------------------
-- Approving directly, by an editor in person

select t.expect('approve: an editor, in person, approves a step awaiting review', t.run('ben', t.do('approve_step', 'g')), '');
select t.expect_true('approve: the step is done, with a finish time', t.state('g') = 'done' and (t.row('g')).done_at is not null);
select t.expect_true('approve: what waited only on it is ready, its stored count down by one',
  t.state('d') = 'ready' and (t.row('d')).open_blockers = 0);
select t.expect_true('approve: logged as step.approve with the person, the plan and the step',
  (select array_agg(l.actor::text || ' ' || coalesce(l.agent, '-') || ' ' || (l.detail->>'step') || ' '
                    || ((l.detail->>'plan') = (t.row('g')).plan_id::text)::text)
     from public.log l where l.vault_id = t.id('rg') and l.event = 'step.approve' and l.path = 'plans/p.md')
  = array[t.id('ben')::text || ' - g true']);
select t.expect('approve: approving it again is refused', t.run('ben', t.do('approve_step', 'g')), 'ERR RLW02');
select t.expect('approve: what waited on it is claimed like any ready step', t.claim('d'), 'd');
select t.complete('d');

-- ---------------------------------------------------------------------------
-- The linked proposal

select t.claim('y');
select t.propose('p-y', 'ben', 'canon/y.md');
select t.expect('link: a step with no gate takes no proposal', t.complete('y', t.id('p-y')), 'ERR 22023');
select t.expect('link: refused, it is still claimed and completes without one', t.complete('y') || t.state('y'), 'done');

select t.claim('h');
select t.propose('p-ana', 'ana', 'canon/h-other.md');
select t.propose('p-old', 'ben', 'canon/h-old.md');
update public.proposals set created_at = coalesce((t.row('h')).claimed_at, now()) - interval '1 minute' where id = t.id('p-old');
select t.propose('p-elsewhere', 'ben', 'canon/h.md', 'rg2');
select t.propose('p-applied', 'ben', 'canon/h-applied.md');
select t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p-applied')));
select t.propose('p-h', 'ben', 'canon/h.md');

select t.expect('link: another person''s proposal is refused', t.complete('h', t.id('p-ana')), 'ERR 22023');
select t.expect('link: a proposal made before the step was claimed is refused', t.complete('h', t.id('p-old')), 'ERR 22023');
select t.expect('link: a proposal in another vault is refused', t.complete('h', t.id('p-elsewhere')), 'ERR 22023');
select t.expect('link: a proposal already applied is refused', t.complete('h', t.id('p-applied')), 'ERR 22023');
select t.expect('link: an unknown proposal is refused', t.complete('h', gen_random_uuid()), 'ERR 22023');
select t.expect_true('link: none of the refused completions changed the step', (t.row('h')).status = 'claimed');

select t.expect('link: completing with the holder''s own open proposal succeeds', t.complete('h', t.id('p-h')), '');
select t.expect_true('link: the step awaits review, linked to the proposal, and what waits on it is blocked',
  t.state('h') = 'awaiting_review' and (t.row('h')).proposal_id = t.id('p-h') and t.state('e') = 'blocked');
select t.expect('link: the completion is logged with the proposal',
  (select l.detail->>'proposal' from public.log l where l.vault_id = t.id('rg') and l.event = 'step.complete' and l.detail->>'step' = 'h'),
  t.id('p-h')::text);
select t.run('ana', format($q$select public.decide(%L, 'request_changes', 'tighten it')$q$, t.id('p-h')));
select t.expect('link: changes requested on the proposal leave the step awaiting review', t.state('h'), 'awaiting_review');
select t.run('ben', format($q$select public.revise_proposal(%L, 'the output, tightened', 'done')$q$, t.id('p-h')), 'Hermes');
select t.expect('link: applying the linked proposal returns applied, as decide always does',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p-h'))), 'applied');
select t.expect_true('link: applying the linked proposal approves the step, and what waited only on it is ready',
  t.state('h') = 'done' and t.state('e') = 'ready' and (t.row('e')).open_blockers = 0);
select t.expect_true('link: logged as step.approve by the person who applied it, naming the proposal',
  (select array_agg(l.actor::text || ' ' || (l.detail->>'proposal') || ' ' || (l.proposal_id is null)::text)
     from public.log l where l.vault_id = t.id('rg') and l.event = 'step.approve' and l.detail->>'step' = 'h')
  = array[t.id('ana')::text || ' ' || t.id('p-h')::text || ' true']);

-- A rejected proposal leaves the step for a person.
select t.claim('k');
select t.propose('p-k', 'ben', 'canon/k.md');
select t.complete('k', t.id('p-k'));
select t.run('ana', format($q$select public.decide(%L, 'reject', 'not this')$q$, t.id('p-k')));
select t.expect('link: a rejected proposal leaves the step awaiting review', t.state('k'), 'awaiting_review');

-- ---------------------------------------------------------------------------
-- Cancelled while awaiting review

select t.expect('cancel: a step awaiting review can be cancelled by a person', t.run('ana', t.do('cancel_step', 'k')), '');
select t.expect('cancel: what waits on it reads blocked by a cancelled step', t.state('m'), 'blocked_by_cancelled');
select t.expect('cancel: a cancelled step is not approved', t.run('ana', t.do('approve_step', 'k')), 'ERR RLW02');

-- ---------------------------------------------------------------------------
-- The stored counts

select t.expect_true('recount: every stored count of unfinished blockers matches the plan', t.counts_right());
