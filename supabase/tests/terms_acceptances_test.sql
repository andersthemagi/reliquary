-- Hostile tests for 20261018150000_terms_acceptances: the record of which
-- terms each account accepted at sign-in. Ana and Ben have accounts; Gone's
-- id has none.

insert into t.ids values ('gone', '00000000-0000-0000-0000-00000000a0f1');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test');

create function t.accepted(p text) returns text language sql as $$
  select coalesce(string_agg(terms_date::text, ' ' order by terms_date), 'none')
    from private.terms_acceptances where user_id = t.id(p)
$$;

select t.expect('terms acceptances: only the web app''s role records one; people, agents, the MCP and operator roles and anonymous callers can''t',
  concat_ws(' ',
    t.run('ana', format($q$select private.record_terms_acceptance(%L, '2026-10-18')::text$q$, t.id('ana'))),
    t.run('ana', format($q$select private.record_terms_acceptance(%L, '2026-10-18')::text$q$, t.id('ana')), 'Claude Code'),
    t.run_role('reliquary_mcp', format($q$select private.record_terms_acceptance(%L, '2026-10-18')::text$q$, t.id('ana'))),
    t.run_role('reliquary_ops', format($q$select private.record_terms_acceptance(%L, '2026-10-18')::text$q$, t.id('ana'))),
    t.run(null, format($q$select private.record_terms_acceptance(%L, '2026-10-18')::text$q$, t.id('ana'))),
    t.accepted('ana')),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501 none');

select t.expect('terms acceptances: nobody reads or writes the record directly, not the web app either',
  concat_ws(' ',
    t.run('ana', 'select count(*)::text from private.terms_acceptances'),
    t.run_role('reliquary_web', 'select count(*)::text from private.terms_acceptances'),
    t.run_role('reliquary_web', format($q$insert into private.terms_acceptances (user_id, terms_date) values (%L, '2026-10-18') returning 'x'$q$, t.id('ana')))),
  'ERR 42501 ERR 42501 ERR 42501');

select t.run_role('reliquary_web', format($q$select private.record_terms_acceptance(%L, '2026-10-18')::text$q$, t.id('ana')));
update private.terms_acceptances set accepted_at = '2026-10-18 09:00+00' where user_id = t.id('ana');
select t.run_role('reliquary_web', format($q$select private.record_terms_acceptance(%L, '2026-10-18')::text$q$, t.id('ana')));
select t.run_role('reliquary_web', format($q$select private.record_terms_acceptance(%L, '2026-11-01')::text$q$, t.id('ana')));
select t.expect('terms acceptances: the web app records each version an account accepts once, keeping the first time',
  t.accepted('ana') || ' ' || (select accepted_at = '2026-10-18 09:00+00' from private.terms_acceptances
                               where user_id = t.id('ana') and terms_date = '2026-10-18')::text,
  '2026-10-18 2026-11-01 true');

select t.expect('terms acceptances: an id with no account records nothing, and the sign-in isn''t refused',
  t.run_role('reliquary_web', format($q$select coalesce(private.record_terms_acceptance(%L, '2026-10-18')::text, 'done')$q$, t.id('gone')))
    || ' ' || t.accepted('gone'),
  'done none');

select t.run_role('reliquary_web', format($q$select private.record_terms_acceptance(%L, '2026-10-18')::text$q$, t.id('ben')));
select t.run('ana', $q$select public.delete_account('ana@example.test')::text$q$);
select t.expect('terms acceptances: deleting an account deletes its record and leaves other accounts''',
  t.accepted('ana') || ' / ' || t.accepted('ben'),
  'none / 2026-10-18');
