-- The "canon moved" signal (20261013100000_canon_moved, CL-3.6): an approved
-- change to a cited file marks every open or claimed step that cites it,
-- and no others, in work_plan_status; and list_flags tells the plan's
-- registrant and the step's holder, and no one else. The rest of
-- work_plan_status is work_plans_test.sql's, the rest of list_flags
-- flags_test.sql's.
--
-- Ana owns, Ben registers the plan, Cal holds a step, Dee is a member the
-- plan has nothing to do with. canon/ needs one approval.

insert into t.ids select 'cm', t.run('ana', $q$select public.create_vault('Canon moved')$q$)::uuid;
select test_support.add_member(t.id('cm'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('cm'), t.id('cal'), 'editor', t.id('ana'));
select test_support.add_member(t.id('cm'), t.id('dee'), 'editor', t.id('ana'));

create function t.write(p_path text, p_body text) returns text language sql as $$
  select t.run('ana', format($q$select public.write_file(%L, %L, %L)::text$q$, t.id('cm'), p_path, p_body))
$$;
select t.write('canon/x.md', 'x one'), t.write('canon/y.md', 'y one'), t.write('plans/p.md', 'a plan');
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('cm')));
create function t.version(p_path text) returns text language sql as $$
  select current_version_id::text from public.files where vault_id = t.id('cm') and path = p_path
$$;
insert into t.ids values ('x1', t.version('canon/x.md')::uuid), ('y1', t.version('canon/y.md')::uuid);

-- One step in each state that cites canon/x.md, plus one citing only
-- canon/y.md, one citing nothing, and one citing a version canon/x.md
-- never had.
select t.run('ben', format($q$select public.register_work_plan(%L, 'plans/p.md', %L, %L::jsonb)::text$q$, t.id('cm'), t.version('plans/p.md'),
  jsonb_build_array(
    jsonb_build_object('key', 'ready', 'title', 'R', 'cites', jsonb_build_array(jsonb_build_object('path', 'canon/x.md', 'version', t.id('x1')))),
    jsonb_build_object('key', 'held', 'title', 'H', 'cites', jsonb_build_array(jsonb_build_object('path', 'canon/x.md', 'version', t.id('x1')))),
    jsonb_build_object('key', 'waits', 'title', 'W', 'blocked_by', jsonb_build_array('ready'),
                       'cites', jsonb_build_array(jsonb_build_object('path', 'canon/x.md', 'version', t.id('x1')))),
    jsonb_build_object('key', 'fin', 'title', 'F', 'cites', jsonb_build_array(jsonb_build_object('path', 'canon/x.md', 'version', t.id('x1')))),
    jsonb_build_object('key', 'drop', 'title', 'D', 'cites', jsonb_build_array(jsonb_build_object('path', 'canon/x.md', 'version', t.id('x1')))),
    jsonb_build_object('key', 'other', 'title', 'O', 'cites', jsonb_build_array(jsonb_build_object('path', 'canon/y.md', 'version', t.id('y1')))),
    jsonb_build_object('key', 'bare', 'title', 'B'),
    jsonb_build_object('key', 'unknown', 'title', 'U', 'cites', jsonb_build_array(jsonb_build_object('path', 'canon/x.md', 'version', gen_random_uuid())))
  )::text));
select t.run('cal', format($q$select o_secret from public.claim_step(%L, 'plans/p.md', 'held')$q$, t.id('cm')));
select t.run('ben', format($q$select public.complete_step(%L, 'plans/p.md', 'fin', f.o_fence, f.o_secret)::text
                             from public.claim_step(%L, 'plans/p.md', 'fin') f$q$, t.id('cm'), t.id('cm')));
select t.run('ana', format($q$select public.cancel_step(%L, 'plans/p.md', 'drop')::text$q$, t.id('cm')));

-- Steps whose context moved, as "key key ..." in plan order, or 'none'.
create function t.moved(p_user text default 'dee') returns text language sql as $$
  select coalesce(nullif(t.run(p_user, format(
    $q$select string_agg(o_key, ' ' order by o_key) from public.work_plan_status(%L, 'plans/p.md') where cardinality(o_moved) > 0$q$,
    t.id('cm'))), ''), 'none')
$$;
-- The flags as "reason path plan", or 'none'; then marked shown.
create function t.flags(p_user text) returns text language sql as $$
  select coalesce((select string_agg(concat_ws(' ', f ->> 'reason', f ->> 'path', f ->> 'plan'), '; ' order by (f ->> 'seq')::bigint)
                     from jsonb_array_elements(t.run(p_user, format($q$select public.list_flags(%L)::text$q$, t.id('cm')))::jsonb -> 'flags') f),
                  'none')
$$;
create function t.catch_up(p_user text) returns text language sql as $$
  select t.run(p_user, format($q$select public.advance_flags(%L, (public.list_flags(%L) ->> 'through')::bigint)::text$q$, t.id('cm'), t.id('cm')))
$$;
select t.catch_up('ana'), t.catch_up('ben'), t.catch_up('cal'), t.catch_up('dee');

select t.expect('canon moved: no step reads as moved while every cited file is at its cited version',
  t.moved(), 'none');

-- A proposal to change canon/x.md, not yet approved.
insert into t.ids select 'px', t.run('ana', format($q$select public.propose(%L, 'canon/x.md', 'x two', 'newer')$q$, t.id('cm')))::uuid;
select t.expect('canon moved: a proposal that isn''t approved yet moves no step',
  t.moved(), 'none');
select t.catch_up('ana'), t.catch_up('ben'), t.catch_up('cal'), t.catch_up('dee');

-- Approved, and so applied.
select t.run('dee', format($q$select public.decide(%L, 'approve')$q$, t.id('px')));
select t.expect_true('canon moved: approving the proposal wrote a new version of the cited file',
  t.version('canon/x.md') <> t.id('x1')::text);

select t.expect('canon moved: an approved change to a cited file moves every open or claimed step that cites it, and no others',
  t.moved(), 'held ready waits');
select t.expect('canon moved: a moved step names the cited file that moved',
  t.run('dee', format($q$select array_to_string(o_moved, ',') from public.work_plan_status(%L, 'plans/p.md') where o_key = 'held'$q$, t.id('cm'))),
  'canon/x.md');
select t.expect('canon moved: the step''s state is unchanged by it',
  t.run('dee', format($q$select string_agg(o_state, ' ' order by o_key) from public.work_plan_status(%L, 'plans/p.md') where o_key in ('held', 'ready', 'waits')$q$, t.id('cm'))),
  'claimed ready blocked');

select t.expect('canon moved flags: the plan''s registrant is flagged, naming the file and the plan',
  t.flags('ben'), 'cite_moved canon/x.md plans/p.md');
select t.expect('canon moved flags: a cited step''s holder is flagged',
  t.flags('cal'), 'cite_moved canon/x.md plans/p.md');
select t.expect_true('canon moved flags: a member the plan doesn''t concern isn''t flagged',
  t.flags('dee') not like '%cite_moved%', t.flags('dee'));
select t.catch_up('ana'), t.catch_up('ben'), t.catch_up('cal'), t.catch_up('dee');

-- A change to a file only a finished step cites.
select t.run('ana', format($q$select public.cancel_step(%L, 'plans/p.md', 'other')::text$q$, t.id('cm')));
select t.catch_up('ben'), t.catch_up('cal');
insert into t.ids select 'py', t.run('ana', format($q$select public.propose(%L, 'canon/y.md', 'y two', 'newer')$q$, t.id('cm')))::uuid;
select t.run('dee', format($q$select public.decide(%L, 'approve')$q$, t.id('py')));
select t.expect('canon moved: a change to a file only a cancelled step cites moves nothing',
  t.moved(), 'held ready waits');
select t.expect('canon moved flags: nor flags anyone',
  t.flags('ben') || ' / ' || t.flags('cal'), 'none / none');
