-- Hostile tests for members and invites (20260925140000_invites). Ana owns
-- Team (Ben edits, Cal views); Dee is an outsider with a vault of her own;
-- Fay, Gil and Hal have accounts and no vaults. Emails live in auth.users
-- (stubbed); Fay's is mixed case.

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids values
  ('fay', '00000000-0000-0000-0000-0000000000f1'),
  ('gil', '00000000-0000-0000-0000-0000000000f2'),
  ('hal', '00000000-0000-0000-0000-0000000000f3'),
  ('ivy', '00000000-0000-0000-0000-0000000000f4'),
  ('joy', '00000000-0000-0000-0000-0000000000f5'),
  ('kai', '00000000-0000-0000-0000-0000000000f6');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'),
  (t.id('cal'), 'cal@example.test'), (t.id('dee'), 'dee@example.test'),
  (t.id('fay'), 'Fay@Example.Test'), (t.id('gil'), 'gil@example.test'),
  (t.id('hal'), 'hal@example.test'), (t.id('ivy'), 'ivy@example.test'),
  (t.id('joy'), 'joy@example.test'), (t.id('kai'), 'kai@example.test');

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'deev', t.run('dee', $q$select public.create_vault('Dee own')$q$)::uuid;
insert into t.ids select 'benv', t.run('ben', $q$select public.create_vault('Ben own')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));

-- Tokens, used the way the MCP server does (act.tok = the token id), and a
-- CLI grant and an OAuth grant as rows.
select t.run('ana', $q$select public.create_access_token('ana-all', 30)$q$);
select t.run('fay', $q$select public.create_access_token('fay-all', 30)$q$);
select t.run('ben', $q$select public.create_access_token('ben-all', 30)$q$);
select t.run('ben', format($q$select public.create_access_token('ben-team', 30, array[%L]::uuid[], 'read')$q$, t.id('team')));
select t.run('ben', format($q$select public.create_access_token('ben-both', 30, array[%L, %L]::uuid[], 'write')$q$, t.id('team'), t.id('benv')));
select t.run('ben', format($q$select public.create_access_token('ben-own', 30, array[%L]::uuid[], 'write')$q$, t.id('benv')));
select t.run('dee', $q$select public.create_access_token('dee-all', 30)$q$);
insert into public.access_tokens (user_id, name, kind, client_id, resource, expires_at, access)
values (t.id('ana'), 'ana-oauth', 'oauth', 'https://client.example/meta.json', 'https://mcp.example/mcp', now() + interval '30 days', 'write'),
       (t.id('ana'), 'ana-cli', 'cli', 'https://app.example/cli/oauth-client.json', 'https://app.example/api/env', now() + interval '30 days', 'read'),
       (t.id('fay'), 'fay-cli', 'cli', 'https://app.example/cli/oauth-client.json', 'https://app.example/api/env', now() + interval '30 days', 'read');

create function t.invite(p_user text, p_vault text, p_email text, p_role text, p_max_uses int default 1) returns text language sql as $$
  select t.run(p_user, format($q$select public.create_invite(%L, %L, %L, %L)$q$, t.id(p_vault), p_email, p_role, p_max_uses))
$$;
create function t.peek_uses(p_token text) returns text language sql as $$
  select t.run_role('reliquary_web', format($q$select uses_count || '/' || max_uses from private.invite_peek(%L)$q$, p_token))
$$;
create function t.accept(p_user text, p_token text, p_agent text default null) returns text language sql as $$
  select t.run(p_user, format($q$select public.accept_invite(%L)::text$q$, p_token), p_agent)
$$;
create function t.state(p_token text) returns text language sql as $$
  select private.invite_state(accepted_at, revoked_at, expires_at) from private.vault_invites
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
$$;
create function t.role_of(p_vault text, p_user text) returns text language sql as $$
  select coalesce((select role from public.vault_members where vault_id = t.id(p_vault) and user_id = t.id(p_user)), 'none')
$$;
create function t.log_count(p_vault text, p_event text) returns text language sql as
$$ select count(*)::text from public.log where vault_id = t.id(p_vault) and event = p_event $$;
create function t.emails(p_user text, p_vault text) returns text language sql as $$
  select t.run(p_user, format($q$select string_agg(email || ':' || role, ',' order by email) from public.list_members(%L)$q$, t.id(p_vault)))
$$;

-- ---------------------------------------------------------------------------
-- Members and their emails

select t.expect('members: the owner sees every member by email and role',
  t.emails('ana', 'team'), 'ana@example.test:owner,ben@example.test:editor,cal@example.test:viewer');
select t.expect('members: an editor and a viewer see their co-members'' emails too',
  t.emails('ben', 'team') || ' | ' || t.emails('cal', 'team'),
  'ana@example.test:owner,ben@example.test:editor,cal@example.test:viewer | ana@example.test:owner,ben@example.test:editor,cal@example.test:viewer');
select t.expect('members: an outsider learns no member''s email',
  t.emails('dee', 'team'), 'ERR P0002');
select t.expect('members: anonymous learns no email',
  t.emails(null, 'team'), 'ERR 42501');
select t.expect('members: the owner''s agent gets no emails (people only)',
  t.run('ana', format($q$select count(*)::text from public.list_members(%L)$q$, t.id('team')), 'Claude Code'), 'ERR 42501');
select t.expect('members: the owner''s token, OAuth client and CLI grant get no emails',
  t.run_tok('ana', 'ana-all', format($q$select count(*)::text from public.list_members(%L)$q$, t.id('team')))
  || ' ' || t.run_tok('ana', 'ana-oauth', format($q$select count(*)::text from public.list_members(%L)$q$, t.id('team')))
  || ' ' || t.run_tok('ana', 'ana-cli', format($q$select count(*)::text from public.list_members(%L)$q$, t.id('team'))),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('members: the MCP server''s role can''t list members',
  t.run_role('reliquary_mcp', format($q$select count(*)::text from public.list_members(%L)$q$, t.id('team'))), 'ERR 42501');
select t.expect('members: nobody signed in reads auth.users or calls email_of directly',
  t.run('dee', $q$select count(*)::text from auth.users$q$)
  || ' ' || t.run('dee', format($q$select private.email_of(%L)$q$, t.id('ana')))
  || ' ' || t.run_role('reliquary_web', format($q$select private.email_of(%L)$q$, t.id('ana'))),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('members: my_email is your own address, in person only',
  t.run('fay', $q$select public.my_email()$q$) || ' ' || t.run('fay', $q$select public.my_email()$q$, 'Agent'),
  'fay@example.test ERR 42501');

-- ---------------------------------------------------------------------------
-- Creating invites

select t.expect('invite: an editor cannot invite', t.invite('ben', 'team', 'fay@example.test', 'viewer'), 'ERR 42501');
select t.expect('invite: a viewer cannot invite', t.invite('cal', 'team', 'fay@example.test', 'viewer'), 'ERR 42501');
select t.expect('invite: an outsider cannot invite', t.invite('dee', 'team', 'fay@example.test', 'viewer'), 'ERR 42501');
select t.expect('invite: anonymous cannot invite', t.invite(null, 'team', 'fay@example.test', 'viewer'), 'ERR 42501');
select t.expect('invite: the owner''s agent cannot invite',
  t.run('ana', format($q$select public.create_invite(%L, 'fay@example.test', 'viewer')$q$, t.id('team')), 'Claude Code'), 'ERR 42501');
select t.expect('invite: the owner''s all-vaults token, OAuth client and CLI grant cannot invite',
  t.run_tok('ana', 'ana-all', format($q$select public.create_invite(%L, 'fay@example.test', 'viewer')$q$, t.id('team')))
  || ' ' || t.run_tok('ana', 'ana-oauth', format($q$select public.create_invite(%L, 'fay@example.test', 'viewer')$q$, t.id('team')))
  || ' ' || t.run_tok('ana', 'ana-cli', format($q$select public.create_invite(%L, 'fay@example.test', 'viewer')$q$, t.id('team'))),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('invite: the MCP server''s role cannot invite',
  t.run_role('reliquary_mcp', format($q$select public.create_invite(%L, 'fay@example.test', 'viewer')$q$, t.id('team'))), 'ERR 42501');
select t.expect('invite: refused calls store and log nothing',
  (select count(*)::text from private.vault_invites) || ' ' || t.log_count('team', 'invite.create'), '0 0');
select t.expect('invite: not an email address is refused',
  t.invite('ana', 'team', 'not an email', 'viewer') || ' ' || t.invite('ana', 'team', 'a@b', 'viewer')
  || ' ' || t.invite('ana', 'team', E'x@example.test\nBcc: y@example.test', 'viewer'), 'ERR 22023 ERR 22023 ERR 22023');
select t.expect('invite: the role is owner, editor or viewer',
  t.invite('ana', 'team', 'fay@example.test', 'admin') || ' ' || t.invite('ana', 'team', 'fay@example.test', null), 'ERR 22023 ERR 22023');
select t.expect('invite: an address that already belongs to a member is refused, whatever its case',
  t.invite('ana', 'team', 'BEN@example.test', 'owner'), 'ERR 23505');

create table t.tokens (name text primary key, token text);
insert into t.tokens select 'fay', t.invite('ana', 'team', '  fay@EXAMPLE.test ', 'editor');
create function t.tk(p_name text) returns text language sql as $$ select token from t.tokens where name = p_name $$;

select t.expect('invite: the owner gets a single token, rli_ and 32 random bytes in hex',
  (t.tk('fay') ~ '^rli_[0-9a-f]{64}$')::text, 'true');
select t.expect('invite: only its SHA-256 is stored, with the address lower-cased and a 7-day expiry',
  (select count(*)::text || ' ' || bool_and(email = 'fay@example.test')::text || ' '
          || bool_and(expires_at between now() + interval '7 days' - interval '1 minute' and now() + interval '7 days')::text
     from private.vault_invites where token_hash = encode(extensions.digest(t.tk('fay'), 'sha256'), 'hex'))
  || ' ' || (select count(*)::text from private.vault_invites i where to_jsonb(i)::text like '%' || t.tk('fay') || '%'),
  '1 true true 0');
select t.expect('invite: logged as invite.create with the role and no address',
  (select string_agg((detail ->> 'role') || ' ' || (detail::text like '%@%')::text || ' ' || coalesce(agent, 'no agent'), ';')
     from public.log where vault_id = t.id('team') and event = 'invite.create'),
  'editor false no agent');
select t.expect('invite: nobody signed in reads the invites table',
  t.run('ana', $q$select count(*)::text from private.vault_invites$q$)
  || ' ' || t.run_role('reliquary_web', $q$select count(*)::text from private.vault_invites$q$)
  || ' ' || t.run_role('reliquary_mcp', $q$select count(*)::text from private.vault_invites$q$),
  'ERR 42501 ERR 42501 ERR 42501');

-- ---------------------------------------------------------------------------
-- Listing invites: owners in person

select t.expect('list invites: the owner sees the pending invite with its address and role',
  t.run('ana', format($q$select string_agg(email || ' ' || role, ',') from public.list_invites(%L)$q$, t.id('team'))),
  'fay@example.test editor');
select t.expect('list invites: an editor, a viewer and an outsider see no invited address',
  t.run('ben', format($q$select count(*)::text from public.list_invites(%L)$q$, t.id('team')))
  || ' ' || t.run('cal', format($q$select count(*)::text from public.list_invites(%L)$q$, t.id('team')))
  || ' ' || t.run('dee', format($q$select count(*)::text from public.list_invites(%L)$q$, t.id('team'))),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('list invites: the owner''s agent and token see none',
  t.run('ana', format($q$select count(*)::text from public.list_invites(%L)$q$, t.id('team')), 'Claude Code')
  || ' ' || t.run_tok('ana', 'ana-all', format($q$select count(*)::text from public.list_invites(%L)$q$, t.id('team'))),
  'ERR 42501 ERR 42501');
select t.expect('list invites: no log row anywhere holds an invited address',
  (select count(*)::text from public.log where detail::text like '%@%'), '0');

-- ---------------------------------------------------------------------------
-- The link before sign-in: the web app's role only

select t.expect('peek: the web app''s role learns the vault, role, address and state from the token',
  t.run_role('reliquary_web', format($q$select state || ' ' || vault_name || ' ' || role || ' ' || email from private.invite_peek(%L)$q$, t.tk('fay'))),
  'pending Team editor fay@example.test');
select t.expect('peek: a signed-in person, anonymous and the MCP server can''t peek',
  t.run('dee', format($q$select state from private.invite_peek(%L)$q$, t.tk('fay')))
  || ' ' || t.run(null, format($q$select state from private.invite_peek(%L)$q$, t.tk('fay')))
  || ' ' || t.run_role('reliquary_mcp', format($q$select state from private.invite_peek(%L)$q$, t.tk('fay'))),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('peek: a guessed, truncated or hashed token finds nothing',
  coalesce(t.run_role('reliquary_web', format($q$select state from private.invite_peek(%L)$q$, 'rli_' || repeat('0', 64))), 'none')
  || ' ' || coalesce(t.run_role('reliquary_web', format($q$select state from private.invite_peek(%L)$q$, left(t.tk('fay'), 60))), 'none')
  || ' ' || coalesce(t.run_role('reliquary_web', format($q$select state from private.invite_peek(%L)$q$,
       encode(extensions.digest(t.tk('fay'), 'sha256'), 'hex'))), 'none'),
  'none none none');

-- ---------------------------------------------------------------------------
-- Accepting

select t.expect('accept: someone signed in with another email is refused, and the invite stays usable',
  t.accept('ben', t.tk('fay')) || ' ' || t.accept('dee', t.tk('fay')) || ' ' || t.state(t.tk('fay')) || ' ' || t.role_of('team', 'dee'),
  'ERR 42501 ERR 42501 pending none');
select t.expect('accept: the invitee''s agent cannot accept',
  t.accept('fay', t.tk('fay'), 'Claude Code') || ' ' || t.state(t.tk('fay')), 'ERR 42501 pending');
select t.expect('accept: the invitee''s token and CLI grant cannot accept',
  t.run_tok('fay', 'fay-all', format($q$select public.accept_invite(%L)::text$q$, t.tk('fay')))
  || ' ' || t.run_tok('fay', 'fay-cli', format($q$select public.accept_invite(%L)::text$q$, t.tk('fay')))
  || ' ' || t.state(t.tk('fay')), 'ERR 42501 ERR 42501 pending');
select t.expect('accept: anonymous and the MCP server cannot accept',
  t.accept(null, t.tk('fay')) || ' ' || t.run_role('reliquary_mcp', format($q$select public.accept_invite(%L)::text$q$, t.tk('fay'))),
  'ERR 42501 ERR 42501');
select t.expect('accept: guessing fails: a random token, a truncated one, the stored hash, another case',
  t.accept('fay', 'rli_' || encode(extensions.gen_random_bytes(32), 'hex'))
  || ' ' || t.accept('fay', left(t.tk('fay'), 40))
  || ' ' || t.accept('fay', encode(extensions.digest(t.tk('fay'), 'sha256'), 'hex'))
  || ' ' || t.accept('fay', upper(t.tk('fay')))
  || ' ' || t.accept('fay', null)
  || ' ' || t.state(t.tk('fay')),
  'ERR P0002 ERR P0002 ERR P0002 ERR P0002 ERR P0002 pending');
select t.expect('accept: refusals make no member and log nothing',
  t.role_of('team', 'fay') || ' ' || t.log_count('team', 'invite.accept'), 'none 0');
select t.expect('accept: the invitee in person, whatever the case of either address, joins with the invite''s role',
  t.accept('fay', t.tk('fay')) || ' ' || t.role_of('team', 'fay') || ' ' || t.state(t.tk('fay')),
  t.id('team')::text || ' editor accepted');
select t.expect('accept: logged as invite.accept by the invitee, with the role and no address',
  (select string_agg(actor::text || ' ' || (detail ->> 'role') || ' ' || (detail::text like '%@%')::text, ';')
     from public.log where vault_id = t.id('team') and event = 'invite.accept'),
  t.id('fay')::text || ' editor false');
select t.expect('accept: a used invite can''t be used again, by anyone',
  t.accept('fay', t.tk('fay')) || ' ' || t.accept('ben', t.tk('fay')), 'ERR 55000 ERR 55000');
select t.expect('accept: the new member now sees co-members'' emails, and they see hers',
  t.emails('fay', 'team') || ' | ' || t.emails('cal', 'team'),
  'ana@example.test:owner,ben@example.test:editor,cal@example.test:viewer,fay@example.test:editor | ana@example.test:owner,ben@example.test:editor,cal@example.test:viewer,fay@example.test:editor');
select t.expect('accept: an outsider still sees nobody''s email',
  t.emails('dee', 'team'), 'ERR P0002');

-- Expired
insert into t.tokens select 'gil', t.invite('ana', 'team', 'gil@example.test', 'viewer');
update private.vault_invites set expires_at = now() - interval '1 second'
 where token_hash = encode(extensions.digest(t.tk('gil'), 'sha256'), 'hex');
select t.expect('accept: an expired invite is refused and makes no member',
  t.accept('gil', t.tk('gil')) || ' ' || t.role_of('team', 'gil'), 'ERR 55000 none');
select t.expect('list invites: expired and accepted invites are not listed as pending',
  t.run('ana', format($q$select count(*)::text from public.list_invites(%L)$q$, t.id('team'))), '0');

-- Revoked
insert into t.tokens select 'hal', t.invite('ana', 'team', 'hal@example.test', 'owner');
insert into t.ids select 'hal_invite', id from private.vault_invites
 where token_hash = encode(extensions.digest(t.tk('hal'), 'sha256'), 'hex');
select t.expect('revoke invite: an editor, an outsider and anonymous are told there is no such invite',
  t.run('ben', format($q$select 'ok' from public.revoke_invite(%L)$q$, t.id('hal_invite')))
  || ' ' || t.run('dee', format($q$select 'ok' from public.revoke_invite(%L)$q$, t.id('hal_invite')))
  || ' ' || t.run(null, format($q$select 'ok' from public.revoke_invite(%L)$q$, t.id('hal_invite'))),
  'ERR P0002 ERR P0002 ERR 42501');
select t.expect('revoke invite: the owner''s agent and token cannot revoke',
  t.run('ana', format($q$select 'ok' from public.revoke_invite(%L)$q$, t.id('hal_invite')), 'Claude Code')
  || ' ' || t.run_tok('ana', 'ana-all', format($q$select 'ok' from public.revoke_invite(%L)$q$, t.id('hal_invite')))
  || ' ' || t.state(t.tk('hal')), 'ERR 42501 ERR 42501 pending');
select t.expect('revoke invite: the owner revokes',
  t.run('ana', format($q$select 'ok' from public.revoke_invite(%L)$q$, t.id('hal_invite')))
  || ' ' || t.state(t.tk('hal')), 'ok revoked');
select t.expect('revoke invite: logged as invite.revoke without the address',
  (select count(*)::text from public.log where vault_id = t.id('team') and event = 'invite.revoke'
     and detail ->> 'invite' = t.id('hal_invite')::text and detail::text not like '%@%'), '1');
select t.expect('revoke invite: a revoked invite can''t be accepted or revoked again',
  t.accept('hal', t.tk('hal')) || ' ' || t.role_of('team', 'hal')
  || ' ' || t.run('ana', format($q$select 'ok' from public.revoke_invite(%L)$q$, t.id('hal_invite'))),
  'ERR 55000 none ERR 55000');

-- Replaced
insert into t.tokens select 'hal1', t.invite('ana', 'team', 'hal@example.test', 'viewer');
insert into t.tokens select 'hal2', t.invite('ana', 'team', 'HAL@example.test', 'editor');
select t.expect('replace: inviting an address again withdraws its pending invite',
  t.state(t.tk('hal1')) || ' ' || t.state(t.tk('hal2')) || ' ' || t.accept('hal', t.tk('hal1')), 'revoked pending ERR 55000');
select t.expect('replace: the newer invite works',
  t.accept('hal', t.tk('hal2')) || ' ' || t.role_of('team', 'hal'), t.id('team')::text || ' editor');

-- An invite never demotes
insert into t.tokens select 'gil2', t.invite('dee', 'deev', 'gil@example.test', 'viewer');
select test_support.add_member(t.id('deev'), t.id('gil'), 'owner', t.id('dee'));
select t.expect('accept: someone who became a member meanwhile keeps their role',
  t.accept('gil', t.tk('gil2')) || ' ' || t.role_of('deev', 'gil') || ' ' || t.state(t.tk('gil2')),
  t.id('deev')::text || ' owner accepted');
select t.expect('invite: an address that already belongs to a member is refused in any vault',
  t.invite('gil', 'deev', 'dee@example.test', 'viewer'), 'ERR 23505');

-- Invites stay in their vault: an owner of one vault can't list or revoke another's
select t.expect('isolation: an owner of another vault can''t list or revoke this vault''s invites',
  t.run('dee', format($q$select count(*)::text from public.list_invites(%L)$q$, t.id('team')))
  || ' ' || t.run('dee', format($q$select 'ok' from public.revoke_invite(%L)$q$, t.id('hal_invite'))),
  'ERR 42501 ERR P0002');

-- Cap on waiting invites. Waiting invites count toward a vault's people
-- limit (20260925230000_plans), so this vault gets room for all of them.
insert into private.vault_tiers (id, name, max_members) values ('roomy', 'Roomy', 1000) on conflict do nothing;
select private.set_vault_tier(t.id('deev'), 'roomy');
do $$ begin
  for n in 1..50 loop
    perform t.invite('dee', 'deev', 'cap' || n || '@example.test', 'viewer');
    -- Made before the hourly rate's window, so only the cap applies here.
    update private.vault_invites set created_at = created_at - interval '2 hours' where created_by = t.id('dee');
  end loop;
end $$;
select t.expect('cap: a vault holds at most 50 waiting invites',
  t.run('dee', format($q$select count(*)::text from public.list_invites(%L)$q$, t.id('deev')))
  || ' ' || t.invite('dee', 'deev', 'cap51@example.test', 'viewer'), '50 ERR 54000');

-- ---------------------------------------------------------------------------
-- Changing roles and removing: owners in person, and a vault keeps an owner

select t.expect('last owner: the only owner can''t demote themself',
  t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, 'editor')$q$, t.id('team'), t.id('ana')))
  || ' ' || t.role_of('team', 'ana'), 'ERR 55000 owner');
select t.expect('last owner: an owner can''t remove themself',
  t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, null)$q$, t.id('team'), t.id('ana'))), 'ERR 42501');
select t.expect('members: an editor can''t change roles, and the owner''s agent and token can''t either',
  t.run('ben', format($q$select 'ok' from public.set_member(%L, %L, 'owner')$q$, t.id('team'), t.id('ben')))
  || ' ' || t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, 'owner')$q$, t.id('team'), t.id('ben')), 'Claude Code')
  || ' ' || t.run_tok('ana', 'ana-all', format($q$select 'ok' from public.set_member(%L, %L, 'owner')$q$, t.id('team'), t.id('ben')))
  || ' ' || t.role_of('team', 'ben'), 'ERR 42501 ERR 42501 ERR 42501 editor');
select t.expect('members: an unknown role is refused',
  t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, 'admin')$q$, t.id('team'), t.id('ben'))), 'ERR 22023');
select t.expect('members: removing someone who isn''t a member is an error and logs nothing',
  t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, null)$q$, t.id('team'), t.id('dee')))
  || ' ' || (select count(*)::text from public.log where vault_id = t.id('team') and event = 'member.set'
               and detail ->> 'user' = t.id('dee')::text), 'ERR P0002 0');
select t.expect('last owner: with a second owner, the first can step down',
  t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, 'owner')$q$, t.id('team'), t.id('ben')))
  || ' ' || t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, 'editor')$q$, t.id('team'), t.id('ana')))
  || ' ' || t.role_of('team', 'ana') || ' ' || t.role_of('team', 'ben'), 'ok ok editor owner');
select t.expect('last owner: then the new only owner can''t step down',
  t.run('ben', format($q$select 'ok' from public.set_member(%L, %L, 'viewer')$q$, t.id('team'), t.id('ben')))
  || ' ' || t.role_of('team', 'ben'), 'ERR 55000 owner');
select t.run('ben', format($q$select public.set_member(%L, %L, 'owner')$q$, t.id('team'), t.id('ana')));
select t.expect('members: role changes are logged as member.set with the person''s id and no address',
  (select count(*)::text || ' ' || bool_and(detail::text not like '%@%')::text from public.log
    where vault_id = t.id('team') and event = 'member.set'), '5 true');
select t.expect('members: a removed member loses the member list',
  t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, null)$q$, t.id('team'), t.id('cal')))
  || ' ' || t.emails('cal', 'team'), 'ok ERR P0002');

-- ---------------------------------------------------------------------------
-- Members' agent connections

create function t.conns(p_user text, p_vault text) returns text language sql as $$
  select t.run(p_user, format($q$select string_agg(name, ',' order by name) from public.member_connections(%L)$q$, t.id(p_vault)))
$$;
select t.expect('connections: an owner sees every member''s live connections that reach the vault, and no others',
  t.conns('ana', 'team'), 'ana-all,ana-cli,ana-oauth,ben-all,ben-both,ben-team,fay-all,fay-cli');
select t.expect('connections: an editor, an outsider, the owner''s agent and token see none',
  t.conns('fay', 'team') || ' ' || t.conns('dee', 'team')
  || ' ' || t.run('ana', format($q$select count(*)::text from public.member_connections(%L)$q$, t.id('team')), 'Claude Code')
  || ' ' || t.run_tok('ana', 'ana-all', format($q$select count(*)::text from public.member_connections(%L)$q$, t.id('team'))),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501');

-- The message p_sql raises as p_user, in the words of the Connections page.
create function t.conn_msg(p_user text, p_sql text) returns text
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql;
  perform set_config('role', 'none', true);
  return null;
exception when others then
  perform set_config('role', 'none', true);
  return sqlstate || ' ' || sqlerrm;
end $$;
select t.expect('connections: a non-owner is told only owners see the connections members have',
  t.conn_msg('fay', format('select count(*) from public.member_connections(%L)', t.id('team'))),
  '42501 only owners see the connections members have to this vault');
select t.expect('connections: a non-owner is told only owners revoke the connections members have',
  t.conn_msg('fay', format('select public.revoke_member_connection(%L, %L)', t.id('team'), t.tok('ben-team'))),
  '42501 only owners revoke the connections members have to this vault');

create function t.tok_state(p_name text) returns text language sql as $$
  select case when revoked_at is not null then 'revoked'
              when all_vaults then 'all'
              else (select string_agg(n.name, '+' order by n.name) from t.ids n where n.id = any(vault_ids)) end
    from public.access_tokens where name = p_name
$$;
select t.expect('connections: an editor, the owner''s agent and token can''t revoke one',
  t.run('fay', format($q$select 'ok' from public.revoke_member_connection(%L, %L)$q$, t.id('team'), t.tok('ben-team')))
  || ' ' || t.run('ana', format($q$select 'ok' from public.revoke_member_connection(%L, %L)$q$, t.id('team'), t.tok('ben-team')), 'Claude Code')
  || ' ' || t.run_tok('ana', 'ana-all', format($q$select 'ok' from public.revoke_member_connection(%L, %L)$q$, t.id('team'), t.tok('ben-team')))
  || ' ' || t.tok_state('ben-team'), 'ERR 42501 ERR 42501 ERR 42501 team');
select t.expect('connections: an owner can''t touch a connection that doesn''t reach the vault, or a non-member''s',
  t.run('ana', format($q$select 'ok' from public.revoke_member_connection(%L, %L)$q$, t.id('team'), t.tok('ben-own')))
  || ' ' || t.run('ana', format($q$select 'ok' from public.revoke_member_connection(%L, %L)$q$, t.id('team'), t.tok('dee-all')))
  || ' ' || t.tok_state('ben-own') || ' ' || t.tok_state('dee-all'), 'ERR P0002 ERR P0002 benv all');
select t.expect('connections: a connection that reached only this vault is revoked',
  t.run('ana', format($q$select 'ok' from public.revoke_member_connection(%L, %L)$q$, t.id('team'), t.tok('ben-team')))
  || ' ' || t.tok_state('ben-team'), 'ok revoked');
select t.expect('connections: one with a list of vaults loses only this vault',
  t.run('ana', format($q$select 'ok' from public.revoke_member_connection(%L, %L)$q$, t.id('team'), t.tok('ben-both')))
  || ' ' || t.tok_state('ben-both'), 'ok benv');
select t.expect('connections: an all-vaults one keeps the member''s other vaults, and no longer reaches this one',
  t.run('ana', format($q$select 'ok' from public.revoke_member_connection(%L, %L)$q$, t.id('team'), t.tok('ben-all')))
  || ' ' || t.tok_state('ben-all')
  || ' ' || coalesce(t.run_tok('ben', 'ben-all', format($q$select name from public.vaults where id = %L$q$, t.id('team'))), 'invisible')
  || ' ' || t.run_tok('ben', 'ben-all', format($q$select name from public.vaults where id = %L$q$, t.id('benv'))),
  'ok benv invisible Ben own');
select t.expect('connections: a member with no other vault loses the connection',
  t.run('ana', format($q$select 'ok' from public.revoke_member_connection(%L, %L)$q$, t.id('team'), t.tok('fay-all')))
  || ' ' || t.tok_state('fay-all'), 'ok revoked');
select t.expect('connections: each cut is logged with the member and token ids',
  (select count(*)::text || ' ' || bool_and(detail ? 'user' and detail ? 'token')::text from public.log
    where vault_id = t.id('team') and event = 'member.connection_revoke'), '4 true');

-- ---------------------------------------------------------------------------
-- Open invite links (20260929180000_open_invites): no address, a use
-- count instead of one use. A fresh vault, so nothing here disturbs
-- 'team' or 'deev's membership used above.

insert into t.ids select 'openv', t.run('dee', $q$select public.create_vault('Open')$q$)::uuid;
create table t.open_tokens (name text primary key, token text);
create function t.otk(p_name text) returns text language sql as $$ select token from t.open_tokens where name = p_name $$;

insert into t.open_tokens select 'link2', t.invite('dee', 'openv', null, 'viewer', 2);
select t.expect('open invite: an owner creates a link with no address and a use count',
  (t.otk('link2') ~ '^rli_[0-9a-f]{64}$')::text, 'true');
select t.expect('open invite: stored with no email, the requested max_uses, and zero uses so far',
  (select (email is null and max_uses = 2 and uses_count = 0)::text from private.vault_invites
     where token_hash = encode(extensions.digest(t.otk('link2'), 'sha256'), 'hex')),
  'true');
select t.expect('open invite: peek reports it usable by anyone, with uses remaining',
  t.run_role('reliquary_web', format($q$select state || ' ' || coalesce(email, '(none)') || ' ' || uses_count || '/' || max_uses
                                        from private.invite_peek(%L)$q$, t.otk('link2'))),
  'pending (none) 0/2');

select t.expect('open invite: someone not pre-specified accepts and joins with the link''s role',
  t.accept('ivy', t.otk('link2')) || ' ' || t.role_of('openv', 'ivy'), t.id('openv')::text || ' viewer');
select t.expect('open invite: still usable after one redemption, one use left',
  t.peek_uses(t.otk('link2')) || ' ' || t.state(t.otk('link2')), '1/2 pending');
select t.expect('open invite: a second, different person also joins with it',
  t.accept('joy', t.otk('link2')) || ' ' || t.role_of('openv', 'joy'), t.id('openv')::text || ' viewer');
select t.expect('open invite: exhausted once its use count is reached',
  t.peek_uses(t.otk('link2')) || ' ' || t.state(t.otk('link2')), '2/2 accepted');
select t.expect('open invite: a third person is refused once uses run out, and joins nothing',
  t.accept('kai', t.otk('link2')) || ' ' || t.role_of('openv', 'kai'), 'ERR 55000 none');

insert into t.open_tokens select 'link1', t.invite('dee', 'openv', null, 'editor');
select t.expect('open invite: the default use count is 1, same as an address-bound invite',
  (select max_uses::text from private.vault_invites
     where token_hash = encode(extensions.digest(t.otk('link1'), 'sha256'), 'hex')), '1');
select t.expect('open invite: a one-time link dies after its first use, whoever uses it',
  t.accept('kai', t.otk('link1')) || ' ' || t.role_of('openv', 'kai') || ' ' || t.state(t.otk('link1'))
  || ' ' || t.accept('ivy', t.otk('link1')),
  t.id('openv')::text || ' editor accepted ERR 55000');

select t.expect('open invite: a use count outside 1 to 100 is refused',
  t.invite('dee', 'openv', null, 'viewer', 0) || ' ' || t.invite('dee', 'openv', null, 'viewer', 101)
  || ' ' || t.invite('dee', 'openv', null, 'viewer', -1), 'ERR 22023 ERR 22023 ERR 22023');

insert into t.open_tokens select 'boundhigh', t.invite('dee', 'openv', 'gil@example.test', 'viewer', 5);
select t.expect('invite: an address-bound invite is always single-use, even if a higher count is asked for',
  (select max_uses::text from private.vault_invites
     where token_hash = encode(extensions.digest(t.otk('boundhigh'), 'sha256'), 'hex')), '1');
select t.expect('invite: and dies after its one use, as always',
  t.accept('gil', t.otk('boundhigh')) || ' ' || t.state(t.otk('boundhigh')), t.id('openv')::text || ' accepted');

insert into t.open_tokens select 'link3', t.invite('dee', 'openv', null, 'viewer', 3);
insert into t.ids select 'link3_invite', id from private.vault_invites
 where token_hash = encode(extensions.digest(t.otk('link3'), 'sha256'), 'hex');
select t.expect('open invite: the owner revokes a partially-used link',
  t.accept('kai', t.otk('link3')) || ' ' || t.peek_uses(t.otk('link3'))
  || ' ' || t.run('dee', format($q$select 'ok' from public.revoke_invite(%L)$q$, t.id('link3_invite')))
  || ' ' || t.state(t.otk('link3')),
  t.id('openv')::text || ' 1/3 ok revoked');
select t.expect('open invite: revoked stops further redemptions, however many uses were left',
  t.accept('joy', t.otk('link3')), 'ERR 55000');

insert into t.open_tokens select 'link4', t.invite('dee', 'openv', null, 'editor', 10);
select t.expect('list invites: a link shows its role and use count, with no address',
  t.run('dee', format($q$select coalesce(email, '(none)') || ' ' || role || ' ' || uses_count || '/' || max_uses
                          from public.list_invites(%L) order by created_at desc limit 1$q$, t.id('openv'))),
  '(none) editor 0/10');
select t.expect('open invite: never appears in anyone''s inbox: there''s no address to match',
  t.run('kai', $q$select count(*)::text from public.my_invites()$q$), '0');

-- ---------------------------------------------------------------------------
-- Deleting a vault with invites

insert into t.tokens select 'doomed', t.invite('ana', 'team', 'zed@example.test', 'viewer');
select t.expect('delete: a vault with invites deletes',
  t.run('ana', format($q$select 'ok' from public.delete_vault(%L, 'Team')$q$, t.id('team'))), 'ok');
select t.expect('delete: its invites go with it, and their links find nothing',
  (select count(*)::text from private.vault_invites where vault_id = t.id('team'))
  || ' ' || coalesce(t.run_role('reliquary_web', format($q$select state from private.invite_peek(%L)$q$, t.tk('doomed'))), 'none'),
  '0 none');
