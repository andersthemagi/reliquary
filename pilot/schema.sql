-- Reliquary pilot schema: the gate spike plus what a live Telegram bot needs.
-- Not a migration; the real schema starts in supabase/migrations/. The spike's
-- hostile tests (spikes/gate/tests.sql) run against this file unchanged.
--
-- Supabase puts the verified JWT payload in request.jwt.claims; this spike
-- sets it with set_config. The only claim the gate reads is sid, a session
-- created by app.mint_session from an agent token plus a message ticket.

create extension if not exists pgcrypto;

create schema if not exists app;

-- The role the bot/agent queries as. No BYPASSRLS, no table grants except
-- SELECT on entries.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'reliquary_agent') then
    create role reliquary_agent nologin;
  end if;
end $$;
grant usage on schema app to reliquary_agent;

create table app.spaces (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  is_public boolean not null default false
);

create table app.members (
  id           uuid primary key default gen_random_uuid(),
  display_name text not null
);

create table app.space_members (
  space_id  uuid not null references app.spaces on delete cascade,
  member_id uuid not null references app.members on delete cascade,
  role      text not null check (role in ('owner', 'collaborator', 'viewer')),
  primary key (space_id, member_id)
);
create index on app.space_members (member_id);

-- Verified channel sender IDs mapped to members.
create table app.identities (
  channel     text not null,
  external_id text not null,
  member_id   uuid not null references app.members on delete cascade,
  primary key (channel, external_id)
);

-- A chat the bot is in. Groups are bound to one space by an admin; until then
-- they see public spaces only. DMs are not bound.
create table app.chats (
  id                uuid primary key default gen_random_uuid(),
  channel           text not null,
  external_chat_id  text not null,
  kind              text not null check (kind in ('group', 'dm')),
  space_id          uuid references app.spaces on delete set null,
  members_synced_at timestamptz not null default now(),
  -- Set by channels that can't list members (Telegram): the platform's own
  -- member count. The gate only trusts the participant list when it
  -- accounts for every member. NULL for channels that give full lists.
  reported_member_count int,
  title             text,
  unique (channel, external_chat_id)
);

-- Who can read replies in a chat, as raw channel IDs. Some may be unlinked.
-- Maintained from the channel's membership events.
create table app.chat_participants (
  chat_id     uuid not null references app.chats on delete cascade,
  external_id text not null,
  -- Bots never read another bot's messages on Telegram, so they count toward
  -- completeness but not toward the audience.
  is_bot      boolean not null default false,
  primary key (chat_id, external_id)
);

-- Agent tokens are random, high-entropy strings shown once; only the SHA-256
-- is stored.
create table app.agent_tokens (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  token_hash text not null unique,
  expires_at timestamptz,
  revoked_at timestamptz
);

create table app.agent_token_spaces (
  token_id uuid not null references app.agent_tokens on delete cascade,
  space_id uuid not null references app.spaces on delete cascade,
  can_read boolean not null default true,
  -- May record chat memory into this space.
  can_capture boolean not null default false,
  primary key (token_id, space_id)
);

-- audience: members the entry was said to. NULL means the whole space.
-- An audience A may read an entry only if A is a subset of entry.audience.
-- kind: 'canon' (approved by a person) or 'chat_memory' (said in a chat,
-- attributed, expires).
create table app.entries (
  id       uuid primary key default gen_random_uuid(),
  space_id uuid not null references app.spaces on delete cascade,
  title    text not null,
  body     text not null,
  audience uuid[],
  kind         text not null default 'canon'
                 check (kind in ('canon', 'chat_memory')),
  author_id    uuid references app.members on delete set null,
  author_label text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  tsv      tsvector generated always as
             (to_tsvector('simple', title || ' ' || body)) stored,
  check (audience is null or cardinality(audience) > 0)
);
create index on app.entries (space_id);
create index on app.entries using gin (audience);
create index on app.entries using gin (tsv);

-- Which bots are installed in which chats. A bot can only mint sessions for
-- chats it is in.
create table app.chat_bots (
  chat_id  uuid not null references app.chats on delete cascade,
  token_id uuid not null references app.agent_tokens on delete cascade,
  primary key (chat_id, token_id)
);

-- Issued by the channel adapter after it verifies the platform's webhook
-- signature. Binds one incoming message to (bot, chat, sender). Single use,
-- short-lived.
create table app.message_tickets (
  id          uuid primary key default gen_random_uuid(),
  token_id    uuid not null references app.agent_tokens on delete cascade,
  chat_id     uuid not null references app.chats on delete cascade,
  asker       text not null,
  message_ref text not null,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '2 minutes',
  used_at     timestamptz
);

-- A session pins identity (bot, chat, asker) for a few minutes. It does not
-- snapshot access: the gate resolves membership live on every query, so
-- revocation is immediate. The JWT carries only the session id.
create table app.sessions (
  id         uuid primary key default gen_random_uuid(),
  token_id   uuid not null references app.agent_tokens on delete cascade,
  chat_id    uuid not null references app.chats on delete cascade,
  asker      text not null,
  ticket_id  uuid not null unique references app.message_tickets,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 minutes'
);

-- Append-only record of every mint attempt. Never holds the token itself.
create table app.mint_log (
  seq       bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  ok        boolean not null,
  reason    text not null,
  token_id  uuid,
  ticket_id uuid,
  session_id uuid
);

create or replace function app.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;

create trigger mint_log_append_only
  before update or delete on app.mint_log
  for each row execute function app.forbid_change();
create trigger mint_log_no_truncate
  before truncate on app.mint_log
  for each statement execute function app.forbid_change();

-- ---------------------------------------------------------------------------
-- Claims and audience resolution. SECURITY DEFINER so the agent role never
-- reads membership tables directly. All fail closed: missing or malformed
-- claims resolve to nothing.

create or replace function app.claims() returns jsonb
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;

-- The session named by the JWT's sid, only while it, its token and the bot's
-- place in the chat are all still valid.
create or replace function app.current_session() returns app.sessions
language sql stable security definer set search_path = '' as $$
  select s.*
  from app.sessions s
  join app.agent_tokens t
    on t.id = s.token_id
   and t.revoked_at is null
   and (t.expires_at is null or t.expires_at > now())
  join app.chat_bots b
    on b.chat_id = s.chat_id and b.token_id = s.token_id
  where s.id = (app.claims() ->> 'sid')::uuid
    and s.expires_at > now()
$$;

-- The session's chat, only if the asker is still a participant in it.
create or replace function app.current_chat() returns app.chats
language sql stable security definer set search_path = '' as $$
  with s as (select * from app.current_session())
  select c.*
  from s
  join app.chats c on c.id = s.chat_id
  join app.chat_participants p
    on p.chat_id = c.id and p.external_id = s.asker
$$;

-- 'full'   every participant is known and linked, and membership is fresh
-- 'public' someone is unknown or unlinked, or membership may be stale
-- 'none'   no valid claims / asker not in chat
create or replace function app.audience_mode() returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  c app.chats;
begin
  c := app.current_chat();
  if c.id is null then
    return 'none';
  end if;
  if c.members_synced_at < now() - interval '10 minutes' then
    return 'public';
  end if;
  if c.reported_member_count is not null
     and (select count(*) from app.chat_participants p where p.chat_id = c.id)
         < c.reported_member_count then
    return 'public';
  end if;
  if exists (
    select 1 from app.chat_participants p
    left join app.identities i
      on i.channel = c.channel and i.external_id = p.external_id
    where p.chat_id = c.id and not p.is_bot and i.member_id is null
  ) then
    return 'public';
  end if;
  return 'full';
end $$;

-- Member IDs of everyone who will read the reply. In 'public' mode returns a
-- sentinel that no entry audience contains, so only audience-NULL entries in
-- public spaces pass. NULL (matches nothing) in 'none' mode.
create or replace function app.audience_member_ids() returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  c    app.chats;
  mode text := app.audience_mode();
  ids  uuid[];
begin
  if mode = 'none' then
    return null;
  elsif mode = 'public' then
    return array['00000000-0000-0000-0000-000000000000'::uuid];
  end if;
  c := app.current_chat();
  select array_agg(distinct i.member_id) into ids
  from app.chat_participants p
  join app.identities i
    on i.channel = c.channel and i.external_id = p.external_id
  where p.chat_id = c.id;
  return ids;
end $$;

-- Spaces this token may read on behalf of this audience:
--   token has read on the space, and
--   (full mode) every audience member belongs to it, or it is public;
--   (public mode) it is public;
--   and for a group chat, it is the chat's bound space or a public one.
create or replace function app.readable_spaces() returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  c    app.chats;
  mode text := app.audience_mode();
  aud  uuid[];
  out  uuid[];
begin
  if mode = 'none' then
    return '{}';
  end if;
  c := app.current_chat();
  aud := app.audience_member_ids();
  select coalesce(array_agg(s.id), '{}') into out
  from app.spaces s
  join app.agent_token_spaces t
    on t.space_id = s.id and t.can_read
   and t.token_id = (app.current_session()).token_id
  where (c.kind = 'dm' or s.id = c.space_id or s.is_public)
    and (
      s.is_public
      or (mode = 'full' and not exists (
            select 1 from unnest(aud) m(id)
            where not exists (
              select 1 from app.space_members sm
              where sm.space_id = s.id and sm.member_id = m.id)))
    );
  return out;
end $$;

-- ---------------------------------------------------------------------------
-- Minting. Two more roles, each able to call exactly its own functions:
--   reliquary_adapter  the channel adapter, after verifying a platform
--                      webhook signature: issues tickets, syncs membership
--   reliquary_minter   the API endpoint a bot calls: token + ticket -> session
-- Neither can read entries.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'reliquary_adapter') then
    create role reliquary_adapter nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'reliquary_minter') then
    create role reliquary_minter nologin;
  end if;
end $$;
grant usage on schema app to reliquary_adapter, reliquary_minter;

create or replace function app.issue_ticket(
  p_channel text, p_external_chat_id text, p_token_id uuid,
  p_sender text, p_message_ref text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_chat uuid;
  v_ticket uuid;
begin
  select c.id into v_chat
  from app.chats c
  join app.chat_bots b on b.chat_id = c.id and b.token_id = p_token_id
  where c.channel = p_channel and c.external_chat_id = p_external_chat_id;
  if v_chat is null then
    raise exception 'bot is not installed in this chat';
  end if;
  insert into app.message_tickets (token_id, chat_id, asker, message_ref)
  values (p_token_id, v_chat, p_sender, p_message_ref)
  returning id into v_ticket;
  return v_ticket;
end $$;

create or replace function app.sync_participants(
  p_channel text, p_external_chat_id text, p_external_ids text[])
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_chat uuid;
begin
  select id into v_chat from app.chats
  where channel = p_channel and external_chat_id = p_external_chat_id
  for update;
  if v_chat is null then
    raise exception 'unknown chat';
  end if;
  delete from app.chat_participants where chat_id = v_chat;
  insert into app.chat_participants (chat_id, external_id)
  select v_chat, x from unnest(p_external_ids) x;
  update app.chats set members_synced_at = now() where id = v_chat;
end $$;

-- Every failure returns zero rows, whatever the cause, so callers can't
-- probe which part was wrong. The cause goes to mint_log for the operator.
create or replace function app.mint_session(p_token text, p_ticket uuid)
returns table (session_id uuid, expires_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  tok    app.agent_tokens;
  tk     app.message_tickets;
  reason text;
  s      app.sessions;
begin
  select * into tok from app.agent_tokens
  where token_hash = encode(public.digest(coalesce(p_token, ''), 'sha256'), 'hex');

  if tok.id is null then
    reason := 'unknown token';
  elsif tok.revoked_at is not null then
    reason := 'revoked token';
  elsif tok.expires_at is not null and tok.expires_at <= now() then
    reason := 'expired token';
  else
    select * into tk from app.message_tickets where id = p_ticket for update;
    if tk.id is null then
      reason := 'unknown ticket';
    elsif tk.token_id <> tok.id then
      reason := 'ticket issued to another bot';
    elsif tk.used_at is not null then
      reason := 'ticket replay';
    elsif tk.expires_at <= now() then
      reason := 'expired ticket';
    elsif not exists (select 1 from app.chat_bots b
                      where b.chat_id = tk.chat_id and b.token_id = tok.id) then
      reason := 'bot no longer in chat';
    elsif not exists (select 1 from app.chat_participants p
                      where p.chat_id = tk.chat_id and p.external_id = tk.asker) then
      reason := 'sender not in chat';
    end if;
  end if;

  if reason is not null then
    insert into app.mint_log (ok, reason, token_id, ticket_id)
    values (false, reason, tok.id, p_ticket);
    return;
  end if;

  update app.message_tickets set used_at = now() where id = tk.id;
  insert into app.sessions (token_id, chat_id, asker, ticket_id)
  values (tok.id, tk.chat_id, tk.asker, tk.id)
  returning * into s;
  insert into app.mint_log (ok, reason, token_id, ticket_id, session_id)
  values (true, 'ok', tok.id, tk.id, s.id);

  return query select s.id, s.expires_at;
end $$;

revoke all on all functions in schema app from public;
grant execute on function app.claims(), app.readable_spaces(),
  app.audience_member_ids() to reliquary_agent;
grant execute on function app.issue_ticket(text, text, uuid, text, text),
  app.sync_participants(text, text, text[]) to reliquary_adapter;
grant execute on function app.mint_session(text, uuid) to reliquary_minter;

-- ---------------------------------------------------------------------------
-- The gate. The (select ...) wrappers make Postgres evaluate each helper once
-- per query (an initPlan), not once per row.

alter table app.entries enable row level security;
alter table app.entries force row level security;

create policy entries_audience_gate on app.entries
  for select to reliquary_agent
  using (
    space_id = any ((select app.readable_spaces())::uuid[])
    and (
      audience is null
      or audience @> (select app.audience_member_ids())
    )
    and (expires_at is null or expires_at > now())
  );

grant select on app.entries to reliquary_agent;

-- ===========================================================================
-- Pilot additions

-- Space names, readable only for spaces the current audience may read.
alter table app.spaces enable row level security;
alter table app.spaces force row level security;
create policy spaces_gate on app.spaces
  for select to reliquary_agent
  using (id = any ((select app.readable_spaces())::uuid[]));
grant select (id, name) on app.spaces to reliquary_agent;

-- The adapter registers each chat it sees and installs its bot in it.
create or replace function app.register_chat(
  p_channel text, p_external_chat_id text, p_kind text, p_title text,
  p_token_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_chat uuid;
begin
  insert into app.chats (channel, external_chat_id, kind, title, members_synced_at)
  values (p_channel, p_external_chat_id, p_kind, p_title, '-infinity')
  on conflict (channel, external_chat_id)
    do update set title = excluded.title
  returning id into v_chat;
  insert into app.chat_bots (chat_id, token_id) values (v_chat, p_token_id)
  on conflict do nothing;
  return v_chat;
end $$;

-- Replace a chat's participant list from what the adapter verified with the
-- platform. p_member_count is the platform's count (NULL if the channel lists
-- members fully).
create or replace function app.sync_chat(
  p_channel text, p_external_chat_id text,
  p_humans text[], p_bots text[], p_member_count int)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_chat uuid;
begin
  select id into v_chat from app.chats
  where channel = p_channel and external_chat_id = p_external_chat_id
  for update;
  if v_chat is null then
    raise exception 'unknown chat';
  end if;
  delete from app.chat_participants where chat_id = v_chat;
  insert into app.chat_participants (chat_id, external_id, is_bot)
  select v_chat, x, false from unnest(p_humans) x
  union
  select v_chat, x, true from unnest(p_bots) x;
  update app.chats
  set members_synced_at = now(), reported_member_count = p_member_count
  where id = v_chat;
end $$;

-- Linked channel IDs the adapter should check for presence in a chat.
create or replace function app.linked_ids(p_channel text) returns setof text
language sql stable security definer set search_path = '' as $$
  select external_id from app.identities where channel = p_channel
$$;

-- One-time codes an admin gives a person to link their chat account.
create table app.link_codes (
  code_hash  text primary key,
  member_id  uuid not null references app.members on delete cascade,
  expires_at timestamptz not null default now() + interval '24 hours',
  used_at    timestamptz
);

-- Called by the adapter with a sender ID it got from the platform, never from
-- message text. Returns false for any bad, used or expired code.
create or replace function app.link_identity(
  p_channel text, p_external_id text, p_code text)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_member uuid;
begin
  update app.link_codes
  set used_at = now()
  where code_hash = encode(public.digest(upper(trim(coalesce(p_code, ''))), 'sha256'), 'hex')
    and used_at is null
    and expires_at > now()
  returning member_id into v_member;
  if v_member is null then
    return false;
  end if;
  insert into app.identities (channel, external_id, member_id)
  values (p_channel, p_external_id, v_member)
  on conflict (channel, external_id) do update set member_id = excluded.member_id;
  return true;
end $$;

-- Record something said in a group as chat memory. The database, not the
-- bot, decides the space (the chat's bound space), the audience (everyone
-- in the chat now) and the author (the asker). Only in 'full' mode: if we
-- don't know who heard it, we can't scope it.
create or replace function app.capture_memory(p_body text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  s    app.sessions := app.current_session();
  c    app.chats := app.current_chat();
  v_author uuid;
  v_label  text;
  v_id     uuid;
begin
  if c.id is null or c.kind <> 'group' or c.space_id is null then
    return null;
  end if;
  if app.audience_mode() <> 'full' then
    return null;
  end if;
  if not exists (select 1 from app.agent_token_spaces t
                 where t.token_id = s.token_id and t.space_id = c.space_id
                   and t.can_read and t.can_capture) then
    return null;
  end if;
  if not c.space_id = any (app.readable_spaces()) then
    return null;
  end if;
  select i.member_id, m.display_name into v_author, v_label
  from app.identities i join app.members m on m.id = i.member_id
  where i.channel = c.channel and i.external_id = s.asker;

  insert into app.entries (space_id, title, body, audience, kind,
                           author_id, author_label, expires_at)
  values (c.space_id, left(p_body, 60), p_body, app.audience_member_ids(),
          'chat_memory', v_author, v_label, now() + interval '30 days')
  returning id into v_id;
  return v_id;
end $$;

-- What the gate currently allows in this chat, in words people can act on.
-- Counts only, never IDs or names.
create or replace function app.explain_chat()
returns table (mode text, space text, members int, known int, unlinked int,
               synced_minutes_ago int)
language plpgsql stable security definer set search_path = '' as $$
declare
  c app.chats := app.current_chat();
begin
  if c.id is null then
    return;
  end if;
  -- The bound space's name only when everyone here may read it.
  return query
  select app.audience_mode(),
         case when app.audience_mode() = 'full'
              then (select name from app.spaces where id = c.space_id) end,
         c.reported_member_count,
         (select count(*)::int from app.chat_participants p where p.chat_id = c.id),
         (select count(*)::int from app.chat_participants p
          left join app.identities i
            on i.channel = c.channel and i.external_id = p.external_id
          where p.chat_id = c.id and not p.is_bot and i.member_id is null),
         (extract(epoch from now() - c.members_synced_at) / 60)::int;
end $$;

revoke all on all functions in schema app from public;
grant execute on function app.claims(), app.readable_spaces(),
  app.audience_member_ids(), app.capture_memory(text), app.explain_chat()
  to reliquary_agent;
grant execute on function app.issue_ticket(text, text, uuid, text, text),
  app.sync_participants(text, text, text[]),
  app.register_chat(text, text, text, text, uuid),
  app.sync_chat(text, text, text[], text[], int),
  app.linked_ids(text),
  app.link_identity(text, text, text) to reliquary_adapter;
grant execute on function app.mint_session(text, uuid) to reliquary_minter;
