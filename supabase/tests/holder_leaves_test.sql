-- A held step survives its holder leaving (20261017130000_release_steps_on_leave):
-- leave_vault, set_member's removal and delete_account each release the
-- member's claimed steps, the way release_step does, instead of letting the
-- membership cascade delete them. Issue #383.
--
-- Ana owns; ben and dee are editors who hold steps; cal is a viewer.

insert into auth.users (id, email) values (t.id('dee'), 'dee@example.test');
insert into t.ids select 'hl', t.run('ana', $q$select public.create_vault('Holder leaves')$q$)::uuid;
select test_support.add_member(t.id('hl'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('hl'), t.id('cal'), 'viewer', t.id('ana'));
select test_support.add_member(t.id('hl'), t.id('dee'), 'editor', t.id('ana'));

-- a; b waits on a; x stands alone.
select t.run('ana', format($q$select public.write_file(%L, 'plans/p.md', 'a plan')::text$q$, t.id('hl')));
select t.run('ana', format($q$select public.register_work_plan(%L, 'plans/p.md', %L, %L::jsonb)::text$q$, t.id('hl'),
  (select current_version_id from public.files where vault_id = t.id('hl') and path = 'plans/p.md'),
  '[{"key":"a","title":"A"},{"key":"b","title":"B","blocked_by":["a"]},{"key":"x","title":"X"}]'));

create function t.claim(p_user text, p_key text) returns text language sql as $$
  select t.run(p_user, format($q$select o_fence::text from public.claim_step(%L, 'plans/p.md', %L)$q$, t.id('hl'), p_key))
$$;
create function t.row(p_key text) returns public.work_plan_steps language sql as $$
  select s.* from public.work_plan_steps s join public.work_plans p on p.id = s.plan_id
   where p.vault_id = t.id('hl') and p.path = 'plans/p.md' and s.key = p_key
$$;
create function t.state(p_key text) returns text language sql as $$
  select o_state from public.work_plan_status(t.id('hl'), 'plans/p.md') where o_key = p_key
$$;
-- What a released step must look like, in words, so each path's check reads the same.
create function t.released(p_key text) returns text language sql as $$
  select format('status=%s holder=%s token=%s label=%s secret=%s expires=%s steps=%s blockers_of_b=%s b=%s',
    r.status, coalesce(r.holder::text, 'none'), coalesce(r.holder_token::text, 'none'), coalesce(r.holder_label, 'none'),
    coalesce(r.secret_hash, 'none'), coalesce(r.expires_at::text, 'none'),
    (select count(*) from public.work_plan_steps s where s.vault_id = t.id('hl')),
    (t.row('b')).open_blockers, t.state('b'))
  from t.row(p_key) r
$$;
create function t.releases(p_user text) returns bigint language sql as $$
  select count(*) from public.log
   where vault_id = t.id('hl') and event = 'step.release' and path = 'plans/p.md'
     and detail->>'step' = 'a' and detail->>'reason' = 'holder left the vault' and detail->>'user' = t.id(p_user)::text
$$;

-- ---------------------------------------------------------------------------
-- leave_vault

select t.expect('holder leaves: ben holds a before leaving', t.claim('ben', 'a') || ' ' || t.state('a'), '1 claimed');
select t.expect('holder leaves: leaving the vault releases the held step, which stays in its plan',
  t.run('ben', format($q$select public.leave_vault(%L)::text$q$, t.id('hl'))) || ' ' || t.released('a'),
  ' status=open holder=none token=none label=none secret=none expires=none steps=3 blockers_of_b=1 b=blocked');
select t.expect('holder leaves: leaving logs step.release with the reason and who', t.releases('ben')::text, '1');
select t.expect('holder leaves: the released step is ready for someone else', t.state('a'), 'ready');

-- ---------------------------------------------------------------------------
-- set_member removal

select test_support.add_member(t.id('hl'), t.id('ben'), 'editor', t.id('ana'));
select t.expect('holder leaves: ben holds a again before being removed', t.claim('ben', 'a') || ' ' || t.state('a'), '2 claimed');
select t.expect('holder leaves: an owner removing the holder releases the held step, which stays in its plan',
  t.run('ana', format($q$select public.set_member(%L, %L, null)::text$q$, t.id('hl'), t.id('ben'))) || ' ' || t.released('a'),
  ' status=open holder=none token=none label=none secret=none expires=none steps=3 blockers_of_b=1 b=blocked');
select t.expect('holder leaves: removal logs step.release with the reason and who', t.releases('ben')::text, '2');

-- ---------------------------------------------------------------------------
-- delete_account

select t.expect('holder leaves: dee holds a before deleting her account', t.claim('dee', 'a') || ' ' || t.state('a'), '3 claimed');
create table t.deleted as select t.run('dee', $q$select public.delete_account('dee@example.test')::text$q$) as r;
select t.expect_true('holder leaves: dee deletes her account', (select r not like 'ERR%' from t.deleted), (select r from t.deleted));
select t.expect('holder leaves: deleting the holder''s account releases the held step, which stays in its plan',
  t.released('a'), 'status=open holder=none token=none label=none secret=none expires=none steps=3 blockers_of_b=1 b=blocked');
select t.expect('holder leaves: account deletion logs step.release with the reason and who', t.releases('dee')::text, '1');

-- ---------------------------------------------------------------------------
-- The blocker count stayed right: finishing the released step frees b.

select t.expect('holder leaves: a step released this way completes like any other and frees what waited on it',
  t.run('ana', format($q$select public.complete_step(%L, 'plans/p.md', 'a', f.o_fence, f.o_secret)::text
                        from public.claim_step(%L, 'plans/p.md', 'a') f$q$, t.id('hl'), t.id('hl')))
  || ' ' || (t.row('b')).open_blockers || ' ' || t.state('b'), ' 0 ready');
select t.expect_true('holder leaves: a member leaving with no held step releases and logs nothing',
  t.run('cal', format($q$select public.leave_vault(%L)::text$q$, t.id('hl'))) = ''
  and (select count(*) from public.log where vault_id = t.id('hl') and event = 'step.release') = 3);
