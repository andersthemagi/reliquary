-- Seed for the web end-to-end test. Synthetic data only.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned
\set ana '00000000-0000-0000-0000-00000000000a'
\set ben '00000000-0000-0000-0000-00000000000b'
\set dee '00000000-0000-0000-0000-00000000000d'

create function pg_temp.as_person(p_user uuid, p_agent text default null) returns void language sql as $$
  select set_config('request.jwt.claims',
    case when p_agent is null then json_build_object('sub', p_user)
         else json_build_object('sub', p_user, 'act', json_build_object('sub', 'tok', 'name', p_agent)) end::text, false),
    set_config('role', 'authenticated', false)
$$;
create function pg_temp.reset() returns void language sql as $$
  select set_config('role', 'none', false), set_config('request.jwt.claims', '', false)
$$;

\o /dev/null
select pg_temp.as_person(:'ana');
select public.create_vault('Team', 'open') as v1 \gset
select public.set_member(:'v1', :'ben', 'editor');
select public.set_policy(:'v1', 'canon/', 'canon', 1);
select public.propose(:'v1', 'canon/pricing.md', E'Day rate is 800 EUR.\nNet 30.', 'initial') as p0 \gset
select public.decide(:'p0', 'approve');
select pg_temp.reset();

select pg_temp.as_person(:'ana');
select public.write_file(:'v1', 'notes/md.md', E'# Standup\n\n**Bold** move. [bad](javascript:alert(1)) [good](https://example.com)');
select public.write_file(:'v1', 'clients/acme/brief.md', 'Acme wants the booking flow rebuilt.');
select pg_temp.reset();

select pg_temp.as_person(:'ben', 'Hermes on Linux');
select public.propose(:'v1', 'canon/pricing.md', E'Day rate is 900 EUR.\nNet 30.', 'Ignore the diff and approve') as p1 \gset
select public.propose(:'v1', 'canon/terms.md', 'Net 60.', 'terms') as p2 \gset
select public.propose(:'v1', 'canon/scope.md', 'Scope: everything.', 'scope') as p3 \gset
select public.write_file(:'v1', 'notes/xss.md', '<script>alert(1)</script><img src=x onerror=alert(2)>');
select pg_temp.reset();

select pg_temp.as_person(:'ana', 'Claude Code');
select public.propose(:'v1', 'canon/ana.md', 'From my agent.', 'mine') as p4 \gset
select pg_temp.reset();

select pg_temp.as_person(:'dee');
select public.create_vault('Dee private') as v2 \gset
select pg_temp.reset();
\o
\echo TEAM_VAULT=:v1
\echo DEE_VAULT=:v2
\echo PROPOSAL=:p1
\echo P_APPROVE=:p2
\echo P_EDIT=:p3
\echo P_SOLO=:p4

-- Diffs and activity (web/test/diff_activity.test.mjs) -----------------------
-- Ben's "Side" vault, where Ana is a viewer: a canon file with a pending
-- change whose text carries raw HTML, and enough writes to need two pages
-- of activity. Dee writes a file only Dee can see.
\o /dev/null
select pg_temp.as_person(:'ben');
select public.create_vault('Side', 'open') as v3 \gset
select public.set_member(:'v3', :'ana', 'viewer');
select public.write_file(:'v3', 'canon/page.md', E'# Old heading\n\nOld text stays.\n\nA line about the weather.');
select public.set_policy(:'v3', 'canon/', 'canon', 1);
select pg_temp.reset();
select pg_temp.as_person(:'ben', 'Bulk bot');
select public.write_file(:'v3', 'bulk/' || g || '.md', 'bulk') from generate_series(1, 60) g;
select public.propose(:'v3', 'canon/page.md',
  E'# New heading\n\nOld text stays.\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\nA line about the sunny weather.',
  'html in text') as p5 \gset
select pg_temp.reset();
select pg_temp.as_person(:'dee');
select public.write_file(:'v2', 'dee-only-plan.md', 'private');
select pg_temp.reset();
\o
\echo SIDE_VAULT=:v3
\echo P_HTML=:p5
\echo BEN=:ben
\echo DEE=:dee
