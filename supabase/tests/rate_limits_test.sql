-- Hostile tests for 20260925200000_rate_limits: nobody but the apps' roles
-- counts, nobody reads or resets a counter, a key is never a raw address,
-- the limit and its Retry-After, a refused request counting nothing, a
-- token's grant as its key, and pruning.

-- A call of private.rate_limit_hit as SQL text, one bucket.
create function t.hit(p_bucket text, p_key text, p_window int, p_limit int, p_cost int default 1) returns text
language sql as $$
  select format('select private.rate_limit_hit(array[%L], array[%L], array[%s], array[%s], array[%s])',
    p_bucket, p_key, p_window, p_limit, p_cost)
$$;

-- ---------------------------------------------------------------------------
-- Who may count, read and reset

select t.expect('who: people, agents and anonymous callers can''t count, read the salt, prune or count for a token',
  t.run('ana', t.hit('probe', t.sha('a'), 60, 5))
  || ',' || t.run('ana', t.hit('probe', t.sha('a'), 60, 5), 'Claude')
  || ',' || t.run(null, t.hit('probe', t.sha('a'), 60, 5))
  || ',' || t.run('ana', 'select private.rate_limit_salt()')
  || ',' || t.run('ana', 'select private.rate_limit_salt()', 'Claude')
  || ',' || t.run(null, 'select private.rate_limit_salt()')
  || ',' || t.run('ana', 'select private.prune_rate_limits()')
  || ',' || t.run('ana', format($q$select private.rate_limit_token(%L, array['t'], array[60], array[5], array[1])$q$, t.sha('x')), 'Claude'),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501');

select t.run_role('reliquary_web', t.hit('probe', t.sha('victim'), 3600, 3));

select t.expect('who: people and agents can''t read, change or delete a counter, or read the salt table',
  t.run('ana', 'select count(*) from private.rate_limits')
  || ',' || t.run('ana', 'delete from private.rate_limits returning 1')
  || ',' || t.run('ana', 'update private.rate_limits set hits = 0 returning 1', 'Claude')
  || ',' || t.run('ana', format($q$insert into private.rate_limits values ('probe', %L, now(), now() + interval '1 hour', 0) returning 1$q$, t.sha('victim')))
  || ',' || t.run(null, 'delete from private.rate_limits returning 1')
  || ',' || t.run('ana', 'select salt from private.rate_limit_salt')
  || ',' || t.run('ana', 'select salt from private.rate_limit_salt', 'Claude'),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501');

select t.expect('who: the apps'' roles count only through the functions: no reading, resetting or pruning the table',
  t.run_role('reliquary_web', 'select count(*) from private.rate_limits')
  || ',' || t.run_role('reliquary_web', 'delete from private.rate_limits returning 1')
  || ',' || t.run_role('reliquary_mcp', 'update private.rate_limits set hits = 0 returning 1')
  || ',' || t.run_role('reliquary_mcp', 'select salt from private.rate_limit_salt')
  || ',' || t.run_role('reliquary_web', 'select private.prune_rate_limits()')
  || ',' || t.run_role('reliquary_mcp', 'select private.prune_rate_limits()'),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501');

select t.expect('who: the web app''s and the MCP server''s roles count and read the salt, the same salt',
  t.run_role('reliquary_web', t.hit('probe', t.sha('b'), 60, 5))
  || ',' || t.run_role('reliquary_mcp', t.hit('probe', t.sha('c'), 60, 5))
  || ',' || (t.run_role('reliquary_web', 'select private.rate_limit_salt()') = t.run_role('reliquary_mcp', 'select private.rate_limit_salt()'))::text
  || ',' || (t.run_role('reliquary_web', 'select private.rate_limit_salt()') ~ '^[0-9a-f]{64}$')::text,
  '0,0,true,true');

select t.expect_true('who: every rate limit function pins its search_path',
  (select bool_and(p.proconfig @> array['search_path=""'])
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in ('rate_limit_salt', 'rate_limit_hit', 'rate_limit_token',
                                                   'prune_rate_limits', 'rate_limits_pruned_by_cron')
   having count(*) = 5));

select t.expect_true('who: the counters are unlogged, behind row level security',
  (select relpersistence = 'u' and relrowsecurity from pg_class where oid = 'private.rate_limits'::regclass));

-- ---------------------------------------------------------------------------
-- Keys

select t.expect('keys: a raw IP address, an email address or a short key is refused; only 64 hex digits are stored',
  t.run_role('reliquary_web', t.hit('probe', '203.0.113.9', 60, 5))
  || ',' || t.run_role('reliquary_web', t.hit('probe', 'ana@example.test', 60, 5))
  || ',' || t.run_role('reliquary_web', t.hit('probe', 'abc123', 60, 5))
  || ',' || t.run_role('reliquary_web', t.hit('Probe!', t.sha('d'), 60, 5))
  || ',' || (select count(*) from private.rate_limits where key !~ '^[0-9a-f]{64}$')::text,
  'ERR 23514,ERR 23514,ERR 23514,ERR 23514,0');

select t.expect('keys: bad windows, limits, costs, lengths and repeated keys are refused',
  t.run_role('reliquary_web', t.hit('probe', t.sha('e'), 0, 5))
  || ',' || t.run_role('reliquary_web', t.hit('probe', t.sha('e'), 604801, 5))
  || ',' || t.run_role('reliquary_web', t.hit('probe', t.sha('e'), 60, 0))
  || ',' || t.run_role('reliquary_web', t.hit('probe', t.sha('e'), 60, 5, -1))
  || ',' || t.run_role('reliquary_web', format($q$select private.rate_limit_hit(array['a','b'], array[%L], array[60], array[5], array[1])$q$, t.sha('e')))
  || ',' || t.run_role('reliquary_web', format($q$select private.rate_limit_hit(array['a','a'], array[%L,%L], array[60,60], array[5,5], array[1,1])$q$, t.sha('e'), t.sha('e')))
  || ',' || t.run_role('reliquary_web', $q$select private.rate_limit_hit('{}', '{}', '{}', '{}', '{}')$q$),
  'ERR 22023,ERR 22023,ERR 22023,ERR 22023,ERR 22023,ERR 22023,ERR 22023');

-- ---------------------------------------------------------------------------
-- Counting

create function t.hits(p_bucket text, p_key text) returns text language sql as
$$ select coalesce(sum(hits), 0)::text from private.rate_limits where bucket = p_bucket and key = p_key $$;

select t.expect('count: the first 3 hits in a window pass, the 4th is refused with the seconds left in the window',
  t.run_role('reliquary_web', t.hit('count', t.sha('f'), 3600, 3))
  || ',' || t.run_role('reliquary_web', t.hit('count', t.sha('f'), 3600, 3))
  || ',' || t.run_role('reliquary_web', t.hit('count', t.sha('f'), 3600, 3))
  || ',' || (t.run_role('reliquary_web', t.hit('count', t.sha('f'), 3600, 3))::int between 1 and 3600)::text,
  '0,0,0,true');

select t.expect('count: a refused request counts nothing (the counter stays at the limit)',
  t.run_role('reliquary_web', t.hit('count', t.sha('i'), 3600, 1))
  || ',' || (t.run_role('reliquary_web', t.hit('count', t.sha('i'), 3600, 1)) <> '0')::text
  || ',' || (t.run_role('reliquary_web', t.hit('count', t.sha('i'), 3600, 1)) <> '0')::text
  || ',' || t.hits('count', t.sha('i')),
  '0,true,true,1');

select t.expect('count: another key, and the same key in another bucket, have counters of their own',
  t.run_role('reliquary_web', t.hit('count', t.sha('g'), 3600, 3))
  || ',' || t.run_role('reliquary_web', t.hit('other', t.sha('f'), 3600, 3)),
  '0,0');

select t.expect('count: a cost counts that many; one over the limit is refused',
  t.run_role('reliquary_mcp', t.hit('cost', t.sha('h'), 3600, 10, 7))
  || ',' || (t.run_role('reliquary_mcp', t.hit('cost', t.sha('h'), 3600, 10, 4)) <> '0')::text
  || ',' || t.run_role('reliquary_mcp', t.hit('cost', t.sha('h'), 3600, 10, 3))
  || ',' || t.hits('cost', t.sha('h')),
  '0,true,0,10');

select t.expect('count: several buckets in one call; one refusing refuses the request and none of them counts it',
  t.run_role('reliquary_web', format($q$select private.rate_limit_hit(array['multi_email','multi_ip'], array[%L,%L], array[900,900], array[5,2], array[1,1])$q$, t.sha('victim@'), t.sha('ip1')))
  || ',' || t.run_role('reliquary_web', format($q$select private.rate_limit_hit(array['multi_email','multi_ip'], array[%L,%L], array[900,900], array[5,2], array[1,1])$q$, t.sha('victim@'), t.sha('ip1')))
  || ',' || (t.run_role('reliquary_web', format($q$select private.rate_limit_hit(array['multi_email','multi_ip'], array[%L,%L], array[900,900], array[5,2], array[1,1])$q$, t.sha('victim@'), t.sha('ip1'))) <> '0')::text
  || ',' || t.hits('multi_email', t.sha('victim@')) || ',' || t.hits('multi_ip', t.sha('ip1')),
  '0,0,true,2,2');

create function t.two(p_key text) returns text language sql as $$
  select t.run_role('reliquary_web', format($q$select private.rate_limit_hit(array['wa','wb'], array[%L,%L], array[60,86400], array[1,1], array[1,1])$q$, p_key, p_key))
$$;
-- In one statement, so one transaction and one now().
select t.expect('count: the Retry-After is the fullest refusing window''s end',
  t.two(t.sha('w')) || ',' || t.two(t.sha('w')),
  '0,' || greatest(ceil(60 - mod(extract(epoch from now())::numeric, 60)), ceil(86400 - mod(extract(epoch from now())::numeric, 86400)))::int);

-- ---------------------------------------------------------------------------
-- Tokens: counted against the grant

-- Ana's personal token, and an OAuth grant of hers with two access tokens
-- (an old one and its refreshed one).
insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
create table t.raw (name text primary key, value text);
insert into t.raw select 'pat', t.run('ana', $q$select public.create_access_token('pat', 30)$q$);
insert into t.raw select 'code', t.run('ana', format($q$select public.create_oauth_grant('Client', %L, %L, %L, %L, null, 'read')$q$,
  'https://client.example/meta.json', 'https://client.example/cb', 'https://mcp.example/mcp',
  translate(rtrim(encode(sha256(convert_to(repeat('v', 50), 'UTF8')), 'base64'), '='), '+/', '-_')));
select t.run_role('reliquary_web', format($q$select private.oauth_redeem_code(%L, %L, %L, %L, %L, %L, %L)$q$,
  t.sha((select value from t.raw where name = 'code')), 'https://client.example/meta.json', 'https://client.example/cb',
  'https://mcp.example/mcp', repeat('v', 50), t.sha('rlo_access_1'), t.sha('rlr_refresh_1')));
select t.run_role('reliquary_web', format($q$select private.oauth_refresh(%L, %L, %L, %L, %L)$q$,
  t.sha('rlr_refresh_1'), 'https://client.example/meta.json', 'https://mcp.example/mcp', t.sha('rlo_access_2'), t.sha('rlr_refresh_2')));

create function t.rate_tok(p_hash text, p_limit int default 3) returns text language sql as $$
  select t.run_role('reliquary_mcp', format($q$select private.rate_limit_token(%L, array['tok_minute'], array[3600], array[%s], array[1])$q$,
    p_hash, p_limit))
$$;

select t.expect('tokens: a personal token''s calls count against it; the 4th of 3 is refused',
  t.rate_tok(t.sha((select value from t.raw where name = 'pat'))) || ',' || t.rate_tok(t.sha((select value from t.raw where name = 'pat')))
  || ',' || t.rate_tok(t.sha((select value from t.raw where name = 'pat')))
  || ',' || (t.rate_tok(t.sha((select value from t.raw where name = 'pat'))) <> '0')::text,
  '0,0,0,true');

select t.expect('tokens: a grant''s access tokens share one counter, so refreshing doesn''t reset it',
  t.rate_tok(t.sha('rlo_access_1')) || ',' || t.rate_tok(t.sha('rlo_access_2')) || ',' || t.rate_tok(t.sha('rlo_access_2'))
  || ',' || (t.rate_tok(t.sha('rlo_access_1')) <> '0')::text,
  '0,0,0,true');

select t.expect('tokens: an unknown, refresh or revoked token counts nothing, and the key is never the token''s hash',
  t.rate_tok(t.sha('rlq_nope'), 1) || ',' || t.rate_tok(t.sha('rlq_nope'), 1)
  || ',' || t.rate_tok(t.sha('rlr_refresh_2'), 1) || ',' || t.rate_tok(t.sha('rlr_refresh_2'), 1)
  || ',' || t.rate_tok('not-a-hash', 1)
  || ',' || (select count(*) from private.rate_limits
              where key in (t.sha('rlq_nope'), t.sha('rlr_refresh_2'), t.sha('rlo_access_1'), t.sha((select value from t.raw where name = 'pat'))))::text,
  '0,0,0,0,0,0');

select t.run('ana', format($q$select public.revoke_access_token(%L)$q$,
  (select id from public.access_tokens where token_hash = t.sha((select value from t.raw where name = 'pat')))));
select t.expect('tokens: a revoked personal token counts nothing',
  t.rate_tok(t.sha((select value from t.raw where name = 'pat')), 1000),
  '0');

-- ---------------------------------------------------------------------------
-- Pruning

insert into private.rate_limits values
  ('old', t.sha('p1'), now() - interval '2 hours', now() - interval '1 hour', 4),
  ('old', t.sha('p2'), now() - interval '2 minutes', now() - interval '1 second', 1),
  ('old', t.sha('p3'), now() - interval '1 minute', now() + interval '1 hour', 1);

select t.expect_true('prune: ended windows go, open ones stay (the count)', private.prune_rate_limits() >= 2);
select t.expect('prune: ended windows go, open ones stay',
  (select string_agg(key, ',') from private.rate_limits where bucket = 'old'),
  t.sha('p3'));

select t.expect('prune: without pg_cron here the job isn''t found, so hits prune now and then',
  private.rate_limits_pruned_by_cron()::text,
  'false');
