-- Each vault's request budget (20261013235000_vault_request_budget.sql,
-- issue #80): every full evaluation of request_work or claim_step counts
-- against its vault, all its people and agents together; over the budget
-- the answer is wait, with the seconds until the vault's minute ends, and
-- other vaults go on as before. The floor under a rule's minimum gap is
-- claim_rules_test.sql's ("waiting:"); the per-token limit is the MCP
-- server's (mcp/test/rate_limits.test.mjs).
--
-- A vault is put over its budget by filling its counter, as the table
-- owner, for this minute and the next, so a call made any time in the next
-- minute is over it whichever second the test runs at.
--
-- Ana owns vaults A and B; Ben, Eva and Fay are editors of both. A refusal
-- for who may ask (42501) is an exception, so it counts nothing.

insert into t.ids values
  ('eva', '00000000-0000-0000-0000-0000000000e1'), ('fay', '00000000-0000-0000-0000-0000000000e2');
insert into t.ids select 'a', t.run('ana', $q$select public.create_vault('Budget A')$q$)::uuid;
insert into t.ids select 'b', t.run('ana', $q$select public.create_vault('Budget B')$q$)::uuid;
select test_support.add_member(t.id(v), t.id(p), 'editor', t.id('ana'))
  from unnest(array['a', 'b']) v, unnest(array['ben', 'eva', 'fay']) p;

create table t.vals (name text primary key, val text);
create function t.save(p_name text, p_val text) returns text language sql as $$
  insert into t.vals values (p_name, p_val) on conflict (name) do update set val = excluded.val returning val
$$;
create function t.val(p_name text) returns text language sql as $$ select val from t.vals where name = p_name $$;
create function t.j(p_name text) returns jsonb language sql as $$ select val::jsonb from t.vals where name = p_name $$;

create function t.plan(p_vault text, p_path text, p_steps jsonb) returns text language sql as $$
  select t.run('ana', format($q$select public.write_file(%L, %L, 'a plan')::text$q$, t.id(p_vault), p_path));
  select t.run('ana', format($q$select public.register_work_plan(%L, %L, %L, %L::jsonb)::text$q$, t.id(p_vault), p_path,
    (select current_version_id from public.files where vault_id = t.id(p_vault) and path = p_path), p_steps::text));
$$;
create function t.rw(p_user text, p_vault text, p_path text) returns jsonb language sql as $$
  select case when x like 'ERR %' then jsonb_build_object('o_state', x) else x::jsonb end
    from (select t.run(p_user, format($q$select to_jsonb(r)::text from public.request_work(%L, %L) r$q$, t.id(p_vault), p_path)) x) y
$$;
create function t.key(p_vault text) returns text language sql as $$
  select encode(sha256(convert_to('vault:' || t.id(p_vault)::text, 'UTF8')), 'hex')
$$;
-- Every evaluation counted against the vault so far, across windows.
create function t.hits(p_vault text) returns bigint language sql as $$
  select coalesce(sum(hits), 0) from private.rate_limits where bucket = 'vault_request_work_minute' and key = t.key(p_vault)
$$;
create function t.fill(p_vault text) returns void language sql as $$
  insert into private.rate_limits (bucket, key, window_start, expires_at, hits)
  select 'vault_request_work_minute', t.key(p_vault), to_timestamp(w), to_timestamp(w + 60), (select per_minute from private.request_budget)
    from (select floor(extract(epoch from clock_timestamp()) / 60) * 60 + k * 60 as w from generate_series(0, 1) k) x
  on conflict (bucket, key, window_start) do update set hits = excluded.hits
$$;
-- A refusal's message, as p_user.
create function t.refusal(p_user text, p_sql text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql;
  perform set_config('role', 'none', true);
  return 'no error';
exception when others then
  perform set_config('role', 'none', true);
  return sqlstate || ' ' || sqlerrm;
end $$;

select t.plan('a', 'p.md', '[{"key":"x","title":"X"},{"key":"y","title":"Y","blocked_by":["x"]}]');
select t.plan('a', 'free.md', '[{"key":"z","title":"Z"}]');
select t.plan('b', 'p.md', '[{"key":"x","title":"X"}]');

-- ---------------------------------------------------------------------------

select t.expect('budget: the shipped budget is 300 evaluations a minute per vault',
  (select per_minute::text from private.request_budget), '300');

create table t.seen (k serial, what text);
create function t.note(p_what text) returns void language sql as $$ insert into t.seen (what) values (p_what) $$;

select t.note((t.rw('ben', 'a', 'p.md')->>'o_state') || ' ' || t.hits('a'));
select t.note((t.rw('ben', 'a', 'p.md')->>'o_state') || ' ' || t.hits('a'));
select t.note((t.rw('eva', 'a', 'p.md')->>'o_state') || ' ' || t.hits('a'));
select t.note((t.rw('eva', 'a', 'p.md')->>'o_state') || ' ' || t.hits('a'));
select t.expect('budget: a grant, an at-capacity answer and a first wait each count against the vault; a call back before its gap doesn''t',
  (select string_agg(what, ', ' order by k) from t.seen), 'granted 1, at_capacity 2, wait 3, wait 3');

select t.fill('a');
select t.save('fay-over', t.rw('fay', 'a', 'p.md')::text);
select t.expect_true('budget: over its budget, a vault''s agent is answered wait, with no place, no ready count and the seconds until its minute ends',
  t.j('fay-over')->>'o_state' = 'wait' and t.j('fay-over')->'o_place' = 'null' and t.j('fay-over')->'o_ready' = 'null'
    and (t.j('fay-over')->>'o_wait_seconds')::int between 1 and 60,
  t.val('fay-over'));
select t.expect('budget: an answer over budget writes no place and logs nothing',
  (select count(*) from public.work_plan_places where vault_id = t.id('a') and holder = t.id('fay'))::text || ' '
    || (select count(*) from public.log where vault_id = t.id('a') and actor = t.id('fay'))::text,
  '0 0');
update public.work_plan_places set next_allowed_at = clock_timestamp() - interval '1 second' where vault_id = t.id('a') and holder = t.id('eva');
select t.save('eva-place', (select to_jsonb(pl) from public.work_plan_places pl where vault_id = t.id('a') and holder = t.id('eva'))::text);
select t.save('eva-over', t.rw('eva', 'a', 'p.md')::text);
select t.expect('budget: a place already in line is kept, as it was, when its holder is over budget',
  coalesce(t.j('eva-over')->>'o_place', 'no place') || ', '
    || ((select to_jsonb(pl) from public.work_plan_places pl where vault_id = t.id('a') and holder = t.id('eva')) = t.j('eva-place'))::text,
  'no place, true');
select t.expect('budget: claim_step in a vault over its budget is refused in words, with the budget and the seconds',
  regexp_replace(t.refusal('fay', format($q$select public.claim_step(%L, 'free.md', 'z')$q$, t.id('a'))), '\d+ seconds', 'N seconds'),
  'RLW06 this vault''s people and agents together have asked for work 300 times this minute, its budget; ask again in N seconds');
select t.expect('budget: another vault''s agents are unaffected while one vault is over its budget',
  t.rw('ben', 'b', 'p.md')->>'o_state', 'granted');

select t.expect('budget: no person, agent or app role can read or change the budget, count against it or reset a vault''s count',
  (select string_agg(x, ',' order by n) from (
    select 1 n, t.run('ben', $q$select per_minute::text from private.request_budget$q$) x
    union all select 2, t.run('ben', $q$update private.request_budget set per_minute = 1000000 returning 'raised'$q$)
    union all select 3, t.run('ben', format($q$select private.request_budget_hit(%L)::text$q$, t.id('b')))
    union all select 4, t.run('ben', $q$delete from private.rate_limits returning 'reset'$q$)
    union all select 5, t.run_role('reliquary_mcp', $q$update private.request_budget set per_minute = 1000000 returning 'raised'$q$)
    union all select 6, t.run_role('reliquary_mcp', format($q$select private.request_budget_hit(%L)::text$q$, t.id('b')))) s),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501');
