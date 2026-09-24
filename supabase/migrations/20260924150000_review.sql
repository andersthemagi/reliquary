-- Review flow: request changes, revisions, edit & approve, revision-bound
-- approvals, and review notes. See docs/research/ux-patterns.md.
--
-- - A proposal has a revision number. Approvals are recorded against the
--   revision they saw; only approvals of the current revision count, so any
--   change to a proposal voids earlier approvals.
-- - "Request changes" keeps the proposal alive (status changes_requested) and
--   leaves a note the proposing agent can read over MCP and act on.
-- - The proposer (or their agent) can revise. A reviewer can edit & approve,
--   which is a revision authored by the reviewer; the applied file is then
--   attributed to the reviewer, not the agent.
-- - Notes live in proposal_notes: insert-only, erasable like file versions.

alter table public.proposals drop constraint proposals_status_check;
alter table public.proposals add constraint proposals_status_check
  check (status in ('open', 'changes_requested', 'applied', 'rejected', 'stale'));
alter table public.proposals add column revision int not null default 1;
alter table public.proposals add column edited_by uuid;

alter table public.approvals drop constraint approvals_decision_check;
alter table public.approvals add constraint approvals_decision_check
  check (decision in ('approve', 'reject', 'request_changes'));
alter table public.approvals add column revision int not null default 1;
alter table public.approvals drop constraint approvals_pkey;
alter table public.approvals add primary key (proposal_id, user_id, revision);

create table public.proposal_notes (
  id          uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references public.proposals on delete cascade,
  vault_id    uuid not null references public.vaults on delete cascade,
  author      uuid not null,
  agent       text,
  revision    int not null,
  kind        text not null check (kind in ('request_changes', 'reject', 'revise', 'edit')),
  body        text,
  at          timestamptz not null default now(),
  erased_at   timestamptz
);
create index on public.proposal_notes (proposal_id, at);

create or replace function private.notes_erase_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'proposal_notes rows are never deleted' using errcode = '42501';
  end if;
  if new.body is not null or new.erased_at is null or new.id <> old.id
     or new.author <> old.author or new.at <> old.at or new.kind <> old.kind then
    raise exception 'proposal_notes rows can only be erased' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger proposal_notes_erase_only before update or delete on public.proposal_notes
  for each row execute function private.notes_erase_only();

alter table public.proposal_notes enable row level security;
create policy member_read on public.proposal_notes for select to authenticated
  using (private.is_member(vault_id));
revoke all on public.proposal_notes from anon, authenticated;
grant select on public.proposal_notes to authenticated;

create or replace function private.add_note(p public.proposals, p_kind text, p_body text)
returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.proposal_notes (proposal_id, vault_id, author, agent, revision, kind, body)
  values (p.id, p.vault_id, private.uid(), private.agent(), p.revision, p_kind, nullif(trim(p_body), ''))
$$;

-- ---------------------------------------------------------------------------
-- decide: approve, request changes, or reject. People only. Notes are
-- required to reject or request changes, so the agent learns why.

drop function public.decide(uuid, text);

create or replace function public.decide(p_proposal uuid, p_decision text, p_note text default null)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
  v_quorum int;
  v_approvals int;
  v_current uuid;
begin
  perform private.require_human();
  select * into p from public.proposals where id = p_proposal for update;
  if p.id is null or not private.can_write(p.vault_id) then
    raise exception 'no such proposal' using errcode = 'P0002';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject', 'request_changes') then
    raise exception 'decision must be approve, request_changes or reject' using errcode = '22023';
  end if;
  if not (p.status = 'open' or (p.status = 'changes_requested' and p_decision = 'reject')) then
    raise exception 'proposal is %', replace(p.status, '_', ' ') using errcode = '55000';
  end if;
  if p_decision <> 'approve' and length(trim(coalesce(p_note, ''))) = 0 then
    raise exception 'say why, so the proposer can act on it' using errcode = '22023';
  end if;

  insert into public.approvals (proposal_id, user_id, decision, revision)
  values (p.id, private.uid(), p_decision, p.revision)
  on conflict do nothing;
  if not found then
    raise exception 'you already decided on this revision' using errcode = '23505';
  end if;
  if p_decision <> 'approve' then
    perform private.add_note(p, p_decision, p_note);
  end if;
  perform private.log_event(p.vault_id, 'proposal.' || p_decision, p.path, null, p.id,
    jsonb_build_object('revision', p.revision));

  if p_decision = 'reject' then
    update public.proposals set status = 'rejected', decided_at = now() where id = p.id;
    return 'rejected';
  elsif p_decision = 'request_changes' then
    update public.proposals set status = 'changes_requested' where id = p.id;
    return 'changes_requested';
  end if;

  v_quorum := (private.policy_for(p.vault_id, p.path)).quorum;
  select count(*) into v_approvals from public.approvals a
  join public.vault_members m on m.vault_id = p.vault_id and m.user_id = a.user_id
  where a.proposal_id = p.id and a.decision = 'approve' and a.revision = p.revision
    and m.role in ('owner', 'editor');
  if v_approvals < v_quorum then
    return 'open';
  end if;

  select current_version_id into v_current from public.files
  where vault_id = p.vault_id and path = p.path and deleted_at is null;
  if v_current is distinct from p.base_version_id then
    update public.proposals set status = 'stale', decided_at = now() where id = p.id;
    perform private.log_event(p.vault_id, 'proposal.stale', p.path, null, p.id);
    return 'stale';
  end if;

  if p.kind = 'delete' then
    update public.files set deleted_at = now(), updated_at = now()
    where vault_id = p.vault_id and path = p.path;
    insert into public.log (vault_id, actor, agent, event, path, proposal_id)
    values (p.vault_id, coalesce(p.edited_by, p.proposed_by),
            case when p.edited_by is null then p.agent end, 'file.delete', p.path, p.id);
  else
    perform private.apply_write(p.vault_id, p.path, p.body, coalesce(p.edited_by, p.proposed_by),
      case when p.edited_by is null then p.agent end, p.id);
  end if;
  update public.proposals set status = 'applied', decided_at = now() where id = p.id;
  return 'applied';
end $$;

-- The proposer, or their agent, revises after feedback. Voids approvals of
-- earlier revisions (they no longer match) and reopens the proposal.
create or replace function public.revise_proposal(p_proposal uuid, p_body text, p_reason text default null)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
begin
  perform private.require_person();
  select * into p from public.proposals where id = p_proposal for update;
  if p.id is null or p.proposed_by <> private.uid() or not private.can_write(p.vault_id) then
    raise exception 'no such proposal of yours' using errcode = 'P0002';
  end if;
  if p.status not in ('open', 'changes_requested') then
    raise exception 'proposal is %', replace(p.status, '_', ' ') using errcode = '55000';
  end if;
  if p.kind <> 'write' then
    raise exception 'only proposals that write a file can be revised' using errcode = '22023';
  end if;
  update public.proposals
  set body = p_body, reason = coalesce(nullif(trim(p_reason), ''), reason),
      revision = revision + 1, status = 'open'
  where id = p.id
  returning * into p;
  perform private.add_note(p, 'revise', p_reason);
  perform private.log_event(p.vault_id, 'proposal.revise', p.path, null, p.id,
    jsonb_build_object('revision', p.revision));
  return p.revision;
end $$;

-- A reviewer fixes the proposal themself and approves it in one step. The
-- edit is a new revision authored by the reviewer; with a quorum above one,
-- the others must approve the edited revision.
create or replace function public.edit_and_approve(p_proposal uuid, p_body text, p_note text default null)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
begin
  perform private.require_human();
  select * into p from public.proposals where id = p_proposal for update;
  if p.id is null or not private.can_write(p.vault_id) then
    raise exception 'no such proposal' using errcode = 'P0002';
  end if;
  if p.status not in ('open', 'changes_requested') then
    raise exception 'proposal is %', replace(p.status, '_', ' ') using errcode = '55000';
  end if;
  if p.kind <> 'write' then
    raise exception 'only proposals that write a file can be edited' using errcode = '22023';
  end if;
  update public.proposals
  set body = p_body, revision = revision + 1, status = 'open', edited_by = private.uid()
  where id = p.id
  returning * into p;
  perform private.add_note(p, 'edit', p_note);
  perform private.log_event(p.vault_id, 'proposal.edit', p.path, null, p.id,
    jsonb_build_object('revision', p.revision));
  return public.decide(p.id, 'approve', null);
end $$;

-- Erasure now also blanks review notes on the file's proposals.
create or replace function public.erase_file(p_vault uuid, p_path text)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners erase' using errcode = '42501';
  end if;
  update public.file_versions v set body = null, erased_at = now()
  from public.files f
  where f.id = v.file_id and f.vault_id = p_vault and f.path = p_path and v.erased_at is null;
  get diagnostics n = row_count;
  update public.proposals set body = null
  where vault_id = p_vault and path = p_path;
  update public.proposal_notes set body = null, erased_at = now()
  where erased_at is null and proposal_id in
    (select id from public.proposals where vault_id = p_vault and path = p_path);
  update public.files set deleted_at = coalesce(deleted_at, now())
  where vault_id = p_vault and path = p_path;
  perform private.log_event(p_vault, 'file.erase', p_path, null, null,
    jsonb_build_object('versions', n));
  return n;
end $$;

revoke all on function public.decide(uuid, text, text), public.revise_proposal(uuid, text, text),
  public.edit_and_approve(uuid, text, text) from public, anon;
grant execute on function public.decide(uuid, text, text), public.revise_proposal(uuid, text, text),
  public.edit_and_approve(uuid, text, text) to authenticated;

-- New functions are executable by PUBLIC by default. Close that for the
-- helpers here, and for every private function created from now on.
revoke all on function private.add_note(public.proposals, text, text),
  private.notes_erase_only() from public, anon, authenticated;
alter default privileges in schema private revoke execute on functions from public;
