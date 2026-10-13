-- Hostile tests for 20261014150000_display_preferences and
-- 20261014160000_drop_vault_email_requirement: showing your email or
-- hiding it, and the one rule (private.email_hidden) where people are
-- resolved. Ana owns Team (Ben
-- edits, Cal views); Dee owns Side, where Ben is an editor too, so Ben
-- shares Team with Ana and Cal and only Side with Dee. Eve has an account
-- and an invite to Team.

insert into t.ids values ('eve', '00000000-0000-0000-0000-0000000000e5');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'),
  (t.id('cal'), 'cal@example.test'), (t.id('dee'), 'dee@example.test'),
  (t.id('eve'), 'eve@example.test');

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('dee', $q$select public.create_vault('Side')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select test_support.add_member(t.id('side'), t.id('ben'), 'editor', t.id('dee'));
select t.run('ana', $q$select public.create_access_token('ana-all', 30)$q$);
select t.run('ben', $q$select public.set_display_name('Ben')$q$);

-- How p_reader sees p_user: the label co_member_people writes, its email
-- column, and whether list_members (in p_vault) and co_member_emails give
-- the address.
create function t.seen(p_reader text, p_user text, p_agent text default null) returns text language sql as $$
  select coalesce(t.run(p_reader, format($q$select label || ' / ' || coalesce(email, 'no email')
                                          from public.co_member_people(array[%L]::uuid[])$q$, t.id(p_user)), p_agent), 'nobody')
$$;
create function t.member_email(p_reader text, p_vault text, p_user text) returns text language sql as $$
  select coalesce(t.run(p_reader, format($q$select email from public.list_members(%L) where user_id = %L$q$, t.id(p_vault), t.id(p_user))), 'no email')
$$;
create function t.shows(p_user text) returns text language sql as $$
  select coalesce((select show_email::text from public.display_preferences where user_id = t.id(p_user)), 'default')
$$;

-- ---------------------------------------------------------------------------
-- The choice: yours, in person

select t.expect('display: by default a co-member sees the display name with the email',
  t.seen('ana', 'ben'), 'Ben (ben@example.test) / ben@example.test');
select t.expect('display: an agent never gets an email, not of a co-member who shows it, nor of its own person',
  t.seen('ana', 'ben', 'Claude Code') || ' | ' || t.seen('ana', 'cal', 'Claude Code') || ' | ' || t.seen('ana', 'ana', 'Claude Code')
  || ' | ' || t.run_tok('ana', 'ana-all', format($q$select label || ' / ' || coalesce(email, 'no email')
                                                    from public.co_member_people(array[%L]::uuid[])$q$, t.id('ben'))),
  'Ben · 00000000 / no email | 00000000 / no email | 00000000 / no email | Ben · 00000000 / no email');
select t.expect('display: a person can hide their email, and read their choice back',
  t.run('ben', $q$select public.set_email_shown(false)::text$q$) || ' '
  || t.run('ben', $q$select show_email::text from public.display_preferences$q$), 'false false');
select t.expect('display: nobody but the person changes it: not another member, through the function or the table',
  t.run('ana', format($q$insert into public.display_preferences (user_id, show_email) values (%L, true) returning 'ok'$q$, t.id('cal'))) || ' '
  || coalesce(t.run('ana', format($q$update public.display_preferences set show_email = true where user_id = %L returning 'changed'$q$, t.id('ben'))), 'nothing') || ' '
  || coalesce(t.run('ana', format($q$delete from public.display_preferences where user_id = %L returning 'deleted'$q$, t.id('ben'))), 'nothing') || ' '
  || t.shows('ben') || ' ' || t.shows('cal'),
  'ERR 42501 ERR 42501 ERR 42501 false default');
select t.expect('display: nor their own agent, token or anonymous',
  t.run('ben', $q$select public.set_email_shown(true)::text$q$, 'Claude Code') || ' '
  || t.run_tok('ana', 'ana-all', $q$select public.set_email_shown(false)::text$q$) || ' '
  || t.run(null, $q$select public.set_email_shown(true)::text$q$) || ' '
  || t.shows('ben') || ' ' || t.shows('ana'),
  'ERR 42501 ERR 42501 ERR 42501 false default');
select t.expect('display: another member can''t read someone''s choice from the table',
  t.run('ana', $q$select count(*)::text from public.display_preferences$q$), '0');

-- ---------------------------------------------------------------------------
-- A hidden email

select t.expect('display: a hidden email shows as the name and the first 8 characters of the id, to people and agents alike',
  t.seen('ana', 'ben') || ' | ' || t.seen('ana', 'ben', 'Claude Code')
  || ' | ' || t.run_tok('ana', 'ana-all', format($q$select label from public.co_member_people(array[%L]::uuid[])$q$, t.id('ben'))),
  'Ben · 00000000 / no email | Ben · 00000000 / no email | Ben · 00000000');
select t.expect('display: a hidden email is in no member list or email lookup',
  t.member_email('ana', 'team', 'ben') || ' ' || t.member_email('dee', 'side', 'ben') || ' '
  || t.run('ana', format($q$select count(*)::text from public.co_member_emails(array[%L]::uuid[])$q$, t.id('ben'))),
  'no email no email 0');
select t.expect('display: a person always sees their own email',
  t.seen('ben', 'ben') || ' ' || t.member_email('ben', 'team', 'ben'),
  'Ben (ben@example.test) / ben@example.test ben@example.test');
select t.expect('display: someone with no display name who hides their email is shown by the tag alone',
  t.run('cal', $q$select public.set_email_shown(false)::text$q$) || ' ' || t.seen('ana', 'cal'),
  'false 00000000 / no email');
select t.run('cal', $q$select public.set_email_shown(true)$q$);

select t.expect('display: a hostile display name is kept as written and does nothing',
  t.run('cal', $q$select public.set_display_name('Robert''); DROP TABLE students;--')$q$) || ' | '
  || t.seen('ana', 'cal') || ' | '
  || t.run('cal', $q$select public.set_display_name('<script>alert(1)</script>')$q$) || ' | '
  || (select count(*)::text from public.vault_members),
  'Robert''); DROP TABLE students;-- | Robert''); DROP TABLE students;-- (cal@example.test) / cal@example.test | <script>alert(1)</script> | 5');

-- ---------------------------------------------------------------------------
-- Agents and tokens

insert into t.ids select 'alone', t.run('ana', $q$select public.create_vault('Ana alone')$q$)::uuid;
select t.run('ana', format($q$select public.create_access_token('ana-other', 30, array[%L]::uuid[], 'read')$q$, t.id('alone')));
select t.expect('display: a token scoped away from every vault a person shares with its person sees nobody',
  t.run_tok('ana', 'ana-other', format($q$select count(*)::text from public.co_member_people(array[%L]::uuid[])$q$, t.id('ben'))),
  '0');

-- ---------------------------------------------------------------------------
-- Invites and deletion notices name a hidden inviter without the email

select t.run('ana', format($q$select public.create_invite(%L, 'eve@example.test', 'viewer')$q$, t.id('team')));
select t.expect('display: an invite from someone who hides their email doesn''t give it',
  t.run('eve', $q$select coalesce(invited_by_email, 'no email') from public.my_invites()$q$) || ' '
  || t.run('ana', $q$select public.set_email_shown(false)::text$q$) || ' '
  || t.run('eve', $q$select coalesce(invited_by_email, 'no email') from public.my_invites()$q$),
  'ana@example.test false no email');
select t.run('dee', $q$select public.set_email_shown(false)$q$);
select t.run('dee', format($q$select public.delete_vault(%L, 'Side')$q$, t.id('side')));
select t.expect('display: nor does a vault deletion notice from them',
  t.run('ben', $q$select coalesce(deleted_by_email, 'no email') from public.my_deletion_notices()$q$) || ' '
  || t.run('ben', $q$select coalesce(deleted_by_email, 'no email') from public.take_deletion_notices()$q$),
  'no email no email');
