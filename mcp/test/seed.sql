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
-- Token scope (test/scope.test.mjs): Ana gets a second vault (named to sort
-- after Team), a read-only token for Team, a read-write token for Workshop
-- only, one to revoke mid-session and one already expired.
\o /dev/null
select pg_temp.as_person(:'ana');
select public.create_vault('Workshop') as ana_ws \gset
select public.write_file(:'ana_ws', 'notes/shed.md', 'Workshop: garden shed plans.');
select public.create_access_token('Team reader', 30, array[:'v1']::uuid[], 'read') as ana_team_ro \gset
select public.create_access_token('Workshop writer', 30, array[:'ana_ws']::uuid[], 'write') as ana_ws_rw \gset
select public.create_access_token('To revoke', 30, array[:'v1']::uuid[], 'read') as ana_revoke \gset
select public.create_access_token('Already expired', 30) as ana_expired \gset
select pg_temp.reset();
update public.access_tokens set expires_at = now() - interval '1 second' where name = 'Already expired';
\o

\echo ANA_TEAM_RO=:ana_team_ro
\echo ANA_WS_RW=:ana_ws_rw
\echo ANA_REVOKE=:ana_revoke
\echo ANA_EXPIRED=:ana_expired
\echo WORKSHOP_VAULT=:ana_ws
