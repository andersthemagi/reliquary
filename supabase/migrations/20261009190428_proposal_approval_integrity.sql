-- Turning a proposal into canon (decide, edit_and_approve, revise_proposal),
-- each copied from its latest definition (decide:
-- 20260928130000_path_ownership.sql; edit_and_approve:
-- 20261002100000_path_owner_review_parity.sql; revise_proposal:
-- 20260924150000_review.sql) and changed only where said.
--
-- Lock order. decide() locked the proposal's row, then (inside
-- apply_write) the file's, and compared the file's version with a plain
-- read in between. Two proposals made against the same version and
-- approved at once both read that version, both passed, and the second
-- overwrote the first instead of going stale; with no file yet, both bases
-- are null and the same happened. And erase_file locks the file's row,
-- then its proposals' (20260925240100_lock_order.sql), the opposite order,
-- so a final approval racing an erasure of its file could deadlock (40P01).
-- Now both functions find the proposal unlocked, lock its path, then the
-- file's row, then the proposal's, and decide() compares versions only
-- after that. The path lock is for a file that doesn't exist yet: there is
-- no row to lock, so it is what makes a second create wait and go stale.
-- edit_and_approve takes the same locks before touching the proposal,
-- since it holds the proposal's row when it calls decide().
--
-- The revision a reviewer read. Both took no revision and acted on
-- whichever one was current when the click arrived, so a revise_proposal
-- (an agent may call it) between the page loading and Approve meant the
-- person approved text they never saw, and at quorum 1 it became canon;
-- an edit replaced a revision its editor never saw the same way. Both now
-- take p_expected_revision: given and not the current revision, nothing is
-- recorded and the refusal says which revision to read. Given nothing,
-- both behave as before, so the old signatures are dropped first (as
-- 20260930100000_compare_and_swap.sql does) to keep calls unambiguous.
--
-- Credit after a revision. revise_proposal never cleared edited_by, which
-- edit_and_approve sets, so a revision made after a reviewer's edit (with
-- a quorum above one, the proposal stays open) was applied as the
-- reviewer's text, with no agent, though the reviewer never saw it. A
-- revision now clears edited_by: the text is the proposer's (and their
-- agent's) again.

drop function public.decide(uuid, text, text);
drop function public.edit_and_approve(uuid, text, text);

create function private.lock_path(p_vault uuid, p_path text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('reliquary.path:' || p_vault::text || '/' || p_path, 0));
  perform 1 from public.files where vault_id = p_vault and path = p_path for update;
end $$;

revoke all on function private.lock_path(uuid, text) from public, anon, authenticated;

create function public.decide(p_proposal uuid, p_decision text, p_note text default null,
  p_expected_revision int default null)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
  v_quorum int;
  v_approvals int;
  v_current uuid;
  v_owners uuid[];
begin
  perform private.require_human();
  select * into p from public.proposals where id = p_proposal;
  if p.id is null or not private.can_write_path(p.vault_id, p.path) then
    raise exception 'no such proposal' using errcode = 'P0002';
  end if;
  perform private.lock_path(p.vault_id, p.path);
  select * into p from public.proposals where id = p_proposal for update;
  if p.id is null then
    raise exception 'no such proposal' using errcode = 'P0002';
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject', 'request_changes') then
    raise exception 'decision must be approve, request_changes or reject' using errcode = '22023';
  end if;
  if not (p.status = 'open' or (p.status = 'changes_requested' and p_decision = 'reject')) then
    raise exception 'proposal is %', replace(p.status, '_', ' ') using errcode = '55000';
  end if;
  if p_expected_revision <> p.revision then
    raise exception 'this proposal was revised while you were reading it: you read revision %, and it is now revision %. Read revision % before you decide',
      p_expected_revision, p.revision, p.revision using errcode = '55000';
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
  select array_agg(o) into v_owners from private.path_owner_ids(p.vault_id, p.path) as o;
  if v_owners is not null then
    select count(*) into v_approvals from public.approvals a
    where a.proposal_id = p.id and a.decision = 'approve' and a.revision = p.revision
      and a.user_id = any(v_owners);
  else
    select count(*) into v_approvals from public.approvals a
    join public.vault_members m on m.vault_id = p.vault_id and m.user_id = a.user_id
    where a.proposal_id = p.id and a.decision = 'approve' and a.revision = p.revision
      and m.role in ('owner', 'editor');
  end if;
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

create function public.edit_and_approve(p_proposal uuid, p_body text, p_note text default null,
  p_expected_revision int default null)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
begin
  perform private.require_human();
  select * into p from public.proposals where id = p_proposal;
  if p.id is null or not private.can_write_path(p.vault_id, p.path) then
    raise exception 'no such proposal' using errcode = 'P0002';
  end if;
  perform private.lock_path(p.vault_id, p.path);
  select * into p from public.proposals where id = p_proposal for update;
  if p.id is null then
    raise exception 'no such proposal' using errcode = 'P0002';
  end if;
  if p.status not in ('open', 'changes_requested') then
    raise exception 'proposal is %', replace(p.status, '_', ' ') using errcode = '55000';
  end if;
  if p.kind <> 'write' then
    raise exception 'only proposals that write a file can be edited' using errcode = '22023';
  end if;
  if p_expected_revision <> p.revision then
    raise exception 'this proposal was revised while you were editing it: you started from revision %, and it is now revision %. Your edit is not saved; read revision % before you save it again',
      p_expected_revision, p.revision, p.revision using errcode = '55000';
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
      revision = revision + 1, status = 'open', edited_by = null
  where id = p.id
  returning * into p;
  perform private.add_note(p, 'revise', p_reason);
  perform private.log_event(p.vault_id, 'proposal.revise', p.path, null, p.id,
    jsonb_build_object('revision', p.revision));
  return p.revision;
end $$;

revoke all on function public.decide(uuid, text, text, int), public.edit_and_approve(uuid, text, text, int)
  from public, anon;
grant execute on function public.decide(uuid, text, text, int), public.edit_and_approve(uuid, text, text, int)
  to authenticated;
