-- Hostile tests for 20260926180000_welcome_tour: whether a person has seen
-- the Welcome tour is their own, in person only. Ana and Ben have accounts
-- made after the migration (so unseen); Cal is a second person.

insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'), (t.id('cal'), 'cal@example.test');

create function t.unseen(p_user text) returns text language sql as
$$ select t.run(p_user, $q$select public.shell_summary(0) ->> 'welcome_unseen'$q$) $$;
create function t.seen_rows(p_user text) returns text language sql as
$$ select count(*)::text from public.welcome_seen where user_id = t.id(p_user) $$;

select t.expect('welcome: an account made after the migration is unseen',
  t.unseen('ana') || ' ' || t.unseen('ben'), 'true true');

select t.expect('welcome: an agent, token or connected app can''t mark it seen, and it stays unseen',
  t.run('ana', $q$select coalesce(nullif(public.mark_welcome_seen()::text, ''), 'ok')$q$, 'Claude Code') || ' '
  || coalesce(t.run('ana', format($q$insert into public.welcome_seen (user_id) values (%L) returning 'ok'$q$, t.id('ana')), 'Claude Code'), 'nothing') || ' '
  || t.unseen('ana'),
  'ERR 42501 ERR 42501 true');

select t.expect('welcome: an agent can''t read the row either',
  t.run('ana', $q$select count(*)::text from public.welcome_seen$q$, 'Claude Code') || ' ' || t.run('ana', $q$select public.shell_summary(0) ->> 'welcome_unseen'$q$, 'Claude Code'),
  '0 ERR 42501');

select t.expect('welcome: nobody marks another person''s tour seen, through the table',
  t.run('cal', format($q$insert into public.welcome_seen (user_id) values (%L) returning 'ok'$q$, t.id('ben'))) || ' '
  || t.unseen('ben') || ' ' || t.seen_rows('ben'),
  'ERR 42501 true 0');

select t.expect('welcome: a person marks their own seen, and it is seen from then on; doing it again is harmless',
  t.run('ana', $q$select coalesce(nullif(public.mark_welcome_seen()::text, ''), 'ok')$q$) || ' ' || t.run('ana', $q$select coalesce(nullif(public.mark_welcome_seen()::text, ''), 'ok')$q$) || ' '
  || t.unseen('ana') || ' ' || t.seen_rows('ana'),
  'ok ok false 1');

select t.expect('welcome: someone else''s seen row is invisible, and can''t be changed or deleted',
  t.run('cal', $q$select count(*)::text from public.welcome_seen$q$) || ' '
  || coalesce(t.run('cal', format($q$update public.welcome_seen set seen_at = now() where user_id = %L returning 'changed'$q$, t.id('ana'))), 'nothing') || ' '
  || coalesce(t.run('cal', format($q$delete from public.welcome_seen where user_id = %L returning 'deleted'$q$, t.id('ana'))), 'nothing') || ' '
  || t.seen_rows('ana'),
  '0 ERR 42501 ERR 42501 1');

select t.expect('welcome: a person can''t un-see it either (no update or delete for themselves)',
  coalesce(t.run('ana', $q$delete from public.welcome_seen returning 'deleted'$q$), 'nothing') || ' ' || t.unseen('ana'),
  'ERR 42501 false');

create table t.before as select count(*) as n from public.welcome_seen where user_id = t.id('ana');
delete from auth.users where id = t.id('ana');
select t.expect('welcome: the row goes with the account',
  (select n::text from t.before) || ' ' || t.seen_rows('ana'), '1 0');
