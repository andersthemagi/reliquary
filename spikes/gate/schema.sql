-- Gate spike: audience-aware read access enforced by RLS.
-- Throwaway. Not a migration. See README.md.
--
-- Supabase puts the verified JWT payload in request.jwt.claims; this spike
-- sets it with set_config. In the real system a minting function builds the
-- claims after checking the agent token hash, and the JWT is signed.

create extension if not exists pgcrypto;

drop schema if exists app cascade;
create schema app;

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

-- A chat the bot is in. Groups are bound to one space; DMs are not.
create table app.chats (
  id                uuid primary key default gen_random_uuid(),
  channel           text not null,
  external_chat_id  text not null,
  kind              text not null check (kind in ('group', 'dm')),
  space_id          uuid references app.spaces on delete set null,
  members_synced_at timestamptz not null default now(),
  unique (channel, external_chat_id),
  check (kind = 'dm' or space_id is not null)
);

-- Who can read replies in a chat, as raw channel IDs. Some may be unlinked.
-- Maintained from the channel's membership events.
create table app.chat_participants (
  chat_id     uuid not null references app.chats on delete cascade,
  external_id text not null,
  primary key (chat_id, external_id)
);

create table app.agent_tokens (
  id   uuid primary key default gen_random_uuid(),
  name text not null
);

create table app.agent_token_spaces (
  token_id uuid not null references app.agent_tokens on delete cascade,
  space_id uuid not null references app.spaces on delete cascade,
  can_read boolean not null default true,
  primary key (token_id, space_id)
);

-- audience: members the entry was said to. NULL means the whole space.
-- An audience A may read an entry only if A is a subset of entry.audience.
create table app.entries (
  id       uuid primary key default gen_random_uuid(),
  space_id uuid not null references app.spaces on delete cascade,
  title    text not null,
  body     text not null,
  audience uuid[],
  tsv      tsvector generated always as
             (to_tsvector('simple', title || ' ' || body)) stored,
  check (audience is null or cardinality(audience) > 0)
);
create index on app.entries (space_id);
create index on app.entries using gin (audience);
create index on app.entries using gin (tsv);

-- ---------------------------------------------------------------------------
-- Claims and audience resolution. SECURITY DEFINER so the agent role never
-- reads membership tables directly. All fail closed: missing or malformed
-- claims resolve to nothing.

create or replace function app.claims() returns jsonb
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;

-- The chat the claims point at, only if the asker is a participant in it.
create or replace function app.current_chat() returns app.chats
language sql stable security definer set search_path = '' as $$
  select c.*
  from app.chats c
  join app.chat_participants p
    on p.chat_id = c.id and p.external_id = app.claims() ->> 'asker'
  where c.id = (app.claims() ->> 'chat')::uuid
$$;

-- 'full'   every participant is linked and membership is fresh
-- 'public' someone is unlinked, or membership may be stale
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
  if exists (
    select 1 from app.chat_participants p
    left join app.identities i
      on i.channel = c.channel and i.external_id = p.external_id
    where p.chat_id = c.id and i.member_id is null
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
   and t.token_id = (app.claims() ->> 'token')::uuid
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

revoke all on all functions in schema app from public;
grant execute on function app.claims(), app.readable_spaces(),
  app.audience_member_ids() to reliquary_agent;

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
  );

grant select on app.entries to reliquary_agent;
