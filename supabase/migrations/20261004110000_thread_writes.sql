-- Opening, posting to, resolving and reopening threads. The tables, and
-- who reads them, are 20261004100000_threads.sql. Nothing in mcp/ or web/
-- calls these yet.
--
-- Who writes: owners and editors, and their agents through a read-write
-- connection, the rule comments on proposals already follow
-- (comment_on_proposal). Viewers and read-only connections read and never
-- write. Attribution is a comment's too: the person from the session, and
-- the agent's name when one acted. No argument names either.
--
-- A message is words, never a decision. Nothing here approves, reveals a
-- value, breaks a claim, cancels or skips a step, or changes anything
-- outside its thread, whatever a message says. An anchor is a reference,
-- and a task or file cited in a message is text as typed: nothing parses
-- either into authority.
--
-- Addressing. A thread with no addressees is vault-wide; one addressed to
-- some members is a side thread. Addressees are fixed when a thread opens:
-- each a member of the vault then (any role: a viewer can be told about a
-- thread they can't post to), at most private.thread_addressees_cap().
-- Addressing will decide whose connections are flagged about a thread
-- (flags are a later change), never who reads it.
--
-- Anchors, at most one: a file path (shaped as a file's would be; the file
-- need not exist yet), a work plan step by its id (shown to people as a
-- task) or a proposal, each in this vault. Another vault's step or
-- proposal is "no such" one, the same answer as one that doesn't exist, so
-- an anchor says nothing about a vault the caller can't read.
--
-- A resolved thread takes no messages until it is reopened. The people
-- who post resolve and reopen: both are reversible and logged, so neither
-- is behind the ceiling.
--
-- Limits refuse with RLP01, a message naming the vault, the limit and the
-- usage, and a DETAIL for programs, as plans and limits do
-- (20260925230000_plans.sql). Threads and messages are never deleted, so
-- nothing but a higher number makes room, and the refusal says so.
--
-- The log records thread.open, thread.post, thread.resolve and
-- thread.reopen with the thread's and message's ids. Never a title or a
-- message's text, so a redacted message leaves nothing in the append-only
-- log. Never the anchor's path or proposal either: list_flags flags a log
-- row's path to whoever watches it and its proposal to that proposal's
-- author, which would tell people about a side thread not addressed to
-- them.
--
-- Lock order. Each function takes the vault's row (for key share) before
-- any thread, proposal or step row, the order delete_vault takes them in
-- (the vault's row for update, then the rest through the cascade). The
-- other way round deadlocks when the two interleave, the bug class
-- 20260925240100_lock_order.sql fixed for invites.

-- Starting points, not settled numbers.
-- People a thread is addressed to: past this, address the whole vault.
create function private.thread_addressees_cap() returns int
language sql immutable set search_path = '' as $$ select 20 $$;
-- Threads in one vault, open and resolved together.
create function private.threads_per_vault_cap() returns int
language sql immutable set search_path = '' as $$ select 1000 $$;
-- Messages in one vault, across its threads, redacted ones included.
create function private.thread_messages_per_vault_cap() returns int
language sql immutable set search_path = '' as $$ select 10000 $$;

-- The refusal at a limit. p_used: the message's length, or the count
-- before this one.
create function private.thread_limit_refusal(p_vault uuid, p_limit text, p_used bigint, p_max bigint)
returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_detail text := jsonb_build_object('limit', p_limit, 'used', p_used, 'max', p_max)::text;
begin
  if p_limit = 'thread_message_size' then
    raise exception 'a thread message is at most % characters, and this one has %: shorten it, or put the long text in a file and cite its path',
        p_max, p_used
      using errcode = 'RLP01', detail = v_detail;
  end if;
  raise exception '% holds %, the most one vault holds for now. They are kept for the record, so nothing frees room: ask the operator for a higher limit with Ask for a bigger plan, on Plan and usage',
      (select v.name from public.vaults v where v.id = p_vault),
      p_max || case p_limit when 'threads' then ' threads' else ' thread messages' end
    using errcode = 'RLP01', detail = v_detail;
end $$;

-- A message's text, or a refusal. Leading blank lines and trailing
-- whitespace go; the first line's indent stays, for code.
create function private.thread_body(p_vault uuid, p_body text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_body text := regexp_replace(coalesce(p_body, ''), '^\s*\n|\s+$', '', 'g');
begin
  if v_body ~ '^\s*$' then
    raise exception 'a message needs some text' using errcode = '22023';
  end if;
  if v_body ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    raise exception 'a message can''t contain control characters other than line breaks and tabs'
      using errcode = '22023';
  end if;
  if length(v_body) > private.thread_message_max_chars() then
    perform private.thread_limit_refusal(p_vault, 'thread_message_size', length(v_body),
      private.thread_message_max_chars());
  end if;
  return v_body;
end $$;

-- Refuses a caller who may not write threads in p_vault, in the order a
-- person can act on: not signed in or a CLI sign-in (require_person), not
-- a member (P0002, p_missing: the answer for a vault or thread that doesn't
-- exist), then a viewer or a read-only connection (42501).
create function private.require_thread_writer(p_vault uuid, p_missing text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_person();
  if p_vault is null or private.role_in(p_vault) is null then
    raise exception '%', p_missing using errcode = 'P0002';
  end if;
  if not private.can_write(p_vault) then
    raise exception 'only editors and owners write in threads, and their agents need a read-write connection; viewers read them'
      using errcode = '42501';
  end if;
end $$;

-- The vault's row, for key share: first, before any other row (see the
-- top of this file). A vault deleted meanwhile is "no such" one.
create function private.lock_thread_vault(p_vault uuid, p_missing text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform 1 from public.vaults where id = p_vault for key share;
  if not found then
    raise exception '%', p_missing using errcode = 'P0002';
  end if;
  -- One thread or message at a time per vault, so two at once can't both
  -- pass a limit.
  perform pg_advisory_xact_lock(hashtextextended('reliquary.threads:' || p_vault::text, 0));
end $$;

-- Refuses a vault with no room for p_threads more threads and one more
-- message.
create function private.require_thread_room(p_vault uuid, p_threads int) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_n bigint;
begin
  if p_threads > 0 then
    select count(*) into v_n from public.threads where vault_id = p_vault;
    if v_n + p_threads > private.threads_per_vault_cap() then
      perform private.thread_limit_refusal(p_vault, 'threads', v_n, private.threads_per_vault_cap());
    end if;
  end if;
  select count(*) into v_n from public.thread_messages where vault_id = p_vault;
  if v_n + 1 > private.thread_messages_per_vault_cap() then
    perform private.thread_limit_refusal(p_vault, 'thread_messages', v_n, private.thread_messages_per_vault_cap());
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Opening and posting

-- Opens a thread with its first message. p_addressees: the members it is
-- addressed to, or null or empty for the whole vault. At most one anchor.
-- Returns the thread's id.
create function public.open_thread(p_vault uuid, p_title text, p_body text,
  p_addressees uuid[] default null, p_anchor_path text default null,
  p_anchor_step bigint default null, p_anchor_proposal uuid default null)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
  v_body text;
  v_to uuid[];
  v_thread uuid;
  v_message bigint;
begin
  perform private.require_thread_writer(p_vault, 'no such vault');
  if v_title = '' then
    raise exception 'a thread needs a title' using errcode = '22023';
  end if;
  if v_title ~ '[[:cntrl:]]' then
    raise exception 'a thread''s title is one line, with no control characters' using errcode = '22023';
  end if;
  if length(v_title) > 200 then
    raise exception 'a thread''s title is at most 200 characters, and this one has %', length(v_title)
      using errcode = '22023';
  end if;
  v_body := private.thread_body(p_vault, p_body);

  if num_nonnulls(p_anchor_path, p_anchor_step, p_anchor_proposal) > 1 then
    raise exception 'a thread is about one thing at most: a path, a task or a proposal' using errcode = '22023';
  end if;
  if p_anchor_path is not null then
    perform private.valid_path(p_anchor_path);
  end if;
  if p_anchor_step is not null
     and not exists (select 1 from public.work_plan_steps s where s.id = p_anchor_step and s.vault_id = p_vault) then
    raise exception 'no such task in this vault' using errcode = 'P0002';
  end if;
  if p_anchor_proposal is not null
     and not exists (select 1 from public.proposals p where p.id = p_anchor_proposal and p.vault_id = p_vault) then
    raise exception 'no such proposal in this vault' using errcode = 'P0002';
  end if;

  if exists (select 1 from unnest(p_addressees) u where u is null) then
    raise exception 'an addressee can''t be empty: name each member by their id' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct u), '{}') into v_to from unnest(p_addressees) u;
  if cardinality(v_to) > private.thread_addressees_cap() then
    raise exception 'a thread is addressed to at most % members; to tell everyone, address no one',
      private.thread_addressees_cap() using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_to) u
              where not exists (select 1 from public.vault_members m where m.vault_id = p_vault and m.user_id = u)) then
    raise exception 'every addressee must be a member of this vault' using errcode = '22023';
  end if;

  perform private.lock_thread_vault(p_vault, 'no such vault');
  perform private.require_thread_room(p_vault, 1);

  insert into public.threads (vault_id, title, anchor_path, anchor_step, anchor_proposal, opened_by, agent)
  values (p_vault, v_title, p_anchor_path, p_anchor_step, p_anchor_proposal, private.uid(), private.agent())
  returning id into v_thread;
  insert into public.thread_addressees (vault_id, thread_id, user_id)
  select p_vault, v_thread, u from unnest(v_to) u;
  insert into public.thread_messages (thread_id, vault_id, author, agent, body)
  values (v_thread, p_vault, private.uid(), private.agent(), v_body)
  returning id into v_message;
  perform private.log_event(p_vault, 'thread.open', null, null, null,
    jsonb_build_object('thread', v_thread, 'message', v_message));
  return v_thread;
end $$;

-- The thread's vault, when the caller may write in it; refused otherwise
-- as no such thread (an outsider) or 42501 (a viewer).
create function private.thread_writer(p_thread uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v_vault uuid;
begin
  perform private.require_person();
  select th.vault_id into v_vault from public.threads th where th.id = p_thread;
  perform private.require_thread_writer(v_vault, 'no such thread');
  return v_vault;
end $$;

-- Adds a message to an open thread. Returns the message's id.
create function public.post_message(p_thread uuid, p_body text)
returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid := private.thread_writer(p_thread);
  v_body text := private.thread_body(v_vault, p_body);
  th public.threads;
  v_message bigint;
begin
  perform private.lock_thread_vault(v_vault, 'no such thread');
  -- For share: a resolve waits for this post, and this post for a resolve.
  select * into th from public.threads where id = p_thread for share;
  if th.id is null then
    raise exception 'no such thread' using errcode = 'P0002';
  end if;
  if th.resolved_at is not null then
    raise exception 'this thread is resolved: reopen it to post again' using errcode = '55000';
  end if;
  perform private.require_thread_room(v_vault, 0);
  insert into public.thread_messages (thread_id, vault_id, author, agent, body)
  values (th.id, v_vault, private.uid(), private.agent(), v_body)
  returning id into v_message;
  perform private.log_event(v_vault, 'thread.post', null, null, null,
    jsonb_build_object('thread', th.id, 'message', v_message));
  return v_message;
end $$;

-- ---------------------------------------------------------------------------
-- Resolving and reopening

create function public.resolve_thread(p_thread uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid := private.thread_writer(p_thread);
  th public.threads;
begin
  perform private.lock_thread_vault(v_vault, 'no such thread');
  select * into th from public.threads where id = p_thread for no key update;
  if th.id is null then
    raise exception 'no such thread' using errcode = 'P0002';
  end if;
  if th.resolved_at is not null then
    raise exception 'this thread is already resolved' using errcode = '55000';
  end if;
  update public.threads set resolved_at = now(), resolved_by = private.uid(), resolved_agent = private.agent()
   where id = th.id;
  perform private.log_event(v_vault, 'thread.resolve', null, null, null, jsonb_build_object('thread', th.id));
end $$;

create function public.reopen_thread(p_thread uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid := private.thread_writer(p_thread);
  th public.threads;
begin
  perform private.lock_thread_vault(v_vault, 'no such thread');
  select * into th from public.threads where id = p_thread for no key update;
  if th.id is null then
    raise exception 'no such thread' using errcode = 'P0002';
  end if;
  if th.resolved_at is null then
    raise exception 'this thread is open already' using errcode = '55000';
  end if;
  update public.threads set resolved_at = null, resolved_by = null, resolved_agent = null
   where id = th.id;
  perform private.log_event(v_vault, 'thread.reopen', null, null, null, jsonb_build_object('thread', th.id));
end $$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.thread_addressees_cap(), private.threads_per_vault_cap(),
  private.thread_messages_per_vault_cap(), private.thread_limit_refusal(uuid, text, bigint, bigint),
  private.thread_body(uuid, text), private.require_thread_writer(uuid, text),
  private.lock_thread_vault(uuid, text), private.require_thread_room(uuid, int), private.thread_writer(uuid)
  from public, anon, authenticated;

revoke all on function public.open_thread(uuid, text, text, uuid[], text, bigint, uuid),
  public.post_message(uuid, text), public.resolve_thread(uuid), public.reopen_thread(uuid)
  from public, anon;
grant execute on function public.open_thread(uuid, text, text, uuid[], text, bigint, uuid),
  public.post_message(uuid, text), public.resolve_thread(uuid), public.reopen_thread(uuid)
  to authenticated;
