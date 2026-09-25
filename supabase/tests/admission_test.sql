-- Hostile tests for invite-only admission (20260925240000_admission:
-- SQLSTATE RLP02, and the operator's controls over it), emails compared in
-- one Unicode form (20260925240300_email_nfc, "emails:") and the storage
-- counter's drift check (20260925240400_storage_drift, "drift:", "gone:").
-- The races are in web/test/races.test.mjs: they need several connections
-- at once.
--
-- supabase/tests/support.sql starts this database open (invite-only off);
-- this file turns it on. Ana owns a vault and is admitted by the operator;
-- Gus, Hal, Ivy and Kim have accounts nobody admitted.

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids values
  ('gus', '00000000-0000-0000-0000-0000000000f1'),
  ('hal', '00000000-0000-0000-0000-0000000000f2'),
  ('ivy', '00000000-0000-0000-0000-0000000000f3'),
  ('kim', '00000000-0000-0000-0000-0000000000f5'),
  ('kim2', '00000000-0000-0000-0000-0000000000f6');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('gus'), 'gus@example.test'),
  (t.id('hal'), 'hal@example.test'), (t.id('ivy'), 'ivy@example.test'),
  (t.id('kim'), 'kim@example.test');
select private.admit_account(t.id('ana'));
select private.set_invite_only(true);

-- As t.run, but an error comes back as "<sqlstate> <message>", or with
-- p_detail its DETAIL.
create function t.msg(p_user text, p_sql text, p_agent text default null, p_detail boolean default false)
returns text language plpgsql as $$
declare
  v text;
  v_state text;
  v_msg text;
  v_detail text;
  claims jsonb := jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated');
begin
  if p_agent is not null then
    claims := claims || jsonb_build_object('act', jsonb_build_object('sub', 'agent-1', 'name', p_agent));
  end if;
  perform set_config('request.jwt.claims', claims::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return v;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text, v_detail = pg_exception_detail;
  perform set_config('role', 'none', true);
  return case when p_detail then v_detail else v_state || ' ' || v_msg end;
end $$;
create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;
create function t.new_vault(p_user text, p_key text, p_name text) returns text language sql as $$
  insert into t.ids select p_key, v::uuid from (select t.run(p_user, format($q$select public.create_vault(%L)$q$, p_name)) v) x
   where v !~ '^ERR' returning 'ok'
$$;
create function t.invite(p_user text, p_vault text, p_email text) returns text language sql as $$
  select t.msg(p_user, format($q$select public.create_invite(%L, %L, 'editor')$q$, t.id(p_vault), p_email))
$$;
create function t.accept(p_user text, p_token text) returns text language sql as
$$ select t.msg(p_user, format($q$select public.accept_invite(%L)::text$q$, p_token)) $$;
create function t.admission(p_user text) returns text language sql as $$
  select t.run(p_user, $q$select concat_ws(' ', admitted::text, invite_only::text) from public.my_admission()$q$)
$$;
create function t.via(p_user text) returns text language sql as
$$ select coalesce((select via from private.admissions where user_id = t.id(p_user)), 'none') $$;
create function t.ops(p_sql text) returns text language sql as $$ select t.run_role('reliquary_ops', p_sql) $$;
create function t.q(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return v;
end $$;

select t.new_vault('ana', 'club', 'Club');
select t.run('ana', format($q$select public.write_file(%L, 'notes/plan.md', 'the plan')::text$q$, t.id('club')));
select t.run('gus', $q$select public.create_access_token('gus-all', 30)$q$);

-- ---------------------------------------------------------------------------
-- An account nobody admitted

select t.expect('admission: an account nobody admitted can''t create a vault: RLP02, saying how to get in',
  t.msg('gus', $q$select public.create_vault('Mine')::text$q$),
  'RLP02 your account can''t create vaults yet: Reliquary is invite-only during alpha. Open an invite link someone sent you and join their vault (that admits your account), or ask the operator to admit you');
select t.expect('admission: the refusal''s detail says which limit, for programs',
  t.msg('gus', $q$select public.create_vault('Mine')::text$q$, null, true),
  '{"limit": "admission", "invite_only": true}');
select t.expect('admission: nor can their agent, even through an all-vaults read-write token',
  t.run_tok('gus', 'gus-all', $q$select public.create_vault('Agent''s')::text$q$), 'ERR RLP02');
select t.expect('admission: a refused vault leaves nothing behind',
  (select count(*)::text from public.vaults where created_by = t.id('gus')), '0');
select t.expect('admission: an account nobody admitted sees no vault, file, member, log row or proposal',
  concat_ws(' ',
    t.run('gus', 'select count(*)::text from public.vaults'),
    t.run('gus', 'select count(*)::text from public.files'),
    t.run('gus', 'select count(*)::text from public.file_versions'),
    t.run('gus', 'select count(*)::text from public.vault_members'),
    t.run('gus', 'select count(*)::text from public.log'),
    t.run('gus', 'select count(*)::text from public.proposals')),
  '0 0 0 0 0 0');
select t.expect('admission: nor can it write into someone else''s vault',
  t.run('gus', format($q$select public.write_file(%L, 'x.md', 'x')::text$q$, t.id('club'))), 'ERR 42501');
select t.expect('admission: people and their agents read their own admission; anonymous callers can''t',
  concat_ws(' / ', t.admission('gus'), t.admission('ana'),
    t.run('gus', $q$select admitted::text from public.my_admission()$q$, 'Claude Code'),
    t.run(null, $q$select admitted::text from public.my_admission()$q$)),
  'false true / true true / false / ERR 42501');

-- ---------------------------------------------------------------------------
-- Ways in

select t.expect('invite: accepting any invite admits the account, which can then create vaults',
  (select t.accept('gus', t.invite('ana', 'club', 'gus@example.test')) = t.id('club')::text)::text
  || ' ' || t.via('gus') || ' ' || t.admission('gus') || ' ' || coalesce(t.new_vault('gus', 'gus1', 'Gus one'), 'refused'),
  'true invite true true ok');
select t.expect('invite: a refused acceptance (another address''s invite) admits no one',
  t.accept('hal', t.invite('ana', 'club', 'someone@example.test')) || ' / ' || t.via('hal'),
  '42501 this invite is for a different email address / none');
select t.expect('invite: a withdrawn invite admits no one',
  (select t.accept('hal', tok) from (select t.invite('ana', 'club', 'hal@example.test') tok) x,
          lateral (select t.invite('ana', 'club', 'hal@example.test')) y)
  || ' / ' || t.via('hal'),
  '55000 this invite was withdrawn / none');
select t.expect('plan: the operator putting an account on a plan admits it',
  t.ops(format($q$select private.set_account_plan(%L, 'alpha_tester')$q$, t.id('hal')))
  || ' / ' || t.via('hal') || ' / ' || coalesce(t.new_vault('hal', 'hal1', 'Hal one'), 'refused'),
  'Alpha tester plan: 0 of 25 vaults / plan / ok');
select t.expect('operator: admitting an account lets it create vaults',
  t.ops(format($q$select private.admit_account(%L)$q$, t.id('ivy')))
  || ' / ' || coalesce(t.new_vault('ivy', 'ivy1', 'Ivy one'), 'refused'),
  'admitted (operator, ' || to_char(now(), 'YYYY-MM-DD') || ') / ok');
select t.expect('operator: admitting again keeps how the account was first admitted',
  t.ops(format($q$select private.admit_account(%L)$q$, t.id('gus'))),
  'admitted (invite, ' || to_char(now(), 'YYYY-MM-DD') || ')');

-- ---------------------------------------------------------------------------
-- Taking admission back

select t.run('ana', format($q$select public.create_invite(%L, 'ivy@example.test', 'editor')$q$, t.id('club')));
select t.expect('revoke: the account keeps its vaults and memberships and can''t create another',
  t.ops(format($q$select private.revoke_admission(%L)$q$, t.id('gus')))
  || ' / ' || t.admission('gus')
  || ' / ' || t.msg('gus', $q$select public.create_vault('Gus two')::text$q$)
  || ' / ' || t.run('gus', 'select count(*)::text from public.vaults'),
  'not admitted: they keep their 1 vault and memberships, and can''t create a vault until they accept an invite or are admitted again / false true / '
  || 'RLP02 your account can''t create vaults yet: Reliquary is invite-only during alpha. Open an invite link someone sent you and join their vault (that admits your account), or ask the operator to admit you / 2');
select t.expect('revoke: the vaults it kept still take its writes',
  (t.run('gus', format($q$select public.write_file(%L, 'still.md', 'mine')::text$q$, t.id('gus1'))) ~ '^[0-9a-f-]{36}$')::text, 'true');
select t.expect('revoke: its agent is refused too',
  t.run_tok('gus', 'gus-all', $q$select public.create_vault('Agent''s')::text$q$), 'ERR RLP02');
select t.expect('revoke: accepting another invite admits it again',
  (select t.accept('gus', tok) is not null from (select t.invite('ivy', 'ivy1', 'gus@example.test') tok) x)::text
  || ' ' || t.via('gus') || ' ' || coalesce(t.new_vault('gus', 'gus2', 'Gus two'), 'refused'),
  'true invite ok');
select t.expect('revoke: an account deleted in Auth and made again with the same address starts un-admitted',
  t.q(format($q$select private.admit_account(%L)$q$, t.id('kim'))) || ' / '
  || t.q(format($q$delete from auth.users where id = %L returning 'gone'$q$, t.id('kim'))) || ' / '
  || t.q(format($q$insert into auth.users (id, email) values (%L, 'kim@example.test') returning 'made'$q$, t.id('kim2'))) || ' / '
  || t.admission('kim2'),
  'admitted (operator, ' || to_char(now(), 'YYYY-MM-DD') || ') / gone / made / false true');

-- ---------------------------------------------------------------------------
-- Invite-only off

select t.expect('open: with invite-only off, an account nobody admitted creates vaults, within its plan',
  t.ops('select private.set_invite_only(false)') || ' / ' || t.admission('kim2')
  || ' / ' || coalesce(t.new_vault('kim2', 'kim1', 'Kim one'), 'refused'),
  'open: every account creates vaults, within its plan / true false / ok');
select t.expect('open: turned on again, the same account is refused',
  t.ops('select private.set_invite_only(true)') || ' / ' || t.admission('kim2')
  || ' / ' || t.run('kim2', $q$select public.create_vault('Kim two')::text$q$),
  'invite-only: only admitted accounts create vaults / false true / ERR RLP02');

-- ---------------------------------------------------------------------------
-- Only the operator admits

select t.expect('operator: a person can''t read or write admissions or the setting',
  concat_ws(' ',
    t.run('ana', 'select count(*)::text from private.admissions'),
    t.run('ana', 'select count(*)::text from private.settings'),
    t.run('kim2', format($q$insert into private.admissions (user_id, via) values (%L, 'operator') returning 'x'$q$, t.id('kim2'))),
    t.run('kim2', $q$update private.settings set invite_only = false returning 'x'$q$)),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('operator: a person can''t admit themself, take admission back or turn invite-only off',
  concat_ws(' ',
    t.run('kim2', format($q$select private.admit_account(%L)$q$, t.id('kim2'))),
    t.run('kim2', format($q$select private.admit(%L, 'operator')::text$q$, t.id('kim2'))),
    t.run('ana', format($q$select private.revoke_admission(%L)$q$, t.id('gus'))),
    t.run('kim2', 'select private.set_invite_only(false)')),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('operator: nor can an agent, even an admitted person''s through an all-vaults token',
  concat_ws(' ',
    t.run('ana', format($q$select private.admit_account(%L)$q$, t.id('kim2')), 'Claude Code'),
    t.run_tok('gus', 'gus-all', format($q$select private.admit_account(%L)$q$, t.id('kim2'))),
    t.run_tok('gus', 'gus-all', 'select private.set_invite_only(false)')),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('operator: nor the web app''s role, the MCP server''s or anonymous callers',
  concat_ws(' ',
    t.run_role('reliquary_web', format($q$select private.admit_account(%L)$q$, t.id('kim2'))),
    t.run_role('reliquary_web', 'select count(*)::text from private.admissions'),
    t.run_role('reliquary_mcp', format($q$select private.admit_account(%L)$q$, t.id('kim2'))),
    t.run_role('reliquary_mcp', 'select private.set_invite_only(false)'),
    t.run(null, format($q$select private.admit_account(%L)$q$, t.id('kim2')))),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('operator: reliquary_ops works through the functions only, and reads no table directly',
  t.ops('select count(*)::text from private.admissions') || ' ' || t.ops('select count(*)::text from private.settings')
  || ' ' || t.ops(format($q$select private.admit(%L, 'operator')::text$q$, t.id('kim2'))),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('operator: an unknown account, or neither on nor off, is refused',
  concat_ws(' ',
    t.ops($q$select private.admit_account('00000000-0000-0000-0000-000000000999')$q$),
    t.ops($q$select private.revoke_admission('00000000-0000-0000-0000-000000000999')$q$),
    t.ops('select private.set_invite_only(null)')),
  'ERR P0002 ERR P0002 ERR 22023');
select t.expect('operator: nothing was changed by the refused calls',
  t.admission('kim2') || ' ' || t.via('kim2'), 'false true none');

-- ---------------------------------------------------------------------------
-- Emails in one form

-- José, as Auth might store it: e and a combining accent (NFD).
insert into t.ids values ('jo', '00000000-0000-0000-0000-0000000000f4');
insert into auth.users (id, email) values (t.id('jo'), U&'Jose\0301@Example.test');

select t.expect('emails: an invite typed with é as one character is accepted by the account Auth stored with a combining accent',
  (select t.accept('jo', tok) = t.id('club')::text from (select t.invite('ana', 'club', U&'jos\00e9@example.test') tok) x)::text,
  'true');
select t.expect('emails: the operator finds that account by either form, any case',
  (t.ops(format($q$select private.user_by_email(%L)::text$q$, U&'JOS\00C9@example.test')) = t.id('jo')::text)::text || ' '
  || (t.ops(format($q$select private.user_by_email(%L)::text$q$, U&'jose\0301@example.test')) = t.id('jo')::text)::text,
  'true true');
select t.expect('emails: inviting a member again in the other form is refused as already a member',
  t.invite('ana', 'club', U&'jose\0301@EXAMPLE.test'),
  '23505 that address already belongs to a member of this vault');
select t.expect('emails: invites are stored in the one form',
  (select count(*)::text from private.vault_invites where email is distinct from private.email_key(email)), '0');

-- ---------------------------------------------------------------------------
-- Counter drift, and accounts gone from Auth

select t.expect('drift: with every counter kept by the triggers, nothing has drifted',
  t.ops('select count(*)::text from private.storage_drift()'), '0');
update private.vault_storage set bytes = bytes + 7 where vault_id = t.id('club');
select t.expect('drift: a counter off from a full scan is found, by how much',
  t.ops(format($q$select concat_ws(' ', vault_name, drift) from private.storage_drift() where vault_id = %L$q$, t.id('club'))),
  'Club -7');
select t.expect('drift: the weekly check records it and fixes nothing',
  private.log_storage_drift()::text || ' '
  || t.q(format('select count(*)::text from private.storage_drift_log where vault_id = %L', t.id('club'))) || ' '
  || t.ops('select count(*)::text from private.storage_drift()'),
  '1 1 1');
select t.expect('drift: the operator recounts a vault on purpose, and it no longer drifts',
  (t.ops(format($q$select private.recount_storage(%L)$q$, t.id('club'))) ~ '^counted \d+, scanned \d+: the counter is now ')::text
  || ' ' || t.ops('select count(*)::text from private.storage_drift()'),
  'true 0');
select t.expect('drift: people, agents and the app roles can''t check, recount or read the log',
  concat_ws(' ',
    t.run('ana', 'select count(*)::text from private.storage_drift()'),
    t.run('ana', format($q$select private.recount_storage(%L)$q$, t.id('club'))),
    t.run('ana', 'select count(*)::text from private.storage_drift_log', 'Claude Code'),
    t.run_role('reliquary_web', 'select private.log_storage_drift()::text'),
    t.run_role('reliquary_mcp', format($q$select private.recount_storage(%L)$q$, t.id('club'))),
    t.ops('select count(*)::text from private.storage_drift_log')),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('gone: members whose account was deleted in Auth are listed for the operator',
  t.q(format($q$delete from auth.users where id = %L returning 'gone'$q$, t.id('jo'))) || ' / '
  || t.ops(format($q$select concat_ws(' ', kind, vault_name, role) from private.accounts_gone() where user_id = %L$q$, t.id('jo')))
  || ' / ' || t.run('ana', 'select count(*)::text from private.accounts_gone()'),
  'gone / member Club editor / ERR 42501');
