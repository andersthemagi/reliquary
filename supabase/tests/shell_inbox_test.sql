-- Hostile tests for 20260926100000_shell_inbox: display names (your own,
-- in person only), co_member_people, the header's shell_summary and the
-- inbox's invites and deletion notices. Ana owns Team (Ben edits, Cal
-- views); Dee is an outsider with a vault of her own; Eve has an account,
-- no vault, and an invite to Team.

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids values ('eve', '00000000-0000-0000-0000-0000000000e5');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'),
  (t.id('cal'), 'cal@example.test'), (t.id('dee'), 'dee@example.test'),
  (t.id('eve'), 'Eve@Example.test');

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'deev', t.run('dee', $q$select public.create_vault('Dee own')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('team')));

create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;
select t.run('ana', $q$select public.create_access_token('ana-all', 30)$q$);

create function t.name_of(p_user text) returns text language sql as
$$ select coalesce((select display_name from public.profiles where user_id = t.id(p_user)), 'none') $$;
create function t.summary(p_user text, p_path text) returns text language sql as
$$ select t.run(p_user, format($q$select public.shell_summary(5) #>> %L$q$, string_to_array(p_path, '.'))) $$;

-- ---------------------------------------------------------------------------
-- Display names: your own, in person

select t.expect('names: a person sets their own, trimmed, and reads it back',
  t.run('ana', $q$select public.set_display_name('  Ana Ruiz  ')$q$) || ' / ' || t.name_of('ana')
  || ' / ' || t.run('ana', $q$select display_name from public.profiles$q$),
  'Ana Ruiz / Ana Ruiz / Ana Ruiz');
select t.expect('names: setting it again replaces it',
  t.run('ana', $q$select public.set_display_name('Ana R.')$q$) || ' / ' || t.name_of('ana'), 'Ana R. / Ana R.');
select t.expect('names: Unicode spaces at either end are trimmed too',
  t.run('ben', format($q$select public.set_display_name(%L)$q$, chr(12288) || 'Ben' || chr(160))), 'Ben');
select t.expect('names: only spaces clears it',
  t.run('ben', $q$select coalesce(public.set_display_name('   '), 'cleared')$q$) || ' / ' || t.name_of('ben'), 'cleared / none');
select t.expect('names: 80 characters is fine, 81 is refused and the old name stays',
  t.run('cal', $q$select char_length(public.set_display_name(repeat('c', 80)))::text$q$) || ' / '
  || t.run('cal', $q$select public.set_display_name(repeat('c', 81))$q$) || ' / ' || char_length(t.name_of('cal')),
  '80 / ERR 22023 / 80');
select t.expect('names: control characters, invisible and direction marks, and "@" are refused',
  t.run('dee', format($q$select public.set_display_name(%L)$q$, 'Dee' || chr(10) || 'x')) || ' '
  || t.run('dee', format($q$select public.set_display_name(%L)$q$, 'Dee' || chr(8238) || 'x')) || ' '
  || t.run('dee', format($q$select public.set_display_name(%L)$q$, 'De' || chr(8203) || 'e')) || ' '
  || t.run('dee', $q$select public.set_display_name('ana@example.test')$q$) || ' ' || t.name_of('dee'),
  'ERR 22023 ERR 22023 ERR 22023 ERR 22023 none');
select t.expect('names: the table refuses a bad name written directly, too',
  t.run('dee', format($q$insert into public.profiles (user_id, display_name) values (%L, ' Dee') returning 'ok'$q$, t.id('dee'))) || ' '
  || t.run('dee', format($q$insert into public.profiles (user_id, display_name) values (%L, 'a@b') returning 'ok'$q$, t.id('dee'))) || ' '
  || t.name_of('dee'),
  'ERR 23514 ERR 23514 none');

select t.expect('names: nobody writes someone else''s row: an insert for another person is refused',
  t.run('dee', format($q$insert into public.profiles (user_id, display_name) values (%L, 'Mallory') returning 'ok'$q$, t.id('eve')))
  || ' ' || t.name_of('eve'),
  'ERR 42501 none');
select t.expect('names: nor an update or delete of another person''s name, which is left as it was',
  coalesce(t.run('dee', format($q$update public.profiles set display_name = 'Mallory' where user_id = %L returning 'changed'$q$, t.id('ana'))), 'nothing')
  || ' ' || coalesce(t.run('dee', format($q$delete from public.profiles where user_id = %L returning 'deleted'$q$, t.id('ana'))), 'nothing')
  || ' ' || coalesce(t.run('ana', format($q$update public.profiles set user_id = %L returning 'moved'$q$, t.id('dee'))), 'nothing')
  || ' ' || t.name_of('ana'),
  'nothing nothing ERR 42501 Ana R.');
select t.expect('names: a co-member can''t read the table for another person''s name (only co_member_people)',
  t.run('ben', $q$select count(*)::text from public.profiles$q$), '0');

select t.expect('names: an agent can''t set its person''s name, through the function or the table',
  t.run('ana', $q$select public.set_display_name('Agent says')$q$, 'Claude Code') || ' '
  || coalesce(t.run('ana', $q$update public.profiles set display_name = 'Agent says' returning 'changed'$q$, 'Claude Code'), 'nothing') || ' '
  || t.name_of('ana'),
  'ERR 42501 nothing Ana R.');
select t.expect('names: an agent can''t add or delete its person''s row either',
  t.run('eve', format($q$insert into public.profiles (user_id, display_name) values (%L, 'Agent') returning 'ok'$q$, t.id('eve')), 'Claude Code')
  || ' ' || coalesce(t.run('ana', $q$delete from public.profiles returning 'deleted'$q$, 'Claude Code'), 'nothing')
  || ' ' || t.name_of('eve') || ' ' || t.name_of('ana'),
  'ERR 42501 nothing none Ana R.');
select t.expect('names: nor can a token, nor read its person''s row through one',
  t.run_tok('ana', 'ana-all', $q$select public.set_display_name('Token says')$q$) || ' '
  || coalesce(t.run_tok('ana', 'ana-all', $q$select display_name from public.profiles$q$), 'nothing') || ' ' || t.name_of('ana'),
  'ERR 42501 nothing Ana R.');
select t.expect('names: anonymous can''t set one or read the table',
  t.run(null, $q$select public.set_display_name('Anon')$q$) || ' '
  || t.run(null, $q$select count(*)::text from public.profiles$q$),
  'ERR 42501 ERR 42501');

-- ---------------------------------------------------------------------------
-- co_member_people: names where emails already are

select t.expect('people: a co-member sees the name with the email; someone without one shows none',
  t.run('ben', format($q$select string_agg(email || '=' || coalesce(display_name, '-'), ',' order by email)
     from public.co_member_people(array[%L, %L]::uuid[])$q$, t.id('ana'), t.id('cal'))),
  'ana@example.test=Ana R.,cal@example.test=' || repeat('c', 80));
select t.expect('people: you see your own name',
  t.run('ana', format($q$select display_name from public.co_member_people(array[%L]::uuid[])$q$, t.id('ana'))), 'Ana R.');
select t.expect('people: an outsider learns neither the email nor the name',
  t.run('dee', format($q$select count(*)::text from public.co_member_people(array[%L, %L]::uuid[])$q$, t.id('ana'), t.id('cal'))), '0');
select t.expect('people: agents, tokens and anonymous are refused',
  t.run('ben', format($q$select count(*)::text from public.co_member_people(array[%L]::uuid[])$q$, t.id('ana')), 'Claude Code') || ' '
  || t.run_tok('ana', 'ana-all', format($q$select count(*)::text from public.co_member_people(array[%L]::uuid[])$q$, t.id('ana'))) || ' '
  || t.run(null, format($q$select count(*)::text from public.co_member_people(array[%L]::uuid[])$q$, t.id('ana'))),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('people: at most 500 ids a call',
  t.run('ana', $q$select count(*)::text from public.co_member_people(array(select gen_random_uuid() from generate_series(1, 501)))$q$),
  'ERR 54000');

-- ---------------------------------------------------------------------------
-- The header: shell_summary

insert into t.ids select 'p_rate', t.run('ben',
  format($q$select public.propose(%L, 'canon/rate.md', 'Rate 900', 'raise')$q$, t.id('team')), 'Hermes')::uuid;
insert into t.ids select 'p_terms', t.run('ben',
  format($q$select public.propose(%L, 'canon/terms.md', 'Net 30', 'terms')$q$, t.id('team')))::uuid;
insert into t.ids select 'p_dee', t.run('dee',
  format($q$select public.propose(%L, 'x.md', 'Dee''s', 'mine')$q$, t.id('deev')))::uuid;

select t.expect('summary: the review count is what waits on me: both of Ben''s proposals, not Dee''s',
  t.summary('ana', 'counts.review') || ' ' || t.summary('ana', 'total'), '2 2');
select t.expect_true('summary: a proposal I snoozed leaves the count and the items',
  t.run('ana', format($q$select public.snooze_proposal(%L)::text || 'ok'$q$, t.id('p_terms'))) is not null
  and t.summary('ana', 'counts.review') = '1'
  and t.run('ana', $q$select string_agg(i ->> 'path', ',') from jsonb_array_elements(public.shell_summary(5) -> 'items') i$q$) = 'canon/rate.md');
select t.expect('summary: items name the verb and the vault; a new file is Create',
  t.run('ana', $q$select (public.shell_summary(5) -> 'items' -> 0) ->> 'verb' || ' ' || ((public.shell_summary(5) -> 'items' -> 0) ->> 'vault')$q$),
  'Create Team');
select t.expect_true('summary: a proposal I decided leaves my count; the proposer is asked to revise it',
  t.run('ana', format($q$select public.decide(%L, 'request_changes', 'Use 850')::text$q$, t.id('p_rate'))) is not null
  and t.summary('ana', 'counts.review') = '0'
  and t.summary('ben', 'counts.revise') = '1'
  and t.run('ben', $q$select (public.shell_summary(5) -> 'items' -> 0) ->> 'kind'$q$) = 'revise');
select t.expect('summary: a viewer has nothing to review; an outsider sees nothing of Team',
  t.summary('cal', 'counts.review') || ' ' || t.summary('dee', 'counts.revise') || ' '
  || t.run('dee', $q$select count(*)::text from jsonb_array_elements(public.shell_summary(20) -> 'items') i where i ->> 'vault' = 'Team'$q$)
  || ' ' || t.run('dee', $q$select string_agg(v ->> 'name', ',') from jsonb_array_elements(public.shell_summary(5) -> 'vaults') v$q$),
  '0 0 0 Dee own');
select t.expect('summary: the vault switcher lists only my vaults, by name, with my role',
  t.run('cal', $q$select string_agg((v ->> 'name') || ':' || (v ->> 'role'), ',') from jsonb_array_elements(public.shell_summary(5) -> 'vaults') v$q$),
  'Team:viewer');
select t.expect('summary: who I am: my email and name',
  t.summary('ana', 'me.email') || ' / ' || t.summary('ana', 'me.name'), 'ana@example.test / Ana R.');
select t.expect('summary: items are at most 20 (and 0 is allowed); counts count everything',
  (select string_agg(t.run('ben', format($q$select public.propose(%L, %L, 'x', 'bulk') is not null$q$, t.id('team'), 'canon/bulk-' || g || '.md')), '') from generate_series(1, 25) g) || ' '
  || t.run('ana', $q$select jsonb_array_length(public.shell_summary(0) -> 'items')::text || ' ' || jsonb_array_length(public.shell_summary(100) -> 'items')::text || ' ' || (public.shell_summary(5) #>> '{counts,review}')$q$),
  repeat('true', 25) || ' 0 20 25');
select t.expect('summary: agents, tokens and anonymous are refused',
  t.run('ana', $q$select public.shell_summary(5)::text$q$, 'Claude Code') || ' '
  || t.run_tok('ana', 'ana-all', $q$select public.shell_summary(5)::text$q$) || ' '
  || t.run(null, $q$select public.shell_summary(5)::text$q$),
  'ERR 42501 ERR 42501 ERR 42501');

-- ---------------------------------------------------------------------------
-- Invites for my address

select t.run('ana', format($q$select public.create_invite(%L, 'eve@example.test', 'editor')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_invite(%L, 'someone@example.test', 'viewer')$q$, t.id('team')));

select t.expect('invites: the invited address sees its invite (any case): the vault, the role and who sent it',
  t.run('eve', $q$select string_agg(vault_name || ' ' || role || ' ' || invited_by_email, ',') from public.my_invites()$q$)
  || ' / ' || t.summary('eve', 'counts.invites') || ' ' || t.summary('eve', 'total'),
  'Team editor ana@example.test / 1 1');
select t.expect('invites: nobody else sees it: not the owner, a member or an outsider',
  t.run('ana', $q$select count(*)::text from public.my_invites()$q$) || ' '
  || t.run('ben', $q$select count(*)::text from public.my_invites()$q$) || ' '
  || t.run('dee', $q$select count(*)::text from public.my_invites()$q$),
  '0 0 0');
select t.expect('invites: an agent, a token and anonymous are refused',
  t.run('eve', $q$select count(*)::text from public.my_invites()$q$, 'Claude Code') || ' '
  || t.run_tok('ana', 'ana-all', $q$select count(*)::text from public.my_invites()$q$) || ' '
  || t.run(null, $q$select count(*)::text from public.my_invites()$q$),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('invites: a revoked invite is gone from the list and the count',
  t.run('ana', format($q$select 'ok' from public.list_invites(%L) i, public.revoke_invite(i.id) where i.email = 'eve@example.test'$q$, t.id('team')))
  || ' ' || t.run('eve', $q$select count(*)::text from public.my_invites()$q$) || ' ' || t.summary('eve', 'total'),
  'ok 0 0');

-- ---------------------------------------------------------------------------
-- Deletion notices, peeked

insert into t.ids select 'gone', t.run('ana', $q$select public.create_vault('Gone soon')$q$)::uuid;
select test_support.add_member(t.id('gone'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.delete_vault(%L, 'Gone soon')::text$q$, t.id('gone')));

select t.expect('notices: a former member sees the notice in the header, and it stays until taken',
  t.run('cal', $q$select string_agg(vault_name || ' by ' || deleted_by_email, ',') from public.my_deletion_notices()$q$)
  || ' / ' || t.summary('cal', 'counts.notices') || ' ' || t.summary('cal', 'counts.notices')
  || ' / ' || t.run('cal', $q$select count(*)::text from public.take_deletion_notices()$q$)
  || ' / ' || t.summary('cal', 'counts.notices'),
  'Gone soon by ana@example.test / 1 1 / 1 / 0');
select t.expect('notices: the deleter and outsiders see none; agents and tokens are refused',
  t.run('ana', $q$select count(*)::text from public.my_deletion_notices()$q$) || ' '
  || t.run('dee', $q$select count(*)::text from public.my_deletion_notices()$q$) || ' '
  || t.run('cal', $q$select count(*)::text from public.my_deletion_notices()$q$, 'Claude Code') || ' '
  || t.run_tok('ana', 'ana-all', $q$select count(*)::text from public.my_deletion_notices()$q$),
  '0 0 ERR 42501 ERR 42501');
