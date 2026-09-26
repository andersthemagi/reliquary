-- Hostile tests for a change of email address (web/src/settings.ts asks
-- Supabase Auth; Auth writes auth.users once the new address is confirmed).
-- Reliquary keeps no copy of an address: memberships, roles, connections,
-- admission and plans are the account id's, and invites are matched to the
-- address the account has when one is accepted (private.email_of). So a
-- change grants nothing before it is confirmed, and after it the old
-- address's invites stop matching while the new address's open with their
-- links, as for anyone holding that inbox.
--
-- Ana owns Team (Ben edits) and Old; Eve is a viewer in Side (Dee's) with a
-- token, a display name and an admission, and is changing
-- eve@example.test to eve.new@example.test.

insert into t.ids values ('eve', '00000000-0000-0000-0000-0000000000e5'),
                         ('eve2', '00000000-0000-0000-0000-0000000000e6');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'),
  (t.id('dee'), 'dee@example.test'), (t.id('eve'), 'eve@example.test');
-- Supabase Auth keeps an address waiting for confirmation in its own
-- column; the stub doesn't have it.
alter table auth.users add column email_change varchar(255);

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'old', t.run('ana', $q$select public.create_vault('Old')$q$)::uuid;
insert into t.ids select 'side', t.run('dee', $q$select public.create_vault('Side')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('side'), t.id('eve'), 'viewer', t.id('dee'));
select t.run('eve', $q$select public.create_access_token('eve-laptop', 30)$q$);
select t.run('eve', $q$select public.set_display_name('Eve Ortiz')$q$);
select private.admit(t.id('eve'), 'operator');

create table t.tokens (name text primary key, token text);
insert into t.tokens select 'new', t.run('ana', format($q$select public.create_invite(%L, 'eve.new@example.test', 'editor')$q$, t.id('team')));
insert into t.tokens select 'old', t.run('ana', format($q$select public.create_invite(%L, 'eve@example.test', 'viewer')$q$, t.id('old')));
create function t.tk(p_name text) returns text language sql as $$ select token from t.tokens where name = p_name $$;
create function t.role(p_vault text, p_user text) returns text language sql as $$
  select coalesce((select role from public.vault_members where vault_id = t.id(p_vault) and user_id = t.id(p_user)), 'none')
$$;
create function t.seen_by(p_reader text, p_user text) returns text language sql as $$
  select t.run(p_reader, format($q$select email from public.co_member_people(array[%L]::uuid[])$q$, t.id(p_user)))
$$;

-- ---------------------------------------------------------------------------
-- Waiting for confirmation

update auth.users set email_change = 'eve.new@example.test' where id = t.id('eve');

select t.expect('email change: while it waits for confirmation, invites to the new address are neither listed nor accepted',
  t.run('eve', $q$select coalesce(string_agg(vault_name, ','), 'none') from public.my_invites()$q$) || ' '
  || t.run('eve', format($q$select public.accept_invite(%L)::text$q$, t.tk('new'))) || ' ' || t.role('team', 'eve'),
  'Old ERR 42501 none');
select t.expect('email change: while it waits, co-members and the account itself still see the current address',
  t.seen_by('dee', 'eve') || ' ' || t.run('eve', $q$select public.my_email()$q$),
  'eve@example.test eve@example.test');

-- ---------------------------------------------------------------------------
-- Confirmed: Supabase Auth writes the new address

update auth.users set email = 'eve.new@example.test', email_change = null where id = t.id('eve');

select t.expect('email change: once confirmed, co-members see the new address, in Members too',
  t.seen_by('dee', 'eve') || ' '
  || t.run('dee', format($q$select email from public.list_members(%L) where user_id = %L$q$, t.id('side'), t.id('eve'))),
  'eve.new@example.test eve.new@example.test');
select t.expect('email change: invites made out to the old address stop matching: not listed, and accepting one is refused',
  t.run('eve', $q$select coalesce(string_agg(vault_name, ','), 'none') from public.my_invites()$q$) || ' '
  || t.run('eve', format($q$select public.accept_invite(%L)::text$q$, t.tk('old'))) || ' ' || t.role('old', 'eve'),
  'Team ERR 42501 none');
select t.expect('email change: an invite made out to the new address is accepted with its link',
  (t.run('eve', format($q$select public.accept_invite(%L)::text$q$, t.tk('new'))) = t.id('team')::text)::text || ' ' || t.role('team', 'eve'),
  'true editor');
select t.expect('email change: an agent still can''t accept an invite for its person',
  t.run('eve', format($q$select public.accept_invite(%L)::text$q$, t.tk('old')), 'Claude Code'),
  'ERR 42501');
select t.expect('email change: memberships, roles, connections, admission and display name stay with the account',
  t.role('side', 'eve') || ' '
  || (select count(*)::text from public.access_tokens where user_id = t.id('eve') and revoked_at is null) || ' '
  || t.run('eve', $q$select admitted::text from public.my_admission()$q$) || ' '
  || t.run('dee', format($q$select display_name from public.co_member_people(array[%L]::uuid[])$q$, t.id('eve'))),
  'viewer 1 true Eve Ortiz');
select t.expect('email change: an owner can''t invite the new address into a vault it is now a member of',
  t.run('ana', format($q$select public.create_invite(%L, 'EVE.NEW@example.test', 'viewer')$q$, t.id('team'))),
  'ERR 23505');

-- ---------------------------------------------------------------------------
-- The old address, free again

insert into t.tokens select 'reuse', t.run('dee', format($q$select public.create_invite(%L, 'eve@example.test', 'viewer')$q$, t.id('side')));
insert into auth.users (id, email) values (t.id('eve2'), 'eve@example.test');

select t.expect('email change: a new account with the old address gets the invites made out to it, not the moved account''s place',
  t.run('eve2', $q$select string_agg(vault_name, ',' order by vault_name) from public.my_invites()$q$) || ' '
  || (t.run('eve2', format($q$select public.accept_invite(%L)::text$q$, t.tk('old'))) = t.id('old')::text)::text || ' '
  || t.role('old', 'eve2') || ' ' || t.role('old', 'eve') || ' ' || t.role('team', 'eve2'),
  'Old,Side true viewer none none');
select t.expect('email change: the new account and the moved one stay apart: each sees its own address and memberships only',
  t.run('eve2', $q$select public.my_email()$q$) || ' ' || t.run('eve', $q$select public.my_email()$q$) || ' '
  || t.run('eve2', $q$select count(*)::text from public.vault_members where user_id <> private.uid() and vault_id in (select vault_id from public.vault_members where user_id = private.uid())$q$) || ' '
  || t.role('side', 'eve2'),
  'eve@example.test eve.new@example.test 1 none');
