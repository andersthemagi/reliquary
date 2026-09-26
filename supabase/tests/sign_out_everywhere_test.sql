-- Hostile tests for 20260926140100_sign_out_everywhere: ending every browser
-- session of an account (private.session_cutoffs, private.check_session)
-- and, when asked, revoking its connections (public.end_my_sessions). Ana
-- and Ben each have a personal token and a connected app; Cal has a token.

insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'), (t.id('cal'), 'cal@example.test');

select t.run('ana', $q$select public.create_access_token('ana-pat', 30)$q$);
select t.run('ben', $q$select public.create_access_token('ben-pat', 30)$q$);
select t.run('cal', $q$select public.create_access_token('cal-pat', 30)$q$);
insert into public.access_tokens (user_id, name, kind, client_id, resource, expires_at)
values (t.id('ana'), 'ana-app', 'oauth', 'https://client.example/meta.json', 'https://mcp.example/mcp', now() + interval '30 days'),
       (t.id('ben'), 'ben-app', 'oauth', 'https://client.example/meta.json', 'https://mcp.example/mcp', now() + interval '30 days');

create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;
create function t.live(p_user text) returns text language sql as
$$ select count(*)::text from public.access_tokens where user_id = t.id(p_user) and revoked_at is null $$;
-- A browser session of p_user whose JWT was issued p_age seconds ago (its iat), checked as the web app does.
create function t.session(p_user text, p_age int) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'iat', floor(extract(epoch from now())) - p_age), $q$select private.check_session()::text || 'ok'$q$)
$$;
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;

-- ---------------------------------------------------------------------------
-- Before: every session passes

select t.expect('sign out everywhere: before it, a session of any age passes the check',
  t.session('ana', 3000) || ' ' || t.session('ana', 0), 'ok ok');
select t.expect('sign out everywhere: a session without an iat (the local stand-in) is not checked',
  t.run('ana', $q$select private.check_session()::text || 'ok'$q$), 'ok');

-- ---------------------------------------------------------------------------
-- Only the person, in person

select t.expect('sign out everywhere: an agent can''t do it for its person, and nothing is cut off',
  t.run('ana', $q$select public.end_my_sessions(true)::text$q$, 'Claude Code') || ' '
  || (select count(*)::text from private.session_cutoffs) || ' ' || t.live('ana'),
  'ERR 42501 0 2');
select t.expect('sign out everywhere: nor a personal token or a connected app of theirs',
  t.run_tok('ana', 'ana-pat', $q$select public.end_my_sessions(false)::text$q$) || ' '
  || t.run_tok('ana', 'ana-app', $q$select public.end_my_sessions(true)::text$q$) || ' '
  || (select count(*)::text from private.session_cutoffs) || ' ' || t.live('ana'),
  'ERR 42501 ERR 42501 0 2');
select t.expect('sign out everywhere: anonymous callers are refused',
  t.run(null, $q$select public.end_my_sessions(true)::text$q$), 'ERR 42501');
select t.expect('sign out everywhere: nobody reads or writes the cutoffs directly, the web app''s role included',
  t.run('ana', $q$select count(*)::text from private.session_cutoffs$q$) || ' '
  || t.run('ana', format($q$insert into private.session_cutoffs values (%L, now()) returning 'x'$q$, t.id('ben'))) || ' '
  || t.run_role('reliquary_web', $q$select count(*)::text from private.session_cutoffs$q$),
  'ERR 42501 ERR 42501 ERR 42501');

-- ---------------------------------------------------------------------------
-- In person, without revoking connections

select t.expect('sign out everywhere: in person it returns 0 connections revoked when not asked to revoke them',
  t.run('ana', $q$select public.end_my_sessions(false)::text$q$), '0');
select t.expect('sign out everywhere: a session issued before is refused with RLA01',
  t.session('ana', 5), 'ERR RLA01');
select t.expect('sign out everywhere: a session issued after passes (signing in again works)',
  t.session('ana', -2), 'ok');
select t.expect('sign out everywhere: other people''s sessions are untouched',
  t.session('ben', 5) || ' ' || t.session('cal', 3000), 'ok ok');
select t.expect('sign out everywhere: connections are separate and stay live when not asked',
  t.live('ana'), '2');
select t.expect('sign out everywhere: signing out again never moves the cutoff back',
  (select t.run('ana', $q$select public.end_my_sessions(false)::text$q$)) || ' '
  || (select (not_before <= now())::text from private.session_cutoffs where user_id = t.id('ana')),
  '0 true');

-- ---------------------------------------------------------------------------
-- In person, revoking connections

update public.access_tokens set revoked_at = now() - interval '1 day' where name = 'ben-app';
select t.expect('sign out everywhere: asked to, it revokes every live connection of the person, and counts them',
  t.run('ben', $q$select public.end_my_sessions(true)::text$q$) || ' ' || t.live('ben'), '1 0');
select t.expect('sign out everywhere: a connection revoked earlier keeps its revocation time',
  (select (revoked_at < now() - interval '12 hours')::text from public.access_tokens where name = 'ben-app'), 'true');
select t.expect('sign out everywhere: other people''s connections are untouched',
  t.live('ana') || ' ' || t.live('cal'), '2 1');
select t.expect('sign out everywhere: a revoked connection no longer resolves over MCP',
  (select count(*)::text from private.resolve_access_token(
     (select token_hash from public.access_tokens where name = 'ben-pat'))), '0');
