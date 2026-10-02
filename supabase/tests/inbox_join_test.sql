-- Hostile tests for 20260926140000_inbox_join: joining or declining an
-- invite from the Inbox by its id (accept_my_invite, decline_my_invite),
-- my_invites' ids, and accept_invite through the shared take_invite. Ana
-- owns Team (Ben edits, Cal views); Dee is an outsider with a vault of her
-- own; Eve, Gil and Hal have accounts and no vault; Fay's address isn't
-- confirmed. Small limits come from a test tier, "Tiny" (3 people).

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids values
  ('eve', '00000000-0000-0000-0000-0000000000e1'),
  ('fay', '00000000-0000-0000-0000-0000000000e2'),
  ('gil', '00000000-0000-0000-0000-0000000000e3'),
  ('hal', '00000000-0000-0000-0000-0000000000e4');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'),
  (t.id('cal'), 'cal@example.test'), (t.id('dee'), 'dee@example.test'),
  (t.id('eve'), 'Eve@Example.test'), (t.id('gil'), 'gil@example.test'),
  (t.id('hal'), 'hal@example.test');
insert into auth.users (id, email, email_confirmed_at) values (t.id('fay'), 'fay@example.test', null);
insert into private.vault_tiers (id, name, max_members, max_storage_bytes) values ('tiny', 'Tiny', 3, 1000000);

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'deev', t.run('dee', $q$select public.create_vault('Dee own')$q$)::uuid;
insert into t.ids select 'club', t.run('ana', $q$select public.create_vault('Club')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select private.set_vault_tier(t.id('club'), 'tiny');

-- As t.run, but an error comes back as "<sqlstate> <message>".
create function t.msg(p_user text, p_sql text, p_agent text default null)
returns text language plpgsql as $$
declare
  v text;
  v_state text;
  v_msg text;
  claims jsonb := case when p_user is null then '{}'::jsonb
                       else jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated') end;
begin
  if p_agent is not null then
    claims := claims || jsonb_build_object('act', jsonb_build_object('sub', 'agent-1', 'name', p_agent));
  end if;
  perform set_config('request.jwt.claims', claims::text, true);
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return v;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  perform set_config('role', 'none', true);
  return v_state || ' ' || v_msg;
end $$;

select t.run('eve', $q$select public.create_access_token('eve-all', 30)$q$);
insert into public.access_tokens (user_id, name, kind, client_id, resource, expires_at, access)
values (t.id('eve'), 'eve-oauth', 'oauth', 'https://client.example/meta.json', 'https://mcp.example/mcp', now() + interval '30 days', 'write'),
       (t.id('eve'), 'eve-cli', 'cli', 'https://app.example/cli/oauth-client.json', 'https://app.example/api/env', now() + interval '30 days', 'read');

create table t.tokens (name text primary key, token text);
-- An invite from the vault's creator (an owner).
create function t.invite(p_key text, p_vault text, p_email text, p_role text) returns void language sql as $$
  insert into t.tokens select p_key, t.run_claims(
    jsonb_build_object('sub', (select created_by from public.vaults where id = t.id(p_vault)), 'role', 'authenticated'),
    format($q$select public.create_invite(%L, %L, %L)$q$, t.id(p_vault), p_email, p_role))
$$;
create function t.tk(p_key text) returns text language sql as $$ select token from t.tokens where name = p_key $$;
-- An invite's id, found by its token (as its owner could from list_invites).
create function t.inv(p_key text) returns uuid language sql as $$
  select id from private.vault_invites where token_hash = encode(extensions.digest(t.tk(p_key), 'sha256'), 'hex')
$$;
create function t.state(p_key text) returns text language sql as $$
  select private.invite_state(accepted_at, revoked_at, expires_at) || case when declined_at is not null then ' declined' else '' end
    from private.vault_invites where id = t.inv(p_key)
$$;
create function t.join_sql(p_key text) returns text language sql as
$$ select format($q$select public.accept_my_invite(%L)::text$q$, t.inv(p_key)) $$;
create function t.decline_sql(p_key text) returns text language sql as
$$ select format($q$select public.decline_my_invite(%L)$q$, t.inv(p_key)) $$;
create function t.role_of(p_vault text, p_user text) returns text language sql as $$
  select coalesce((select role from public.vault_members where vault_id = t.id(p_vault) and user_id = t.id(p_user)), 'none')
$$;
create function t.log_count(p_vault text, p_event text) returns text language sql as
$$ select count(*)::text from public.log where vault_id = t.id(p_vault) and event = p_event $$;

select t.invite('eve', 'team', 'eve@example.test', 'editor');
select t.invite('eve-dee', 'deev', 'eve@example.test', 'viewer');

-- ---------------------------------------------------------------------------
-- The id in my_invites

select t.expect('ids: my_invites gives the addressee each invite''s id, and nobody else sees it',
  t.run('eve', format($q$select count(*)::text from public.my_invites() where id in (%L, %L)$q$, t.inv('eve'), t.inv('eve-dee')))
  || ' ' || t.run('ana', $q$select count(*)::text from public.my_invites()$q$)
  || ' ' || t.run('dee', $q$select count(*)::text from public.my_invites()$q$),
  '2 0 0');
select t.invite('fay', 'team', 'fay@example.test', 'viewer');
select t.expect('ids: an address Auth hasn''t confirmed sees no invites in its inbox',
  t.run('fay', $q$select count(*)::text from public.my_invites()$q$), '0');

-- ---------------------------------------------------------------------------
-- Someone else's invite

select t.expect('others: another person can''t join with someone else''s invite id, and learns nothing about it',
  t.msg('dee', t.join_sql('eve')) || ' / ' || t.msg('ana', t.join_sql('eve')) || ' / ' || t.msg('ben', t.join_sql('eve')),
  'P0002 no invite with this id is waiting for your address: it may have been sent to another address, or its vault deleted / '
  || 'P0002 no invite with this id is waiting for your address: it may have been sent to another address, or its vault deleted / '
  || 'P0002 no invite with this id is waiting for your address: it may have been sent to another address, or its vault deleted');
select t.expect('others: another person can''t decline someone else''s invite by id',
  t.msg('dee', t.decline_sql('eve')) || ' / ' || t.msg('ana', t.decline_sql('eve')),
  'P0002 no invite with this id is waiting for your address: it may have been sent to another address, or its vault deleted / '
  || 'P0002 no invite with this id is waiting for your address: it may have been sent to another address, or its vault deleted');
select t.expect('others: a made-up id and a null id are refused the same way',
  t.msg('eve', format($q$select public.accept_my_invite(%L)::text$q$, gen_random_uuid())) || ' / '
  || t.msg('eve', $q$select public.decline_my_invite(null)$q$),
  'P0002 no invite with this id is waiting for your address: it may have been sent to another address, or its vault deleted / '
  || 'P0002 no invite with this id is waiting for your address: it may have been sent to another address, or its vault deleted');
select t.expect('others: after all that the invite still waits, and nobody joined or logged anything',
  t.state('eve') || ' ' || t.role_of('team', 'dee') || ' ' || t.log_count('team', 'invite.accept')
  || ' ' || t.log_count('team', 'invite.decline'),
  'pending none 0 0');

-- ---------------------------------------------------------------------------
-- Agents, tokens and anonymous

select t.expect('agents: the addressee''s agent, token, OAuth client and CLI grant can''t join',
  t.msg('eve', t.join_sql('eve'), 'Claude Code') || ' / '
  || t.run_tok('eve', 'eve-all', t.join_sql('eve')) || ' ' || t.run_tok('eve', 'eve-oauth', t.join_sql('eve'))
  || ' ' || t.run_tok('eve', 'eve-cli', t.join_sql('eve')),
  '42501 this action needs the person, not their agent / ERR 42501 ERR 42501 ERR 42501');
select t.expect('agents: nor decline',
  t.run('eve', t.decline_sql('eve'), 'Claude Code') || ' ' || t.run_tok('eve', 'eve-all', t.decline_sql('eve'))
  || ' ' || t.run_tok('eve', 'eve-oauth', t.decline_sql('eve')) || ' ' || t.run_tok('eve', 'eve-cli', t.decline_sql('eve')),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('agents: anonymous and the MCP server''s role can''t call either',
  t.run(null, t.join_sql('eve')) || ' ' || t.run(null, t.decline_sql('eve'))
  || ' ' || t.run_role('reliquary_mcp', t.join_sql('eve')) || ' ' || t.run_role('reliquary_mcp', t.decline_sql('eve')),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('agents: the helpers aren''t callable by a signed-in person',
  t.run('eve', format($q$select private.take_invite(%L, 'inbox')::text$q$, t.inv('eve'))) || ' '
  || t.run('eve', format($q$select (private.invite_for_me(%L)).id::text$q$, t.inv('eve'))) || ' '
  || t.run('eve', format($q$select private.confirmed_email_of(%L)$q$, t.id('eve'))),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('agents: after all that the invite still waits',
  t.state('eve') || ' ' || t.role_of('team', 'eve'), 'pending none');

-- ---------------------------------------------------------------------------
-- Confirmed addresses only

select t.expect('unconfirmed: an address Auth hasn''t confirmed can''t join or decline from the inbox, and is told to use the link',
  t.msg('fay', t.join_sql('fay')) || ' / ' || t.msg('fay', t.decline_sql('fay')) || ' / ' || t.state('fay'),
  '42501 your account''s email address isn''t confirmed yet, so invites can''t be answered from your inbox: open the invite link you were sent instead / '
  || '42501 your account''s email address isn''t confirmed yet, so invites can''t be answered from your inbox: open the invite link you were sent instead / pending');

-- ---------------------------------------------------------------------------
-- Joining

select t.expect('join: the addressee joins from the inbox (any case) with the invite''s role, and gets the vault''s id',
  t.run('eve', t.join_sql('eve')) || ' ' || t.role_of('team', 'eve'),
  t.id('team')::text || ' editor');
select t.expect('join: the invite is used, the account admitted, and the join logged with ids and the role, never the address',
  t.state('eve') || ' ' || (select via from private.admissions where user_id = t.id('eve'))
  || ' ' || (select count(*) from public.log where vault_id = t.id('team') and event = 'invite.accept'
              and actor = t.id('eve') and agent is null and detail::text not like '%@%'
              and detail = jsonb_build_object('invite', t.inv('eve'), 'role', 'editor', 'via', 'inbox'))::text,
  'accepted invite 1');
select t.expect('join: it leaves my_invites and the inbox count',
  t.run('eve', format($q$select count(*)::text from public.my_invites() where id = %L$q$, t.inv('eve')))
  || ' ' || t.run('eve', $q$select public.shell_summary(5) #>> '{counts,invites}'$q$),
  '0 1');
select t.expect('join: a used invite is refused, by id and by its link',
  t.msg('eve', t.join_sql('eve')) || ' / ' || t.msg('eve', t.decline_sql('eve')) || ' / '
  || t.msg('eve', format($q$select public.accept_invite(%L)::text$q$, t.tk('eve'))),
  '55000 this invite has already been used / 55000 this invite has already been used / 55000 this invite has already been used');

select t.invite('gil-exp', 'team', 'gil@example.test', 'viewer');
update private.vault_invites set expires_at = now() - interval '1 minute' where id = t.inv('gil-exp');
select t.expect('join: an expired invite is refused, and says so',
  t.msg('gil', t.join_sql('gil-exp')) || ' / ' || t.msg('gil', t.decline_sql('gil-exp')) || ' / ' || t.role_of('team', 'gil'),
  '55000 this invite has expired / 55000 this invite has expired / none');

select t.invite('gil-rev', 'deev', 'gil@example.test', 'viewer');
select t.run('dee', format($q$select 'ok' from public.revoke_invite(%L)$q$, t.inv('gil-rev')));
select t.expect('join: a withdrawn invite is refused, and says so',
  t.msg('gil', t.join_sql('gil-rev')) || ' / ' || t.msg('gil', t.decline_sql('gil-rev')) || ' / ' || t.role_of('deev', 'gil'),
  '55000 this invite was withdrawn / 55000 this invite was withdrawn / none');

-- ---------------------------------------------------------------------------
-- Declining

select t.expect('decline: the addressee declines from the inbox and is told the vault''s name',
  t.run('eve', t.decline_sql('eve-dee')) || ' / ' || t.state('eve-dee') || ' / ' || t.role_of('deev', 'eve'),
  'Dee own / revoked declined / none');
select t.expect('decline: the owners'' waiting list and the addressee''s inbox lose it; the vault''s log says so with ids and the role',
  t.run('dee', format($q$select count(*)::text from public.list_invites(%L)$q$, t.id('deev')))
  || ' ' || t.run('eve', format($q$select count(*)::text from public.my_invites() where id = %L$q$, t.inv('eve-dee')))
  || ' ' || (select count(*) from public.log where vault_id = t.id('deev') and event = 'invite.decline'
              and actor = t.id('eve') and agent is null
              and detail = jsonb_build_object('invite', t.inv('eve-dee'), 'role', 'viewer'))::text,
  '0 0 1');
select t.expect('decline: a declined invite can''t be joined, by id or by its link, nor declined twice',
  t.msg('eve', t.join_sql('eve-dee')) || ' / ' || t.msg('eve', format($q$select public.accept_invite(%L)::text$q$, t.tk('eve-dee')))
  || ' / ' || t.msg('eve', t.decline_sql('eve-dee')),
  '55000 you declined this invite: to join, ask an owner of the vault to invite you again / '
  || '55000 you declined this invite: to join, ask an owner of the vault to invite you again / '
  || '55000 you already declined this invite');
select t.expect('decline: the link''s page reads it as declined; an owner can''t revoke it again',
  t.run_role('reliquary_web', format($q$select state from private.invite_peek(%L)$q$, t.tk('eve-dee')))
  || ' ' || t.run('dee', format($q$select 'ok' from public.revoke_invite(%L)$q$, t.inv('eve-dee'))),
  'declined ERR 55000');
select t.invite('eve-dee2', 'deev', 'eve@example.test', 'viewer');
select t.expect('decline: the owner can invite the address again, and that invite can be joined',
  t.run('eve', t.join_sql('eve-dee2')) || ' ' || t.role_of('deev', 'eve'),
  t.id('deev')::text || ' viewer');
select t.owner_error('decline: a declined invite always stays revoked (the table refuses one without the other)',
  $q$update private.vault_invites set declined_at = now() - interval '1 day' where declined_at is not null$q$);

-- ---------------------------------------------------------------------------
-- The people limit

select test_support.add_member(t.id('club'), t.id('ben'), 'editor', t.id('ana'));
select t.invite('hal-club', 'club', 'hal@example.test', 'viewer');
select test_support.add_member(t.id('club'), t.id('cal'), 'viewer', t.id('ana'));
select t.expect('full: joining a full vault from the inbox is refused, saying what to do, and doesn''t use the invite up',
  t.msg('hal', t.join_sql('hal-club')) || ' / ' || t.state('hal-club') || ' ' || t.role_of('club', 'hal'),
  'RLP01 Club is at its 3-person limit on the Tiny tier (3 members): ask an owner to make room, then choose Join in your inbox again / pending none');
select t.expect('full: the invite link still says to open the link again',
  t.msg('hal', format($q$select public.accept_invite(%L)::text$q$, t.tk('hal-club'))),
  'RLP01 Club is at its 3-person limit on the Tiny tier (3 members): ask an owner to make room, then open this link again');
select t.expect('full: declining works in a full vault',
  t.run('hal', t.decline_sql('hal-club')) || ' ' || t.state('hal-club'),
  'Club revoked declined');
