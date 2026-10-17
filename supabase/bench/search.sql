-- Seeds and times public.search. Run by search.sh after every migration, on
-- an empty database. Synthetic data only.
--
-- Ana owns three vaults of 1k, 10k and 50k files, and Dee owns one of 10k
-- that Ana can't read, so RLS has other tenants' rows to keep out. Every
-- file has an older version (its words cleared, as efficiency_3 does) and
-- 5% are deleted. Bodies are 100 to 600 words over a 5,000-word vocabulary
-- whose word k turns up with probability log((k+1)/k) / log(5000): w1 is in
-- nearly every file, w50 in about half, w3000 in about 1 in 100.

\set ON_ERROR_STOP on
select set_config('bench.runs', :'runs', false);

select setseed(0.42);
select test_support.roomy_free();

create function pg_temp.as_user(p_user uuid, p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return v;
end $$;

create table pg_temp.bv (label text primary key, owner uuid, n int, id uuid);
insert into pg_temp.bv values
  ('1k',    '00000000-0000-0000-0000-00000000000a', 1000,  null),
  ('10k',   '00000000-0000-0000-0000-00000000000a', 10000, null),
  ('50k',   '00000000-0000-0000-0000-00000000000a', 50000, null),
  ('other', '00000000-0000-0000-0000-00000000000d', 10000, null);
update pg_temp.bv set id = pg_temp.as_user(owner, format('select public.create_vault(%L)', 'Bench ' || label))::uuid;

create function pg_temp.note(p_words int) returns text language sql volatile as $$
  select string_agg(case when i % 12 = 0 then E'\n' else '' end
                    || 'w' || floor(power(5000, random()))::int, ' ')
    from generate_series(1, p_words) i
$$;

\echo 'Seeding 71,000 files with two versions each...'
insert into public.files (vault_id, path)
select bv.id, 'area-' || (g % 40) || '/note-' || lpad(g::text, 5, '0') || '.md'
  from pg_temp.bv bv cross join lateral generate_series(1, bv.n) g;

-- The older version first, then the current one: replacing the current
-- version clears the old one's words (private.clear_superseded_words).
insert into public.file_versions (file_id, vault_id, body, author, created_at)
select f.id, f.vault_id, pg_temp.note(50 + floor(random() * 200)::int), bv.owner, now() - interval '30 days'
  from public.files f join pg_temp.bv bv on bv.id = f.vault_id;
update public.files f set current_version_id = v.id
  from public.file_versions v where v.file_id = f.id;
insert into public.file_versions (file_id, vault_id, body, author)
select f.id, f.vault_id, '# ' || f.path || E'\n' || pg_temp.note(100 + floor(random() * 500)::int), bv.owner
  from public.files f join pg_temp.bv bv on bv.id = f.vault_id;
update public.files f set current_version_id = v.id,
       updated_at = now() - random() * interval '30 days',
       deleted_at = case when random() < 0.05 then now() end
  from public.file_versions v
 where v.file_id = f.id and v.created_at > now() - interval '1 day';
vacuum analyze;

\echo
\echo 'Sizes:'
select relname, n_live_tup as rows, pg_size_pretty(pg_total_relation_size(relid)) as total
  from pg_stat_user_tables where relname in ('files', 'file_versions') order by relname;

-- ---------------------------------------------------------------------------

create function pg_temp.bench(p_vault text, p_label text, p_query text)
returns table (vault text, query text, runs int, p50_ms numeric, p95_ms numeric, max_ms numeric, hits int)
language plpgsql as $$
declare
  r pg_temp.bv;
  t0 timestamptz;
  times numeric[] := '{}';
  k int;
  n int := current_setting('bench.runs')::int;
begin
  select * into r from pg_temp.bv where label = p_vault;
  perform pg_temp.as_user(r.owner, format('select count(*) from public.search(%L, %L, 20)', r.id, p_query));
  for i in 1 .. n loop
    t0 := clock_timestamp();
    k := pg_temp.as_user(r.owner, format('select count(*) from public.search(%L, %L, 20)', r.id, p_query))::int;
    times := times || extract(epoch from clock_timestamp() - t0) * 1000;
  end loop;
  return query select p_vault, p_label, n,
    round((select percentile_cont(0.5) within group (order by x) from unnest(times) x)::numeric, 1),
    round((select percentile_cont(0.95) within group (order by x) from unnest(times) x)::numeric, 1),
    round((select max(x) from unnest(times) x), 1),
    k;
end $$;

create table pg_temp.q (ord int, label text, query text);
insert into pg_temp.q values
  (1, 'common word (w1)',   'w1'),
  (2, 'mid word (w50)',     'w50'),
  (3, 'rare word (w3000)',  'w3000'),
  (4, 'two words',          'w50 w400'),
  (5, 'no match',           'nosuchword'),
  (6, 'path substring',     'note-00042');

\echo
\echo 'public.search(vault, query, 20) as the owner, under RLS (ms, warm cache):'
select b.* from pg_temp.bv v cross join pg_temp.q q
  cross join lateral pg_temp.bench(v.label, q.label, q.query) b
 where v.label <> 'other'
 order by v.n, q.ord;

-- auto_explain shows the plan inside the function, which a plain EXPLAIN of
-- the call hides behind a Function Scan.
\echo
\echo 'Plans for the 50k vault (auto_explain, nested statements):'
load 'auto_explain';
set auto_explain.log_min_duration = 0;
set auto_explain.log_analyze = on;
set auto_explain.log_buffers = on;
set auto_explain.log_nested_statements = on;
set auto_explain.log_level = notice;
set client_min_messages = notice;
\echo '-- common word (w1):'
select pg_temp.as_user(owner, format('select count(*) from public.search(%L, %L, 20)', id, 'w1')) from pg_temp.bv where label = '50k';
\echo '-- rare word (w3000):'
select pg_temp.as_user(owner, format('select count(*) from public.search(%L, %L, 20)', id, 'w3000')) from pg_temp.bv where label = '50k';
