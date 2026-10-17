-- What a person has read of a thread, in the web app (web/src/threadview.ts):
-- the newest message they were shown when they opened it. The Threads page
-- (web/src/threadspage.ts) marks a thread Unread when it has a message from
-- someone else, or from an agent, newer than that. A thread never opened has
-- no row, and counts as unread on the same rule.
--
-- The owner's decision of 2026-10-17: reading is tracked per person and
-- thread, and is that person's own, in person only. Another member sees
-- nothing of it; an agent, token, OAuth client or CLI grant reads and writes
-- nothing here (RLS, as for welcome_seen). Agents and the MCP tools are
-- unchanged: nothing in thread_summaries, list_threads or read_thread says
-- what a person has read. Hostile tests: supabase/tests/thread_reads_test.sql.
--
-- The row goes with the membership (as flag_watermarks), so leaving a vault
-- or deleting the account drops it, and with the thread.

create table public.thread_reads (
  user_id         uuid not null,
  vault_id        uuid not null,
  thread_id       uuid not null,
  last_message_id bigint not null check (last_message_id >= 0),
  updated_at      timestamptz not null default now(),
  primary key (user_id, vault_id, thread_id),
  foreign key (vault_id, thread_id) references public.threads (vault_id, id) on delete cascade,
  foreign key (vault_id, user_id) references public.vault_members (vault_id, user_id) on delete cascade
);
-- The primary key leads with (user_id, vault_id), covering the membership
-- foreign key; the thread's needs its own.
create index on public.thread_reads (vault_id, thread_id);

alter table public.thread_reads enable row level security;
revoke all on public.thread_reads from public, anon, authenticated;
grant select, insert, update on public.thread_reads to authenticated;

create policy own_thread_reads_read on public.thread_reads for select to authenticated
  using (user_id = (select private.uid()) and (select private.agent()) is null);
create policy own_thread_reads_insert on public.thread_reads for insert to authenticated
  with check (user_id = (select private.uid()) and (select private.agent()) is null);
create policy own_thread_reads_update on public.thread_reads for update to authenticated
  using (user_id = (select private.uid()) and (select private.agent()) is null)
  with check (user_id = (select private.uid()) and (select private.agent()) is null);
