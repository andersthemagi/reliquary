-- Seed for the MCP end-to-end test. Everything goes through the API as the
-- person (no act claim), exactly as the web UI would. Synthetic data only.
-- Prints one KEY=VALUE line per token for test.sh.

\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned

create function pg_temp.as_person(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user)::text, false),
         set_config('role', 'authenticated', false)
$$;
create function pg_temp.reset() returns void language sql as $$
  select set_config('role', 'none', false), set_config('request.jwt.claims', '', false)
$$;

\set ana '00000000-0000-0000-0000-00000000000a'
\set ben '00000000-0000-0000-0000-00000000000b'
\set cal '00000000-0000-0000-0000-00000000000c'
\set dee '00000000-0000-0000-0000-00000000000d'

\o /dev/null
select pg_temp.as_person(:'ana');
select public.create_vault('Team', 'open') as v1 \gset
select public.set_member(:'v1', :'ben', 'editor');
select public.set_member(:'v1', :'cal', 'viewer');
select public.set_policy(:'v1', 'canon/', 'canon', 1);
select public.write_file(:'v1', 'notes/standup.md', 'Standup is at 10:00 in room B.');
select public.propose(:'v1', 'canon/pricing.md', 'Day rate is 800 EUR.', 'initial rate') as p1 \gset
select public.decide(:'p1', 'approve');
select public.create_access_token('Claude Code on MacBook') as ana_token \gset
select pg_temp.reset();

select pg_temp.as_person(:'ben');
select public.create_access_token('Hermes on Linux') as ben_token \gset
select pg_temp.reset();

select pg_temp.as_person(:'cal');
select public.create_access_token('ChatGPT') as cal_token \gset
select pg_temp.reset();

select pg_temp.as_person(:'dee');
select public.create_vault('Dee private') as v2 \gset
select public.write_file(:'v2', 'secret.md', 'Acquisition talks with Falcon.');
select public.create_access_token('Cursor') as dee_token \gset
select pg_temp.reset();
\o

\echo ANA_TOKEN=:ana_token
\echo BEN_TOKEN=:ben_token
\echo CAL_TOKEN=:cal_token
\echo DEE_TOKEN=:dee_token
\echo TEAM_VAULT=:v1
\echo DEE_VAULT=:v2
