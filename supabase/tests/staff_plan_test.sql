-- Hostile tests for 20260926170000_staff_plan: the `staff` plan (no vault
-- limit, alpha_tester's per-vault numbers) and per-vault storage grants.
-- Ana, Ben come from the harness.

-- ---------------------------------------------------------------------------
-- Setup

insert into auth.users (id, email) values (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test');
insert into private.vault_tiers (id, name, max_members, max_storage_bytes) values ('micro', 'Micro', 2, 500);

create function t.new_vault(p_user text, p_key text, p_name text) returns text language sql as $$
  insert into t.ids select p_key, v::uuid from (select t.run(p_user, format($q$select public.create_vault(%L)$q$, p_name)) v) x
   where v !~ '^ERR' returning 'ok'
$$;
create function t.usage(p_user text, p_vault text) returns text language sql as $$
  select t.run(p_user, format($q$select concat_ws(' ', tier, tier_name, plan, plan_name, max_members, max_bytes)
    from public.vault_usage(%L)$q$, t.id(p_vault)))
$$;
create function t.ops(p_sql text) returns text language sql as $$ select t.run_role('reliquary_ops', p_sql) $$;
create function t.write_sql(p_vault text, p_path text, p_bytes int) returns text language sql as
$$ select format($q$select public.write_file(%L, %L, %L)::text$q$, t.id(p_vault), p_path, repeat('w', p_bytes)) $$;

select t.ops(format($q$select private.set_account_plan(%L, 'staff')$q$, t.id('ana')));

-- ---------------------------------------------------------------------------
-- The staff plan: no vault limit, alpha_tester's per-vault numbers

select t.expect('defaults: the staff plan is seeded with no vault limit and alpha_tester''s per-vault numbers',
  (select concat_ws(' ', name, max_vaults, max_members, max_storage_bytes) from private.plans where id = 'staff'),
  'Reliquary staff 1000000000 25 1000000000');
select t.expect('vaults: on staff, more than alpha_tester''s 25-vault cap is allowed',
  (select count(*)::text from (select t.new_vault('ana', 's' || g, 'S' || g) from generate_series(1, 26) g) x
    where x.new_vault = 'ok'),
  '26');
select t.expect('vaults: a staff-plan vault is Standard, taking alpha_tester''s people and storage numbers',
  t.usage('ana', 's1'), 'standard Standard staff Reliquary staff 25 1000000000');

-- ---------------------------------------------------------------------------
-- Storage grants: operator only

select t.expect('grant: a person, their agent, anonymous, the web app''s and the MCP server''s roles can''t grant, or read the grants table',
  t.run('ana', format($q$select private.grant_vault_storage(%L, 100)::text$q$, t.id('s1')))
  || ' ' || t.run('ana', format($q$select private.grant_vault_storage(%L, 100)::text$q$, t.id('s1')), 'Claude Code')
  || ' ' || t.run(null, format($q$select private.grant_vault_storage(%L, 100)::text$q$, t.id('s1')))
  || ' ' || t.run_role('reliquary_web', format($q$select private.grant_vault_storage(%L, 100)::text$q$, t.id('s1')))
  || ' ' || t.run_role('reliquary_mcp', format($q$select private.grant_vault_storage(%L, 100)::text$q$, t.id('s1')))
  || ' ' || t.run_role('reliquary_web', 'select count(*)::text from private.vault_storage_grants')
  || ' ' || t.run_role('reliquary_ops', 'select count(*)::text from private.vault_storage_grants'),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('grant: an unknown vault, or a negative amount, is refused',
  t.ops($q$select private.grant_vault_storage('00000000-0000-0000-0000-000000000999', 100)::text$q$) || ' '
  || t.ops(format($q$select private.grant_vault_storage(%L, -1)::text$q$, t.id('s1'))),
  'ERR P0002 ERR 22023');

-- ---------------------------------------------------------------------------
-- A grant actually raises the limit, and 0 takes it back

select t.new_vault('ana', 'club', 'Club');
select t.ops(format($q$select private.set_vault_tier(%L, 'micro')$q$, t.id('club')));
select test_support.add_member(t.id('club'), t.id('ben'), 'editor', t.id('ana'));
select t.expect('grant: under its tier alone, a write over the limit is refused, naming the tier',
  t.run('ana', t.write_sql('club', 'a.md', 600)),
  'ERR RLP01');
select t.expect('grant: the operator grants more room, naming the vault, the new total and the old one',
  t.ops(format($q$select private.grant_vault_storage(%L, 200)$q$, t.id('club'))),
  'Club: 700 bytes storage limit now (was 500 bytes)');
select t.expect('grant: the same write now fits, and vault_usage shows the grant folded into max_bytes',
  (t.run('ana', t.write_sql('club', 'a.md', 600)) ~ '^[0-9a-f-]{36}$')::text || ' ' || t.usage('ana', 'club'),
  'true micro Micro staff Reliquary staff 2 700');
-- As t.run, but an error comes back as "<sqlstate> <message>" (plans_test.sql
-- has the same helper; this file is self-contained, per AGENTS.md).
create function t.msg(p_user text, p_sql text) returns text language plpgsql as $$
declare v text; v_state text; v_msg text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return v;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  perform set_config('role', 'none', true);
  return v_state || ' ' || v_msg;
end $$;
select t.expect('grant: a write that still doesn''t fit names the grant in its refusal',
  t.msg('ana', t.write_sql('club', 'b.md', 600)),
  'RLP01 Club has 600 bytes of its 700 bytes storage limit on the Micro tier, plus 200 bytes the operator added, and this needs 600 bytes more. Erase files you no longer need (deleting a file keeps its history) or delete variables, then try again');
select t.expect('grant: 0 takes the grant back, naming the vault',
  t.ops(format($q$select private.grant_vault_storage(%L, 0)$q$, t.id('club'))),
  'Club: 500 bytes storage limit now (was 700 bytes), the grant is gone');
select t.expect('grant: gone, the write is refused again at the tier''s own limit',
  t.msg('ana', t.write_sql('club', 'c.md', 600)),
  'RLP01 Club has 600 bytes of its 500 bytes storage limit on the Micro tier, and this needs 600 bytes more. Erase files you no longer need (deleting a file keeps its history) or delete variables, then try again');
select t.ops(format($q$select private.grant_vault_storage(%L, 50)$q$, t.id('club')));
select t.run('ana', format($q$select (public.delete_vault(%L, 'Club') ->> 'members')$q$, t.id('club')));
select t.expect('grant: deleting a vault removes its grant',
  -- reliquary_ops changes grants only through the function, so this reads
  -- the table directly as the test's own (superuser) connection, the same
  -- way t.bytes() reads private.vault_storage in plans_test.sql.
  (select count(*)::text from private.vault_storage_grants where vault_id = t.id('club')),
  '0');
