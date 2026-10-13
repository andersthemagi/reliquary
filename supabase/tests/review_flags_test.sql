-- Approvers are flagged when a task awaits their review
-- (20261014120000_flag_review_approvers, issue #357): completing a
-- review-gated step flags everyone who can write its plan file, in
-- category responsibility, reason step_review, naming the plan and the
-- task, until the step is approved, skipped or cancelled. The gate itself
-- is review_gate_test.sql's; the rest of list_flags flags_test.sql's.
--
-- Ana owns, Ben is an editor with an agent connection, Cal a viewer named
-- owner of owned/, Dee not a member (she owns a vault of her own).

insert into t.ids select 'rf', t.run('ana', $q$select public.create_vault('Review flags')$q$)::uuid;
insert into t.ids select 'dees', t.run('dee', $q$select public.create_vault('Dee''s')$q$)::uuid;
select test_support.add_member(t.id('rf'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('rf'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ben', format($q$select public.create_access_token('ben-agent', 30, array[%L]::uuid[], 'write')$q$, t.id('rf')));
select t.run('ana', format($q$select public.set_policy(%L, 'owned/', 'open')$q$, t.id('rf')));
select t.run('ana', format($q$select public.set_path_owner(%L, 'owned/', %L)$q$, t.id('rf'), t.id('cal')));

create function t.plan(p_path text, p_steps text) returns text language sql as $$
  select t.run('ana', format($q$select public.write_file(%L, %L, 'a plan')::text$q$, t.id('rf'), p_path));
  select t.run('ana', format($q$select public.register_work_plan(%L, %L, %L, %L::jsonb)::text$q$, t.id('rf'), p_path,
           (select current_version_id from public.files where vault_id = t.id('rf') and path = p_path), p_steps))
$$;
select t.plan('plans/p.md', '[{"key":"g1","title":"First gated","gate":"review"},{"key":"g2","title":"Second gated","gate":"review"},
  {"key":"g3","title":"Third gated","gate":"review"},{"key":"g4","title":"Fourth gated","gate":"review"},{"key":"x","title":"Plain"}]');
select t.plan('owned/q.md', '[{"key":"o","title":"Owned gated","gate":"review"}]');

-- Claims and completes p_key as p_user, in person or over p_tok.
create function t.finish(p_user text, p_key text, p_tok text default null, p_path text default 'plans/p.md') returns text
language plpgsql as $$
declare q text := format($q$select public.complete_step(%L, %L, %L, f.o_fence, f.o_secret)::text
                            from public.claim_step(%L, %L, %L) f$q$, t.id('rf'), p_path, p_key, t.id('rf'), p_path, p_key);
begin
  return case when p_tok is null then t.run(p_user, q) else t.run_tok(p_user, p_tok, q) end;
end $$;
-- The flags as "reason event path plan step: title", or 'none'.
create function t.flags(p_user text, p_tok text default null, p_vault text default 'rf') returns text language plpgsql as $$
declare
  q text := format($q$select public.list_flags(%L)::text$q$, t.id(p_vault));
  v text := case when p_tok is null then t.run(p_user, q) else t.run_tok(p_user, p_tok, q) end;
begin
  if v like 'ERR %' then return v; end if;
  return coalesce((select string_agg(concat_ws(' ', f ->> 'reason', f ->> 'event', f ->> 'path', f ->> 'plan', (f ->> 'step') || ':', f ->> 'step_title'),
                                     '; ' order by (f ->> 'seq')::bigint)
                     from jsonb_array_elements(v::jsonb -> 'flags') f), 'none');
end $$;
create function t.catch_up(p_user text, p_tok text default null) returns text language plpgsql as $$
declare
  q text := format($q$select public.advance_flags(%L, (public.list_flags(%L) ->> 'through')::bigint)::text$q$, t.id('rf'), t.id('rf'));
begin
  return case when p_tok is null then t.run(p_user, q) else t.run_tok(p_user, p_tok, q) end;
end $$;
select t.catch_up('ana'), t.catch_up('ben'), t.catch_up('ben', 'ben-agent'), t.catch_up('cal');

-- ---------------------------------------------------------------------------
-- Ben's agent completes g1

select t.expect('step review flags: the agent completes a gated task', t.finish('ben', 'g1', 'ben-agent'), '');
select t.expect('step review flags: an owner is flagged, naming the plan and the task',
  t.flags('ana'), 'step_review step.complete plans/p.md plans/p.md g1: First gated');
select t.expect('step review flags: the agent''s own person, who can approve it, is flagged for what their agent completed',
  t.flags('ben'), 'step_review step.complete plans/p.md plans/p.md g1: First gated');
select t.expect('step review flags: the connection that completed it is not flagged',
  t.flags('ben', 'ben-agent'), 'none');
select t.expect('step review flags: a viewer is not flagged',
  t.flags('cal'), 'none');
select t.expect('step review flags: a non-member is refused the vault''s flags',
  t.flags('dee'), 'ERR P0002');
select t.expect('step review flags: another vault''s owner is not flagged in their own vault',
  t.flags('dee', null, 'dees'), 'none');

-- ---------------------------------------------------------------------------
-- Ben in person completes g2, and a plain step

select t.catch_up('ben');
select t.finish('ben', 'g2');
select t.finish('ben', 'x');
select t.expect('step review flags: an editor completing in person is not flagged for it',
  t.flags('ben'), 'none');
select t.expect('step review flags: every task awaiting review is flagged, and a plain task completed is not',
  t.flags('ana'), 'step_review step.complete plans/p.md plans/p.md g1: First gated; step_review step.complete plans/p.md plans/p.md g2: Second gated');

-- ---------------------------------------------------------------------------
-- A path's named owner

select t.finish('ben', 'o', null, 'owned/q.md');
select t.expect('step review flags: a path''s named owner who can write the plan file is flagged, though a viewer',
  t.flags('cal'), 'step_review step.complete owned/q.md owned/q.md o: Owned gated');

-- ---------------------------------------------------------------------------
-- Decided: approved, cancelled, skipped

select t.finish('ben', 'g3');
select t.finish('ben', 'g4');
select t.run('ana', format($q$select public.approve_step(%L, 'plans/p.md', 'g1')::text$q$, t.id('rf')));
select t.run('ana', format($q$select public.cancel_step(%L, 'plans/p.md', 'g2')::text$q$, t.id('rf')));
select t.run('ana', format($q$select public.skip_step(%L, 'plans/p.md', 'g3')::text$q$, t.id('rf')));
select t.expect('step review flags: once a task is approved, cancelled or skipped it flags no one; one still awaiting review does',
  t.flags('ben', 'ben-agent'), 'step_review step.complete owned/q.md owned/q.md o: Owned gated; step_review step.complete plans/p.md plans/p.md g4: Fourth gated');
