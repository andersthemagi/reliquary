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

-- Ben's agent proposes; Ana asks for changes.
select set_config('request.jwt.claims', json_build_object('sub', :'ben', 'act', json_build_object('sub', 'x', 'name', 'Hermes on Linux'))::text, false),
       set_config('role', 'authenticated', false);
select public.propose(:'v1', 'canon/terms.md', 'Net 60.', 'payment terms') as p2 \gset
select pg_temp.reset();
select pg_temp.as_person(:'ana');
select public.decide(:'p2', 'request_changes', 'We agreed Net 30.');
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
\echo CHANGES_PROPOSAL=:p2
\echo DEE_VAULT=:v2

-- ---------------------------------------------------------------------------
-- Threads (test/threads.test.mjs). Its own vault, so the other tests' lists
-- don't change: Ana owner, Ben editor, Cal viewer. Ben's agent proposes a
-- brief and Ana asks for changes; a second proposal is already applied.
\o /dev/null
select pg_temp.as_person(:'ana');
select public.create_vault('Threads', 'open') as tv \gset
select public.set_member(:'tv', :'ben', 'editor');
select public.set_member(:'tv', :'cal', 'viewer');
select public.set_policy(:'tv', 'canon/', 'canon', 1);
select public.propose(:'tv', 'canon/done.md', 'Done.', 'closed one') as tp_closed \gset
select public.decide(:'tp_closed', 'approve');
select pg_temp.reset();
select set_config('request.jwt.claims', json_build_object('sub', :'ben', 'act', json_build_object('sub', 'x', 'name', 'Hermes on Linux'))::text, false),
       set_config('role', 'authenticated', false);
select public.propose(:'tv', 'canon/brief.md', 'A long brief about the booking flow.', 'first brief') as tp \gset
select pg_temp.reset();
select pg_temp.as_person(:'ana');
select public.decide(:'tp', 'request_changes', 'Shorter, please.');
select pg_temp.reset();
select pg_temp.as_person(:'dee');
select public.propose(:'v2', 'plans.md', 'Plan.', 'dee plan') as tp_dee \gset
select pg_temp.reset();
\o
\echo THREAD_VAULT=:tv
\echo THREAD_PROPOSAL=:tp
\echo THREAD_CLOSED=:tp_closed
\echo DEE_PROPOSAL=:tp_dee
