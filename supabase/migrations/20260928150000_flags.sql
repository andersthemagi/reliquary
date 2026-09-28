-- Flags (docs/design.md, "Notifications", the 2026-09-28 addendum): what
-- changed in a vault that someone hasn't been told about yet. Agents reach
-- Reliquary over MCP, which has no push, so "notified" means flagged on the
-- agent's next call. The word is "flag", not "notify": a routine's notify:
-- is an outbound send, this is inbound to the caller (design.md, "Not
-- 'notify'"). Path ownership and notifications ride alongside milestone 3
-- on the owner's call (2026-09-28); neither is part of milestone 3's exit.
--
-- This migration is the schema and SQL-callable functions only, the way
-- create_link existed before any surface called it: nothing in mcp/ or web/
-- calls these yet.
-- - public.flag_watermarks: per identity and vault, the last log
--   seq that identity has been shown flags through.
-- - public.subscriptions: the paths a person chose to watch.
-- - public.list_flags(vault, limit): categories 2, 3 and 4 of the design's
--   four, read only. It never moves a watermark.
-- - public.advance_flags(vault, through): moves the caller's own watermark,
--   a separate, explicit call. design.md: the watermark advances when a flag
--   is actually shown in a response, not on request, so a call that fails
--   or a response a client discards loses nothing.
-- - public.create_subscription / public.delete_subscription: the person's
--   own, in person.
--
-- Deliberately not built:
-- - Category 1, direct address (addressed notes, a to: field). design.md
--   doesn't say how to: is stored (a file field, frontmatter, a log entry's
--   detail), so there is nothing concrete to match yet.
-- - Staleness for files you read. Nothing logs a read (read_file,
--   list_files and changes_since are plain selects), and design.md says to
--   reuse what is logged rather than add tracking. So category 2 covers only
--   your own proposals that changed under you. design.md's third open
--   question (does re-reading clear a file's flag?) waits with it.
-- - Flags in every MCP response or in a tool of their own (design.md's
--   second open question): no MCP tool calls this yet.
-- - An agent creating a subscription (design.md's first open question).
--   This takes the established, safer answer, the same as variables and
--   rules: the person, in person. Agents list them.
-- - Tag subscriptions. Files carry no tags yet (design.md's data model names
--   a tags column; no migration adds one), so create_subscription refuses
--   kind 'tag' rather than store one that could never match. The table
--   allows the kind, for when tags exist.
-- - Path owners in category 3. Path ownership (design.md, built separately)
--   will narrow "waiting on you" to a path's named owners. Until it lands,
--   the review set here is shell_summary's exactly, and it should follow
--   shell_summary when that changes.
--
-- Identity. A watermark belongs to (person, vault, connection). token_id is
-- the connection's access token (private.token_id(): the act.tok claim that
-- private.mcp_begin sets on every MCP request, for a token or an OAuth
-- grant alike), or null for the person in the web app. design.md sketched
-- identity_kind plus identity_id. A null token already says "the person",
-- and a real foreign key to access_tokens does what a bare identity_id
-- couldn't: a deleted connection takes its watermark with it. So there is no
-- kind column; the same facts have fewer ways to disagree. A person and each
-- of their connections keep separate watermarks, so one agent being shown a
-- flag doesn't silence it for its person or their other agents. An agent
-- with no connection token is refused rather than given its person's
-- watermark. None exists in production, since mcp_begin always sets act.tok.
--
-- Access, enforced here:
-- - Flags and watermarks: any member (owner, editor or viewer), as the
--   person in the web app or through any connection that reaches the vault
--   (read-only ones too: a watermark is the connection's own bookkeeping,
--   not a write to the vault). An outsider, a connection scoped to other
--   vaults and a revoked one get "no such vault" (P0002); a session without
--   a person 28000; a CLI sign-in and an agent without a connection 42501;
--   anonymous callers can't execute the functions at all. Each
--   caller reads and moves only its own watermark: no argument names an
--   identity, and nobody reads or writes the table directly.
-- - Subscriptions: any member, as the person in person
--   (private.require_human). Agents, tokens and OAuth grants are refused
--   (42501); outsiders get "no such vault". The person and their agents list
--   them (RLS, own rows in readable vaults). At most private.subscription_cap()
--   per person per vault. A subscription, like a snooze, is the person's own
--   and not a change to the vault, so it isn't logged in the vault's
--   Activity, where every member would see who watches what.
--
-- Both tables reference vault_members(vault_id, user_id) with on delete
-- cascade: leaving a vault, being removed, deleting the account and
-- deleting the vault all take a person's subscriptions and watermarks with
-- them. A role change is an update, which leaves them alone. Neither table is
-- append-only (a watermark moves, a subscription can be removed), so
-- link_calls' trap doesn't arise here: there, a cascading foreign key into an
-- append-only table would block deleting the row it pointed at. Here the
-- cascades are the point.
--
-- What list_flags returns, oldest first, one row per log seq:
-- - responsibility / review: an open proposal waiting on the caller's
--   person. The predicate is shell_summary's review set, word for word: a
--   vault owner or editor, who hasn't decided at this revision, and hasn't
--   snoozed it. Raised by the latest event that opened, revised, edited or
--   commented on the proposal, when that event isn't the caller's own.
-- - working_set / proposal: an event on one of the person's own proposals (a
--   comment, a decision, an edit, going stale, being applied) that the
--   caller didn't make.
-- - working_set / base_changed: someone else wrote, deleted or erased the
--   file one of the person's pending proposals would change, after that
--   proposal was opened. The proposal's base is then gone, so approving it
--   makes it stale.
-- - subscription / path: an event on a watched path that the caller didn't
--   make. A folder (ending in /) matches everything under it, a file only
--   itself.
-- "The caller made it" means the log row's actor is the person and its agent
-- is the caller's: null for the person in the web app, the connection's
-- name for an agent. The log records a connection's name, not its token, so
-- two connections of one person with the same name count as one here.
-- Only what's past the watermark (0 when there's no row) is returned. An
-- event (working_set, subscription) also counts only from when the identity
-- began: a connection from its creation, a person from joining the vault, a
-- subscription from its creation. A new connection isn't handed the vault's
-- history, but it is told about a proposal waiting on its person, since that
-- is true now. When one event raises several flags, one row is returned:
-- responsibility first, then working_set, then subscription.
-- `through` is the seq everything up to which the response covered: the
-- vault's latest entry, or the last flag returned when `more` is true. A
-- caller shows the flags, then passes it to advance_flags. With no flags it
-- still advances, so the next read doesn't rescan the same log.
-- Known gap, left as it is: a snooze that runs out on its own brings a
-- proposal back to the Inbox but doesn't flag it again until something new
-- happens on it, since nothing is logged when a snooze ends.

create table public.flag_watermarks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  vault_id    uuid not null,
  token_id    uuid references public.access_tokens on delete cascade,
  last_seq    bigint not null default 0 check (last_seq >= 0),
  updated_at  timestamptz not null default now(),
  constraint flag_watermarks_identity unique nulls not distinct (user_id, vault_id, token_id),
  foreign key (vault_id, user_id) references public.vault_members (vault_id, user_id) on delete cascade
);
-- The identity constraint's index leads with (user_id, vault_id), covering
-- the membership foreign key; the token's needs its own.
create index on public.flag_watermarks (token_id);

create table public.subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null,
  vault_id    uuid not null,
  kind        text not null check (kind in ('tag', 'path')),
  target      text not null check (length(target) between 1 and 1024 and target !~ '[[:cntrl:]]'),
  created_at  timestamptz not null default now(),
  unique (user_id, vault_id, kind, target),
  foreign key (vault_id, user_id) references public.vault_members (vault_id, user_id) on delete cascade
);

alter table public.flag_watermarks enable row level security;
alter table public.subscriptions enable row level security;

-- Watermarks: no policy, so no direct read or write for any API role. Each
-- identity sees its own through list_flags and moves it through
-- advance_flags. (private.token_id() isn't the signed-in role's to call,
-- 20260924160000_token_scope.sql, so a policy couldn't tell one connection
-- from another without widening that; a closed table needs neither.)
revoke all on public.flag_watermarks from public, anon, authenticated;

-- Subscriptions: the person's own, in the vaults the caller reaches: a
-- connection scoped to other vaults lists none of these. One readable-set
-- lookup per statement (20260925110000_hardening), not a check per row.
create policy own_subscriptions on public.subscriptions for select to authenticated
  using (user_id = (select private.uid()) and vault_id in (select private.readable_vaults()));
revoke all on public.subscriptions from public, anon, authenticated;
grant select on public.subscriptions to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers

create function private.subscription_cap() returns int
language sql immutable set search_path = '' as $$ select 100 $$;

-- Why a path can't be watched, in words a person can act on, or null. The
-- same shapes a rule takes (private.rule_path_problem): a folder ending in
-- one / or a file, relative, no empty, . or .. segments.
create function private.watch_path_problem(p_path text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_body text;
begin
  if p_path is null or p_path = '' then
    return 'say which path to watch: a folder ending in / (like clients/) or a file (like notes/plan.md)';
  end if;
  if p_path ~ '[[:cntrl:]]' then
    return 'a watched path can''t contain control characters (tabs, line breaks and the like): type the folder or file name as it appears in the vault';
  end if;
  if length(p_path) > 1024 then
    return 'a watched path can be at most 1024 characters; this one has ' || length(p_path);
  end if;
  if left(p_path, 1) = '/' then
    return 'a watched path starts with /, but paths in a vault are relative: write clients/ rather than /clients/';
  end if;
  v_body := case when right(p_path, 1) = '/' then left(p_path, -1) else p_path end;
  if v_body = '' or v_body ~ '//' or right(v_body, 1) = '/' then
    return 'a watched path has an empty folder name (two / in a row): write each folder once, like clients/acme/';
  end if;
  if v_body ~ '(^|/)\.\.?(/|$)' then
    return 'a watched path has a . or .. segment: name the folder or file inside the vault, like clients/';
  end if;
  return null;
end $$;

-- Who is asking, for flags: the person, the connection's token (null in the
-- web app), the agent's name as the log records it, and when this identity
-- began (the connection's creation, or joining the vault). Refuses in the
-- order a person can act on: not signed in, a CLI sign-in (require_person),
-- an agent with no connection, then a vault the caller doesn't reach.
-- Called only from the security definer functions below.
create function private.flag_caller(p_vault uuid,
  out person uuid, out token uuid, out agent text, out began timestamptz)
language plpgsql stable set search_path = '' as $$
begin
  perform private.require_person();
  if private.token_id() is null and private.agent() is not null then
    raise exception 'flags are kept for each connection, and this agent came without one, so it has no flags of its own'
      using errcode = '42501';
  end if;
  if private.role_in(p_vault) is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  person := private.uid();
  token := private.token_id();
  agent := private.agent();
  if token is null then
    select m.added_at into began from public.vault_members m
     where m.vault_id = p_vault and m.user_id = person;
  else
    select t.created_at into began from public.access_tokens t where t.id = token;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Flags

create function public.list_flags(p_vault uuid, p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c record;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_mark bigint;
  v_head bigint;
  v_flags jsonb;
  v_n int;
  v_last bigint;
begin
  select * into c from private.flag_caller(p_vault);
  select w.last_seq into v_mark from public.flag_watermarks w
   where w.user_id = c.person and w.vault_id = p_vault and w.token_id is not distinct from c.token;
  v_mark := coalesce(v_mark, 0);
  select coalesce(max(l.seq), 0) into v_head from public.log l where l.vault_id = p_vault;

  with review as (
    -- shell_summary's review set, and the latest event that put each
    -- proposal in front of reviewers or moved its discussion on.
    select distinct on (p.id)
           l.seq, 1 as rank, 'responsibility' as category, 'review' as reason,
           l.event, l.path, p.id as proposal_id, l.actor, l.agent, l.at, null::text as watching
      from public.proposals p
      join public.vault_members m on m.vault_id = p.vault_id and m.user_id = c.person and m.role in ('owner', 'editor')
      join public.log l on l.vault_id = p.vault_id and l.path = p.path and l.proposal_id = p.id
                       and l.event in ('proposal.open', 'proposal.revise', 'proposal.edit', 'proposal.comment')
     where p.vault_id = p_vault
       and p.status = 'open'
       and not exists (select 1 from public.approvals a
                        where a.proposal_id = p.id and a.user_id = c.person and a.revision = p.revision)
       and not exists (select 1 from public.active_snoozes s where s.proposal_id = p.id and s.user_id = c.person)
     order by p.id, l.seq desc
  ), own as (
    select l.seq, 2, 'working_set', 'proposal', l.event, l.path, l.proposal_id, l.actor, l.agent, l.at, null::text
      from public.log l
      join public.proposals p on p.id = l.proposal_id and p.vault_id = p_vault and p.proposed_by = c.person
     where l.vault_id = p_vault and l.seq > v_mark and l.at >= c.began
  ), base as (
    select l.seq, 2, 'working_set', 'base_changed', l.event, l.path, p.id, l.actor, l.agent, l.at, null::text
      from public.proposals p
      join public.log o on o.vault_id = p.vault_id and o.path = p.path and o.proposal_id = p.id
                       and o.event = 'proposal.open'
      join public.log l on l.vault_id = p.vault_id and l.path = p.path and l.seq > o.seq
                       and l.event in ('file.write', 'file.delete', 'file.erase')
                       and l.proposal_id is distinct from p.id
     where p.vault_id = p_vault and p.proposed_by = c.person and p.status in ('open', 'changes_requested')
       and l.seq > v_mark and l.at >= c.began
  ), watched as (
    select distinct on (l.seq)
           l.seq, 3, 'subscription', 'path', l.event, l.path, l.proposal_id, l.actor, l.agent, l.at, s.target
      from public.subscriptions s
      join public.log l on l.vault_id = s.vault_id and l.path is not null
                       and l.seq > v_mark and l.at >= s.created_at and l.at >= c.began
                       and (l.path = s.target or (right(s.target, 1) = '/' and starts_with(l.path, s.target)))
     where s.user_id = c.person and s.vault_id = p_vault and s.kind = 'path'
     order by l.seq, length(s.target) desc
  ), raised as (
    select * from review where seq > v_mark
    union all select * from own
    union all select * from base
    union all select * from watched
  ), kept as (
    select distinct on (r.seq) r.*
      from raised r
     where not (r.actor is not distinct from c.person and r.agent is not distinct from c.agent)
     order by r.seq, r.rank
  ), page as (
    select * from kept order by seq limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'seq', p.seq, 'category', p.category, 'reason', p.reason, 'event', p.event, 'path', p.path,
           'proposal_id', p.proposal_id, 'actor', p.actor, 'agent', p.agent, 'at', p.at, 'watching', p.watching)
           order by p.seq) filter (where p.n <= v_limit), '[]'::jsonb),
         count(*),
         max(p.seq) filter (where p.n <= v_limit)
    into v_flags, v_n, v_last
    from (select pg.*, row_number() over (order by pg.seq) as n from page pg) p;

  return jsonb_build_object(
    'watermark', v_mark,
    'through', case when v_n > v_limit then v_last else greatest(v_head, v_mark) end,
    'more', v_n > v_limit,
    'flags', v_flags);
end $$;

-- Marks the caller's own flags shown through p_through: pass the `through`
-- list_flags returned, once the response carrying them was delivered. Only
-- ever forward; never past the vault's latest entry. Returns the watermark.
create function public.advance_flags(p_vault uuid, p_through bigint)
returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  c record;
  v_head bigint;
  v_seq bigint;
begin
  select * into c from private.flag_caller(p_vault);
  if p_through is null or p_through < 0 then
    raise exception 'say how far your flags were shown: pass the through value list_flags returned'
      using errcode = '22023';
  end if;
  select coalesce(max(l.seq), 0) into v_head from public.log l where l.vault_id = p_vault;
  if p_through > v_head then
    raise exception 'flags can''t be marked shown past this vault''s latest entry, %: pass the through value list_flags returned', v_head
      using errcode = '22023';
  end if;
  insert into public.flag_watermarks as w (user_id, vault_id, token_id, last_seq)
  values (c.person, p_vault, c.token, p_through)
  on conflict (user_id, vault_id, token_id) do update
    set last_seq = greatest(w.last_seq, excluded.last_seq),
        updated_at = case when excluded.last_seq > w.last_seq then now() else w.updated_at end
  returning w.last_seq into v_seq;
  return v_seq;
end $$;

-- ---------------------------------------------------------------------------
-- Subscriptions: the person's own, in person

-- Watches a path in a vault: a folder ending in / or a file. Watching one
-- already watched returns that subscription. Returns its id.
create function public.create_subscription(p_vault uuid, p_kind text, p_target text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_me uuid;
  v_id uuid;
  v_problem text;
begin
  perform private.require_human();
  v_me := private.uid();
  if private.role_in(p_vault) is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if p_kind is null or p_kind not in ('tag', 'path') then
    raise exception 'a subscription watches a path: kind path, with a folder like clients/ or a file like notes/plan.md'
      using errcode = '22023';
  end if;
  if p_kind = 'tag' then
    raise exception 'files don''t carry tags yet, so a tag subscription would never flag anything: watch a path instead, a folder like clients/ or a file like notes/plan.md'
      using errcode = '22023';
  end if;
  v_problem := private.watch_path_problem(p_target);
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;

  -- One subscription change at a time per person and vault, so two at once
  -- can't both pass the cap. No key update: nothing else waits on it but a
  -- change to this membership, which waits for this.
  perform 1 from public.vault_members m where m.vault_id = p_vault and m.user_id = v_me for no key update;
  select s.id into v_id from public.subscriptions s
   where s.user_id = v_me and s.vault_id = p_vault and s.kind = p_kind and s.target = p_target;
  if v_id is not null then
    return v_id;
  end if;
  if (select count(*) from public.subscriptions s where s.user_id = v_me and s.vault_id = p_vault)
     >= private.subscription_cap() then
    raise exception 'you watch % paths in this vault already, the most one person can: stop watching one first',
      private.subscription_cap() using errcode = '54000';
  end if;
  insert into public.subscriptions (user_id, vault_id, kind, target)
  values (v_me, p_vault, p_kind, p_target)
  returning id into v_id;
  return v_id;
end $$;

-- Stops watching. Only the person's own subscription, in person; anyone
-- else's, or one that doesn't exist, is "no such subscription of yours".
create function public.delete_subscription(p_subscription uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  delete from public.subscriptions s where s.id = p_subscription and s.user_id = private.uid();
  if not found then
    raise exception 'no such subscription of yours' using errcode = 'P0002';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.subscription_cap(), private.watch_path_problem(text), private.flag_caller(uuid)
  from public, anon, authenticated;

revoke all on function public.list_flags(uuid, int), public.advance_flags(uuid, bigint),
  public.create_subscription(uuid, text, text), public.delete_subscription(uuid)
  from public, anon;
grant execute on function public.list_flags(uuid, int), public.advance_flags(uuid, bigint),
  public.create_subscription(uuid, text, text), public.delete_subscription(uuid)
  to authenticated;
