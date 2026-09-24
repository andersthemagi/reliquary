-- Proposal threads and review snooze. See docs/research/ux-patterns.md,
-- phase 2.
--
-- Threads
-- - A comment is a proposal_notes row of kind 'comment', so review notes and
--   discussion share one timeline and one set of protections: insert-only,
--   erased with the file (erase_file already blanks every note of the file's
--   proposals).
-- - Only comment_on_proposal() writes one. Editors and owners comment, and so
--   do their agents: an agent is its person. Viewers read the thread but
--   don't write to it, the same way they can't propose.
-- - Comments are for deciding, so they are taken while a proposal is live
--   (open or changes requested). Once it is applied, rejected or stale, its
--   record stays as it was when decided; further discussion belongs with a
--   new proposal.
-- - The log records that someone commented, never what they wrote, so erasure
--   leaves nothing behind in the append-only log.
--
-- Snooze
-- - Per person, private: only the owner of a snooze can see it, and it is not
--   logged (the vault log is readable by every member).
-- - A snooze ends at its time, or, for "until it changes", never by time. Any
--   snooze also ends when the proposal changes: a new revision, or a note or
--   comment from anyone other than the snoozer themself.
-- - People only: an agent that could snooze could hide its own proposals from
--   its person's Review inbox.

alter table public.proposal_notes drop constraint proposal_notes_kind_check;
alter table public.proposal_notes add constraint proposal_notes_kind_check
  check (kind in ('request_changes', 'reject', 'revise', 'edit', 'comment'));

create or replace function public.comment_on_proposal(p_proposal uuid, p_body text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
  v_body text := trim(coalesce(p_body, ''));
  v_id uuid;
begin
  perform private.require_person();
  select * into p from public.proposals where id = p_proposal;
  if p.id is null or not private.is_member(p.vault_id) then
    raise exception 'no such proposal' using errcode = 'P0002';
  end if;
  if not private.can_write(p.vault_id) then
    raise exception 'only editors and owners comment on proposals' using errcode = '42501';
  end if;
  if p.status not in ('open', 'changes_requested') then
    raise exception 'proposal is %, so its discussion is closed', replace(p.status, '_', ' ')
      using errcode = '55000';
  end if;
  if length(v_body) = 0 then
    raise exception 'a comment needs some text' using errcode = '22023';
  end if;
  if length(v_body) > 4000 then
    raise exception 'comments are at most 4000 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.proposal_notes
       where proposal_id = p.id and kind = 'comment') >= 200 then
    raise exception 'this thread has reached 200 comments; propose again to continue'
      using errcode = '22023';
  end if;
  insert into public.proposal_notes (proposal_id, vault_id, author, agent, revision, kind, body)
  values (p.id, p.vault_id, private.uid(), private.agent(), p.revision, 'comment', v_body)
  returning id into v_id;
  perform private.log_event(p.vault_id, 'proposal.comment', p.path, null, p.id,
    jsonb_build_object('revision', p.revision, 'note', v_id));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Snooze

create table public.review_snoozes (
  user_id     uuid not null,
  proposal_id uuid not null references public.proposals on delete cascade,
  vault_id    uuid not null references public.vaults on delete cascade,
  until       timestamptz,            -- null: until the proposal changes
  revision    int not null,           -- the revision that was snoozed
  snoozed_at  timestamptz not null default now(),
  primary key (user_id, proposal_id)
);

alter table public.review_snoozes enable row level security;
create policy own_snoozes on public.review_snoozes for select to authenticated
  using (user_id = private.uid() and private.is_member(vault_id));
revoke all on public.review_snoozes from anon, authenticated;
grant select on public.review_snoozes to authenticated;

-- Snoozes in force. Security invoker, so review_snoozes' RLS still limits it
-- to the caller's own.
create view public.active_snoozes with (security_invoker = true) as
  select s.*
    from public.review_snoozes s
    join public.proposals p on p.id = s.proposal_id
   where (s.until is null or s.until > now())
     and p.revision = s.revision
     and not exists (
       select 1 from public.proposal_notes n
        where n.proposal_id = s.proposal_id and n.at > s.snoozed_at
          and (n.author <> s.user_id or n.agent is not null));
revoke all on public.active_snoozes from anon, authenticated;
grant select on public.active_snoozes to authenticated;

create or replace function public.snooze_proposal(p_proposal uuid, p_until timestamptz default null)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare p public.proposals;
begin
  perform private.require_human();
  select * into p from public.proposals where id = p_proposal;
  if p.id is null or not private.is_member(p.vault_id) then
    raise exception 'no such proposal' using errcode = 'P0002';
  end if;
  if p.status not in ('open', 'changes_requested') then
    raise exception 'proposal is %', replace(p.status, '_', ' ') using errcode = '55000';
  end if;
  if p_until is not null and (p_until <= now() or p_until > now() + interval '366 days') then
    raise exception 'snooze until a time within the next year' using errcode = '22023';
  end if;
  insert into public.review_snoozes (user_id, proposal_id, vault_id, until, revision)
  values (private.uid(), p.id, p.vault_id, p_until, p.revision)
  on conflict (user_id, proposal_id) do update
    set until = excluded.until, revision = excluded.revision, snoozed_at = now();
end $$;

-- Unsnoozing only brings a proposal back into view, so the person's agent
-- may do it too. It only ever touches the caller's own snooze.
create or replace function public.unsnooze_proposal(p_proposal uuid)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_person();
  delete from public.review_snoozes where user_id = private.uid() and proposal_id = p_proposal;
  return found;
end $$;

revoke all on function public.comment_on_proposal(uuid, text),
  public.snooze_proposal(uuid, timestamptz), public.unsnooze_proposal(uuid) from public, anon;
grant execute on function public.comment_on_proposal(uuid, text),
  public.snooze_proposal(uuid, timestamptz), public.unsnooze_proposal(uuid) to authenticated;
