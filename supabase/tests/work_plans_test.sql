-- Hostile tests for work plans (20261002200000_work_plans, CL-3.2): the
-- SQL layer's own re-validation of a plan's steps (register_work_plan
-- trusts nothing the client already checked), the stored open_blockers
-- count staying right through claim/complete/release/cancel/skip, and
-- the access rules the migration introduces. The concurrent "claim and
-- ready in one statement" property and the delete_vault lock order are
-- CL-3.3's job, not this file's (this migration's own header explains
-- why), same split path_claims_test.sql and claims_lock_order.sql used.

insert into t.ids select 'wp', t.run('ana', $q$select public.create_vault('Work plans')$q$)::uuid;
select test_support.add_member(t.id('wp'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('wp'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.create_access_token('wp-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('wp')));

-- A second, unrelated vault, for the cross-vault RLS check at the end.
insert into t.ids select 'wp-other', t.run('ana', $q$select public.create_vault('Work plans (other)')$q$)::uuid;
select t.run('ana', format($q$select public.create_access_token('wp-other-tok', 30, array[%L]::uuid[], 'write')$q$, t.id('wp-other')));

create table t.vals (name text primary key, val text);
create function t.save(p_name text, p_val text) returns text language sql as $$
  insert into t.vals values (p_name, p_val) on conflict (name) do update set val = excluded.val returning val
$$;
create function t.val(p_name text) returns text language sql as $$ select val from t.vals where name = p_name $$;

create function t.seed_sql(p_path text, p_body text default 'a plan') returns text language sql as $$
  select format($q$select public.write_file(%L, %L, %L)::text$q$, t.id('wp'), p_path, p_body)
$$;
create function t.register_sql(p_path text, p_version text, p_steps jsonb) returns text language sql as $$
  select format($q$select public.register_work_plan(%L, %L, %L, %L::jsonb)::text$q$,
    t.id('wp'), p_path, p_version, p_steps::text)
$$;
create function t.claim_sql(p_path text, p_key text, p_label text default null, p_ttl int default null) returns text language sql as $$
  select format($q$select o_secret from public.claim_step(%L, %L, %L, %L, %L)$q$, t.id('wp'), p_path, p_key, p_label, p_ttl)
$$;
create function t.complete_sql(p_path text, p_key text, p_fence int, p_secret text) returns text language sql as $$
  select format($q$select public.complete_step(%L, %L, %L, %L, %L)::text$q$, t.id('wp'), p_path, p_key, p_fence, p_secret)
$$;
create function t.release_sql(p_path text, p_key text, p_fence int, p_secret text) returns text language sql as $$
  select format($q$select public.release_step(%L, %L, %L, %L, %L)::text$q$, t.id('wp'), p_path, p_key, p_fence, p_secret)
$$;
create function t.cancel_sql(p_path text, p_key text) returns text language sql as $$
  select format($q$select public.cancel_step(%L, %L, %L)::text$q$, t.id('wp'), p_path, p_key)
$$;
create function t.skip_sql(p_path text, p_key text) returns text language sql as $$
  select format($q$select public.skip_step(%L, %L, %L)::text$q$, t.id('wp'), p_path, p_key)
$$;
create function t.step(p_path text, p_key text) returns public.work_plan_steps language sql as $$
  select s.* from public.work_plan_steps s
    join public.work_plans p on p.id = s.plan_id
   where p.vault_id = t.id('wp') and p.path = p_path and s.key = p_key
$$;
create function t.status(p_path text, p_key text) returns text language sql as $$
  select o_state from public.work_plan_status(t.id('wp'), p_path) where o_key = p_key
$$;

-- ---------------------------------------------------------------------------
-- register_work_plan: re-validation, independent of mcp/src/workplan-format.ts

select t.run('ben', t.seed_sql('plans/bad.md'));
select t.save('bad-version', (select current_version_id::text from public.files where vault_id = t.id('wp') and path = 'plans/bad.md'));

select t.expect('register: a duplicate key is refused',
  t.run('ben', t.register_sql('plans/bad.md', t.val('bad-version'), '[{"key":"a","title":"A"},{"key":"a","title":"B"}]'::jsonb)),
  'ERR 22023');
select t.expect('register: an unknown blocker is refused',
  t.run('ben', t.register_sql('plans/bad.md', t.val('bad-version'), '[{"key":"a","title":"A","blocked_by":["zzz"]}]'::jsonb)),
  'ERR 22023');
select t.expect('register: a self-dependency is refused',
  t.run('ben', t.register_sql('plans/bad.md', t.val('bad-version'), '[{"key":"a","title":"A","blocked_by":["a"]}]'::jsonb)),
  'ERR 22023');
select t.expect('register: a longer cycle is refused',
  t.run('ben', t.register_sql('plans/bad.md', t.val('bad-version'),
    '[{"key":"a","title":"A","blocked_by":["b"]},{"key":"b","title":"B","blocked_by":["a"]}]'::jsonb)),
  'ERR 22023');
select t.expect('register: a missing title is refused',
  t.run('ben', t.register_sql('plans/bad.md', t.val('bad-version'), '[{"key":"a"}]'::jsonb)), 'ERR 22023');
select t.expect('register: a title over 200 characters is refused',
  t.run('ben', t.register_sql('plans/bad.md', t.val('bad-version'),
    jsonb_build_array(jsonb_build_object('key', 'a', 'title', repeat('x', 201))))), 'ERR 22023');
select t.expect('register: an invalid key is refused',
  t.run('ben', t.register_sql('plans/bad.md', t.val('bad-version'), '[{"key":"Not_Valid","title":"A"}]'::jsonb)), 'ERR 22023');
select t.expect('register: an invalid gate is refused',
  t.run('ben', t.register_sql('plans/bad.md', t.val('bad-version'), '[{"key":"a","title":"A","gate":"maybe"}]'::jsonb)), 'ERR 22023');
select t.expect('register: no steps at all is refused',
  t.run('ben', t.register_sql('plans/bad.md', t.val('bad-version'), '[]'::jsonb)), 'ERR 22023');
select t.expect('register: more than 500 steps is refused',
  t.run('ben', t.register_sql('plans/bad.md', t.val('bad-version'),
    (select jsonb_agg(jsonb_build_object('key', 'k' || g, 'title', 'T')) from generate_series(1, 501) g))), 'ERR 22023');
select t.expect('register: more than 50 blockers on one step is refused',
  t.run('ben', t.register_sql('plans/bad.md', t.val('bad-version'),
    jsonb_build_array(jsonb_build_object('key', 'top', 'title', 'Top',
      'blocked_by', (select jsonb_agg('b' || g) from generate_series(1, 51) g))))),
  'ERR 22023');
select t.expect_true('register: none of the refused attempts registered a plan',
  not exists (select 1 from public.work_plans where vault_id = t.id('wp') and path = 'plans/bad.md'));

select t.expect('register: a stale version is refused',
  t.run('ben', t.register_sql('plans/bad.md', gen_random_uuid()::text, '[{"key":"a","title":"A"}]'::jsonb)), 'ERR RLF01');
select t.expect('register: a missing file is refused',
  t.run('ben', t.register_sql('plans/missing.md', null, '[{"key":"a","title":"A"}]'::jsonb)), 'ERR P0002');
select t.expect('register: a viewer is refused',
  t.run('cal', t.register_sql('plans/bad.md', t.val('bad-version'), '[{"key":"a","title":"A"}]'::jsonb)), 'ERR 42501');
select t.expect('register: a read-only connection is refused',
  t.run_tok('ana', 'wp-ro', t.register_sql('plans/bad.md', t.val('bad-version'), '[{"key":"a","title":"A"}]'::jsonb)), 'ERR 42501');

-- A real chain: a -> b -> c, and a diamond d needs both b and c.
select t.run('ben', t.seed_sql('plans/p.md'));
select t.save('p-version', (select current_version_id::text from public.files where vault_id = t.id('wp') and path = 'plans/p.md'));
select t.save('p-id', t.run('ben', t.register_sql('plans/p.md', t.val('p-version'),
  '[{"key":"a","title":"Fetch"},
    {"key":"b","title":"Clean","blocked_by":["a"],"cites":[{"path":"docs/x.md","version":"3fa85f64-5717-4562-b3fc-2c963f66afa6"}]},
    {"key":"c","title":"Check","blocked_by":["a"]},
    {"key":"d","title":"Ship","blocked_by":["b","c"],"gate":"review"}]'::jsonb)));
select t.expect_true('register: a valid plan creates one row per step with the right open_blockers',
  (t.step('plans/p.md', 'a')).open_blockers = 0 and (t.step('plans/p.md', 'b')).open_blockers = 1
    and (t.step('plans/p.md', 'c')).open_blockers = 1 and (t.step('plans/p.md', 'd')).open_blockers = 2);
select t.expect_true('register: gate is stored', (t.step('plans/p.md', 'd')).gate = 'review');
select t.expect_true('register: cites is stored',
  exists (select 1 from public.work_plan_step_cites c where c.step_id = (t.step('plans/p.md', 'b')).id and c.path = 'docs/x.md'));
select t.expect('register: the same path twice is refused',
  t.run('ben', t.register_sql('plans/p.md', t.val('p-version'), '[{"key":"x","title":"X"}]'::jsonb)), 'ERR 23505');

-- ---------------------------------------------------------------------------
-- claim_step: the claim and "every blocker is done" in one statement

select t.expect('claim: a step with an unfinished blocker is refused',
  t.run('ben', t.claim_sql('plans/p.md', 'd')), 'ERR RLW02');
select t.expect('claim: an unknown step is refused',
  t.run('ben', t.claim_sql('plans/p.md', 'zzz')), 'ERR P0002');
select t.expect('claim: an unregistered plan is refused',
  t.run('ben', t.claim_sql('plans/nope.md', 'a')), 'ERR P0002');
select t.expect('claim: a viewer is refused',
  t.run('cal', t.claim_sql('plans/p.md', 'a')), 'ERR 42501');

select t.save('a', t.run('ben', t.claim_sql('plans/p.md', 'a', 'Ben''s agent')));
select t.expect_true('claim: a ready step is claimed, fence 1, label recorded',
  (t.step('plans/p.md', 'a')).fence = 1 and (t.step('plans/p.md', 'a')).holder_label = 'Ben''s agent');
select t.expect('claim: the same step is refused while actively held',
  t.run('ana', t.claim_sql('plans/p.md', 'a')), 'ERR RLW01');

update public.work_plan_steps set expires_at = now() - interval '1 second'
 where id = (t.step('plans/p.md', 'a')).id;
select t.save('a2', t.run('ana', t.claim_sql('plans/p.md', 'a')));
select t.expect_true('claim: an expired claim is reclaimed, fence keeps counting up',
  t.val('a2') ~ '^[0-9a-f]{64}$' and (t.step('plans/p.md', 'a')).fence = 2);

-- ---------------------------------------------------------------------------
-- complete_step: identity, then unblocking dependents

select t.expect('complete: a stale fence is refused',
  t.run('ana', t.complete_sql('plans/p.md', 'a', 999, t.val('a2'))), 'ERR RLW03');
select t.expect('complete: a different connection is refused',
  t.run_tok('ana', 'wp-ro', t.complete_sql('plans/p.md', 'a', (t.step('plans/p.md', 'a')).fence, t.val('a2'))), 'ERR RLW03');
select t.expect('complete: the right fence, secret, connection and person succeeds',
  t.run('ana', t.complete_sql('plans/p.md', 'a', (t.step('plans/p.md', 'a')).fence, t.val('a2'))), '');
select t.expect_true('complete: a is done', (t.step('plans/p.md', 'a')).status = 'done');
select t.expect_true('complete: b and c lost one blocker each and are now ready',
  (t.step('plans/p.md', 'b')).open_blockers = 0 and (t.step('plans/p.md', 'c')).open_blockers = 0);
select t.expect_true('complete: d still has both blockers (b and c are not done yet)',
  (t.step('plans/p.md', 'd')).open_blockers = 2);
select t.expect('complete: completing an already-done step is refused',
  t.run('ana', t.complete_sql('plans/p.md', 'a', (t.step('plans/p.md', 'a')).fence, t.val('a2'))), 'ERR RLW03');

-- ---------------------------------------------------------------------------
-- release_step: gives a claimed step back, reclaimable right away

select t.save('b', t.run('ben', t.claim_sql('plans/p.md', 'b')));
select t.expect('release: a stale fence is refused',
  t.run('ben', t.release_sql('plans/p.md', 'b', 999, t.val('b'))), 'ERR RLW03');
select t.expect('release: the right fence and secret frees it',
  t.run('ben', t.release_sql('plans/p.md', 'b', (t.step('plans/p.md', 'b')).fence, t.val('b'))), '');
select t.expect_true('release: b is open again', (t.step('plans/p.md', 'b')).status = 'open');
select t.expect_true('release: b is claimable again right away',
  (t.run('ana', t.claim_sql('plans/p.md', 'b'))) ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- cancel_step: person only, never unblocks

select t.expect('cancel: an agent cannot cancel a step',
  t.run('ana', t.cancel_sql('plans/p.md', 'c'), 'Claude Code'), 'ERR 42501');
select t.expect('cancel: a viewer cannot cancel a step',
  t.run('cal', t.cancel_sql('plans/p.md', 'c')), 'ERR 42501');
select t.expect('cancel: an owner, in person, cancels it',
  t.run('ana', t.cancel_sql('plans/p.md', 'c')), '');
select t.expect_true('cancel: c is cancelled', (t.step('plans/p.md', 'c')).status = 'cancelled');
select t.expect_true('cancel: d is never unblocked by a cancellation (still has 2)', (t.step('plans/p.md', 'd')).open_blockers = 2);
select t.expect('cancel: claiming a cancelled step is refused',
  t.run('ben', t.claim_sql('plans/p.md', 'c')), 'ERR RLW02');
select t.expect('cancel: cancelling an already-cancelled step is refused',
  t.run('ana', t.cancel_sql('plans/p.md', 'c')), 'ERR RLW02');

-- ---------------------------------------------------------------------------
-- skip_step: person only, marks done and does unblock, without needing
-- the holder's secret (b is actively claimed by Ana, from release_step's
-- last check above)

select t.expect('skip: an agent cannot skip a step',
  t.run('ana', t.skip_sql('plans/p.md', 'b'), 'Claude Code'), 'ERR 42501');
select t.expect('skip: a person skips an actively claimed step with no secret at all',
  t.run('ana', t.skip_sql('plans/p.md', 'b')), '');
select t.expect_true('skip: b is done', (t.step('plans/p.md', 'b')).status = 'done');
select t.expect('skip: skipping an already-done step is refused',
  t.run('ana', t.skip_sql('plans/p.md', 'b')), 'ERR RLW02');
select t.expect('skip: skipping a cancelled step is refused',
  t.run('ana', t.skip_sql('plans/p.md', 'c')), 'ERR RLW02');

-- ---------------------------------------------------------------------------
-- computed status (work_plan_status): d is blocked_by_cancelled (c is
-- cancelled), never just "blocked", even once b (its other blocker) is done

select t.expect('status: a step blocked by a cancelled one reads blocked_by_cancelled, not blocked',
  t.status('plans/p.md', 'd'), 'blocked_by_cancelled');
select t.expect('status: a done step reads done', t.status('plans/p.md', 'b'), 'done');
select t.expect('status: a cancelled step reads cancelled', t.status('plans/p.md', 'c'), 'cancelled');
select t.expect('status: an outsider sees no steps', t.run('dee', format(
  $q$select count(*)::text from public.work_plan_status(%L, 'plans/p.md')$q$, t.id('wp'))), '0');

-- ---------------------------------------------------------------------------
-- tables: closed to direct writes, two columns never selectable, and
-- invisible outside the vault (RLS, not app-level filtering)

select t.expect('tables: no direct insert into work_plans',
  t.run('ben', format($q$insert into public.work_plans (vault_id, path, version_id, registered_by) values (%L, 'direct.md', gen_random_uuid(), %L) returning 'x'$q$,
    t.id('wp'), t.id('ben'))), 'ERR 42501');
select t.expect('tables: no direct insert into work_plan_steps',
  t.run('ben', format($q$insert into public.work_plan_steps (plan_id, vault_id, key, title) values (%L, %L, 'x', 'X') returning 'x'$q$,
    t.val('p-id'), t.id('wp'))), 'ERR 42501');
select t.expect('tables: no direct update of a step',
  t.run('ben', format($q$update public.work_plan_steps set status = 'done' where id = %L returning 'x'$q$, (t.step('plans/p.md', 'd')).id)),
  'ERR 42501');
select t.expect('tables: no direct delete of a step',
  t.run('ben', format($q$delete from public.work_plan_steps where id = %L returning 'x'$q$, (t.step('plans/p.md', 'd')).id)),
  'ERR 42501');
select t.expect('tables: the secret hash is not a selectable column',
  t.run('ben', format($q$select secret_hash from public.work_plan_steps where id = %L$q$, (t.step('plans/p.md', 'd')).id)), 'ERR 42501');
select t.expect('tables: the holder token is not a selectable column',
  t.run('ben', format($q$select holder_token::text from public.work_plan_steps where id = %L$q$, (t.step('plans/p.md', 'd')).id)), 'ERR 42501');

select t.expect('rls: an outsider sees no work plans in a vault they are not in',
  t.run('dee', format($q$select count(*)::text from public.work_plans where vault_id = %L$q$, t.id('wp'))), '0');
select t.expect('rls: a connection scoped to another vault sees no steps here either',
  t.run_tok('ana', 'wp-other-tok', format($q$select count(*)::text from public.work_plan_steps where vault_id = %L$q$, t.id('wp'))), '0');

-- ---------------------------------------------------------------------------
-- checkin_step (20261002210000_work_plan_checkin): restarts a claimed
-- step's lease without finishing it, the same identity check complete_step
-- and release_step already have

create function t.checkin_sql(p_path text, p_key text, p_fence int, p_secret text, p_ttl int default null) returns text language sql as $$
  select format($q$select public.checkin_step(%L, %L, %L, %L, %L, %L)::text$q$, t.id('wp'), p_path, p_key, p_fence, p_secret, p_ttl)
$$;

select t.run('ben', t.seed_sql('plans/checkin.md'));
select t.save('checkin-version', (select current_version_id::text from public.files where vault_id = t.id('wp') and path = 'plans/checkin.md'));
select t.run('ben', t.register_sql('plans/checkin.md', t.val('checkin-version'), '[{"key":"x","title":"X"}]'::jsonb));
select t.save('x', t.run('ben', t.claim_sql('plans/checkin.md', 'x', 'Ben''s agent')));

select t.expect('checkin: a stale fence is refused',
  t.run('ben', t.checkin_sql('plans/checkin.md', 'x', 999, t.val('x'))), 'ERR RLW03');
select t.expect('checkin: a stale secret is refused',
  t.run('ben', t.checkin_sql('plans/checkin.md', 'x', (t.step('plans/checkin.md', 'x')).fence, 'wrong-secret')), 'ERR RLW03');
select t.expect('checkin: a different connection (even the same person) is refused',
  t.run_tok('ana', 'wp-ro', t.checkin_sql('plans/checkin.md', 'x', (t.step('plans/checkin.md', 'x')).fence, t.val('x'))), 'ERR RLW03');
select t.expect('checkin: an unknown step is refused',
  t.run('ben', t.checkin_sql('plans/checkin.md', 'zzz', 1, t.val('x'))), 'ERR P0002');
select t.expect('checkin: an unregistered plan is refused',
  t.run('ben', t.checkin_sql('plans/nope.md', 'x', 1, t.val('x'))), 'ERR P0002');

select t.save('x-expires-before', (t.step('plans/checkin.md', 'x')).expires_at::text);
select t.run('ben', t.checkin_sql('plans/checkin.md', 'x', (t.step('plans/checkin.md', 'x')).fence, t.val('x')));
select t.expect_true('checkin: the right fence, secret, connection and person extends the lease',
  (t.step('plans/checkin.md', 'x')).expires_at > t.val('x-expires-before')::timestamptz);

update public.work_plan_steps set expires_at = now() - interval '1 second' where id = (t.step('plans/checkin.md', 'x')).id;
select t.expect('checkin: a lapsed lease is refused',
  t.run('ben', t.checkin_sql('plans/checkin.md', 'x', (t.step('plans/checkin.md', 'x')).fence, t.val('x'))), 'ERR RLW03');

-- Un-lapse it directly (checkin_step itself refuses to, by design) so the
-- hold limit below is isolated from the lapse check above.
update public.work_plan_steps set expires_at = now() + interval '5 minutes' where id = (t.step('plans/checkin.md', 'x')).id;

-- ---------------------------------------------------------------------------
-- checkin_step's hold limit: counted from the original claim_step grant
-- (claimed_at), not the last check-in, the same shape renew_claim already
-- gives path claims

update public.work_plan_steps set claimed_at = now() - interval '6 days 23 hours' where id = (t.step('plans/checkin.md', 'x')).id;
select t.save('x-claimed', (t.step('plans/checkin.md', 'x')).claimed_at::text);
select t.run('ben', t.checkin_sql('plans/checkin.md', 'x', (t.step('plans/checkin.md', 'x')).fence, t.val('x'), 120));
select t.expect_true('hold limit: a check-in is capped at the original claim plus 7 days, not the full request',
  abs(extract(epoch from ((t.step('plans/checkin.md', 'x')).expires_at - (t.val('x-claimed')::timestamptz + interval '7 days')))) < 1);

update public.work_plan_steps set claimed_at = now() - interval '8 days' where id = (t.step('plans/checkin.md', 'x')).id;
select t.expect('hold limit: past it, a check-in is refused outright',
  t.run('ben', t.checkin_sql('plans/checkin.md', 'x', (t.step('plans/checkin.md', 'x')).fence, t.val('x'), 120)), 'ERR RLW04');
