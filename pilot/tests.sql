-- Hostile tests for the pilot additions. Run after schema.sql on a fresh
-- database. The spike's tests (spikes/gate/tests.sql) also run against
-- schema.sql; see test.sh. Synthetic fixtures only.

\set ON_ERROR_STOP on

insert into app.members (id, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Ana'),
  ('00000000-0000-0000-0000-0000000000a2', 'Ben'),
  ('00000000-0000-0000-0000-0000000000a3', 'Cal'),
  ('00000000-0000-0000-0000-0000000000a4', 'Dee');

insert into app.spaces (id, name, is_public) values
  ('00000000-0000-0000-0000-0000000000b1', 'team',  false),
  ('00000000-0000-0000-0000-0000000000b2', 'other', false),
  ('00000000-0000-0000-0000-0000000000b3', 'pub',   true);

insert into app.space_members (space_id, member_id, role) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', 'collaborator'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a4', 'viewer'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'owner');

-- Cal (tg:3) starts unlinked
insert into app.identities (channel, external_id, member_id) values
  ('telegram', 'tg:1', '00000000-0000-0000-0000-0000000000a1'),
  ('telegram', 'tg:2', '00000000-0000-0000-0000-0000000000a2'),
  ('telegram', 'tg:4', '00000000-0000-0000-0000-0000000000a4');

insert into app.agent_tokens (id, name, token_hash) values
  ('00000000-0000-0000-0000-0000000000f1', 'bot', encode(digest('secret', 'sha256'), 'hex'));
insert into app.agent_token_spaces (token_id, space_id, can_read, can_capture) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1', true, true),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2', true, false),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b3', true, false);

insert into app.entries (space_id, title, body) values
  ('00000000-0000-0000-0000-0000000000b1', 'team-schedule', 'Standup at 10'),
  ('00000000-0000-0000-0000-0000000000b2', 'other-secret',  'Only Ana knows'),
  ('00000000-0000-0000-0000-0000000000b3', 'pub-info',      'Venue opens at 9');

-- ---------------------------------------------------------------------------
-- Harness

drop schema if exists t cascade;
create schema t;
create table t.results (name text, ok boolean, detail text);

create function t.as_role(p_role text) returns void language sql as
$$ select set_config('role', p_role, true) $$;
create function t.reset_role() returns void language sql as
$$ select set_config('role', 'none', true) $$;

-- A session for (chat, asker), created directly so tests control identity.
create function t.session(p_chat text, p_asker text) returns jsonb
language plpgsql as $$
declare v_chat uuid; v_ticket uuid; v_sid uuid;
begin
  select id into v_chat from app.chats
  where channel = 'telegram' and external_chat_id = p_chat;
  insert into app.message_tickets (token_id, chat_id, asker, message_ref, used_at)
  values ('00000000-0000-0000-0000-0000000000f1', v_chat, p_asker, 'test', now())
  returning id into v_ticket;
  insert into app.sessions (token_id, chat_id, asker, ticket_id)
  values ('00000000-0000-0000-0000-0000000000f1', v_chat, p_asker, v_ticket)
  returning id into v_sid;
  return jsonb_build_object('sid', v_sid);
end $$;

create function t.visible(p_chat text, p_asker text) returns text[]
language plpgsql as $$
declare r text[];
begin
  perform set_config('request.jwt.claims', t.session(p_chat, p_asker)::text, true);
  perform t.as_role('reliquary_agent');
  select coalesce(array_agg(title order by title), '{}') into r from app.entries;
  perform set_config('role', 'none', true);
  return r;
end $$;

create function t.space_names(p_chat text, p_asker text) returns text[]
language plpgsql as $$
declare r text[];
begin
  perform set_config('request.jwt.claims', t.session(p_chat, p_asker)::text, true);
  perform t.as_role('reliquary_agent');
  select coalesce(array_agg(name order by name), '{}') into r from app.spaces;
  perform set_config('role', 'none', true);
  return r;
end $$;

create function t.capture(p_chat text, p_asker text, p_body text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform set_config('request.jwt.claims', t.session(p_chat, p_asker)::text, true);
  perform t.as_role('reliquary_agent');
  v := app.capture_memory(p_body);
  perform set_config('role', 'none', true);
  return v;
end $$;

create function t.explain(p_chat text, p_asker text) returns text
language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claims', t.session(p_chat, p_asker)::text, true);
  perform t.as_role('reliquary_agent');
  select format('%s|%s|%s|%s|%s', mode, coalesce(space, '-'), members, known, unlinked)
    into r from app.explain_chat();
  perform set_config('role', 'none', true);
  return r;
end $$;

-- As the adapter: register a chat, then sync it.
create function t.chat(p_chat text, p_kind text, p_humans text[], p_count int,
                       p_space uuid default null) returns void
language plpgsql as $$
begin
  perform t.as_role('reliquary_adapter');
  perform app.register_chat('telegram', p_chat, p_kind, p_chat,
            '00000000-0000-0000-0000-0000000000f1');
  perform app.sync_chat('telegram', p_chat, p_humans, array['tg:bot'], p_count);
  perform set_config('role', 'none', true);
  -- Binding a group to a space is an admin action, done as the owner.
  update app.chats set space_id = p_space
  where channel = 'telegram' and external_chat_id = p_chat;
end $$;

create function t.expect(p_name text, p_got text[], p_want text[]) returns void
language sql as $$
  insert into t.results values (p_name,
    (select coalesce(array_agg(x order by x), '{}') from unnest(p_got) x)
      = (select coalesce(array_agg(x order by x), '{}') from unnest(p_want) x),
    format('got %s want %s', p_got, p_want))
$$;

create function t.expect_true(p_name text, p_ok boolean, p_detail text default '')
returns void language sql as $$
  insert into t.results values (p_name, coalesce(p_ok, false), p_detail)
$$;

create function t.expect_error(p_name text, p_sql text, p_role text) returns void
language plpgsql as $$
begin
  perform t.as_role(p_role);
  begin
    execute p_sql;
    perform set_config('role', 'none', true);
    insert into t.results values (p_name, false, 'no error raised');
  exception when others then
    perform set_config('role', 'none', true);
    insert into t.results values (p_name, true, sqlerrm);
  end;
end $$;

-- ---------------------------------------------------------------------------
-- Chats. Member counts include the bot, as Telegram's do.

select t.chat('g-team',  'group', array['tg:1', 'tg:2'], 3, '00000000-0000-0000-0000-0000000000b1');
select t.chat('g-lurk',  'group', array['tg:1', 'tg:2'], 4, '00000000-0000-0000-0000-0000000000b1');
select t.chat('g-unbound', 'group', array['tg:1', 'tg:2'], 3, null);
select t.chat('g-wide',  'group', array['tg:1', 'tg:2', 'tg:4'], 4, '00000000-0000-0000-0000-0000000000b1');
select t.chat('g-other', 'group', array['tg:1'], 2, '00000000-0000-0000-0000-0000000000b2');
select t.chat('g-cal',   'group', array['tg:1', 'tg:3'], 3, '00000000-0000-0000-0000-0000000000b1');
select t.chat('dm-1', 'dm', array['tg:1'], null);
select t.chat('dm-2', 'dm', array['tg:2'], null);
select t.chat('dm-4', 'dm', array['tg:4'], null);

-- Completeness (Telegram can't list members)

select t.expect('complete: every member known and linked gives the bound space',
  t.visible('g-team', 'tg:1'), '{team-schedule,pub-info}');
select t.expect('complete: the bot counts toward the total but is not an unlinked human',
  t.visible('g-team', 'tg:2'), '{team-schedule,pub-info}');
select t.expect('incomplete: one member the adapter never saw drops the group to public',
  t.visible('g-lurk', 'tg:1'), '{pub-info}');
select t.expect('unbound: a group no admin has bound sees public only',
  t.visible('g-unbound', 'tg:1'), '{pub-info}');
select t.expect('unlinked: a known but unlinked member (Cal) drops the group to public',
  t.visible('g-cal', 'tg:1'), '{pub-info}');

-- Capture: the database picks space, audience and author

do $$
declare
  v uuid;
  e app.entries;
begin
  v := t.capture('g-team', 'tg:1', 'Offsite moved to Friday');
  select * into e from app.entries where id = v;
  perform t.expect_true('capture: works in a complete, bound group', v is not null);
  perform t.expect_true('capture: audience is exactly the humans present (Ana, Ben)',
    e.audience @> array['00000000-0000-0000-0000-0000000000a1',
                        '00000000-0000-0000-0000-0000000000a2']::uuid[]
    and cardinality(e.audience) = 2, e.audience::text);
  perform t.expect_true('capture: goes to the bound space, as chat memory, by the asker, expiring',
    e.space_id = '00000000-0000-0000-0000-0000000000b1' and e.kind = 'chat_memory'
    and e.author_label = 'Ana' and e.expires_at > now(),
    format('%s %s %s %s', e.space_id, e.kind, e.author_label, e.expires_at));
end $$;

select t.expect('capture: visible back in the group it was said in',
  t.visible('g-team', 'tg:2'), '{team-schedule,pub-info,Offsite moved to Friday}');
select t.expect('capture: visible in the DM of someone who heard it',
  t.visible('dm-2', 'tg:2'), '{team-schedule,pub-info,Offsite moved to Friday}');
select t.expect('capture: not in a group with someone who didn''t hear it (Dee)',
  t.visible('g-wide', 'tg:1'), '{team-schedule,pub-info}');
select t.expect('capture: not in the DM of a space member who wasn''t there',
  t.visible('dm-4', 'tg:4'), '{team-schedule,pub-info}');

select t.expect_true('capture: refused when the group is incomplete',
  t.capture('g-lurk', 'tg:1', 'x') is null);
select t.expect_true('capture: refused in an unbound group',
  t.capture('g-unbound', 'tg:1', 'x') is null);
select t.expect_true('capture: refused in a DM',
  t.capture('dm-1', 'tg:1', 'x') is null);
select t.expect_true('capture: refused where the token lacks can_capture',
  t.capture('g-other', 'tg:1', 'x') is null);
select t.expect_true('capture: refused ones left nothing behind',
  (select count(*) from app.entries where body = 'x') = 0);

update app.entries set expires_at = now() - interval '1 second'
where body = 'Offsite moved to Friday';
select t.expect('capture: expired chat memory disappears',
  t.visible('g-team', 'tg:1'), '{team-schedule,pub-info}');

-- Space names are behind the gate too

select t.expect('spaces: Ben''s DM sees only names of spaces he may read',
  t.space_names('dm-2', 'tg:2'), '{pub,team}');
select t.expect('spaces: Ana''s DM sees hers',
  t.space_names('dm-1', 'tg:1'), '{other,pub,team}');
select t.expect('spaces: a public-mode group sees only public names',
  t.space_names('g-lurk', 'tg:1'), '{pub}');
select t.expect_error('spaces: agent cannot read columns beyond id and name',
  'select is_public from app.spaces', 'reliquary_agent');

-- Explain

select t.expect('explain: complete group reports full, its space and counts',
  array[t.explain('g-team', 'tg:1')], '{full|team|3|3|0}');
select t.expect('explain: incomplete group hides the space name',
  array[t.explain('g-lurk', 'tg:1')], '{public|-|4|3|0}');
select t.expect('explain: counts the unlinked human',
  array[t.explain('g-cal', 'tg:1')], '{public|-|3|3|1}');

-- Linking accounts

insert into app.link_codes (code_hash, member_id) values
  (encode(digest('ABCD1234', 'sha256'), 'hex'), '00000000-0000-0000-0000-0000000000a3'),
  (encode(digest('OLDCODE1', 'sha256'), 'hex'), '00000000-0000-0000-0000-0000000000a3');
update app.link_codes set expires_at = now() - interval '1 second'
where code_hash = encode(digest('OLDCODE1', 'sha256'), 'hex');

do $$
declare ok1 boolean; ok2 boolean; ok3 boolean; ok4 boolean;
begin
  perform t.as_role('reliquary_adapter');
  ok1 := app.link_identity('telegram', 'tg:3', 'wrongcode');
  ok2 := app.link_identity('telegram', 'tg:3', 'OLDCODE1');
  ok3 := app.link_identity('telegram', 'tg:3', ' abcd1234 ');
  ok4 := app.link_identity('telegram', 'tg:99', 'ABCD1234');
  perform set_config('role', 'none', true);
  perform t.expect_true('link: wrong code refused', not ok1);
  perform t.expect_true('link: expired code refused', not ok2);
  perform t.expect_true('link: valid code links (case and spaces forgiven)', ok3);
  perform t.expect_true('link: a used code cannot link a second account', not ok4);
end $$;

select t.expect('link: Cal linked but not in team, so g-cal stays public',
  (select t.visible('g-cal', 'tg:3')), '{pub-info}');
insert into app.space_members (space_id, member_id, role) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a3', 'viewer');
select t.expect('link: ...and sees the team space after being added to it',
  t.visible('g-cal', 'tg:3'), '{team-schedule,pub-info}');

-- Roles

select t.expect_error('roles: agent cannot link identities',
  $q$select app.link_identity('telegram', 'tg:5', 'ABCD1234')$q$, 'reliquary_agent');
select t.expect_error('roles: agent cannot register chats',
  $q$select app.register_chat('telegram', 'x', 'group', 'x', '00000000-0000-0000-0000-0000000000f1')$q$,
  'reliquary_agent');
select t.expect_error('roles: agent cannot sync membership',
  $q$select app.sync_chat('telegram', 'g-team', array['tg:1'], array[]::text[], 2)$q$,
  'reliquary_agent');
select t.expect_error('roles: agent cannot list linked IDs',
  $q$select app.linked_ids('telegram')$q$, 'reliquary_agent');
select t.expect_error('roles: minter cannot capture',
  $q$select app.capture_memory('x')$q$, 'reliquary_minter');
select t.expect_error('roles: adapter cannot capture',
  $q$select app.capture_memory('x')$q$, 'reliquary_adapter');
select t.expect_error('roles: agent cannot read link codes',
  'select * from app.link_codes', 'reliquary_agent');

-- ---------------------------------------------------------------------------

\echo
select case when ok then 'PASS' else 'FAIL' end as result, name,
       case when ok then '' else detail end as detail
from t.results;

do $$
declare n_fail int := (select count(*) from t.results where not ok);
begin
  if n_fail > 0 then
    raise exception '% pilot test(s) failed', n_fail;
  end if;
end $$;
