-- Hostile tests for 20260925160000_membership_polish: invites are the only
-- way in, the invite rate, leaving a vault, co-members' emails, deletion
-- notices, and the export's snapshot and rate. Ana owns Team (Ben edits, Cal
-- views); Dee is an outsider with a vault of her own; Eve has an account and
-- no vault. Emails live in auth.users (stubbed).

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids values ('eve', '00000000-0000-0000-0000-0000000000e5');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'Ben@Example.test'),
  (t.id('cal'), 'cal@example.test'), (t.id('dee'), 'dee@example.test'),
  (t.id('eve'), 'eve@example.test');

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'deev', t.run('dee', $q$select public.create_vault('Dee own')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));

select t.run('ana', $q$select public.create_access_token('ana-all', 30)$q$);
select t.run('ben', $q$select public.create_access_token('ben-all', 30)$q$);
select t.run('cal', $q$select public.create_access_token('cal-all', 30)$q$);

create function t.role_of(p_vault text, p_user text) returns text language sql as $$
  select coalesce((select role from public.vault_members where vault_id = t.id(p_vault) and user_id = t.id(p_user)), 'none')
$$;
create function t.log_count(p_vault text, p_event text) returns text language sql as
$$ select count(*)::text from public.log where vault_id = t.id(p_vault) and event = p_event $$;
create function t.set_member(p_by text, p_vault text, p_user text, p_role text, p_agent text default null) returns text
language sql as $$
  select t.run(p_by, format($q$select 'ok' from public.set_member(%L, %L, %L)$q$, t.id(p_vault), t.id(p_user), p_role), p_agent)
$$;
create function t.invite(p_user text, p_vault text, p_email text) returns text language sql as $$
  select t.run(p_user, format($q$select public.create_invite(%L, %L, 'viewer')$q$, t.id(p_vault), p_email))
$$;

-- ---------------------------------------------------------------------------
-- Invites only: set_member changes and removes, never adds

select t.expect('invites only: an owner in person can''t add someone with set_member, as any role',
  t.set_member('ana', 'team', 'dee', 'viewer') || ' ' || t.set_member('ana', 'team', 'dee', 'editor')
  || ' ' || t.set_member('ana', 'team', 'dee', 'owner') || ' ' || t.role_of('team', 'dee'),
  'ERR P0002 ERR P0002 ERR P0002 none');
select t.expect('invites only: an account with no vault can''t be added either, and nothing is logged',
  t.set_member('ana', 'team', 'eve', 'editor') || ' ' || t.role_of('team', 'eve') || ' '
  || (select count(*)::text from public.log where vault_id = t.id('team') and event = 'member.set'
        and detail ->> 'user' in (t.id('dee')::text, t.id('eve')::text)),
  'ERR P0002 none 0');
select t.expect('invites only: the owner''s agent and token can''t add anyone',
  t.set_member('ana', 'team', 'dee', 'viewer', 'Claude Code')
  || ' ' || t.run_tok('ana', 'ana-all', format($q$select 'ok' from public.set_member(%L, %L, 'viewer')$q$, t.id('team'), t.id('dee'))),
  'ERR 42501 ERR 42501');
select t.expect('invites only: nobody signed in writes vault_members directly',
  t.run('ana', format($q$insert into public.vault_members (vault_id, user_id, role) values (%L, %L, 'viewer') returning 'ok'$q$,
                      t.id('team'), t.id('dee')))
  || ' ' || t.run('dee', format($q$insert into public.vault_members (vault_id, user_id, role) values (%L, %L, 'owner') returning 'ok'$q$,
                      t.id('team'), t.id('dee')))
  || ' ' || t.run('ben', format($q$update public.vault_members set role = 'owner' where vault_id = %L returning 'ok'$q$, t.id('team')))
  || ' ' || t.role_of('team', 'dee') || ' ' || t.role_of('team', 'ben'),
  'ERR 42501 ERR 42501 ERR 42501 none editor');
select t.expect('invites only: set_member still changes an existing member''s role',
  t.set_member('ana', 'team', 'cal', 'editor') || ' ' || t.role_of('team', 'cal')
  || ' ' || t.set_member('ana', 'team', 'cal', 'viewer') || ' ' || t.role_of('team', 'cal'),
  'ok editor ok viewer');
create table t.tokens (name text primary key, token text);
insert into t.tokens select 'eve', t.run('ana', format($q$select public.create_invite(%L, 'eve@example.test', 'viewer')$q$, t.id('team')));
select t.expect('invites only: accepting an invite is how someone joins',
  t.run('eve', format($q$select public.accept_invite(%L)::text$q$, (select token from t.tokens where name = 'eve')))
  || ' ' || t.role_of('team', 'eve'),
  t.id('team')::text || ' viewer');
select t.expect('invites only: set_member still removes a member',
  t.set_member('ana', 'team', 'eve', null) || ' ' || t.role_of('team', 'eve'), 'ok none');

-- ---------------------------------------------------------------------------
-- The invite rate: 20 an hour per person, across their vaults

insert into t.ids select 'rate', t.run('ana', $q$select public.create_vault('Rate')$q$)::uuid;
-- Waiting invites count toward a vault's people limit
-- (20260925230000_plans): room for every invite this section makes.
insert into private.vault_tiers (id, name, max_members) values ('roomy', 'Roomy', 1000) on conflict do nothing;
select private.set_vault_tier(t.id('rate'), 'roomy');
update private.vault_invites set created_at = created_at - interval '2 hours';
do $$ begin
  for n in 1..20 loop
    perform t.invite('ana', 'rate', 'r' || n || '@example.test');
  end loop;
end $$;
select t.expect('invite rate: an owner makes 20 invites in an hour, and the 21st is refused',
  (select count(*)::text from private.vault_invites where created_by = t.id('ana') and created_at > now() - interval '1 hour')
  || ' ' || t.invite('ana', 'rate', 'r21@example.test'),
  '20 ERR 54000');
select t.expect('invite rate: it counts the person, not the vault',
  t.invite('ana', 'team', 'other@example.test'), 'ERR 54000');
select t.expect('invite rate: refused invites store and log nothing',
  (select count(*)::text from private.vault_invites where email in ('r21@example.test', 'other@example.test'))
  || ' ' || t.log_count('rate', 'invite.create'), '0 20');
select t.expect('invite rate: another owner is not held back',
  (t.invite('dee', 'deev', 'friend@example.test') ~ '^rli_')::text, 'true');
update private.vault_invites set created_at = created_at - interval '61 minutes' where created_by = t.id('ana');
select t.expect('invite rate: invites older than an hour no longer count',
  (t.invite('ana', 'rate', 'r21@example.test') ~ '^rli_')::text, 'true');

-- ---------------------------------------------------------------------------
-- Leaving a vault

create function t.leave(p_user text, p_vault text, p_agent text default null) returns text language sql as $$
  select t.run(p_user, format($q$select 'ok' from public.leave_vault(%L)$q$, t.id(p_vault)), p_agent)
$$;
select t.expect('leave: a member''s agent and token can''t leave for them',
  t.leave('cal', 'team', 'Claude Code')
  || ' ' || t.run_tok('cal', 'cal-all', format($q$select 'ok' from public.leave_vault(%L)$q$, t.id('team')))
  || ' ' || t.role_of('team', 'cal'), 'ERR 42501 ERR 42501 viewer');
select t.expect('leave: anonymous and the MCP server''s role can''t call it',
  t.leave(null, 'team') || ' ' || t.run_role('reliquary_mcp', format($q$select 'ok' from public.leave_vault(%L)$q$, t.id('team'))),
  'ERR 42501 ERR 42501');
select t.expect('leave: an outsider is told there is no such vault',
  t.leave('dee', 'team'), 'ERR P0002');
select t.expect('leave: refused calls log nothing',
  t.log_count('team', 'member.leave'), '0');
select t.expect('leave: a viewer leaves, in person',
  t.leave('cal', 'team') || ' ' || t.role_of('team', 'cal'), 'ok none');
select t.expect('leave: logged as member.leave by the person, with their former role and no address',
  (select string_agg(actor::text || ' ' || (detail ->> 'user') || ' ' || (detail ->> 'role') || ' '
                     || coalesce(agent, 'no agent') || ' ' || (detail::text like '%@%')::text, ';')
     from public.log where vault_id = t.id('team') and event = 'member.leave'),
  t.id('cal')::text || ' ' || t.id('cal')::text || ' viewer no agent false');
select t.expect('leave: afterwards they read nothing there, and their token reaches nothing',
  t.run('cal', format($q$select count(*)::text from public.vaults where id = %L$q$, t.id('team')))
  || ' ' || t.run_tok('cal', 'cal-all', format($q$select count(*)::text from public.files where vault_id = %L$q$, t.id('team'))),
  '0 0');
select t.expect('leave: leaving twice is an error',
  t.leave('cal', 'team'), 'ERR P0002');
select t.expect('leave: the only owner can''t leave',
  t.leave('ana', 'team') || ' ' || t.role_of('team', 'ana'), 'ERR 55000 owner');
select t.expect('leave: with a second owner, an owner can leave',
  t.set_member('ana', 'team', 'ben', 'owner') || ' ' || t.leave('ana', 'team')
  || ' ' || t.role_of('team', 'ana') || ' ' || t.role_of('team', 'ben'), 'ok ok none owner');
select t.expect('leave: then the new only owner can''t',
  t.leave('ben', 'team') || ' ' || t.role_of('team', 'ben'), 'ERR 55000 owner');

-- ---------------------------------------------------------------------------
-- Co-members' emails, in one call

insert into t.ids select 'club', t.run('dee', $q$select public.create_vault('Club')$q$)::uuid;
select test_support.add_member(t.id('club'), t.id('ana'), 'editor', t.id('dee'));
select test_support.add_member(t.id('club'), t.id('cal'), 'viewer', t.id('dee'));
create function t.emails(p_user text, p_ids text[], p_agent text default null) returns text language sql as $$
  select t.run(p_user, format($q$select coalesce(string_agg(email, ',' order by email), '(none)')
                                   from public.co_member_emails(%L::uuid[])$q$,
                              (select array_agg(t.id(n)) from unnest(p_ids) n)), p_agent)
$$;
select t.expect('emails: a person gets their co-members'' emails and their own, lower-cased, and nobody else''s',
  t.emails('dee', array['ana', 'ben', 'cal', 'dee', 'eve']), 'ana@example.test,cal@example.test,dee@example.test');
select t.expect('emails: a co-member in any shared vault counts; a former one doesn''t',
  t.emails('ben', array['ana', 'cal', 'dee', 'ben']), 'ben@example.test');
select t.expect('emails: someone who shares no vault gets only their own',
  t.emails('eve', array['ana', 'ben', 'cal', 'dee', 'eve']), 'eve@example.test');
select t.expect('emails: an id given twice or unknown comes back once or not at all',
  t.run('dee', format($q$select count(*)::text from public.co_member_emails(array[%L, %L, %L]::uuid[])$q$,
                      t.id('ana'), t.id('ana'), '00000000-0000-0000-0000-00000000ffff')), '1');
select t.expect('emails: an agent, a token, anonymous and the MCP server get none',
  t.emails('dee', array['ana'], 'Claude Code')
  || ' ' || t.run_tok('ana', 'ana-all', format($q$select count(*)::text from public.co_member_emails(array[%L]::uuid[])$q$, t.id('dee')))
  || ' ' || t.emails(null, array['ana'])
  || ' ' || t.run_role('reliquary_mcp', format($q$select count(*)::text from public.co_member_emails(array[%L]::uuid[])$q$, t.id('dee'))),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('emails: at most 500 ids a call',
  t.run('dee', $q$select count(*)::text from public.co_member_emails(array(select gen_random_uuid() from generate_series(1, 501)))$q$)
  || ' ' || t.run('dee', $q$select count(*)::text from public.co_member_emails(array(select gen_random_uuid() from generate_series(1, 500)))$q$),
  'ERR 54000 0');

-- ---------------------------------------------------------------------------
-- Deletion notices

insert into t.ids select 'doomed', t.run('ana', $q$select public.create_vault('Doomed Plans')$q$)::uuid;
select test_support.add_member(t.id('doomed'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('doomed'), t.id('cal'), 'viewer', t.id('ana'));
select test_support.add_member(t.id('doomed'), t.id('eve'), 'owner', t.id('ana'));
create function t.notices(p_user text, p_agent text default null) returns text language sql as $$
  select t.run(p_user, $q$select coalesce(string_agg(vault_name || ' by ' || coalesce(deleted_by_email, '?')
                                   || ' ' || (deleted_at > now() - interval '1 minute')::text, ';'), '(none)')
                            from public.take_deletion_notices()$q$, p_agent)
$$;
select t.expect('notices: before a deletion there are none',
  t.notices('ben'), '(none)');
select t.expect('notices: an owner deletes the vault',
  t.run('ana', format($q$select 'ok' from public.delete_vault(%L, 'Doomed Plans')$q$, t.id('doomed'))), 'ok');
select t.expect('notices: nobody signed in, the web app or the MCP server reads the notices table',
  t.run('ben', $q$select count(*)::text from private.vault_deletion_notices$q$)
  || ' ' || t.run_role('reliquary_web', $q$select count(*)::text from private.vault_deletion_notices$q$)
  || ' ' || t.run_role('reliquary_mcp', $q$select count(*)::text from private.vault_deletion_notices$q$),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('notices: a former member''s agent and token can''t take them',
  t.notices('ben', 'Claude Code')
  || ' ' || t.run_tok('ben', 'ben-all', $q$select count(*)::text from public.take_deletion_notices()$q$)
  || ' ' || t.notices(null), 'ERR 42501 ERR 42501 ERR 42501');
select t.expect('notices: someone who was never a member, and the owner who deleted it, get none',
  t.notices('dee') || ' ' || t.notices('ana'), '(none) (none)');
select t.expect('notices: a former member gets one, with the vault''s name, who deleted it and when',
  t.notices('ben'), 'Doomed Plans by ana@example.test true');
select t.expect('notices: once seen, it is gone',
  t.notices('ben') || ' ' || (select count(*)::text from private.vault_deletion_notices where user_id = t.id('ben')),
  '(none) 0');
update private.vault_deletion_notices set deleted_at = now() - interval '31 days' where user_id = t.id('cal');
select t.expect('notices: after 30 days it is not shown',
  t.notices('cal'), '(none)');
select t.expect('notices: after 30 days it is deleted, unseen',
  (select count(*)::text from private.vault_deletion_notices where user_id = t.id('cal')), '0');
select t.expect('notices: another owner is told too',
  t.notices('eve'), 'Doomed Plans by ana@example.test true');
select t.expect('notices: the deletion record itself still holds no name',
  (select count(*)::text from private.vault_deletions where vault_id = t.id('doomed') and to_jsonb(vault_deletions)::text like '%Doomed%'),
  '0');

-- ---------------------------------------------------------------------------
-- Export: one snapshot, and a rate

insert into t.ids select 'exp', t.run('dee', $q$select public.create_vault('Exp')$q$)::uuid;
select t.run('dee', format($q$select public.write_file(%L, 'a.md', 'A before')$q$, t.id('exp')));
select t.run('dee', format($q$select public.write_file(%L, 'b.md', 'B before')$q$, t.id('exp')));
select t.run('dee', format($q$select public.write_file(%L, 'e.md', 'E before')$q$, t.id('exp')));
select test_support.add_member(t.id('exp'), t.id('ana'), 'owner', t.id('dee'));
create table t.exports (name text primary key, h jsonb);
insert into t.exports select 'first', t.run('dee', format($q$select public.export_vault(%L)::text$q$, t.id('exp')))::jsonb;
create function t.eid(p_name text) returns uuid language sql as $$ select (h ->> 'export')::uuid from t.exports where name = p_name $$;
create function t.files(p_user text, p_vault text, p_export uuid default null) returns text language sql as $$
  select t.run(p_user, format($q$select coalesce(string_agg(path || '=' || body, ', ' order by path), '(none)')
                                   from public.export_files(%L, '', 200, %L)$q$, t.id(p_vault), p_export))
$$;

select t.run('dee', format($q$select public.write_file(%L, 'a.md', 'A after')$q$, t.id('exp')));
select t.run('dee', format($q$select public.delete_file(%L, 'b.md')$q$, t.id('exp')));
select t.run('dee', format($q$select public.write_file(%L, 'c.md', 'C new')$q$, t.id('exp')));
select t.expect('export snapshot: the header names its export and counts the files it holds',
  (t.eid('first') is not null)::text || ' ' || (select h ->> 'files' from t.exports where name = 'first'), 'true 3');
select t.expect('export snapshot: files are as they were when the export started, whatever is written meanwhile',
  t.files('dee', 'exp', t.eid('first')) || ' | ' || t.files('dee', 'exp'),
  'a.md=A before, b.md=B before, e.md=E before | a.md=A before, b.md=B before, e.md=E before');
select t.run('dee', format($q$select public.erase_file(%L, 'e.md')$q$, t.id('exp')));
select t.expect('export snapshot: a file erased meanwhile is left out: erasure wins',
  t.files('dee', 'exp', t.eid('first')), 'a.md=A before, b.md=B before');
select t.expect('export snapshot: another owner can''t read someone else''s export',
  t.files('ana', 'exp', t.eid('first')) || ' ' || t.files('ana', 'exp'), 'ERR 55000 ERR 55000');
select t.expect('export snapshot: an export can''t be read through another vault',
  t.files('dee', 'deev', t.eid('first')), 'ERR 55000');
select t.expect('export snapshot: a new export sees the new state',
  (select t.run('dee', format($q$select public.export_vault(%L)::text$q$, t.id('exp'))) is not null)::text
  || ' ' || t.files('dee', 'exp'), 'true a.md=A after, c.md=C new');
select t.expect('export snapshot: the first export is still its own snapshot',
  t.files('dee', 'exp', t.eid('first')), 'a.md=A before, b.md=B before');
update private.vault_exports set started_at = now() - interval '3 hours' where id = t.eid('first');
select t.expect('export snapshot: an export more than 2 hours old can''t be continued',
  t.files('dee', 'exp', t.eid('first')), 'ERR 55000');
select t.expect('export snapshot: nobody signed in, the web app or the MCP server reads the export tables',
  t.run('dee', $q$select count(*)::text from private.vault_exports$q$)
  || ' ' || t.run('dee', $q$select count(*)::text from private.vault_export_files$q$)
  || ' ' || t.run_role('reliquary_web', $q$select count(*)::text from private.vault_export_files$q$)
  || ' ' || t.run_role('reliquary_mcp', $q$select count(*)::text from private.vault_exports$q$),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('export snapshot: an agent and a token still can''t read files',
  t.run('dee', format($q$select count(*)::text from public.export_files(%L)$q$, t.id('exp')), 'Claude Code')
  || ' ' || t.run_tok('ana', 'ana-all', format($q$select count(*)::text from public.export_files(%L)$q$, t.id('exp'))),
  'ERR 42501 ERR 42501');

-- The rate: the first export is 3 hours old now; the second counts.
do $$ begin
  for n in 1..9 loop
    perform t.run('dee', format($q$select public.export_vault(%L)::text$q$, t.id('exp')));
  end loop;
end $$;
select t.expect('export rate: 10 exports of a vault an hour, the 11th refused and not logged',
  (select count(*)::text from private.vault_exports where vault_id = t.id('exp') and started_at > now() - interval '1 hour')
  || ' ' || t.run('dee', format($q$select public.export_vault(%L)::text$q$, t.id('exp')))
  || ' ' || t.log_count('exp', 'vault.export'),
  '10 ERR 54000 11');
select t.expect('export rate: it counts the vault, whoever exports',
  t.run('ana', format($q$select public.export_vault(%L)::text$q$, t.id('exp'))), 'ERR 54000');
select t.expect('export rate: another vault is not held back',
  (t.run('dee', format($q$select public.export_vault(%L)::text$q$, t.id('deev'))) like '{%')::text, 'true');
update private.vault_exports set started_at = started_at - interval '61 minutes' where vault_id = t.id('exp');
select t.expect('export rate: exports older than an hour no longer count',
  (t.run('dee', format($q$select public.export_vault(%L)::text$q$, t.id('exp'))) like '{%')::text, 'true');
