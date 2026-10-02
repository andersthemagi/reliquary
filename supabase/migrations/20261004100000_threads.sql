-- Threads: conversations inside one vault, between its members and their
-- agents (docs/public/concepts/threads.md; the owner's decision of
-- 2026-10-02, "Threads"). Not the proposal threads of
-- 20260924170000_threads_snooze.sql, which are proposal_notes comments.
--
-- This migration is the tables only. Nothing in mcp/ or web/ reads them
-- yet, and nothing writes them but the functions of later migrations.
--
-- Never private. Every member who can read the vault reads every thread,
-- every message and every addressee, whoever a thread is addressed to: the
-- read policy is the vault's, and nothing else. Addressing decides who is
-- told about a thread, never who may read it (design.md, "Addressed
-- notes", takes the same stance). Anyone who needs privacy takes the
-- conversation outside the app.
--
-- A thread may anchor to one thing in its own vault: a file path, a work
-- plan step (shown to people as a task) or a proposal. The step and the
-- proposal are composite foreign keys on (vault_id, id), so the table
-- itself refuses an anchor in another vault, whatever function writes it.
-- Messages and addressees reference their thread the same way, so neither
-- can sit in a vault other than its thread's.
--
-- Messages are append-only: no update or delete, from any role, the table
-- owner included, with two exceptions. Redaction blanks a body once and
-- changes nothing else (a later migration's redact_message, the owner in
-- person). delete_vault removes everything, the one sanctioned exception
-- AGENTS.md names for append-only tables (private.purging). Addressees are
-- fixed when a thread opens. A thread changes only its resolved state.
--
-- No foreign key points at vault_members. Authors, openers and addressees
-- are a record of who did what, like proposal_notes.author and the log's
-- actor: a member leaving must neither delete that record (a cascade) nor
-- be blocked by it (a cascade into an append-only table fails). Membership
-- is checked when a thread is opened or posted to, by the functions.

-- The longest message, in characters. A starting point, not a settled
-- number: the same as a proposal comment. Long text belongs in a file,
-- cited by its path.
create function private.thread_message_max_chars() returns int
language sql immutable set search_path = '' as $$ select 4000 $$;

-- Referenced keys for the anchors' composite foreign keys.
alter table public.proposals add constraint proposals_vault_id_id_key unique (vault_id, id);
alter table public.work_plan_steps add constraint work_plan_steps_vault_id_id_key unique (vault_id, id);

create table public.threads (
  id              uuid primary key default gen_random_uuid(),
  vault_id        uuid not null references public.vaults on delete cascade,
  title           text not null check (length(title) between 1 and 200 and title !~ '[[:cntrl:]]'),
  anchor_path     text check (length(anchor_path) <= 1024 and anchor_path !~ '[[:cntrl:]]'),
  anchor_step     bigint,
  anchor_proposal uuid,
  opened_by       uuid not null,
  agent           text,
  opened_at       timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     uuid,
  resolved_agent  text,
  unique (vault_id, id),
  check (num_nonnulls(anchor_path, anchor_step, anchor_proposal) <= 1),
  check ((resolved_at is null) = (resolved_by is null)),
  check (resolved_at is not null or resolved_agent is null),
  foreign key (vault_id, anchor_step) references public.work_plan_steps (vault_id, id) on delete cascade,
  foreign key (vault_id, anchor_proposal) references public.proposals (vault_id, id) on delete cascade
);
create index on public.threads (anchor_step, vault_id) where anchor_step is not null;
create index on public.threads (anchor_proposal, vault_id) where anchor_proposal is not null;

-- Message ids are one sequence across every vault, so they order a thread's
-- messages and give list_threads a cursor (a thread's latest message id).
create table public.thread_messages (
  id          bigint generated always as identity primary key,
  thread_id   uuid not null,
  vault_id    uuid not null,
  author      uuid not null,
  agent       text,
  body        text check (body <> '' and length(body) <= private.thread_message_max_chars()),
  at          timestamptz not null default now(),
  redacted_at timestamptz,
  redacted_by uuid,
  check ((body is null) = (redacted_at is not null)),
  check ((redacted_at is null) = (redacted_by is null)),
  foreign key (vault_id, thread_id) references public.threads (vault_id, id) on delete cascade
);
create index on public.thread_messages (vault_id, thread_id, id);

create table public.thread_addressees (
  vault_id  uuid not null,
  thread_id uuid not null,
  user_id   uuid not null,
  primary key (vault_id, thread_id, user_id),
  foreign key (vault_id, thread_id) references public.threads (vault_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Append-only, except redaction and delete_vault

create function private.threads_resolve_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if private.purging(old.vault_id) then
      return old;
    end if;
    raise exception 'threads are never deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.vault_id <> old.vault_id or new.title <> old.title
     or new.anchor_path is distinct from old.anchor_path or new.anchor_step is distinct from old.anchor_step
     or new.anchor_proposal is distinct from old.anchor_proposal or new.opened_by <> old.opened_by
     or new.agent is distinct from old.agent or new.opened_at <> old.opened_at then
    raise exception 'only a thread''s resolved state can change' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger threads_resolve_only before update or delete on public.threads
  for each row execute function private.threads_resolve_only();
create trigger threads_no_truncate before truncate on public.threads
  for each statement execute function private.forbid_change();

-- A redaction blanks the body once and records who and when; nothing else
-- about the message changes, and a redacted message stays redacted.
create function private.thread_messages_redact_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if private.purging(old.vault_id) then
      return old;
    end if;
    raise exception 'thread messages are never deleted' using errcode = '42501';
  end if;
  if old.redacted_at is not null or new.body is not null or new.redacted_at is null or new.redacted_by is null
     or new.id <> old.id or new.thread_id <> old.thread_id or new.vault_id <> old.vault_id
     or new.author <> old.author or new.agent is distinct from old.agent or new.at <> old.at then
    raise exception 'thread messages can only be redacted' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger thread_messages_redact_only before update or delete on public.thread_messages
  for each row execute function private.thread_messages_redact_only();
create trigger thread_messages_no_truncate before truncate on public.thread_messages
  for each statement execute function private.forbid_change();

create trigger thread_addressees_append_only before update or delete on public.thread_addressees
  for each row execute function private.forbid_change();
create trigger thread_addressees_no_truncate before truncate on public.thread_addressees
  for each statement execute function private.forbid_change();

-- ---------------------------------------------------------------------------
-- Every member reads everything; nobody writes directly

alter table public.threads enable row level security;
alter table public.thread_messages enable row level security;
alter table public.thread_addressees enable row level security;

create policy member_read on public.threads for select to authenticated
  using (vault_id in (select private.readable_vaults()));
create policy member_read on public.thread_messages for select to authenticated
  using (vault_id in (select private.readable_vaults()));
create policy member_read on public.thread_addressees for select to authenticated
  using (vault_id in (select private.readable_vaults()));

revoke all on public.threads, public.thread_messages, public.thread_addressees from public, anon, authenticated;
grant select on public.threads, public.thread_messages, public.thread_addressees to authenticated;

revoke all on function private.thread_message_max_chars(), private.threads_resolve_only(),
  private.thread_messages_redact_only() from public, anon, authenticated;
