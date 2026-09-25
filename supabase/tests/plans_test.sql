-- Hostile tests for 20260925230000_plans: account plans (vaults owned),
-- vault tiers (people and storage), the storage counter, and the operator's
-- controls. Ana, Ben, Cal and Dee come from the harness; Eve, Fay and Gil
-- have accounts. Small limits come from a test tier, "Tiny" (3 people,
-- 1000 bytes), set the operator's way.

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids values
  ('eve', '00000000-0000-0000-0000-0000000000e1'),
  ('fay', '00000000-0000-0000-0000-0000000000e2'),
  ('gil', '00000000-0000-0000-0000-0000000000e3');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'),
  (t.id('cal'), 'cal@example.test'), (t.id('dee'), 'dee@example.test'),
  (t.id('eve'), 'eve@example.test'), (t.id('fay'), 'Fay@Example.test'),
  (t.id('gil'), 'gil@example.test');

insert into private.vault_tiers (id, name, max_members, max_storage_bytes) values ('tiny', 'Tiny', 3, 1000);

-- As t.run, but an error comes back as "<sqlstate> <message>", or with
-- p_detail its DETAIL.
create function t.msg(p_user text, p_sql text, p_agent text default null, p_detail boolean default false)
returns text language plpgsql as $$
declare
  v text;
  v_state text;
  v_msg text;
  v_detail text;
  claims jsonb := jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated');
begin
  if p_agent is not null then
    claims := claims || jsonb_build_object('act', jsonb_build_object('sub', 'agent-1', 'name', p_agent));
  end if;
  perform set_config('request.jwt.claims', claims::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return v;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_detail = pg_exception_detail;
  perform set_config('role', 'none', true);
  return case when p_detail then v_detail else v_state || ' ' || v_msg end;
end $$;

create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;
create function t.new_vault(p_user text, p_key text, p_name text) returns text language sql as $$
  insert into t.ids select p_key, v::uuid from (select t.run(p_user, format($q$select public.create_vault(%L)$q$, p_name)) v) x
   where v !~ '^ERR' returning 'ok'
$$;
create function t.bytes(p_vault text) returns text language sql as
$$ select bytes::text from private.vault_storage where vault_id = t.id(p_vault) $$;
-- The counter and a full scan, which must agree.
create function t.counted(p_vault text) returns text language sql as $$
  select (select bytes from private.vault_storage where vault_id = t.id(p_vault))::text || ' = '
      || private.storage_scan(t.id(p_vault))::text
$$;
create function t.usage(p_user text, p_vault text) returns text language sql as $$
  select t.run(p_user, format($q$select concat_ws(' ', tier, tier_name, plan, plan_name, members,
    coalesce(invites::text, '-'), max_members, bytes, max_bytes) from public.vault_usage(%L)$q$, t.id(p_vault)))
$$;
create function t.plan(p_user text) returns text language sql as $$
  select t.run(p_user, $q$select concat_ws(' ', plan, plan_name, vaults_owned, max_vaults) from public.my_plan()$q$)
$$;
-- A query in its own snapshot, so it sees what earlier calls in the same
-- statement did.
create function t.q(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return v;
end $$;
create function t.ops(p_sql text) returns text language sql as $$ select t.run_role('reliquary_ops', p_sql) $$;
create function t.write_sql(p_vault text, p_path text, p_bytes int) returns text language sql as
$$ select format($q$select public.write_file(%L, %L, %L)::text$q$, t.id(p_vault), p_path, repeat('w', p_bytes)) $$;
create function t.invite(p_user text, p_vault text, p_email text) returns text language sql as $$
  select t.msg(p_user, format($q$select public.create_invite(%L, %L, 'viewer')$q$, t.id(p_vault), p_email))
$$;
create function t.accept(p_user text, p_token text) returns text language sql as
$$ select t.msg(p_user, format($q$select public.accept_invite(%L)::text$q$, p_token)) $$;
-- A sealed value of n bytes, as the web app sends one.
create function t.setv_sql(p_vault text, p_name text, p_env text, p_bytes int) returns text language sql as $$
  select format($q$select public.set_variable(%L, %L, %L, 'k1', decode(%L, 'hex'), decode(%L, 'hex'))$q$,
    t.id(p_vault), p_name, p_env, repeat('00', 12), repeat('ab', p_bytes))
$$;
create function t.import_sql(p_vault text, p_names text[], p_bytes int) returns text language sql as $$
  select format($q$select public.create_env_import(%L, array['development'], %L::jsonb)::text$q$, t.id(p_vault),
    (select jsonb_agg(jsonb_build_object('name', n, 'environment', 'development', 'key_id', 'k1',
       'nonce', encode(decode(repeat('00', 12), 'hex'), 'base64'),
       'ciphertext', encode(decode(repeat('cd', p_bytes), 'hex'), 'base64'))) from unnest(p_names) n))
$$;

-- ---------------------------------------------------------------------------
-- Defaults

select t.expect('defaults: the seeded plans are Free (5 vaults, 10 people, 100 MB) and Alpha tester (25, 25, 1 GB)',
  (select string_agg(concat_ws(' ', id, name, max_vaults, max_members, max_storage_bytes), ' | ' order by max_vaults)
     from private.plans),
  'free Free 5 10 100000000 | alpha_tester Alpha tester 25 25 1000000000');
select t.expect('defaults: the seeded vault tiers are Standard (the plan''s limits) and Pro (50 people, 5 GB)',
  (select string_agg(concat_ws(' ', id, name, coalesce(max_members::text, '-'), coalesce(max_storage_bytes::text, '-')), ' | ' order by id)
     from private.vault_tiers where id <> 'tiny'),
  'pro Pro 50 5000000000 | standard Standard - -');
select t.expect('defaults: a person with no plan assigned is on Free, owning none of their 5 vaults',
  t.plan('gil'), 'free Free 0 5');
select t.new_vault('ana', 'team', 'Team');
select t.expect('defaults: a new vault is Standard on its creator''s plan, with its owner, nothing stored',
  t.usage('ana', 'team'), 'standard Standard free Free 1 0 10 0 100000000');

-- ---------------------------------------------------------------------------
-- Vaults per account

select t.new_vault('fay', 'f1', 'F1'), t.new_vault('fay', 'f2', 'F2'), t.new_vault('fay', 'f3', 'F3'),
       t.new_vault('fay', 'f4', 'F4'), t.new_vault('fay', 'f5', 'F5');
select t.expect('vaults: Free allows 5; the 6th is refused with RLP01, naming the limit, the plan and the count',
  t.msg('fay', $q$select public.create_vault('F6')::text$q$),
  'RLP01 you''re at your 5-vault limit on the Free plan (you own 5): delete a vault you no longer need, or ask for a bigger plan');
select t.expect('vaults: the refusal''s detail says which limit, for programs',
  t.msg('fay', $q$select public.create_vault('F6')::text$q$, null, true),
  '{"max": 5, "plan": "free", "used": 5, "limit": "vaults"}');
select t.expect('vaults: a refused vault leaves nothing behind',
  (select count(*)::text from public.vaults where created_by = t.id('fay')), '5');
select t.run('fay', $q$select public.create_access_token('fay-all', 30)$q$);
select t.expect('vaults: an agent through an all-vaults read-write token is held to the same limit',
  t.run_tok('fay', 'fay-all', $q$select public.create_vault('Agent six')::text$q$), 'ERR RLP01');
select test_support.add_member(t.id('team'), t.id('fay'), 'editor', t.id('ana'));
select t.expect('vaults: belonging to someone else''s vault doesn''t count; only vaults a person created do',
  t.plan('fay') || ' / ' || t.plan('ana'), 'free Free 5 5 / free Free 1 5');
select t.expect('vaults: deleting a vault works at the limit and frees its place',
  t.run('fay', format($q$select (public.delete_vault(%L, 'F5') ->> 'members')$q$, t.id('f5')))
  || ' ' || coalesce(t.new_vault('fay', 'f5b', 'F5 again'), 'refused'),
  '1 ok');
select t.expect('vaults: on Alpha tester, 25 are allowed',
  t.ops(format($q$select private.set_account_plan(%L, 'alpha_tester')$q$, t.id('fay')))
  || ' / ' || t.new_vault('fay', 'f6', 'F6') || ' / ' || t.plan('fay'),
  'Alpha tester plan: 5 of 25 vaults / ok / alpha_tester Alpha tester 6 25');
select t.expect('downgrade: back on Free with 6 vaults, every vault stays, and no new one is allowed',
  t.ops(format($q$select private.set_account_plan(%L, 'free')$q$, t.id('fay')))
  || ' / ' || (select count(*)::text from public.vaults where created_by = t.id('fay'))
  || ' / ' || t.msg('fay', $q$select public.create_vault('F7')::text$q$),
  'Free plan: 6 of 5 vaults (over: they can''t create more until under) / 6 / RLP01 you''re at your 5-vault limit on the Free plan (you own 6): delete a vault you no longer need, or ask for a bigger plan');
select t.expect('downgrade: an over-limit account''s vaults still take writes that fit',
  (t.run('fay', t.write_sql('f6', 'notes/a.md', 10)) ~ '^[0-9a-f-]{36}$')::text, 'true');

-- ---------------------------------------------------------------------------
-- People per vault

select t.new_vault('ana', 'club', 'Club');
select t.ops(format($q$select private.set_vault_tier(%L, 'tiny')$q$, t.id('club')));
select test_support.add_member(t.id('club'), t.id('ben'), 'editor', t.id('ana'));
create table t.tokens (name text primary key, token text);
insert into t.tokens select 'eve', t.invite('ana', 'club', 'eve@example.test');
select t.expect('people: an invite fits while members and waiting invites are under the limit',
  ((select token from t.tokens where name = 'eve') ~ '^rli_')::text, 'true');
select t.expect('people: waiting invites count, so the next invite is refused, naming the vault, limit, tier and counts',
  t.invite('ana', 'club', 'fay@example.test'),
  'RLP01 Club is at its 3-person limit on the Tiny tier (2 members and 1 invite waiting): revoke an invite or remove someone first');
select t.expect('people: the refusal''s detail counts members and invites',
  t.msg('ana', format($q$select public.create_invite(%L, 'fay@example.test', 'viewer')$q$, t.id('club')), null, true),
  '{"max": 3, "plan": "free", "tier": "tiny", "used": 3, "limit": "people", "invites": 1, "members": 2}');
update t.tokens set token = t.invite('ana', 'club', 'EVE@example.test') where name = 'eve';
select t.expect('people: inviting the same address again replaces its invite and counts once',
  ((select token from t.tokens where name = 'eve') ~ '^rli_')::text, 'true');
select t.expect('people: a refused invite stores nothing',
  (select count(*)::text from private.vault_invites where vault_id = t.id('club') and email = 'fay@example.test'), '0');
select t.expect('people: accepting takes the place its invite held',
  t.accept('eve', (select token from t.tokens where name = 'eve')) || ' ' ||
  t.q(format('select count(*)::text from public.vault_members where vault_id = %L', t.id('club'))),
  t.id('club')::text || ' 3');
select t.expect('people: an owner can still change roles at the limit',
  t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, 'viewer')$q$, t.id('club'), t.id('eve'))), 'ok');
-- Over the limit (a smaller tier, say): an invite made before can't be used.
select t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, null)$q$, t.id('club'), t.id('eve')));
insert into t.tokens select 'fay', t.invite('ana', 'club', 'fay@example.test');
select test_support.add_member(t.id('club'), t.id('cal'), 'viewer', t.id('ana'));
select t.expect('people: accepting is refused when members alone fill the vault, and says what to do',
  t.accept('fay', (select token from t.tokens where name = 'fay')),
  'RLP01 Club is at its 3-person limit on the Tiny tier (3 members): ask an owner to make room, then open this link again');
select t.expect('people: a refused acceptance doesn''t use the invite up',
  (select private.invite_state(accepted_at, revoked_at, expires_at) from private.vault_invites
    where vault_id = t.id('club') and email = 'fay@example.test' and revoked_at is null), 'pending');
select t.expect('people: removing someone always works, and then the invite can be used',
  t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, null)$q$, t.id('club'), t.id('cal')))
  || ' ' || t.accept('fay', (select token from t.tokens where name = 'fay')),
  'ok ' || t.id('club')::text);
select test_support.add_member(t.id('club'), t.id('dee'), 'viewer', t.id('ana'));
select t.expect('downgrade: a vault over its people limit keeps every member and takes no new invites',
  (select count(*)::text from public.vault_members where vault_id = t.id('club'))
  || ' ' || left(t.invite('ana', 'club', 'gil@example.test'), 5),
  '4 RLP01');
select t.expect('people: leaving an over-limit vault works',
  t.run('dee', format($q$select 'ok' from public.leave_vault(%L)$q$, t.id('club'))), 'ok');

-- ---------------------------------------------------------------------------
-- Storage

select t.new_vault('dee', 'store', 'Store');
select t.ops(format($q$select private.set_vault_tier(%L, 'tiny')$q$, t.id('store')));
select t.run('dee', format($q$select 'ok' from public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('store')));
select t.expect('storage: a write that fits is taken and counted',
  (t.run('dee', t.write_sql('store', 'a.md', 600)) ~ '^[0-9a-f-]{36}$')::text || ' ' || t.bytes('store'), 'true 600');
select t.expect('storage: a write that would pass the limit is refused with RLP01, naming the vault, usage, limit and tier',
  t.msg('dee', t.write_sql('store', 'b.md', 500)),
  'RLP01 Store has 600 bytes of its 1 KB storage limit on the Tiny tier, and this needs 500 bytes more. Erase files you no longer need (deleting a file keeps its history) or delete variables, then try again');
select t.expect('storage: the refusal''s detail says which limit, for programs',
  t.msg('dee', t.write_sql('store', 'b.md', 500), null, true),
  '{"max": 1000, "plan": "free", "tier": "tiny", "used": 600, "limit": "storage", "adding": 500}');
select t.expect('storage: a refused write leaves no file, version or count',
  (select count(*)::text from public.files where vault_id = t.id('store') and path = 'b.md') || ' ' || t.bytes('store'), '0 600');
select t.expect('storage: an agent''s write is held to the same limit',
  t.run('dee', t.write_sql('store', 'b.md', 500), 'Claude Code'), 'ERR RLP01');
select t.expect('storage: history counts: a new version of a file adds its size',
  (t.run('dee', t.write_sql('store', 'a.md', 300)) ~ '^[0-9a-f-]{36}$')::text || ' ' || t.counted('store'), 'true 900 = 900');
select t.expect('storage: a proposal whose text wouldn''t fit is refused when made',
  t.msg('dee', format($q$select public.propose(%L, 'canon/p.md', %L)::text$q$, t.id('store'), repeat('p', 200)), 'Claude Code'),
  'RLP01 Store has 900 bytes of its 1 KB storage limit on the Tiny tier, and this needs 200 bytes more. Erase files you no longer need (deleting a file keeps its history) or delete variables, then try again');
insert into t.ids select 'prop', t.run('dee', format($q$select public.propose(%L, 'canon/p.md', %L)$q$, t.id('store'), repeat('p', 50)), 'Claude Code')::uuid;
select t.expect('storage: a proposal that fits is taken, and counts nothing until applied',
  (t.id('prop') is not null)::text || ' ' || t.bytes('store'), 'true 900');
select t.expect('storage: revising a proposal to text that wouldn''t fit is refused',
  t.run('dee', format($q$select public.revise_proposal(%L, %L)::text$q$, t.id('prop'), repeat('r', 200)), 'Claude Code'), 'ERR RLP01');
select t.run('dee', t.write_sql('store', 'c.md', 60));
select t.expect('storage: approving a proposal that no longer fits is refused, and records no approval',
  t.run('dee', format($q$select public.decide(%L, 'approve')$q$, t.id('prop')))
  || ' ' || t.q(format('select status from public.proposals where id = %L', t.id('prop')))
  || ' ' || t.q(format('select count(*)::text from public.approvals where proposal_id = %L', t.id('prop'))),
  'ERR RLP01 open 0');
select t.expect('storage: edit and approve is held to the same limit',
  t.run('dee', format($q$select public.edit_and_approve(%L, %L)$q$, t.id('prop'), repeat('e', 45))), 'ERR RLP01');
select t.expect('storage: deleting a file works at the limit, and keeps its history counted',
  t.run('dee', format($q$select 'ok' from public.delete_file(%L, 'c.md')$q$, t.id('store'))) || ' ' || t.counted('store'),
  'ok 960 = 960');
select t.expect('storage: erasing a file frees every version''s bytes',
  t.run('dee', format($q$select public.erase_file(%L, 'a.md')::text$q$, t.id('store'))) || ' ' || t.counted('store'),
  '2 60 = 60');
select t.expect('storage: once there is room, the proposal applies and counts',
  t.run('dee', format($q$select public.decide(%L, 'approve')$q$, t.id('prop'))) || ' ' || t.counted('store'),
  'applied 110 = 110');

-- Variables and imports, on the same 1000 bytes.
select t.expect('storage: setting a variable counts its ciphertext',
  t.run('dee', t.setv_sql('store', 'API_KEY', 'development', 400)) || ' ' || t.counted('store'), 'set 510 = 510');
select t.expect('storage: a variable that would pass the limit is refused',
  t.msg('dee', t.setv_sql('store', 'BIG', 'development', 600)),
  'RLP01 Store has 510 bytes of its 1 KB storage limit on the Tiny tier, and this needs 600 bytes more. Erase files you no longer need (deleting a file keeps its history) or delete variables, then try again');
select t.expect('storage: rotating a value to a larger one counts only the difference',
  t.run('dee', t.setv_sql('store', 'API_KEY', 'development', 800)) || ' ' || t.counted('store'), 'rotate 910 = 910');
select t.expect('storage: rotating past the limit is refused and keeps the old value',
  t.run('dee', t.setv_sql('store', 'API_KEY', 'development', 900)) || ' ' || t.counted('store'), 'ERR RLP01 910 = 910');
select t.expect('storage: an import that would pass the limit is refused and stores nothing',
  t.run('dee', t.import_sql('store', array['A', 'B'], 50)) || ' '
  || t.q(format('select count(*)::text from public.env_imports where vault_id = %L', t.id('store'))) || ' ' || t.counted('store'),
  'ERR RLP01 0 910 = 910');
insert into t.ids select 'imp', (t.run('dee', t.import_sql('store', array['A', 'B'], 32))::jsonb ->> 'id')::uuid;
select t.expect('storage: an import waiting to be applied counts its ciphertext',
  (t.id('imp') is not null)::text || ' ' || t.counted('store'), 'true 974 = 974');
update private.vault_tiers set max_storage_bytes = 950 where id = 'tiny';
select t.expect('storage: a vault over its limit can''t apply an import: it says why, and changes nothing',
  (t.run('dee', format($q$select public.apply_env_import(%L)::text$q$, t.id('imp')))::jsonb - 'message')::text
  || ' ' || t.q(format('select status from public.env_imports where id = %L', t.id('imp')))
  || ' ' || t.q(format('select count(*)::text from public.variables where vault_id = %L', t.id('store')))
  || ' ' || t.counted('store'),
  '{"ok": false, "error": "storage_limit"} pending 1 974 = 974');
select t.expect('storage: rotating to a value the same size works over the limit',
  t.run('dee', t.setv_sql('store', 'API_KEY', 'development', 800)) || ' ' || t.counted('store'), 'rotate 974 = 974');
update private.vault_tiers set max_storage_bytes = 1000 where id = 'tiny';
select t.expect('storage: applying an import adds nothing: its ciphertext was counted when it was made',
  (t.run('dee', format($q$select public.apply_env_import(%L)::text$q$, t.id('imp')))::jsonb ->> 'applied')
  || ' ' || t.counted('store'), '2 974 = 974');
insert into t.ids select 'imp2', (t.run('dee', t.import_sql('store', array['C'], 16))::jsonb ->> 'id')::uuid;
select t.expect('storage: rejecting an import frees its ciphertext',
  t.counted('store') || ' ' || (t.run('dee', format($q$select public.reject_env_import(%L)::text$q$, t.id('imp2')))::jsonb ->> 'ok')
  || ' ' || t.counted('store'), '990 = 990 true 974 = 974');
select t.expect('storage: deleting a variable frees its ciphertext',
  t.run('dee', format($q$select 'ok' from public.delete_variable(%L, 'API_KEY', 'development')$q$, t.id('store')))
  || ' ' || t.counted('store'), 'ok 174 = 174');

-- Downgrades never delete.
select t.run('dee', t.write_sql('store', 'd.md', 700));
select t.ops(format($q$select private.set_vault_tier(%L, 'standard')$q$, t.id('store')));
update private.plans set max_storage_bytes = 500 where id = 'free';
select t.expect('downgrade: a vault over its storage limit keeps every file and value',
  (select count(*)::text from public.file_versions where vault_id = t.id('store') and body is not null)
  || ' ' || (select count(*)::text from public.variable_values where vault_id = t.id('store'))
  || ' ' || t.counted('store'),
  '3 2 874 = 874');
select t.expect('downgrade: an over-limit vault refuses anything that adds, even a byte',
  t.run('dee', t.write_sql('store', 'e.md', 1)) || ' '
  || t.run('dee', format($q$select public.propose(%L, 'canon/q.md', 'q')::text$q$, t.id('store'))),
  'ERR RLP01 ERR RLP01');
select t.expect('downgrade: an over-limit vault still reads, deletes and erases',
  t.run('dee', format($q$select count(*)::text from public.files where vault_id = %L$q$, t.id('store')))
  || ' ' || t.run('dee', format($q$select 'ok' from public.delete_variable(%L, 'A', 'development')$q$, t.id('store')))
  || ' ' || t.run('dee', format($q$select public.erase_file(%L, 'd.md')::text$q$, t.id('store')))
  || ' ' || t.counted('store'),
  '4 ok 1 142 = 142');
update private.plans set max_storage_bytes = 100000000 where id = 'free';
select t.expect('downgrade: an over-limit vault can be deleted',
  t.run('dee', format($q$select (public.delete_vault(%L, 'Store') ->> 'files')$q$, t.id('store')))
  || ' ' || t.q(format('select count(*)::text from private.vault_storage where vault_id = %L', t.id('store')))
  || ' ' || t.q(format('select count(*)::text from private.vault_tier_overrides where vault_id = %L', t.id('store'))),
  '4 0 0');

-- ---------------------------------------------------------------------------
-- The counter stays equal to a full scan

select t.new_vault('ana', 'count', 'Count');
select t.run('ana', t.write_sql('count', 'x.md', 123));
select t.run('ana', t.write_sql('count', 'x.md', 77));
select t.run('ana', t.setv_sql('count', 'K1', 'development', 64));
select t.run('ana', t.setv_sql('count', 'K1', 'production', 32));
select t.run('ana', format($q$select 'ok' from public.create_environment(%L, 'staging', false)$q$, t.id('count')));
select t.run('ana', t.setv_sql('count', 'K2', 'staging', 16));
insert into t.ids select 'cimp', (t.run('ana', t.import_sql('count', array['K3', 'K4'], 20))::jsonb ->> 'id')::uuid;
select t.expect('counter: after writes, variables and a waiting import, it equals a full scan',
  t.counted('count'), '352 = 352');
select t.run('ana', format($q$select 'ok' from public.delete_environment(%L, 'staging', 'staging')$q$, t.id('count')));
select t.expect('counter: deleting an environment counts its values out',
  t.counted('count'), '336 = 336');
select t.run('ana', format($q$select public.apply_env_import(%L)::text$q$, t.id('cimp')));
select t.run('ana', format($q$select 'ok' from public.delete_variable(%L, 'K1', 'production')$q$, t.id('count')));
select t.run('ana', format($q$select public.erase_file(%L, 'x.md')::text$q$, t.id('count')));
select t.expect('counter: after an apply, a delete and an erase, it still equals a full scan',
  t.counted('count'), '104 = 104');
select t.expect('counter: every vault''s counter equals its scan',
  (select count(*)::text from public.vaults v join private.vault_storage s on s.vault_id = v.id
    where s.bytes <> private.storage_scan(v.id)), '0');
select t.expect('counter: every vault has one',
  (select count(*)::text from public.vaults v where not exists (select 1 from private.vault_storage s where s.vault_id = v.id)), '0');

-- ---------------------------------------------------------------------------
-- Usage, for members

select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select t.invite('ana', 'team', 'gil@example.test');
select t.expect('usage: an owner sees members, invites waiting, limits and bytes',
  t.usage('ana', 'team'), 'standard Standard free Free 3 1 10 0 100000000');
select t.expect('usage: a viewer sees the same, but not the invites',
  t.usage('cal', 'team'), 'standard Standard free Free 3 - 10 0 100000000');
select t.expect('usage: a Pro vault shows the tier''s limits, whatever its creator''s plan',
  t.ops(format($q$select private.set_vault_tier(%L, 'pro')$q$, t.id('team'))) || ' / ' || t.usage('ana', 'team'),
  'Pro: 3 of 50 people, 0 bytes of 5 GB / pro Pro free Free 3 1 50 0 5000000000');
select t.expect('usage: an outsider learns nothing about a vault',
  t.usage('gil', 'team'), 'ERR P0002');
select t.expect('usage: an agent sees usage only for vaults its token reaches',
  t.run_tok('ana', 'fay-all', format($q$select bytes::text from public.vault_usage(%L)$q$, t.id('team')))
  || ' ' || t.run_tok('fay', 'fay-all', format($q$select max_members::text from public.vault_usage(%L)$q$, t.id('team'))),
  'ERR P0002 50');
select t.expect('usage: anonymous callers get nothing',
  t.run(null, $q$select plan from public.my_plan()$q$) || ' '
  || t.run(null, format($q$select tier from public.vault_usage(%L)$q$, t.id('team'))),
  'ERR 42501 ERR 42501');

-- ---------------------------------------------------------------------------
-- Only the operator changes plans and tiers

select t.expect('operator: a person can''t read plans, assignments, tiers or counters',
  t.run('ana', 'select count(*)::text from private.plans') || ' '
  || t.run('ana', 'select count(*)::text from private.account_plans') || ' '
  || t.run('ana', 'select count(*)::text from private.vault_tiers') || ' '
  || t.run('ana', 'select count(*)::text from private.vault_tier_overrides') || ' '
  || t.run('ana', 'select count(*)::text from private.vault_storage'),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('operator: a person can''t put themself on a plan or change a limit directly',
  t.run('ana', format($q$insert into private.account_plans (user_id, plan_id) values (%L, 'alpha_tester') returning 'x'$q$, t.id('ana')))
  || ' ' || t.run('ana', $q$update private.plans set max_vaults = 1000 returning 'x'$q$)
  || ' ' || t.run('ana', format($q$update private.vault_storage set bytes = 0 where vault_id = %L returning 'x'$q$, t.id('team'))),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('operator: a person can''t call the operator''s functions',
  t.run('ana', format($q$select private.set_account_plan(%L, 'alpha_tester')$q$, t.id('ana'))) || ' '
  || t.run('ana', format($q$select private.set_vault_tier(%L, 'pro')$q$, t.id('club'))) || ' '
  || t.run('ana', $q$select private.user_by_email('ana@example.test')::text$q$),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('operator: nor can their agent',
  t.run('ana', format($q$select private.set_account_plan(%L, 'alpha_tester')$q$, t.id('ana')), 'Claude Code') || ' '
  || t.run_tok('fay', 'fay-all', format($q$select private.set_vault_tier(%L, 'pro')$q$, t.id('f6'))),
  'ERR 42501 ERR 42501');
select t.expect('operator: nor the web app''s role, the MCP server''s or anonymous callers',
  t.run_role('reliquary_web', format($q$select private.set_account_plan(%L, 'alpha_tester')$q$, t.id('ana'))) || ' '
  || t.run_role('reliquary_web', 'select count(*)::text from private.account_plans') || ' '
  || t.run_role('reliquary_mcp', format($q$select private.set_vault_tier(%L, 'pro')$q$, t.id('club'))) || ' '
  || t.run_role('reliquary_mcp', 'select count(*)::text from private.vault_tiers') || ' '
  || t.run(null, format($q$select private.set_account_plan(%L, 'alpha_tester')$q$, t.id('ana'))),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('operator: reliquary_ops sets plans and tiers through the functions, and reads no table directly',
  t.ops(format($q$select private.set_account_plan(private.user_by_email('FAY@example.test'), 'alpha_tester')$q$)) || ' / '
  || t.ops(format($q$select private.set_vault_tier(%L, 'standard')$q$, t.id('team'))) || ' / '
  || t.ops('select count(*)::text from private.account_plans'),
  'Alpha tester plan: 6 of 25 vaults / Standard (Free): 3 of 10 people, 0 bytes of 100 MB / ERR 42501');
select t.expect('operator: an unknown plan, tier, account or vault is refused',
  t.ops(format($q$select private.set_account_plan(%L, 'platinum')$q$, t.id('ana'))) || ' '
  || t.ops(format($q$select private.set_vault_tier(%L, 'gold')$q$, t.id('team'))) || ' '
  || t.ops($q$select private.user_by_email('nobody@example.test')::text$q$) || ' '
  || t.ops($q$select private.set_vault_tier('00000000-0000-0000-0000-000000000999', 'pro')$q$),
  'ERR P0002 ERR P0002 ERR P0002 ERR P0002');

-- ---------------------------------------------------------------------------
-- Sizes as people read them

select t.expect('sizes: decimal units, trimmed',
  concat_ws(', ', private.size_text(1), private.size_text(999), private.size_text(1000), private.size_text(12345678),
    private.size_text(100000000), private.size_text(1000000000), private.size_text(5000000000)),
  '1 byte, 999 bytes, 1 KB, 12.3 MB, 100 MB, 1 GB, 5 GB');
