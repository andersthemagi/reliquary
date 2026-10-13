-- Hostile tests for 20260926140200_delete_account: deleting your own
-- account, in person, with your address typed; what the summary says
-- happens to each vault (orphaned_vaults_test.sql tests each way); what goes (memberships, connections, invites you made
-- or accepted, name, plan, admission, the sign-in account) and what stays
-- (the log and what you wrote, under your id only); and how a deleted
-- account is named afterwards.
--
-- Ana owns Team (Ben edits). Dee created DeeV (Ana became its second
-- owner) and owns DeeSolo alone; she joined Team as an editor by invite,
-- wrote a file there, and has a token, a connected app, a display name, a
-- plan, an admission, a snooze, a deletion notice, a sign-out cutoff, a
-- pasted .env not yet applied and an invite she made that is waiting. Ben
-- has invited Dee's address to his own vault; that invite is his.

insert into t.ids values ('dee2', '00000000-0000-0000-0000-0000000000d2');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'),
  (t.id('cal'), 'cal@example.test'), (t.id('dee'), 'Dee@Example.test');

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'benv', t.run('ben', $q$select public.create_vault('Ben own')$q$)::uuid;
insert into t.ids select 'deev', t.run('dee', $q$select public.create_vault('DeeV')$q$)::uuid;
insert into t.ids select 'deesolo', t.run('dee', $q$select public.create_vault('DeeSolo')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('deev'), t.id('ana'), 'owner', t.id('dee'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('team')));

create table t.tokens (name text primary key, token text);
insert into t.tokens select 'join', t.run('ana', format($q$select public.create_invite(%L, 'dee@example.test', 'editor')$q$, t.id('team')));
insert into t.tokens select 'bens', t.run('ben', format($q$select public.create_invite(%L, 'dee@example.test', 'viewer')$q$, t.id('benv')));
insert into t.tokens select 'deesinvite', t.run('dee', format($q$select public.create_invite(%L, 'zed@example.test', 'viewer')$q$, t.id('deev')));
create function t.tk(p_name text) returns text language sql as $$ select token from t.tokens where name = p_name $$;
select t.run('dee', format($q$select public.accept_invite(%L)::text$q$, t.tk('join')));
select t.run('dee', format($q$select public.write_file(%L, 'notes/dee.md', 'Dee was here')::text$q$, t.id('team')));

select t.run('dee', $q$select public.create_access_token('dee-laptop', 30)$q$);
insert into public.access_tokens (user_id, name, kind, client_id, resource, expires_at)
values (t.id('dee'), 'dee-app', 'oauth', 'https://client.example/meta.json', 'https://mcp.example/mcp', now() + interval '30 days');
select t.run('dee', $q$select public.set_display_name('Dee Doe')$q$);
insert into private.account_plans (user_id, plan_id) values (t.id('dee'), 'alpha_tester');
select private.admit(t.id('dee'), 'operator');
insert into t.ids select 'prop', t.run('ben', format($q$select public.propose(%L, 'canon/x.md', 'X', 'why')$q$, t.id('team')))::uuid;
insert into public.review_snoozes (user_id, proposal_id, vault_id, revision) values (t.id('dee'), t.id('prop'), t.id('team'), 1);
insert into private.vault_deletion_notices (user_id, vault_name, deleted_by) values (t.id('dee'), 'Gone', t.id('ana'));
insert into private.session_cutoffs (user_id, not_before) values (t.id('dee'), now() - interval '1 day');
insert into public.env_imports (vault_id, environments, names, source, created_by, expires_at)
values (t.id('team'), '{development}', '{DEE_KEY}', 'web', t.id('dee'), now() + interval '1 day');

-- Everything the account has, as one line.
create function t.has(p_user text) returns text language sql as $$
  select concat_ws(' ',
    'users=' || (select count(*) from auth.users where id = t.id(p_user)),
    'members=' || (select count(*) from public.vault_members where user_id = t.id(p_user)),
    'tokens=' || (select count(*) from public.access_tokens where user_id = t.id(p_user)),
    'name=' || (select count(*) from public.profiles where user_id = t.id(p_user)),
    'plan=' || (select count(*) from private.account_plans where user_id = t.id(p_user)),
    'admitted=' || (select count(*) from private.admissions where user_id = t.id(p_user)))
$$;

-- ---------------------------------------------------------------------------
-- Only the person, in person, with the address typed

select t.expect('delete account: an agent can''t delete its person''s account, and nothing goes',
  t.run('dee', $q$select public.delete_account('dee@example.test')::text$q$, 'Claude Code') || ' '
  || t.run('dee', $q$select public.account_deletion_summary()::text$q$, 'Claude Code') || ' ' || t.has('dee'),
  'ERR 42501 ERR 42501 users=1 members=3 tokens=2 name=1 plan=1 admitted=1');
select t.expect('delete account: nor a personal token or a connected app of theirs',
  t.run_tok('dee', 'dee-laptop', $q$select public.delete_account('dee@example.test')::text$q$) || ' '
  || t.run_tok('dee', 'dee-app', $q$select public.delete_account('dee@example.test')::text$q$) || ' ' || t.has('dee'),
  'ERR 42501 ERR 42501 users=1 members=3 tokens=2 name=1 plan=1 admitted=1');
select t.expect('delete account: anonymous callers are refused',
  t.run(null, $q$select public.delete_account('dee@example.test')::text$q$), 'ERR 42501');
select t.expect('delete account: a wrong or missing address is refused, and nothing goes',
  t.run('dee', $q$select public.delete_account('ana@example.test')::text$q$) || ' '
  || t.run('dee', $q$select public.delete_account('')::text$q$) || ' '
  || t.run('dee', $q$select public.delete_account(null)::text$q$) || ' ' || t.has('dee'),
  'ERR 22023 ERR 22023 ERR 22023 users=1 members=3 tokens=2 name=1 plan=1 admitted=1');
select t.expect('delete account: nobody reads the deleted accounts, the web app''s role included',
  t.run('ana', $q$select count(*)::text from private.deleted_accounts$q$) || ' '
  || t.run_role('reliquary_web', $q$select count(*)::text from private.deleted_accounts$q$),
  'ERR 42501 ERR 42501');

-- ---------------------------------------------------------------------------
-- What it would do

select t.expect('delete account: the summary says what happens to each vault, and what goes',
  t.run('dee', $q$select concat_ws(' | ', s ->> 'email',
       (select string_agg(v ->> 'name' || ':' || (v ->> 'role') || ':' || (v ->> 'fate'), ',') from jsonb_array_elements(s -> 'vaults') v),
       s ->> 'connections', s ->> 'invites') from public.account_deletion_summary() s$q$),
  'dee@example.test | DeeSolo:owner:delete,DeeV:owner:leave,Team:editor:leave | 2 | 1');
-- DeeSolo goes before the account here, so what follows counts as before
-- (deleting it with the account: orphaned_vaults_test.sql).
select t.run('dee', format($q$select public.delete_vault(%L, 'DeeSolo')::text$q$, t.id('deesolo')));

-- ---------------------------------------------------------------------------
-- Deleting

create table t.before (what text primary key, n bigint);
insert into t.before values
  ('log', (select count(*) from public.log)),
  ('dee_log', (select count(*) from public.log where actor = t.id('dee'))),
  ('versions', (select count(*) from public.file_versions where author = t.id('dee')));

select t.expect('delete account: in person, with the address typed in any case and spacing, it deletes the account and counts what went',
  t.run('dee', $q$select public.delete_account('  DEE@example.TEST ')::text$q$),
  '{"vaults": 2, "deleted": 0, "invites": 1, "orphaned": 0, "connections": 2}');
select t.expect('delete account: the sign-in account, memberships, connections, display name, plan and admission are gone',
  t.has('dee'), 'users=0 members=0 tokens=0 name=0 plan=0 admitted=0');
select t.expect('delete account: snoozes, deletion notices, the sign-out cutoff and unapplied pasted imports are gone',
  (select count(*) from public.review_snoozes where user_id = t.id('dee')) || ' '
  || (select count(*) from private.vault_deletion_notices where user_id = t.id('dee')) || ' '
  || (select count(*) from private.session_cutoffs where user_id = t.id('dee')) || ' '
  || (select count(*) from public.env_imports where created_by = t.id('dee')),
  '0 0 0 0');
select t.expect('delete account: the invite they made is withdrawn, the one they accepted is gone, and the one Ben made out to their address stays his',
  (select string_agg(i.email || ':' || private.invite_state(i.accepted_at, i.revoked_at, i.expires_at), ',' order by i.email)
     from private.vault_invites i),
  'dee@example.test:pending,zed@example.test:revoked');
select t.expect('delete account: the log keeps everything they did, plus one entry per vault left and invite withdrawn, each marked',
  ((select count(*) from public.log where actor = t.id('dee')) - (select n from t.before where what = 'dee_log')) || ' '
  || ((select count(*) from public.log) - (select n from t.before where what = 'log')) || ' '
  || (select string_agg(event, ',' order by event) from public.log
       where actor = t.id('dee') and detail ->> 'account_deleted' = 'true'),
  '3 3 invite.revoke,member.leave,member.leave');
select t.expect('delete account: what they wrote stays in the vault, under their id',
  (select count(*) from public.file_versions where author = t.id('dee'))::text
  || ' ' || t.run('ana', format($q$select body from public.file_versions v join public.files f on f.id = v.file_id
                                   where f.vault_id = %L and f.path = 'notes/dee.md'$q$, t.id('team'))),
  (select n from t.before where what = 'versions')::text || ' Dee was here');
select t.expect('delete account: a vault they created counts against its remaining owner, and none is left counting against no one',
  (select (created_by = t.id('ana'))::text from public.vaults where id = t.id('deev')) || ' '
  || (select count(*)::text from private.accounts_gone() where user_id = t.id('dee')),
  'true 0');
select t.expect('delete account: their address is nowhere in Reliquary''s own tables but in the invite Ben made',
  (select string_agg(format('%s.%s.%s', c.table_schema, c.table_name, c.column_name), ',')
     from information_schema.columns c
    where c.table_schema in ('public', 'private', 'auth')
      and c.data_type in ('text', 'character varying', 'jsonb', 'ARRAY')
      and (select count(*) > 0 from (select 1) x
            where (xpath('//n/text()', query_to_xml(format(
                     'select count(*) as n from %I.%I where %I::text ilike %L', c.table_schema, c.table_name, c.column_name,
                     '%dee@example.test%'), false, false, '')))[1]::text::int > 0)),
  'private.vault_invites.email');
select t.expect('delete account: none of their sessions pass the check any more, with or without an iat',
  t.run('dee', $q$select private.check_session()::text || 'ok'$q$) || ' '
  || t.run_claims(jsonb_build_object('sub', t.id('dee'), 'role', 'authenticated', 'iat', floor(extract(epoch from now())) + 5),
       $q$select private.check_session()::text || 'ok'$q$),
  'ERR RLA01 ERR RLA01');
select t.expect('delete account: people who shared a vault see a deleted account, with no email or name, and so does anyone else in person',
  t.run('ana', format($q$select concat_ws(',', deleted::text, coalesce(email, 'no email'), coalesce(display_name, 'no name'))
                          from public.co_member_people(array[%L]::uuid[])$q$, t.id('dee'))) || ' '
  || t.run('cal', format($q$select deleted::text from public.co_member_people(array[%L]::uuid[])$q$, t.id('dee'))) || ' '
  || t.run('ana', format($q$select deleted::text from public.co_member_people(array[%L]::uuid[])$q$, t.id('ben'))),
  'true,no email,no name true false');
select t.expect('delete account: an agent sees a deleted account as its person does',
  t.run('ana', format($q$select label from public.co_member_people(array[%L]::uuid[])$q$, t.id('dee')), 'Claude Code'),
  'a deleted account');

-- ---------------------------------------------------------------------------
-- The address, later

insert into auth.users (id, email) values (t.id('dee2'), 'dee@example.test');
update private.settings set invite_only = true;
select t.expect('delete account: a new account with the same address starts fresh: no vaults, not admitted, only the invites made out to it',
  t.run('dee2', $q$select count(*)::text from public.vault_members$q$) || ' '
  || t.run('dee2', $q$select admitted::text from public.my_admission()$q$) || ' '
  || t.run('dee2', $q$select string_agg(vault_name, ',') from public.my_invites()$q$) || ' '
  || t.run('dee2', $q$select count(*)::text from public.co_member_people(array[private.uid()]) where deleted$q$),
  '0 false Ben own 0');
update private.settings set invite_only = false;
