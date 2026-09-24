-- Hostile tests for 20260925190000_final_sweep: the operator's role for
-- re-encryption and what the web app's role keeps, readers since a value
-- was set (exact, from private.env_readers), and the access log's primary
-- key. Ana owns Team (Ben edits, Cal views); Dee owns Other.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'other', t.run('dee', $q$select public.create_vault('Other')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));

create function t.ct(p_tag text) returns bytea language sql as
$$ select convert_to('CT-MARKER-' || p_tag || repeat('.', greatest(0, 8 - length(p_tag))), 'utf8') $$;
create function t.setv(p_user text, p_vault text, p_name text, p_env text, p_nonce int) returns text language sql as $$
  select t.run(p_user, format($q$select public.set_variable(%L, %L, %L, 'k1', %L::bytea, %L::bytea)$q$,
    t.id(p_vault), p_name, p_env, decode(lpad(to_hex(p_nonce), 24, '0'), 'hex'), t.ct(p_name || '-' || p_env)))
$$;
select t.setv('ana', 'team', 'API_KEY', 'development', 1);
select t.setv('ana', 'team', 'DB_URL', 'development', 2);
select t.setv('ana', 'team', 'API_KEY', 'production', 3);
select t.setv('dee', 'other', 'OTHER_KEY', 'development', 4);

-- ---------------------------------------------------------------------------
-- The operator's role

select t.expect('operator: reliquary_ops can''t log in until an owner gives it a password, and is no API role',
  (select rolcanlogin::text from pg_roles where rolname = 'reliquary_ops')
  || ' ' || pg_has_role('reliquary_ops', 'authenticated', 'member')::text
  || ' ' || pg_has_role('reliquary_ops', 'reliquary_web', 'member')::text,
  'false false false');

select t.expect_true('operator: reliquary_ops''s statements stop after 60 s',
  exists (select 1 from pg_db_role_setting where setrole = 'reliquary_ops'::regrole and setdatabase = 0
             and 'statement_timeout=60s' = any (setconfig)));

select t.expect('operator: reliquary_ops reads no table itself, ciphertext included',
  t.run_role('reliquary_ops', 'select count(*) from private.variable_secrets')
  || ',' || t.run_role('reliquary_ops', 'select count(*) from public.variables')
  || ',' || t.run_role('reliquary_ops', 'select count(*) from public.env_access_log'),
  'ERR 42501,ERR 42501,ERR 42501');

select t.expect('operator: the web app''s role gets key ids only, for its start-up check',
  t.run_role('reliquary_web', 'select string_agg(k, '','' order by k) from private.stored_key_ids() k'),
  'k1');

select t.expect('operator: people, agents, anonymous and the MCP role can''t call what the web app''s role keeps',
  t.run('ana', 'select count(*) from private.stored_key_ids()')
  || ',' || t.run('ana', format('select count(*) from private.renamed_rows(%L, ''development'')', t.id('team')))
  || ',' || t.run('ana', format('select private.reseal_renamed(%L, ''[]'')', t.id('team')))
  || ',' || t.run('ana', format('select count(*) from private.renamed_rows(%L, ''development'')', t.id('team')), 'Claude')
  || ',' || t.run(null, 'select count(*) from private.stored_key_ids()')
  || ',' || t.run_role('reliquary_mcp', format('select count(*) from private.renamed_rows(%L, ''development'')', t.id('team')))
  || ',' || t.run_role('reliquary_mcp', format('select private.reseal_renamed(%L, ''[]'')', t.id('team'))),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501');

select t.expect('operator: without a rename in its transaction the web app''s role reads and reseals no environment''s values, even with the old setting set by hand',
  t.run_role('reliquary_web', format('select count(*) from private.renamed_rows(%L, ''development'')', t.id('team')))
  || ',' || t.run_role('reliquary_web', format($q$select count(*) from (select set_config('reliquary.resealing', %L, true)) s,
                                                 private.renamed_rows(%L, 'development')$q$, t.id('team') || '/development', t.id('team')))
  || ',' || t.run_role('reliquary_web', format($q$select private.reseal_renamed(%L, '[{"environment": "development"}]')
                                                   from (select set_config('reliquary.resealing', %L, true)) s$q$,
                                                 t.id('team'), t.id('team') || '/development')),
  'ERR 42501,ERR 42501,ERR 42501');

select t.expect('operator: nobody reads the renames in progress',
  t.run('ana', 'select count(*) from private.environment_renames')
  || ',' || t.run_role('reliquary_web', 'select count(*) from private.environment_renames')
  || ',' || t.run_role('reliquary_mcp', 'select count(*) from private.environment_renames'),
  'ERR 42501,ERR 42501,ERR 42501');

-- A rename (Ana, in person) and then, in the same transaction, what the web
-- app's role may read, as renameEnvironment does it.
select t.run('ana', format($q$select public.create_environment(%L, 'staging')$q$, t.id('team')));
select t.run('dee', format($q$select public.create_environment(%L, 'qa')$q$, t.id('other')));
select t.setv('ana', 'team', 'STAGE_KEY', 'staging', 5);
select t.setv('dee', 'other', 'QA_KEY', 'qa', 6);
create function t.rename_then(variadic p_sqls text[]) returns text language plpgsql as $$
declare
  r text;
  s text;
begin
  r := t.run('ana', format($q$select public.rename_environment(%L, 'staging', 'qa') ->> 'moved'$q$, t.id('team')));
  foreach s in array p_sqls loop
    r := r || ',' || t.run_role('reliquary_web', s);
  end loop;
  return r;
end $$;

select t.expect('operator: in a rename''s transaction the web app''s role reads that vault''s renamed environment, and nothing else',
  t.rename_then(
    format($q$select string_agg(name || '=' || convert_from(ciphertext, 'utf8'), ' ') from private.renamed_rows(%L, 'qa')$q$, t.id('team')),
    format($q$select count(*) from private.renamed_rows(%L, 'development')$q$, t.id('team')),
    format($q$select count(*) from private.renamed_rows(%L, 'qa')$q$, t.id('other')),
    format($q$select count(*) from private.sealed_rows(%L)$q$, t.id('team'))),
  '1,STAGE_KEY=CT-MARKER-STAGE_KEY-staging,ERR 42501,ERR 42501,ERR 42501');

select t.expect('operator: once the rename''s transaction is over, its environment is closed again',
  t.run_role('reliquary_web', format($q$select count(*) from private.renamed_rows(%L, 'qa')$q$, t.id('team')))
  || ',' || t.run_role('reliquary_web', format($q$select private.reseal_renamed(%L, '[{"environment": "qa"}]')$q$, t.id('team'))),
  'ERR 42501,ERR 42501');

-- ---------------------------------------------------------------------------
-- Readers since a value was set. Log rows go straight in (as the functions
-- write them), with their times; the values were set "now", then moved back.

update public.variable_values set updated_at = now() - interval '10 days'
 where vault_id = t.id('team') and environment in ('development', 'production');

create function t.logrow(p_vault text, p_user text, p_agent text, p_action text, p_env text, p_names text[], p_ago interval)
returns void language sql as $$
  insert into public.env_access_log (vault_id, at, actor, agent, action, environment, names)
  values (t.id(p_vault), now() - p_ago, t.id(p_user), p_agent, p_action, p_env, p_names)
$$;
-- Cal read development before it was set; Ben read it (CLI) 9 days ago and
-- revealed production's API_KEY 8 days ago; then 600 newer rows that name
-- nothing Ben read (the old lookback's window).
select t.logrow('team', 'cal', 'Reliquary CLI', 'read', 'development', array['API_KEY', 'DB_URL'], interval '11 days');
select t.logrow('team', 'ben', 'Reliquary CLI', 'read', 'development', array['API_KEY', 'DB_URL'], interval '9 days');
select t.logrow('team', 'ben', null, 'reveal', 'production', array['API_KEY'], interval '8 days');
select t.logrow('team', 'ana', null, 'refused', 'production', array['API_KEY'], interval '1 day') from generate_series(1, 600);
select t.logrow('other', 'dee', 'Reliquary CLI', 'read', 'development', array['OTHER_KEY'], interval '1 day');

create function t.readers(p_user text, p_vault text) returns text language sql as $$
  select t.run(p_user, format($q$select coalesce(string_agg(name || '@' || environment || ':' || action || ':' || actor || ':' || coalesce(agent, '-'),
    ' ' order by name, environment, action), '(none)') from public.variable_readers(%L)$q$, t.id(p_vault)))
$$;

select t.expect('readers: a read or reveal since the value was set counts however many log rows came after it; one before it doesn''t',
  t.readers('ana', 'team'),
  format('API_KEY@development:read:%s:Reliquary CLI API_KEY@production:reveal:%s:- DB_URL@development:read:%s:Reliquary CLI',
         t.id('ben'), t.id('ben'), t.id('ben')));

-- The same, from the whole log (as the table owner).
create function t.brute(p_vault text) returns text language sql as $$
  with g as (
    select environment, action, actor, agent, names, max(at) as at from public.env_access_log
     where vault_id = t.id(p_vault) and action in ('read', 'reveal') group by 1, 2, 3, 4, 5),
  x as (
    select distinct n.name, g.environment, g.action, g.actor, g.agent
      from g cross join unnest(g.names) n(name)
      join public.variables v on v.vault_id = t.id(p_vault) and v.name = n.name
      join public.variable_values vv on vv.variable_id = v.id and vv.environment = g.environment and g.at > vv.updated_at)
  select coalesce(string_agg(name || '@' || environment || ':' || action || ':' || actor || ':' || coalesce(agent, '-'),
    ' ' order by name, environment, action), '(none)') from x
$$;

select t.expect_true('readers: exactly what scanning the whole access log gives',
  t.readers('ana', 'team') = t.brute('team'), t.readers('ana', 'team') || ' vs ' || t.brute('team'));

select t.expect('readers: owners and editors see them; viewers and outsiders get none, and anonymous can''t ask',
  (t.readers('ben', 'team') = t.readers('ana', 'team'))::text
  || ' ' || t.readers('cal', 'team') || ' ' || t.readers('dee', 'team') || ' ' || t.readers(null, 'team'),
  'true (none) (none) ERR 42501');

select t.setv('ana', 'team', 'DB_URL', 'development', 7);
select t.expect('readers: once a value is set again, reads before that no longer count',
  t.readers('ana', 'team'),
  format('API_KEY@development:read:%s:Reliquary CLI API_KEY@production:reveal:%s:-', t.id('ben'), t.id('ben')));

create function t.groups(p_vault text, p_user text) returns bigint language sql as
$$ select count(*) from private.env_readers where vault_id = t.id(p_vault) and actor = t.id(p_user) $$;
select t.logrow('team', 'ben', 'Reliquary CLI', 'read', 'development', array['API_KEY', 'DB_URL', 'NEW_KEY'], interval '1 hour');
select t.logrow('team', 'ben', 'Reliquary CLI', 'read', 'development', array['API_KEY', 'DB_URL', 'NEW_KEY'], interval '0');
select t.expect('readers: a newer read naming everything an older one did replaces its group, so they stay few',
  t.groups('team', 'ben') || ' '
  || (select array_to_string(names, ',') from private.env_readers
       where vault_id = t.id('team') and actor = t.id('ben') and action = 'read'),
  '2 API_KEY,DB_URL,NEW_KEY');
-- A newer read that names less (a variable deleted meanwhile) doesn't
-- cover the older one: both stay.
select t.logrow('team', 'ben', 'Reliquary CLI', 'read', 'development', array['API_KEY'], interval '-1 minute');
select t.expect('readers: a newer read naming less keeps the older group, and the answer is still exact',
  t.groups('team', 'ben') || ' ' || (t.readers('ana', 'team') = t.brute('team'))::text || ' '
  || (t.readers('ana', 'team') like '%DB_URL@development:read:' || t.id('ben') || '%')::text,
  '3 true true');

select t.expect('readers: nobody reads the groups themselves',
  t.run('ana', 'select count(*) from private.env_readers')
  || ',' || t.run_role('reliquary_web', 'select count(*) from private.env_readers')
  || ',' || t.run_role('reliquary_mcp', 'select count(*) from private.env_readers'),
  'ERR 42501,ERR 42501,ERR 42501');

select t.run('dee', format($q$select public.delete_vault(%L, 'Other')$q$, t.id('other')));
select t.expect('readers: a deleted vault''s groups go with it',
  (select count(*) from private.env_readers where vault_id = t.id('other'))::text, '0');

-- ---------------------------------------------------------------------------
-- The access log's primary key

select t.expect('access log: its primary key is (vault_id, seq), and no index orders it across vaults',
  (select string_agg(a.attname, ',' order by k.i)
     from pg_constraint c cross join unnest(c.conkey) with ordinality k(n, i)
     join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n
    where c.conrelid = 'public.env_access_log'::regclass and c.contype = 'p')
  || ' ' || (select count(*) from pg_index x join pg_attribute a on a.attrelid = x.indrelid and a.attnum = x.indkey[0]
              where x.indrelid = 'public.env_access_log'::regclass and a.attname = 'seq'),
  'vault_id,seq 0');

-- Old's rows are all the oldest, then many of Team's: a backward walk of
-- the whole log would pass every one of Team's to reach Old's newest.
insert into t.ids select 'old', t.run('ana', $q$select public.create_vault('Old')$q$)::uuid;
insert into public.env_access_log (vault_id, actor, action, environment, names)
select t.id('old'), t.id('ana'), 'read', 'development', '{}' from generate_series(1, 3000);
insert into public.env_access_log (vault_id, actor, action, environment, names)
select t.id('team'), t.id('ana'), 'refused', 'production', '{}' from generate_series(1, 30000);
analyze public.env_access_log;

create function t.plan(p_user text, p_sql text) returns text language plpgsql as $$
declare
  line text;
  out text := '';
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  for line in execute 'explain (analyze, costs off, timing off, summary off) ' || p_sql loop
    out := out || line || E'\n';
  end loop;
  perform set_config('role', 'none', true);
  return out;
end $$;

select t.expect('access log: the newest page of a vault whose rows are the oldest reads only that vault''s rows',
  (select (p ~ 'Index Scan Backward using env_access_log_pkey') || ' ' || (p ~ 'Index Cond: \(vault_id = ') || ' '
          || (p !~ 'Rows Removed by Filter') || ' ' || (p ~ 'rows=101 ')
     from t.plan('ana', format($q$select seq, at, action from public.env_access_log
                                  where vault_id = %L order by seq desc limit 101$q$, t.id('old'))) p),
  'true true true true');
