-- Hostile tests for the audience gate. Run after schema.sql.
-- Fixtures use readable fixed UUIDs; nothing here is real data.

\set ON_ERROR_STOP on

-- Members
insert into app.members (id, display_name) values
  ('00000000-0000-0000-0000-0000000000a1', 'Ana'),
  ('00000000-0000-0000-0000-0000000000a2', 'Ben'),
  ('00000000-0000-0000-0000-0000000000a3', 'Cal'),
  ('00000000-0000-0000-0000-0000000000a4', 'Dee');

-- Spaces
insert into app.spaces (id, name, is_public) values
  ('00000000-0000-0000-0000-0000000000b1', 'eng',  false),
  ('00000000-0000-0000-0000-0000000000b2', 'exec', false),
  ('00000000-0000-0000-0000-0000000000b3', 'pub',  true);

insert into app.space_members (space_id, member_id, role) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a2', 'collaborator'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a3', 'viewer'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'owner'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a4', 'collaborator');

-- Channel identities (tg:eve is deliberately unlinked)
insert into app.identities (channel, external_id, member_id) values
  ('telegram', 'tg:ana', '00000000-0000-0000-0000-0000000000a1'),
  ('telegram', 'tg:ben', '00000000-0000-0000-0000-0000000000a2'),
  ('telegram', 'tg:cal', '00000000-0000-0000-0000-0000000000a3'),
  ('telegram', 'tg:dee', '00000000-0000-0000-0000-0000000000a4');

-- Agent tokens: t1 reads everything, t2 is not granted exec
insert into app.agent_tokens (id, name, token_hash) values
  ('00000000-0000-0000-0000-0000000000f1', 'bot',
   encode(digest('secret-f1', 'sha256'), 'hex')),
  ('00000000-0000-0000-0000-0000000000f2', 'bot-limited',
   encode(digest('secret-f2', 'sha256'), 'hex'));
insert into app.agent_token_spaces (token_id, space_id) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000b3'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000b3');

-- Chats
insert into app.chats (id, channel, external_chat_id, kind, space_id, members_synced_at) values
  ('00000000-0000-0000-0000-0000000000c1', 'telegram', 'g-eng',      'group', '00000000-0000-0000-0000-0000000000b1', now()),
  ('00000000-0000-0000-0000-0000000000c2', 'telegram', 'g-eng-all',  'group', '00000000-0000-0000-0000-0000000000b1', now()),
  ('00000000-0000-0000-0000-0000000000c3', 'telegram', 'g-exec',     'group', '00000000-0000-0000-0000-0000000000b2', now()),
  ('00000000-0000-0000-0000-0000000000c4', 'telegram', 'g-exec-ben', 'group', '00000000-0000-0000-0000-0000000000b2', now()),
  ('00000000-0000-0000-0000-0000000000c5', 'telegram', 'g-eng-eve',  'group', '00000000-0000-0000-0000-0000000000b1', now()),
  ('00000000-0000-0000-0000-0000000000c6', 'telegram', 'g-stale',    'group', '00000000-0000-0000-0000-0000000000b1', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-0000000000c7', 'telegram', 'g-eng-solo', 'group', '00000000-0000-0000-0000-0000000000b1', now()),
  ('00000000-0000-0000-0000-0000000000d1', 'telegram', 'dm-ana',     'dm', null, now()),
  ('00000000-0000-0000-0000-0000000000d2', 'telegram', 'dm-ben',     'dm', null, now()),
  ('00000000-0000-0000-0000-0000000000d4', 'telegram', 'dm-dee',     'dm', null, now()),
  ('00000000-0000-0000-0000-0000000000d5', 'telegram', 'dm-eve',     'dm', null, now());

insert into app.chat_participants (chat_id, external_id) values
  ('00000000-0000-0000-0000-0000000000c1', 'tg:ana'), ('00000000-0000-0000-0000-0000000000c1', 'tg:ben'),
  ('00000000-0000-0000-0000-0000000000c2', 'tg:ana'), ('00000000-0000-0000-0000-0000000000c2', 'tg:ben'),
  ('00000000-0000-0000-0000-0000000000c2', 'tg:cal'),
  ('00000000-0000-0000-0000-0000000000c3', 'tg:ana'), ('00000000-0000-0000-0000-0000000000c3', 'tg:dee'),
  ('00000000-0000-0000-0000-0000000000c4', 'tg:ana'), ('00000000-0000-0000-0000-0000000000c4', 'tg:dee'),
  ('00000000-0000-0000-0000-0000000000c4', 'tg:ben'),
  ('00000000-0000-0000-0000-0000000000c5', 'tg:ana'), ('00000000-0000-0000-0000-0000000000c5', 'tg:eve'),
  ('00000000-0000-0000-0000-0000000000c6', 'tg:ana'), ('00000000-0000-0000-0000-0000000000c6', 'tg:ben'),
  ('00000000-0000-0000-0000-0000000000c7', 'tg:ana'),
  ('00000000-0000-0000-0000-0000000000d1', 'tg:ana'),
  ('00000000-0000-0000-0000-0000000000d2', 'tg:ben'),
  ('00000000-0000-0000-0000-0000000000d4', 'tg:dee'),
  ('00000000-0000-0000-0000-0000000000d5', 'tg:eve');

-- Bot installs: f1 is everywhere, f2 only in Ana's DM
insert into app.chat_bots (chat_id, token_id)
select id, '00000000-0000-0000-0000-0000000000f1' from app.chats;
insert into app.chat_bots (chat_id, token_id) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f2');

-- Entries
insert into app.entries (space_id, title, body, audience) values
  ('00000000-0000-0000-0000-0000000000b1', 'eng-roadmap',       'Q4 roadmap: ship the feed',        null),
  ('00000000-0000-0000-0000-0000000000b2', 'exec-acquisition',  'Talks with Falcon Corp continue',  null),
  ('00000000-0000-0000-0000-0000000000b3', 'pub-wifi-hours',    'Office opens at 9, wifi is guest', null),
  ('00000000-0000-0000-0000-0000000000b1', 'eng-ana-dm-remark', 'Ana said in DM: Ben may be moved', '{00000000-0000-0000-0000-0000000000a1}'),
  ('00000000-0000-0000-0000-0000000000b1', 'eng-chat-remark',   'Said in g-eng: pizza on Friday',   '{00000000-0000-0000-0000-0000000000a1,00000000-0000-0000-0000-0000000000a2}'),
  ('00000000-0000-0000-0000-0000000000b3', 'pub-ana-private',   'Ana told the bot her flight time', '{00000000-0000-0000-0000-0000000000a1}');

-- ---------------------------------------------------------------------------
-- Harness

drop schema if exists t cascade;
create schema t;
create table t.results (name text, ok boolean, detail text);

-- Titles visible to the agent role for the given claims. Runs as invoker, so
-- after set_config('role') the SELECT is subject to RLS.
create function t.visible(p_claims jsonb) returns text[]
language plpgsql as $$
declare r text[];
begin
  perform set_config('request.jwt.claims', coalesce(p_claims::text, ''), true);
  perform set_config('role', 'reliquary_agent', true);
  select coalesce(array_agg(title order by title), '{}') into r from app.entries;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return r;
exception when others then
  perform set_config('role', 'none', true);
  raise;
end $$;

-- Gate tests create sessions directly (bypassing mint) so they can also
-- test sessions mint would refuse, e.g. an asker who isn't in the chat.
create function t.claims(p_token text, p_chat text, p_asker text) returns jsonb
language plpgsql as $$
declare
  v_token uuid := ('00000000-0000-0000-0000-0000000000' || p_token)::uuid;
  v_chat  uuid := ('00000000-0000-0000-0000-0000000000' || p_chat)::uuid;
  v_ticket uuid;
  v_sid uuid;
begin
  insert into app.message_tickets (token_id, chat_id, asker, message_ref, used_at)
  values (v_token, v_chat, p_asker, 'test', now()) returning id into v_ticket;
  insert into app.sessions (token_id, chat_id, asker, ticket_id)
  values (v_token, v_chat, p_asker, v_ticket) returning id into v_sid;
  return jsonb_build_object('sid', v_sid);
end $$;

create function t.sid(p_sid uuid) returns jsonb
language sql as $$ select jsonb_build_object('sid', p_sid) $$;

create function t.expect_true(p_name text, p_ok boolean, p_detail text default '')
returns void language sql as $$
  insert into t.results values (p_name, coalesce(p_ok, false), p_detail)
$$;

-- Calls mint_session as the minter role. NULL when minting is refused.
create function t.mint(p_token text, p_ticket uuid) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform set_config('role', 'reliquary_minter', true);
  select session_id into v from app.mint_session(p_token, p_ticket);
  perform set_config('role', 'none', true);
  return v;
end $$;

-- Calls issue_ticket as the adapter role.
create function t.issue(p_chat text, p_token text, p_sender text) returns uuid
language plpgsql as $$
declare v uuid;
begin
  perform set_config('role', 'reliquary_adapter', true);
  v := app.issue_ticket('telegram', p_chat,
         ('00000000-0000-0000-0000-0000000000' || p_token)::uuid, p_sender, 'msg');
  perform set_config('role', 'none', true);
  return v;
end $$;

create function t.expect(p_name text, p_got text[], p_want text[]) returns void
language sql as $$
  insert into t.results values (
    p_name,
    (select coalesce(array_agg(x order by x), '{}') from unnest(p_got) x)
      = (select coalesce(array_agg(x order by x), '{}') from unnest(p_want) x),
    format('got %s want %s', p_got, p_want))
$$;

-- Runs p_sql as p_role (the agent by default) and records ok if it raises.
create function t.expect_error(p_name text, p_sql text,
  p_role text default 'reliquary_agent') returns void
language plpgsql as $$
begin
  perform set_config('role', p_role, true);
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
-- DMs: the audience is the asker alone

select t.expect('dm: Ana sees everything she is cleared for',
  t.visible(t.claims('f1', 'd1', 'tg:ana')),
  '{eng-roadmap,exec-acquisition,pub-wifi-hours,eng-ana-dm-remark,eng-chat-remark,pub-ana-private}');

select t.expect('dm: Ben sees eng and his group remark, not exec or Ana''s DM remark',
  t.visible(t.claims('f1', 'd2', 'tg:ben')),
  '{eng-roadmap,pub-wifi-hours,eng-chat-remark}');

select t.expect('dm: Dee sees exec, not eng',
  t.visible(t.claims('f1', 'd4', 'tg:dee')),
  '{exec-acquisition,pub-wifi-hours}');

select t.expect('dm: unlinked sender gets public tier only',
  t.visible(t.claims('f1', 'd5', 'tg:eve')),
  '{pub-wifi-hours}');

-- Groups: the audience is everyone in the chat

select t.expect('group: g-eng (Ana, Ben) asked by Ana hides exec and Ana''s DM remark',
  t.visible(t.claims('f1', 'c1', 'tg:ana')),
  '{eng-roadmap,eng-chat-remark,pub-wifi-hours}');

select t.expect('group: same answer whoever asks',
  t.visible(t.claims('f1', 'c1', 'tg:ben')),
  '{eng-roadmap,eng-chat-remark,pub-wifi-hours}');

select t.expect('group: adding Cal hides the remark said only to Ana and Ben',
  t.visible(t.claims('f1', 'c2', 'tg:ana')),
  '{eng-roadmap,pub-wifi-hours}');

select t.expect('group: g-exec (Ana, Dee) sees exec',
  t.visible(t.claims('f1', 'c3', 'tg:ana')),
  '{exec-acquisition,pub-wifi-hours}');

select t.expect('group: one lower-clearance member (Ben) narrows g-exec to public',
  t.visible(t.claims('f1', 'c4', 'tg:ana')),
  '{pub-wifi-hours}');

select t.expect('group: a solo group bound to eng never shows exec, though Ana is cleared for it',
  t.visible(t.claims('f1', 'c7', 'tg:ana')),
  '{eng-roadmap,eng-ana-dm-remark,eng-chat-remark,pub-wifi-hours,pub-ana-private}');

select t.expect('group: an unlinked participant drops the group to public',
  t.visible(t.claims('f1', 'c5', 'tg:ana')),
  '{pub-wifi-hours}');

select t.expect('group: stale membership fails closed to public',
  t.visible(t.claims('f1', 'c6', 'tg:ana')),
  '{pub-wifi-hours}');

-- Forged or missing claims

select t.expect('forged: asker not a participant of the chat sees nothing',
  t.visible(t.claims('f1', 'c1', 'tg:dee')),
  '{}');

select t.expect('forged: Ana''s ID claiming Ben''s DM sees nothing',
  t.visible(t.claims('f1', 'd2', 'tg:ana')),
  '{}');

select t.expect('no claims: nothing',
  t.visible(null), '{}');

select t.expect('empty claims object: nothing',
  t.visible('{}'::jsonb), '{}');

select t.expect('forged: a random session id sees nothing',
  t.visible(t.sid(gen_random_uuid())), '{}');

select t.expect('forged: the old {token, chat, asker} claim shape is ignored',
  t.visible(jsonb_build_object('token', '00000000-0000-0000-0000-0000000000f1',
    'chat', '00000000-0000-0000-0000-0000000000d1', 'asker', 'tg:ana')),
  '{}');

select t.expect('token without exec grant: Ana''s DM loses exec',
  t.visible(t.claims('f2', 'd1', 'tg:ana')),
  '{eng-roadmap,pub-wifi-hours,eng-ana-dm-remark,eng-chat-remark,pub-ana-private}');

-- Forbidden and nonexistent are indistinguishable

do $$
declare
  forbidden uuid := (select id from app.entries where title = 'exec-acquisition');
  n_forbidden int;
  n_missing int;
begin
  perform set_config('request.jwt.claims', t.claims('f1', 'c1', 'tg:ana')::text, true);
  perform set_config('role', 'reliquary_agent', true);
  select count(*) into n_forbidden from app.entries where id = forbidden;
  select count(*) into n_missing from app.entries where id = gen_random_uuid();
  perform set_config('role', 'none', true);
  insert into t.results values ('existence: forbidden id and missing id both return 0 rows',
    n_forbidden = 0 and n_missing = 0, format('forbidden=%s missing=%s', n_forbidden, n_missing));
end $$;

-- The agent role cannot reach around the gate

select t.expect_error('privilege: agent cannot read space_members',
  'select * from app.space_members');
select t.expect_error('privilege: agent cannot read identities',
  'select * from app.identities');
select t.expect_error('privilege: agent cannot read chat_participants',
  'select * from app.chat_participants');
select t.expect_error('privilege: agent cannot insert entries',
  $q$insert into app.entries (space_id, title, body) values ('00000000-0000-0000-0000-0000000000b1', 'x', 'x')$q$);
select t.expect_error('privilege: agent cannot update entries',
  $q$update app.entries set body = 'x'$q$);
select t.expect_error('privilege: agent cannot call audience_mode directly',
  'select app.audience_mode()');
select t.expect_error('privilege: agent cannot disable RLS',
  'alter table app.entries disable row level security');
select set_config('request.jwt.claims', '{"sid":"not-a-uuid"}', false);
select t.expect_error('malformed claims: non-UUID sid raises instead of returning rows',
  'select count(*) from app.entries');
select set_config('request.jwt.claims', '', false);

-- ---------------------------------------------------------------------------
-- Minting: adapter ticket + bot token -> session

-- A third bot for revocation and expiry cases, installed in Ana's DM and g-eng
insert into app.agent_tokens (id, name, token_hash) values
  ('00000000-0000-0000-0000-0000000000f3', 'bot-to-revoke',
   encode(digest('secret-f3', 'sha256'), 'hex')),
  ('00000000-0000-0000-0000-0000000000f4', 'bot-to-expire',
   encode(digest('secret-f4', 'sha256'), 'hex'));
insert into app.agent_token_spaces (token_id, space_id)
select t, s from unnest(array['00000000-0000-0000-0000-0000000000f3',
                              '00000000-0000-0000-0000-0000000000f4']::uuid[]) t,
              unnest(array['00000000-0000-0000-0000-0000000000b1',
                           '00000000-0000-0000-0000-0000000000b3']::uuid[]) s;
insert into app.chat_bots (chat_id, token_id)
select c, t from unnest(array['00000000-0000-0000-0000-0000000000d1',
                              '00000000-0000-0000-0000-0000000000c1']::uuid[]) c,
              unnest(array['00000000-0000-0000-0000-0000000000f3',
                           '00000000-0000-0000-0000-0000000000f4']::uuid[]) t;

do $$
declare
  tk uuid;
  sid uuid;
  sid2 uuid;
begin
  -- Happy path
  tk := t.issue('g-eng', 'f1', 'tg:ana');
  sid := t.mint('secret-f1', tk);
  perform t.expect('mint: token + ticket gives a session that sees g-eng''s view',
    t.visible(t.sid(sid)), '{eng-roadmap,eng-chat-remark,pub-wifi-hours}');

  -- Replay
  perform t.expect_true('mint: a used ticket cannot be replayed',
    t.mint('secret-f1', tk) is null);

  -- Wrong token, then the right one still works (failed attempts don't burn it)
  tk := t.issue('dm-ana', 'f1', 'tg:ana');
  perform t.expect_true('mint: wrong token is refused',
    t.mint('secret-wrong', tk) is null);
  perform t.expect_true('mint: null token is refused',
    t.mint(null, tk) is null);
  perform t.expect_true('mint: after a bad attempt the real bot can still use its ticket',
    t.mint('secret-f1', tk) is not null);

  -- A ticket issued to one bot, presented with another bot's token
  tk := t.issue('dm-ana', 'f1', 'tg:ana');
  perform t.expect_true('mint: ticket issued to bot f1 refused for bot f2',
    t.mint('secret-f2', tk) is null);

  -- Expired ticket
  tk := t.issue('dm-ana', 'f1', 'tg:ana');
  update app.message_tickets set expires_at = now() - interval '1 second' where id = tk;
  perform t.expect_true('mint: expired ticket is refused',
    t.mint('secret-f1', tk) is null);

  -- Unknown ticket
  perform t.expect_true('mint: unknown ticket is refused',
    t.mint('secret-f1', gen_random_uuid()) is null);

  -- Sender not in the chat (adapter bug or spoofed webhook)
  tk := t.issue('g-eng', 'f1', 'tg:dee');
  perform t.expect_true('mint: ticket for a sender outside the chat is refused',
    t.mint('secret-f1', tk) is null);

  -- Revoked token: refused at mint, and kills a live session
  tk := t.issue('dm-ana', 'f3', 'tg:ana');
  sid := t.mint('secret-f3', tk);
  perform t.expect_true('mint: bot f3 gets a session before revocation', sid is not null);
  update app.agent_tokens set revoked_at = now()
  where id = '00000000-0000-0000-0000-0000000000f3';
  perform t.expect('mint: revoking the token empties its live session',
    t.visible(t.sid(sid)), '{}');
  tk := t.issue('dm-ana', 'f3', 'tg:ana');
  perform t.expect_true('mint: revoked token is refused',
    t.mint('secret-f3', tk) is null);

  -- Expired token
  tk := t.issue('dm-ana', 'f4', 'tg:ana');
  sid2 := t.mint('secret-f4', tk);
  update app.agent_tokens set expires_at = now() - interval '1 second'
  where id = '00000000-0000-0000-0000-0000000000f4';
  perform t.expect('mint: an expired token empties its live session',
    t.visible(t.sid(sid2)), '{}');
  update app.agent_tokens set expires_at = null
  where id = '00000000-0000-0000-0000-0000000000f4';

  -- Removing the bot from a chat kills its session there
  tk := t.issue('g-eng', 'f4', 'tg:ana');
  sid := t.mint('secret-f4', tk);
  perform t.expect_true('mint: bot f4 gets a g-eng session', sid is not null);
  delete from app.chat_bots
  where chat_id = '00000000-0000-0000-0000-0000000000c1'
    and token_id = '00000000-0000-0000-0000-0000000000f4';
  perform t.expect('mint: removing the bot from the chat empties its session',
    t.visible(t.sid(sid)), '{}');

  -- Session expiry
  tk := t.issue('dm-ana', 'f1', 'tg:ana');
  sid := t.mint('secret-f1', tk);
  update app.sessions set expires_at = now() - interval '1 second' where id = sid;
  perform t.expect('mint: an expired session sees nothing',
    t.visible(t.sid(sid)), '{}');

  -- Membership sync is live: adapter adds an unlinked user to g-eng
  tk := t.issue('g-eng', 'f1', 'tg:ana');
  sid := t.mint('secret-f1', tk);
  perform set_config('role', 'reliquary_adapter', true);
  perform app.sync_participants('telegram', 'g-eng', array['tg:ana', 'tg:ben', 'tg:eve']);
  perform set_config('role', 'none', true);
  perform t.expect('mint: an unlinked joiner narrows a live session to public',
    t.visible(t.sid(sid)), '{pub-wifi-hours}');
  perform set_config('role', 'reliquary_adapter', true);
  perform app.sync_participants('telegram', 'g-eng', array['tg:ana', 'tg:ben']);
  perform set_config('role', 'none', true);
  perform t.expect('mint: and restoring membership restores it',
    t.visible(t.sid(sid)), '{eng-roadmap,eng-chat-remark,pub-wifi-hours}');
end $$;

-- The adapter can't issue tickets for chats the bot isn't in
select t.expect_error('adapter: cannot issue a ticket for a chat the bot is not in',
  $q$select app.issue_ticket('telegram', 'g-exec',
       '00000000-0000-0000-0000-0000000000f2', 'tg:ana', 'msg')$q$,
  'reliquary_adapter');

-- The mint log explains refusals to the operator, never holds a token
select t.expect_true('mint_log: every refusal cause is recorded',
  (select array_agg(distinct reason order by reason) from app.mint_log where not ok)
    @> array['expired ticket', 'revoked token', 'sender not in chat',
             'ticket issued to another bot', 'ticket replay', 'unknown ticket',
             'unknown token'],
  (select string_agg(distinct reason, ', ') from app.mint_log where not ok));
select t.expect_true('mint_log: no row contains a token value',
  not exists (select 1 from app.mint_log l where l::text like '%secret-%'));

do $$
begin
  begin
    update app.mint_log set reason = 'x';
    perform t.expect_true('mint_log: update is rejected, even for the owner', false);
  exception when others then
    perform t.expect_true('mint_log: update is rejected, even for the owner', true, sqlerrm);
  end;
  begin
    delete from app.mint_log;
    perform t.expect_true('mint_log: delete is rejected, even for the owner', false);
  exception when others then
    perform t.expect_true('mint_log: delete is rejected, even for the owner', true, sqlerrm);
  end;
end $$;

-- Each role can do exactly its job
select t.expect_error('roles: minter cannot read entries',
  'select * from app.entries', 'reliquary_minter');
select t.expect_error('roles: minter cannot read sessions',
  'select * from app.sessions', 'reliquary_minter');
select t.expect_error('roles: minter cannot issue tickets',
  $q$select app.issue_ticket('telegram', 'dm-ana',
       '00000000-0000-0000-0000-0000000000f1', 'tg:ana', 'msg')$q$,
  'reliquary_minter');
select t.expect_error('roles: adapter cannot read entries',
  'select * from app.entries', 'reliquary_adapter');
select t.expect_error('roles: adapter cannot mint sessions',
  $q$select * from app.mint_session('secret-f1', gen_random_uuid())$q$,
  'reliquary_adapter');
select t.expect_error('roles: agent cannot mint sessions',
  $q$select * from app.mint_session('secret-f1', gen_random_uuid())$q$);
select t.expect_error('roles: agent cannot insert a session',
  $q$insert into app.sessions (token_id, chat_id, asker, ticket_id)
     select token_id, chat_id, asker, id from app.message_tickets limit 1$q$);
select t.expect_error('roles: agent cannot read tickets',
  'select * from app.message_tickets');
select t.expect_error('roles: agent cannot read mint_log',
  'select * from app.mint_log');
select t.expect_error('roles: agent cannot read token hashes',
  'select token_hash from app.agent_tokens');

-- Revocation takes effect on the next query, no cache

delete from app.space_members
where space_id = '00000000-0000-0000-0000-0000000000b1'
  and member_id = '00000000-0000-0000-0000-0000000000a2';

select t.expect('revocation: Ben removed from eng loses it on the next query',
  t.visible(t.claims('f1', 'd2', 'tg:ben')),
  '{pub-wifi-hours}');

select t.expect('revocation: g-eng (Ana, Ben) now public-only because Ben left eng',
  t.visible(t.claims('f1', 'c1', 'tg:ana')),
  '{pub-wifi-hours}');

-- ---------------------------------------------------------------------------

\echo
select case when ok then 'PASS' else 'FAIL' end as result, name,
       case when ok then '' else detail end as detail
from t.results;

do $$
declare n_fail int := (select count(*) from t.results where not ok);
begin
  if n_fail > 0 then
    raise exception '% gate test(s) failed', n_fail;
  end if;
end $$;
