-- What the flags hint reads (20261020140000_flags_review_by_proposal.sql,
-- issue #489): every MCP call that names a vault counts its flags, so the
-- count's cost must follow what waits for the caller, not how long the log
-- is. Counted as the log rows one call reads (this transaction's
-- pg_stat_xact_user_tables), which doesn't depend on the machine's speed.
-- Who is flagged is flags_test.sql's; the count's answer is
-- flags_waiting_test.sql's.
--
-- Busy: Ana owns, Ben edits and writes 1,500 files into it, so its log is
-- long.

insert into t.ids select 'busy', t.run('ana', $q$select public.create_vault('Busy')$q$)::uuid;
select test_support.add_member(t.id('busy'), t.id('ben'), 'editor', t.id('ana'));

-- The ids are read before the role changes: authenticated can't read t.
do $$
declare v uuid := t.id('busy');
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.id('ben'), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  for i in 1..1500 loop
    perform public.write_file(v, 'notes/n' || i || '.md', 'note ' || i);
  end loop;
  perform set_config('role', 'none', true);
end $$;
analyze public.log;

-- The flags waiting for Ana in p_vault, and the log rows that count read.
create function t.cost(p_vault text) returns text language plpgsql as $$
declare
  v_before bigint;
  v_after bigint;
  v_count text;
begin
  select coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0) into v_before
    from pg_stat_xact_user_tables where relid = 'public.log'::regclass;
  v_count := t.run('ana', format($q$select public.flags_waiting(%L)::text$q$, t.id(p_vault)));
  select coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0) into v_after
    from pg_stat_xact_user_tables where relid = 'public.log'::regclass;
  return v_count || ' waiting, ' || (v_after - v_before) || ' log rows read';
end $$;

-- ---------------------------------------------------------------------------

select t.expect_true('flags cost: with nothing waiting in a vault of 1,500 log entries, a count reads almost none of them',
  (select split_part(x, ' ', 1) = '0' and split_part(x, ' ', 3)::int <= 20 from (select t.cost('busy') x) y), t.cost('busy'));

do $$
declare v uuid := t.id('busy');
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.id('ben'), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  for i in 1..10 loop
    perform public.propose(v, 'canon/p' || i || '.md', 'proposal ' || i, 'a reason');
  end loop;
  perform set_config('role', 'none', true);
end $$;

select t.expect_true('flags cost: with 10 proposals waiting, a count reads a few log entries per proposal, not the vault''s log',
  (select split_part(x, ' ', 1) = '10' and split_part(x, ' ', 3)::int <= 60 from (select t.cost('busy') x) y), t.cost('busy'));
