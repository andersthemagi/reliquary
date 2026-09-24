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

-- Threads (test/threads.test.mjs). Its own vault, so the other tests' lists
-- don't change (named to sort after Team): Ana owner, Ben editor, Cal viewer. Ben's agent proposes a
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

-- Tidings (test/changes_comments.test.mjs): comments and review notes reach
-- agents through changes_since. Its own vault, named to sort after Team, so
-- the other tests' lists don't change: Ana owner, Ben editor, Cal viewer.
-- Ben's agent proposes a plan that Ana comments on and sends back, a file Ana rejects, and one
-- whose discussion Ana then erases. Dee comments on her own proposal.
\o /dev/null
select pg_temp.as_person(:'ana');
select public.create_vault('Tidings', 'open') as fv \gset
select public.set_member(:'fv', :'ben', 'editor');
select public.set_member(:'fv', :'cal', 'viewer');
select public.set_policy(:'fv', 'canon/', 'canon', 1);
select pg_temp.reset();
select set_config('request.jwt.claims', json_build_object('sub', :'ben', 'act', json_build_object('sub', 'x', 'name', 'Hermes on Linux'))::text, false),
       set_config('role', 'authenticated', false);
select public.propose(:'fv', 'canon/plan.md', 'Ship it next quarter.', 'roadmap') as fp \gset
select public.propose(:'fv', 'canon/old.md', 'Old notes.', 'archive') as fp_old \gset
select public.propose(:'fv', 'canon/gone.md', 'Gone.', 'to erase') as fp_gone \gset
select pg_temp.reset();
select pg_temp.as_person(:'ana');
select public.comment_on_proposal(:'fp', 'Which quarter do you mean?');
select public.decide(:'fp', 'request_changes', 'Name the quarter: Q3 or Q4.');
select public.decide(:'fp_old', 'reject', 'We keep old notes elsewhere.');
select public.comment_on_proposal(:'fp_gone', 'Gone remark, about to be erased.');
select public.decide(:'fp_gone', 'request_changes', 'Gone note, about to be erased.');
select public.erase_file(:'fv', 'canon/gone.md');
select pg_temp.reset();
select pg_temp.as_person(:'dee');
select public.comment_on_proposal(:'tp_dee', 'Dee private remark.');
select pg_temp.reset();
\o
\echo FEED_PROPOSAL=:fp
\echo FEED_REJECTED=:fp_old
\echo FEED_ERASED=:fp_gone

-- Create vault and delete_file (test/create_vault.test.mjs,
-- test/delete_file.test.mjs). Eve exists only here, with her own vault Eve
-- home (an open notes/ and a canon canon/), so the other tests' lists don't
-- change. Her tokens: all vaults read-write, all vaults read-only, Eve home
-- only read-write.
\set eve '00000000-0000-0000-0000-00000000000e'
\o /dev/null
select pg_temp.as_person(:'eve');
select public.create_vault('Eve home', 'open') as eve_home \gset
select public.set_policy(:'eve_home', 'canon/', 'canon', 1);
select public.write_file(:'eve_home', 'notes/scratch.md', 'Scratch notes.');
select public.write_file(:'eve_home', 'notes/keep.md', 'Keep this.');
select public.propose(:'eve_home', 'canon/charter.md', 'Charter.', 'first') as eve_p \gset
select public.decide(:'eve_p', 'approve');
select public.create_access_token('Eve all rw', 30, null, 'write') as eve_all_rw \gset
select public.create_access_token('Eve all ro', 30, null, 'read') as eve_all_ro \gset
select public.create_access_token('Eve home rw', 30, array[:'eve_home']::uuid[], 'write') as eve_home_rw \gset
select pg_temp.reset();
\o
\echo EVE_HOME=:eve_home
\echo EVE_ALL_RW=:eve_all_rw
\echo EVE_ALL_RO=:eve_all_ro
\echo EVE_HOME_RW=:eve_home_rw
