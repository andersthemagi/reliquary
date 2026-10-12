-- Hostile tests for 20261012120000_signup_notices: the web app's claims on
-- new accounts to email the operator about. support.sql starts this
-- database with invite-only off and no line; this file sets a pace of 2 a
-- day. Old was here before
-- (recorded as notified, as the migration records every account it finds)
-- and waits in line;
-- Ana is admitted by the operator; Ben and Cal wait in line; Pip hasn't
-- confirmed his address.

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids values ('old', '00000000-0000-0000-0000-00000000a001'),
  ('pip', '00000000-0000-0000-0000-00000000a002');
insert into auth.users (id, email, email_confirmed_at) values
  (t.id('old'), 'old@example.test', now() - interval '1 day'),
  (t.id('ana'), 'ana@example.test', now() - interval '3 minutes'),
  (t.id('ben'), 'ben@example.test', now() - interval '2 minutes'),
  (t.id('cal'), 'cal@example.test', now() - interval '1 minute'),
  (t.id('pip'), 'pip@example.test', null);
insert into private.signup_notices (user_id, notified_at) values (t.id('old'), now());
select private.admit_account(t.id('ana'));
select private.set_open_per_day(2);

create function t.claim() returns text language sql as $$
  select coalesce(string_agg(concat_ws(' ', email, coalesce(via, '-'), coalesce(place::text, '-'), waiting, open_per_day, invite_only),
                             ' / ' order by confirmed_at), 'none')
    from private.claim_signup_notices(20)
$$;

-- ---------------------------------------------------------------------------
-- Tests

select t.expect('signup notices: only the web app''s role claims them; people, agents, the MCP and operator roles can''t',
  concat_ws(' ',
    t.run('ana', 'select count(*)::text from private.claim_signup_notices(5)'),
    t.run('ana', 'select count(*)::text from private.claim_signup_notices(5)', 'Claude Code'),
    t.run_role('reliquary_mcp', 'select count(*)::text from private.claim_signup_notices(5)'),
    t.run_role('reliquary_ops', 'select count(*)::text from private.claim_signup_notices(5)'),
    t.run(null, 'select count(*)::text from private.claim_signup_notices(5)'),
    t.run('ana', format('select private.signup_notified(%L)::text', t.id('ana'))),
    t.run_role('reliquary_web', 'select count(*)::text from private.claim_signup_notices(5)')),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501 3');
update private.signup_notices set claimed_at = null, attempts = 0;

select t.expect('signup notices: each newly confirmed account is claimed with where it stands; not one already there, nor one unconfirmed',
  t.claim(),
  'ana@example.test operator - 3 2 f / ben@example.test - 2 3 2 f / cal@example.test - 3 3 2 f');
select t.expect('signup notices: a claimed account isn''t claimed again while its claim holds',
  t.claim(), 'none');

select private.signup_notified(t.id('ana'));
update private.signup_notices set claimed_at = now() - interval '11 minutes';
select private.set_invite_only(true);
select t.expect('signup notices: once its claim lapses an unsent one comes back, and a sent one never does; invite-only is said',
  t.claim(), 'ben@example.test - 2 3 2 t / cal@example.test - 3 3 2 t');

update private.signup_notices set claimed_at = now() - interval '11 minutes', attempts = 5 where user_id = t.id('ben');
update auth.users set email_confirmed_at = now() - interval '8 days' where id = t.id('cal');
update private.signup_notices set claimed_at = null where user_id = t.id('cal');
select t.expect('signup notices: after 5 tries, or confirmed over 7 days ago, an account isn''t claimed again',
  t.claim(), 'none');

update auth.users set email_confirmed_at = now() where id = t.id('pip');
select t.expect('signup notices: an account is claimed once it confirms its address',
  t.claim(), 'pip@example.test - 4 4 2 t');

create table t.deleted as select t.run('pip', $q$select public.delete_account('pip@example.test')::text$q$) as r;
select t.expect('signup notices: deleting an account deletes its notice',
  (select (r not like 'ERR%')::text from t.deleted)
  || ' ' || (select count(*) from private.signup_notices where user_id = t.id('pip'))
  || ' ' || (select count(*) from private.deleted_accounts where user_id = t.id('pip')),
  'true 0 1');
