-- Waiting in line (20261013170000_waiting_in_line onwards, CL-3.9, issue
-- #74): places in line, request_work's answers, the rule "the k-th oldest
-- live place may claim only if at least k steps are ready", strikes and
-- the cooldown, and leave_queue. The crowd and lock-order races are
-- web/test/races.test.mjs's.
--
-- Time is moved the way work_plans_test.sql moves it: as the table owner,
-- on the one row a test is about (a place's next_allowed_at or expires_at,
-- a step's expires_at, a strike's cooldown_until).
--
-- Ana owns, Cal is a viewer, Dee not a member; Ben and eight more people
-- are editors, each working as themselves (one connection: the web
-- session) unless a test names a token.

insert into t.ids values
  ('eva', '00000000-0000-0000-0000-0000000000e1'), ('fay', '00000000-0000-0000-0000-0000000000e2'),
  ('gus', '00000000-0000-0000-0000-0000000000e3'), ('hal', '00000000-0000-0000-0000-0000000000e4'),
  ('ivy', '00000000-0000-0000-0000-0000000000e5'), ('jon', '00000000-0000-0000-0000-0000000000e6'),
  ('kim', '00000000-0000-0000-0000-0000000000e7'), ('lee', '00000000-0000-0000-0000-0000000000e8');
insert into t.ids select 'wq', t.run('ana', $q$select public.create_vault('Waiting')$q$)::uuid;
select test_support.add_member(t.id('wq'), t.id(p), 'editor', t.id('ana'))
  from unnest(array['ben', 'eva', 'fay', 'gus', 'hal', 'ivy', 'jon', 'kim', 'lee']) p;
select test_support.add_member(t.id('wq'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.create_access_token('wq-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('wq')));
select t.run('ben', format($q$select public.create_access_token('ben-a', 30, array[%L]::uuid[], 'write')$q$, t.id('wq')));
select t.run('ben', format($q$select public.create_access_token('ben-b', 30, array[%L]::uuid[], 'write')$q$, t.id('wq')));
insert into t.ids select 'wq-other', t.run('ana', $q$select public.create_vault('Waiting (other)')$q$)::uuid;
select t.run('ana', format($q$select public.create_access_token('wq-other-tok', 30, array[%L]::uuid[], 'write')$q$, t.id('wq-other')));

create table t.vals (name text primary key, val text);
create function t.save(p_name text, p_val text) returns text language sql as $$
  insert into t.vals values (p_name, p_val) on conflict (name) do update set val = excluded.val returning val
$$;
create function t.val(p_name text) returns text language sql as $$ select val from t.vals where name = p_name $$;
create function t.j(p_name text) returns jsonb language sql as $$ select val::jsonb from t.vals where name = p_name $$;

-- Writes p_path as Ana and registers its plan from that version.
create function t.plan(p_path text, p_steps jsonb) returns text language sql as $$
  select t.run('ana', format($q$select public.write_file(%L, %L, 'a plan')::text$q$, t.id('wq'), p_path));
  select t.run('ana', format($q$select public.register_work_plan(%L, %L, %L, %L::jsonb)::text$q$, t.id('wq'), p_path,
    (select current_version_id from public.files where vault_id = t.id('wq') and path = p_path), p_steps::text));
$$;
create function t.plan_id(p_path text) returns uuid language sql as $$
  select id from public.work_plans where vault_id = t.id('wq') and path = p_path
$$;
create function t.rw_sql(p_path text, p_label text default null, p_ttl int default null) returns text language sql as $$
  select format($q$select to_jsonb(r)::text from public.request_work(%L, %L, %L, %L) r$q$, t.id('wq'), p_path, p_label, p_ttl)
$$;
-- request_work's answer as jsonb, or {"o_state": "ERR <sqlstate>"}.
create function t.answer(p_got text) returns jsonb language sql as $$
  select case when p_got like 'ERR %' then jsonb_build_object('o_state', p_got) else p_got::jsonb end
$$;
create function t.rw(p_user text, p_path text, p_ttl int default null) returns jsonb language sql as $$
  select t.answer(t.run(p_user, t.rw_sql(p_path, null, p_ttl)))
$$;
create function t.rw_tok(p_user text, p_tok text, p_path text) returns jsonb language sql as $$
  select t.answer(t.run_tok(p_user, p_tok, t.rw_sql(p_path)))
$$;
-- Completes, or gives back, the step a saved answer granted.
create function t.finish(p_user text, p_path text, p_grant text) returns text language sql as $$
  select t.run(p_user, format($q$select public.complete_step(%L, %L, %L, %L, %L)::text$q$, t.id('wq'), p_path,
    t.j(p_grant)->>'o_key', (t.j(p_grant)->>'o_fence')::int, t.j(p_grant)->>'o_secret'))
$$;
create function t.give_back(p_user text, p_path text, p_grant text) returns text language sql as $$
  select t.run(p_user, format($q$select public.release_step(%L, %L, %L, %L, %L)::text$q$, t.id('wq'), p_path,
    t.j(p_grant)->>'o_key', (t.j(p_grant)->>'o_fence')::int, t.j(p_grant)->>'o_secret'))
$$;
create function t.place(p_user text, p_path text) returns public.work_plan_places language sql as $$
  select * from public.work_plan_places where plan_id = t.plan_id(p_path) and holder = t.id(p_user)
$$;
-- Who is in line for a plan, oldest first.
create function t.line(p_path text) returns text language sql as $$
  select coalesce(string_agg(i.name, ' ' order by pl.created_at, pl.id), '')
    from public.work_plan_places pl join t.ids i on i.id = pl.holder
   where pl.plan_id = t.plan_id(p_path)
$$;
-- The caller's gap has passed: its next call is a full evaluation.
create function t.later(p_user text, p_path text) returns void language sql as $$
  update public.work_plan_places set next_allowed_at = clock_timestamp() - interval '1 second'
   where plan_id = t.plan_id(p_path) and holder = t.id(p_user)
$$;
-- The holder stopped checking in: the place lapsed.
create function t.lapse_place(p_user text, p_path text) returns void language sql as $$
  update public.work_plan_places set expires_at = clock_timestamp() - interval '1 second', next_allowed_at = clock_timestamp() - interval '1 second'
   where plan_id = t.plan_id(p_path) and holder = t.id(p_user)
$$;
create function t.lapse_step(p_path text, p_key text) returns void language sql as $$
  update public.work_plan_steps set expires_at = clock_timestamp() - interval '1 second'
   where plan_id = t.plan_id(p_path) and key = p_key
$$;
create function t.events(p_event text, p_path text) returns text language sql as $$
  select coalesce(string_agg(coalesce(i.name, '?') || coalesce(' ' || (l.detail->>'reason'), '') || coalesce(' ' || (l.detail->>'place'), ''), ', ' order by l.seq), '')
    from public.log l left join t.ids i on i.id = l.actor
   where l.vault_id = t.id('wq') and l.event = p_event and l.path = p_path
$$;

-- ---------------------------------------------------------------------------
-- The tables: one way in

select t.plan('q/tables.md', '[{"key":"a","title":"A"}]');
insert into public.work_plan_places (plan_id, vault_id, holder, expires_at, next_allowed_at, last_place, last_ready)
values (t.plan_id('q/tables.md'), t.id('wq'), t.id('hal'), now() + interval '1 hour', now(), 1, 0);
insert into private.work_plan_strikes (vault_id, person, strikes, last_at) values (t.id('wq'), t.id('hal'), 1, now());

select t.expect('places: a person cannot take a place in line directly',
  t.run('ben', format($q$insert into public.work_plan_places (plan_id, vault_id, holder, expires_at, next_allowed_at, last_place, last_ready)
                        values (%L, %L, %L, now() + interval '1 hour', now(), 1, 0) returning 'took'$q$,
                      t.plan_id('q/tables.md'), t.id('wq'), t.id('ben'))), 'ERR 42501');
select t.expect('places: an agent cannot move a place up the line',
  t.run('ben', $q$update public.work_plan_places set created_at = '2000-01-01' returning 'moved'$q$, 'Claude Code'), 'ERR 42501');
select t.expect('places: an owner cannot remove someone else''s place directly',
  t.run('ana', $q$delete from public.work_plan_places returning 'removed'$q$), 'ERR 42501');
select t.expect('places: nobody reads strikes',
  t.run('ana', $q$select count(*)::text from private.work_plan_strikes$q$), 'ERR 42501');
select t.expect('places: nobody clears their own strikes',
  t.run('hal', $q$delete from private.work_plan_strikes returning 'cleared'$q$), 'ERR 42501');
select t.expect('places: nobody reads when a place may ask again',
  t.run('hal', $q$select next_allowed_at::text from public.work_plan_places$q$), 'ERR 42501');
select t.expect('places: a viewer sees who is waiting',
  t.run('cal', format($q$select string_agg(holder::text, ',') from public.work_plan_places where vault_id = %L$q$, t.id('wq'))),
  t.id('hal')::text);
select t.expect('places: an outsider sees no one waiting',
  t.run('dee', $q$select count(*)::text from public.work_plan_places$q$), '0');
select t.expect('places: a connection scoped to another vault sees no one waiting',
  t.run_tok('ana', 'wq-other-tok', $q$select count(*)::text from public.work_plan_places$q$), '0');
select t.expect_true('places: none of the refused attempts changed a place or a strike',
  (select count(*) from public.work_plan_places) = 1
  and (t.place('hal', 'q/tables.md')).created_at > '2000-01-02'
  and (select count(*) from private.work_plan_strikes) = 1);
select t.run('ana', format($q$select public.set_member(%L, %L, null)$q$, t.id('wq'), t.id('hal')));
select t.expect_true('places: a member who leaves the vault gives up their places and strikes',
  not exists (select 1 from public.work_plan_places where holder = t.id('hal'))
  and not exists (select 1 from private.work_plan_strikes where person = t.id('hal')));
select test_support.add_member(t.id('wq'), t.id('hal'), 'editor', t.id('ana'));

-- Deleting a vault takes its places and strikes with it.
insert into t.ids select 'wq-del', t.run('ana', $q$select public.create_vault('Waiting (deleted)')$q$)::uuid;
select test_support.add_member(t.id('wq-del'), t.id('ben'), 'editor', t.id('ana'));
select t.run('ana', format($q$select public.write_file(%L, 'p.md', 'a plan')::text$q$, t.id('wq-del')));
select t.run('ana', format($q$select public.register_work_plan(%L, 'p.md', %L, '[{"key":"a","title":"A"}]'::jsonb)::text$q$, t.id('wq-del'),
  (select current_version_id from public.files where vault_id = t.id('wq-del') and path = 'p.md')));
insert into public.work_plan_places (plan_id, vault_id, holder, expires_at, next_allowed_at, last_place, last_ready)
select id, vault_id, t.id('ben'), now() + interval '1 hour', now(), 1, 0 from public.work_plans where vault_id = t.id('wq-del');
insert into private.work_plan_strikes (vault_id, person, strikes, last_at) values (t.id('wq-del'), t.id('ben'), 1, now());
select t.run('ana', format($q$select public.delete_vault(%L, 'Waiting (deleted)')::text$q$, t.id('wq-del')));
select t.expect_true('places: deleting a vault deletes its places in line and its strikes',
  not exists (select 1 from public.vaults where id = t.id('wq-del'))
  and not exists (select 1 from public.work_plan_places where vault_id = t.id('wq-del'))
  and not exists (select 1 from private.work_plan_strikes where vault_id = t.id('wq-del')));

-- ---------------------------------------------------------------------------
-- request_work: who may ask, and each answer

select t.plan('q/one.md', '[{"key":"a","title":"A"}]');
select t.save('log-before', (select count(*)::text from public.log where vault_id = t.id('wq')));
select t.expect('request: anonymous callers can''t ask', t.run(null, t.rw_sql('q/one.md')), 'ERR 42501');
select t.expect('request: a viewer can''t ask', t.run('cal', t.rw_sql('q/one.md')), 'ERR 42501');
select t.expect('request: an outsider can''t ask', t.run('dee', t.rw_sql('q/one.md')), 'ERR 42501');
select t.expect('request: a read-only connection can''t ask', t.run_tok('ana', 'wq-ro', t.rw_sql('q/one.md')), 'ERR 42501');
select t.expect('request: a connection scoped to another vault can''t ask', t.run_tok('ana', 'wq-other-tok', t.rw_sql('q/one.md')), 'ERR 42501');
select t.expect('request: a label over 200 characters is refused', t.run('ben', t.rw_sql('q/one.md', repeat('x', 201))), 'ERR 22023');
select t.expect('request: a lease under a minute is refused', t.run('ben', t.rw_sql('q/one.md', null, 0)), 'ERR 22023');
select t.expect_true('request: none of the refused requests took a step or a place, or logged anything',
  (select count(*)::text from public.log where vault_id = t.id('wq')) = t.val('log-before')
  and not exists (select 1 from public.work_plan_places where plan_id = t.plan_id('q/one.md'))
  and not exists (select 1 from public.work_plan_steps where plan_id = t.plan_id('q/one.md') and status <> 'open'));

select t.expect('request: a path with no plan answers no_such_plan', t.rw('ben', 'q/none.md')->>'o_state', 'no_such_plan');

select t.save('ben-one', t.run('ben', t.rw_sql('q/one.md', 'tidying')));
select t.expect('request: with a step ready and nobody waiting, the step is granted',
  (t.j('ben-one') - 'o_secret' - 'o_expires')::text,
  '{"o_key": "a", "o_fence": 1, "o_place": 1, "o_ready": 1, "o_state": "granted", "o_wait_seconds": null}');
select t.expect_true('request: a grant returns the secret once and a lease from the claim rule (48 hours with none)',
  length(t.j('ben-one')->>'o_secret') = 64
  and (t.j('ben-one')->>'o_expires')::timestamptz between now() + interval '47 hours 59 minutes' and now() + interval '48 hours 1 minute');
select t.expect_true('request: the grant is the step''s claim, held by this person and connection, with the label',
  (select status = 'claimed' and holder = t.id('ben') and holder_token is null and holder_label = 'tidying' and fence = 1
          and secret_hash = encode(extensions.digest(t.j('ben-one')->>'o_secret', 'sha256'), 'hex')
     from public.work_plan_steps where plan_id = t.plan_id('q/one.md') and key = 'a'));
select t.expect('request: the grant is logged as step.claim, with the place it was granted at and the steps ready',
  (select string_agg(format('%s %s place %s ready %s', l.detail->>'step', l.detail->>'fence', l.detail->>'place', l.detail->>'ready'), ', ')
     from public.log l where l.vault_id = t.id('wq') and l.event = 'step.claim' and l.path = 'q/one.md' and l.actor = t.id('ben')),
  'a 1 place 1 ready 1');
select t.expect('request: a granted caller holds no place in line', t.line('q/one.md'), '');
select t.expect('request: the holder finishes the step it was granted', t.finish('ben', 'q/one.md', 'ben-one'), '');

-- Caps, from the claim rule: one step per connection and five per person by
-- default; here a folder rule allows two per person.
select t.run('ana', format($q$select public.set_claim_rule(%L, 'q/cap/', 60, 120, null, 1, 2)::text$q$, t.id('wq')));
select t.plan('q/cap/p.md', '[{"key":"a","title":"A"},{"key":"b","title":"B"},{"key":"c","title":"C"},{"key":"d","title":"D"}]');
select t.save('ben-cap', t.rw('ben', 'q/cap/p.md')::text);
select t.expect('request: a person''s connection holding a step is answered at_capacity', t.rw('ben', 'q/cap/p.md')->>'o_state', 'at_capacity');
select t.save('ben-cap-a', t.rw_tok('ben', 'ben-a', 'q/cap/p.md')::text);
select t.expect('request: another connection of the same person is still granted a step', t.j('ben-cap-a')->>'o_state', 'granted');
select t.expect('request: past the rule''s claims per person, every connection of theirs is answered at_capacity',
  t.rw_tok('ben', 'ben-b', 'q/cap/p.md')->>'o_state', 'at_capacity');
select t.save('eva-cap', t.rw('eva', 'q/cap/p.md')::text);
select t.expect('request: another person is still granted a step', t.j('eva-cap')->>'o_state', 'granted');
select t.expect('request: at capacity, nobody took a place in line', t.line('q/cap/p.md'), '');
select t.finish('ben', 'q/cap/p.md', 'ben-cap');
select t.finish('eva', 'q/cap/p.md', 'eva-cap');
select t.run_tok('ben', 'ben-a', format($q$select public.complete_step(%L, 'q/cap/p.md', %L, %L, %L)::text$q$, t.id('wq'),
  t.j('ben-cap-a')->>'o_key', (t.j('ben-cap-a')->>'o_fence')::int, t.j('ben-cap-a')->>'o_secret'));

-- Waiting, and asking again too soon.
select t.plan('q/wait.md', '[{"key":"a","title":"A"}]');
select t.save('jon-wait', t.rw('jon', 'q/wait.md')::text);
select t.save('fay-wait', t.run('fay', t.rw_sql('q/wait.md', 'fay''s agent'), 'Hermes'));
select t.expect('request: with nothing ready, the caller is answered wait, first in line, with nothing ready',
  (t.j('fay-wait')->>'o_state') || ' ' || (t.j('fay-wait')->>'o_place') || ' ' || (t.j('fay-wait')->>'o_ready'), 'wait 1 0');
select t.expect('request: and holds a place in line', t.line('q/wait.md'), 'fay');
select t.expect('request: taking a place is logged as queue.join, with the place', t.events('queue.join', 'q/wait.md'), 'fay 1');
select t.expect_true('request: the place keeps the caller''s label and agent',
  (t.place('fay', 'q/wait.md')).label = 'fay''s agent' and (t.place('fay', 'q/wait.md')).agent = 'Hermes');
select t.save('fay-place', (select xmin::text || ' ' || expires_at::text from public.work_plan_places where id = (t.place('fay', 'q/wait.md')).id));
select t.save('log-before', (select count(*)::text from public.log where vault_id = t.id('wq')));
select t.save('fay-again', t.run('fay', format($q$select string_agg(distinct format('%%s %%s %%s', r.o_state, r.o_place, r.o_ready), ',')
  from generate_series(1, 50) n, lateral public.request_work(%L, 'q/wait.md') r$q$, t.id('wq'))));
select t.expect('request: asking again too soon, fifty times, is answered with the last answer each time',
  t.val('fay-again'), 'wait 1 0');
select t.expect_true('request: asking again too soon writes nothing: the place is the same row version and nothing is logged',
  (select xmin::text || ' ' || expires_at::text from public.work_plan_places where id = (t.place('fay', 'q/wait.md')).id) = t.val('fay-place')
  and (select count(*)::text from public.log where vault_id = t.id('wq')) = t.val('log-before'));
select t.later('fay', 'q/wait.md');
select t.save('fay-wait2', t.rw('fay', 'q/wait.md')::text);
select t.expect_true('request: once its time has come, asking again refreshes the place and keeps its order',
  t.j('fay-wait2')->>'o_state' = 'wait' and (t.j('fay-wait2')->>'o_place')::int = 1
  and (t.place('fay', 'q/wait.md')).expires_at > split_part(t.val('fay-place'), ' ', 2)::timestamptz
  and t.events('queue.join', 'q/wait.md') = 'fay 1');

-- One place per person, however many connections.
select t.save('ben-a-wait', t.rw_tok('ben', 'ben-a', 'q/wait.md')::text);
select t.later('ben', 'q/wait.md');
select t.save('ben-b-wait', t.rw_tok('ben', 'ben-b', 'q/wait.md')::text);
select t.expect('request: two connections of one person share one place in line',
  (t.j('ben-a-wait')->>'o_place') || ' ' || (t.j('ben-b-wait')->>'o_place') || ' ' || t.line('q/wait.md'), '2 2 fay ben');
select t.later('ben', 'q/wait.md');
select t.expect('request: asking twice in one transaction answers both, and leaves one place',
  t.run_tok('ben', 'ben-b', format($q$select a.o_state || ' ' || b.o_state from public.request_work(%L, 'q/wait.md') a, public.request_work(%L, 'q/wait.md') b$q$,
    t.id('wq'), t.id('wq'))) || ' ' || t.line('q/wait.md'), 'wait wait fay ben');

-- A plan only a person can move.
select t.plan('q/cancel.md', '[{"key":"a","title":"A"},{"key":"b","title":"B","blocked_by":["a"]}]');
select t.run('ana', format($q$select public.cancel_step(%L, 'q/cancel.md', 'a')::text$q$, t.id('wq')));
select t.expect('request: a plan blocked by a cancelled step answers blocked_by_cancelled',
  t.rw('gus', 'q/cancel.md')->>'o_state', 'blocked_by_cancelled');
select t.expect('request: and takes no place in line', t.line('q/cancel.md'), '');

-- Three places per person in a vault.
select t.plan(p, '[{"key":"a","title":"A"}]') from unnest(array['q/r1.md', 'q/r2.md', 'q/r3.md', 'q/r4.md']) p;
select t.run('ana', format($q$select o_fence::text from public.claim_step(%L, %L, 'a')$q$, t.id('wq'), p))
  from unnest(array['q/r1.md', 'q/r2.md', 'q/r3.md', 'q/r4.md']) p;
select t.expect('request: a person takes a place in line on each of three plans',
  (select string_agg(t.rw('ivy', p)->>'o_state', ' ') from unnest(array['q/r1.md', 'q/r2.md', 'q/r3.md']) p), 'wait wait wait');
select t.expect('request: a fourth place in the vault is refused', t.rw('ivy', 'q/r4.md')->>'o_state', 'refused');
select t.expect('request: and not taken', t.line('q/r4.md'), '');
select t.expect('request: another person still takes a place there', t.rw('gus', 'q/r4.md')->>'o_state', 'wait');
select t.lapse_place('ivy', 'q/r1.md');
select t.expect('request: once one of the three lapses, the fourth is allowed', t.rw('ivy', 'q/r4.md')->>'o_state', 'wait');

-- A finished plan.
select t.plan('q/done.md', '[{"key":"a","title":"A"}]');
select t.save('eva-done', t.rw('eva', 'q/done.md')::text);
select t.rw('fay', 'q/done.md');
select t.rw('gus', 'q/done.md');
select t.finish('eva', 'q/done.md', 'eva-done');
select t.expect('request: before its time, a waiting caller still gets its last answer', t.rw('fay', 'q/done.md')->>'o_state', 'wait');
select t.later('fay', 'q/done.md');
select t.expect('request: once the plan is finished, a waiting caller is told plan_complete',
  t.rw('fay', 'q/done.md')->>'o_state', 'plan_complete');
select t.expect('request: a finished plan clears every place in its line', t.line('q/done.md'), '');
select t.expect('request: each cleared place is logged as queue.expire for its holder, with the reason',
  (select string_agg(e, ', ' order by e) from unnest(string_to_array(t.events('queue.expire', 'q/done.md'), ', ')) e),
  'fay plan_complete, gus plan_complete');
select t.expect('request: every other waiting caller is told plan_complete too', t.rw('gus', 'q/done.md')->>'o_state', 'plan_complete');

-- ---------------------------------------------------------------------------
-- The line: the k-th oldest live place may claim only if at least k steps
-- are ready

select t.finish('jon', 'q/wait.md', 'jon-wait');
select t.plan('q/turn.md', '[{"key":"a","title":"A"}]');
select t.save('hal-turn', t.rw('hal', 'q/turn.md')::text);
select t.rw('eva', 'q/turn.md');
select t.rw('fay', 'q/turn.md');
select t.expect('line: callers queue in the order they came', t.line('q/turn.md'), 'eva fay');
select t.give_back('hal', 'q/turn.md', 'hal-turn');
select t.later('fay', 'q/turn.md');
select t.save('fay-turn', t.rw('fay', 'q/turn.md')::text);
select t.expect('line: a younger place cannot jump ahead: second in line with one step ready, it waits',
  (t.j('fay-turn')->>'o_state') || ' ' || (t.j('fay-turn')->>'o_place') || ' ' || (t.j('fay-turn')->>'o_ready'), 'wait 2 1');
select t.later('eva', 'q/turn.md');
select t.save('eva-turn', t.rw('eva', 'q/turn.md')::text);
select t.expect('line: the oldest waiting caller gets the next ready step',
  (t.j('eva-turn')->>'o_state') || ' ' || (t.j('eva-turn')->>'o_place'), 'granted 1');
select t.expect('line: and leaves the line, so the next one moves up', t.line('q/turn.md'), 'fay');
select t.finish('eva', 'q/turn.md', 'eva-turn');

select t.plan('q/pair.md', '[{"key":"x","title":"X"},{"key":"a","title":"A","blocked_by":["x"]},{"key":"b","title":"B","blocked_by":["x"]}]');
select t.save('hal-pair', t.rw('hal', 'q/pair.md')::text);
select t.rw(p, 'q/pair.md') from unnest(array['eva', 'gus', 'jon']) p;
select t.finish('hal', 'q/pair.md', 'hal-pair');
select t.later(p, 'q/pair.md') from unnest(array['eva', 'gus', 'jon']) p;
select t.save('jon-pair', t.rw('jon', 'q/pair.md')::text);
select t.save('gus-pair', t.rw('gus', 'q/pair.md')::text);
select t.save('eva-pair', t.rw('eva', 'q/pair.md')::text);
select t.expect('line: when two steps are ready, the two oldest each get one and the third waits',
  format('eva %s %s, gus %s %s, jon %s %s', t.j('eva-pair')->>'o_state', t.j('eva-pair')->>'o_key', t.j('gus-pair')->>'o_state',
    t.j('gus-pair')->>'o_key', t.j('jon-pair')->>'o_state', t.j('jon-pair')->>'o_place'),
  'eva granted b, gus granted a, jon wait 3');
select t.finish('eva', 'q/pair.md', 'eva-pair');
select t.finish('gus', 'q/pair.md', 'gus-pair');

-- Dropping out, and coming back late.
select t.plan('q/drop.md', '[{"key":"a","title":"A"}]');
select t.save('hal-drop', t.rw('hal', 'q/drop.md')::text);
select t.rw('eva', 'q/drop.md');
select t.rw('jon', 'q/drop.md');
select t.give_back('hal', 'q/drop.md', 'hal-drop');
select t.later('jon', 'q/drop.md');
select t.expect('line: while the head of the line still checks in, the next one waits', t.rw('jon', 'q/drop.md')->>'o_state', 'wait');
select t.lapse_place('eva', 'q/drop.md');
select t.later('jon', 'q/drop.md');
select t.save('jon-drop', t.rw('jon', 'q/drop.md')::text);
select t.expect('line: once the head stops checking in for the place-in-line time, it drops out and the next one is served',
  (t.j('jon-drop')->>'o_state') || ' ' || (t.j('jon-drop')->>'o_place'), 'granted 1');
select t.expect('line: the lapsed place is logged as queue.expire for its holder', t.events('queue.expire', 'q/drop.md'), 'eva lapsed');
select t.rw('gus', 'q/drop.md');
select t.save('eva-drop', t.rw('eva', 'q/drop.md')::text);
select t.expect('line: a caller that comes back late starts at the back of the line',
  (t.j('eva-drop')->>'o_state') || ' ' || (t.j('eva-drop')->>'o_place') || ' ' || t.line('q/drop.md'), 'wait 2 gus eva');
select t.lapse_place('gus', 'q/drop.md');
select t.later('eva', 'q/drop.md');
select t.save('eva-drop', t.rw('eva', 'q/drop.md')::text);
select t.expect('line: a lapsed place no longer counts ahead of anyone, even before it is cleared',
  (t.j('eva-drop')->>'o_place') || ' ' || t.line('q/drop.md'), '1 eva');
select t.finish('jon', 'q/drop.md', 'jon-drop');

-- The suggested time.
select t.plan('q/hint.md', '[{"key":"a","title":"A"}]');
select t.save('hal-hint', t.rw('hal', 'q/hint.md')::text);
select t.save('kim-hint', t.rw('kim', 'q/hint.md')::text);
select t.expect('line: with no rule, the suggested time is the longest hint, an hour, though the earliest lease ends in 48 hours',
  t.j('kim-hint')->>'o_wait_seconds', '3600');
select t.expect_true('line: and the caller may ask again after the minimum gap, 15 minutes, not later',
  (t.place('kim', 'q/hint.md')).next_allowed_at between now() + interval '14 minutes 58 seconds' and now() + interval '15 minutes 1 second');
select t.plan('q/hint2.md', '[{"key":"a","title":"A"}]');
select t.run('ana', format($q$select o_fence::text from public.claim_step(%L, 'q/hint2.md', 'a', null, 5)$q$, t.id('wq')));
select t.save('kim-hint2', t.rw('kim', 'q/hint2.md')::text);
select t.expect_true('line: a lease ending sooner suggests its end',
  (t.j('kim-hint2')->>'o_wait_seconds')::int between 295 and 300);
select t.expect_true('line: and the caller may ask again then',
  (t.place('kim', 'q/hint2.md')).next_allowed_at between now() + interval '4 minutes 55 seconds' and now() + interval '5 minutes 1 second');
select t.run('ana', format($q$select public.set_claim_rule(%L, 'q/hint/', 120, 240, null, 1, 5, 30, 2, 10)::text$q$, t.id('wq')));
select t.plan('q/hint/p.md', '[{"key":"a","title":"A"}]');
select t.save('lee-hint', t.rw('lee', 'q/hint/p.md')::text);
select t.save('fay-hint', t.rw('fay', 'q/hint/p.md')::text);
select t.expect('line: a rule''s longest hint caps the suggested time (2 minutes, with a 2 hour lease held)',
  t.j('fay-hint')->>'o_wait_seconds', '120');
select t.expect_true('line: the rule''s minimum gap is when the caller may ask again, and its place-in-line time when the place lapses',
  (t.place('fay', 'q/hint/p.md')).next_allowed_at between now() + interval '9 seconds' and now() + interval '11 seconds'
  and (t.place('fay', 'q/hint/p.md')).expires_at between now() + interval '29 minutes 59 seconds' and now() + interval '30 minutes 1 second');
select t.finish('hal', 'q/hint.md', 'hal-hint');
select t.finish('lee', 'q/hint/p.md', 'lee-hint');

-- ---------------------------------------------------------------------------
-- Strikes: a claim let lapse, taken over from the line, counts against its
-- person; past the free one, a cooldown that doubles up to the rule's cap

-- Lease 10 minutes, hold 1 hour, 1 per connection, 5 per person, a place
-- lives 30 minutes, longest hint 5 minutes, gap 10 seconds, 1 free lapse,
-- cooldown at most 25 minutes.
select t.run('ana', format($q$select public.set_claim_rule(%L, 'q/st/', 10, 60, null, 1, 5, 30, 5, 10, 1, 25)::text$q$, t.id('wq')));
select t.plan(p, '[{"key":"a","title":"A"}]')
  from unnest(array['q/st/p1.md', 'q/st/p2.md', 'q/st/p3.md', 'q/st/p4.md', 'q/st/p5.md']) p;
create function t.strike_row(p_user text) returns text language sql as $$
  select strikes || ' ' || coalesce(round(extract(epoch from cooldown_until - clock_timestamp()) / 60)::text, 'none')
    from private.work_plan_strikes where vault_id = t.id('wq') and person = t.id(p_user)
$$;
create function t.cool_off(p_user text) returns void language sql as $$
  update private.work_plan_strikes set cooldown_until = clock_timestamp() - interval '1 second'
   where vault_id = t.id('wq') and person = t.id(p_user)
$$;

select t.save('kim-1', t.rw('kim', 'q/st/p1.md')::text);
select t.lapse_step('q/st/p1.md', 'a');
select t.save('lee-1', t.rw('lee', 'q/st/p1.md')::text);
select t.expect('strikes: a lapsed step is granted to the next caller', (t.j('lee-1')->>'o_state') || ' ' || (t.j('lee-1')->>'o_fence'), 'granted 2');
select t.expect('strikes: the first claim a person lets lapse is a strike with no cooldown', t.strike_row('kim'), '1 none');
select t.finish('lee', 'q/st/p1.md', 'lee-1');
select t.save('kim-2', t.rw('kim', 'q/st/p2.md')::text);
select t.expect('strikes: so the person is still served at once', t.j('kim-2')->>'o_state', 'granted');

select t.expect('strikes: before the second lapse, the person holds places in other lines', t.line('q/hint.md') || ', ' || t.line('q/hint2.md'), 'kim, kim');
select t.lapse_step('q/st/p2.md', 'a');
select t.save('lee-2', t.rw('lee', 'q/st/p2.md')::text);
select t.expect('strikes: the second lapse earns a cooldown of the rule''s lease', t.strike_row('kim'), '2 10');
select t.expect('strikes: a person entering a cooldown gives up every place they hold in the vault''s lines',
  t.line('q/hint.md') || ', ' || t.line('q/hint2.md'), ', ');
select t.expect('strikes: each given-up place is logged as queue.expire for its holder, reason cooling_down',
  t.events('queue.expire', 'q/hint.md') || ', ' || t.events('queue.expire', 'q/hint2.md'), 'kim cooling_down, kim cooling_down');
select t.save('kim-3', t.rw('kim', 'q/st/p3.md')::text);
select t.expect_true('strikes: a person cooling down is answered cooling_down, with how long',
  t.j('kim-3')->>'o_state' = 'cooling_down' and (t.j('kim-3')->>'o_wait_seconds')::int between 595 and 600);
select t.expect('strikes: and takes no place in line', t.line('q/st/p3.md'), '');
select t.expect('strikes: another person is served meanwhile', t.rw('ivy', 'q/st/p3.md')->>'o_state', 'granted');
select t.finish('lee', 'q/st/p2.md', 'lee-2');

select t.cool_off('kim');
select t.save('kim-4', t.rw('kim', 'q/st/p4.md')::text);
select t.expect('strikes: once the cooldown is over, the person is served', t.j('kim-4')->>'o_state', 'granted');
select t.lapse_step('q/st/p4.md', 'a');
select t.save('lee-4', t.rw('lee', 'q/st/p4.md')::text);
select t.expect('strikes: each later lapse doubles the cooldown', t.strike_row('kim'), '3 20');
select t.finish('lee', 'q/st/p4.md', 'lee-4');

select t.cool_off('kim');
select t.save('kim-5', t.rw('kim', 'q/st/p5.md')::text);
select t.lapse_step('q/st/p5.md', 'a');
select t.save('lee-5', t.rw('lee', 'q/st/p5.md')::text);
select t.expect('strikes: the cooldown never passes the rule''s cap', t.strike_row('kim'), '4 25');
select t.finish('lee', 'q/st/p5.md', 'lee-5');

select t.cool_off('kim');
select t.plan('q/st/p6.md', '[{"key":"a","title":"A"}]');
select t.save('kim-6', t.rw('kim', 'q/st/p6.md')::text);
select t.expect('strikes: finishing a step clears the person''s strikes', t.finish('kim', 'q/st/p6.md', 'kim-6') || coalesce(t.strike_row('kim'), 'none'), 'none');

-- ---------------------------------------------------------------------------
-- leave_queue: give up your own place

select t.plan('q/leave.md', '[{"key":"a","title":"A"}]');
select t.run('ana', format($q$select o_fence::text from public.claim_step(%L, 'q/leave.md', 'a')$q$, t.id('wq')));
select t.rw(p, 'q/leave.md') from unnest(array['lee', 'hal', 'jon']) p;
create function t.leave_sql(p_path text) returns text language sql as $$
  select format($q$select public.leave_queue(%L, %L)::text$q$, t.id('wq'), p_path)
$$;
select t.expect('leave: anonymous callers can''t leave a line', t.run(null, t.leave_sql('q/leave.md')), 'ERR 42501');
select t.expect('leave: a viewer can''t', t.run('cal', t.leave_sql('q/leave.md')), 'ERR 42501');
select t.expect('leave: a read-only connection can''t', t.run_tok('ana', 'wq-ro', t.leave_sql('q/leave.md')), 'ERR 42501');
select t.expect('leave: a connection scoped to another vault can''t', t.run_tok('ana', 'wq-other-tok', t.leave_sql('q/leave.md')), 'ERR 42501');
select t.expect('leave: an owner leaving takes nobody else out of line',
  t.run('ana', t.leave_sql('q/leave.md')) || ' ' || t.line('q/leave.md'), 'false lee hal jon');
select t.expect('leave: a caller leaves the line', t.run('lee', t.leave_sql('q/leave.md')), 'true');
select t.expect('leave: and everyone else keeps their place', t.line('q/leave.md'), 'hal jon');
select t.later('jon', 'q/leave.md');
select t.expect('leave: those behind it move up', t.rw('jon', 'q/leave.md')->>'o_place', '2');
select t.expect('leave: leaving is logged as queue.leave', t.events('queue.leave', 'q/leave.md'), 'lee');
select t.expect('leave: leaving again, with no place, answers false and logs nothing',
  t.run('lee', t.leave_sql('q/leave.md')) || ' ' || t.events('queue.leave', 'q/leave.md'), 'false lee');
select t.expect('leave: an agent leaves its person''s place', t.run('hal', t.leave_sql('q/leave.md'), 'Claude Code') || ' ' || t.line('q/leave.md'), 'true jon');
select t.expect('leave: a path with no plan answers false', t.run('jon', t.leave_sql('q/none.md')), 'false');
