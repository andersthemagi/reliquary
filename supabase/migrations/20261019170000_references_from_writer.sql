-- References come from the server that writes the file (#464, part of
-- #238; docs/design.md, "Encryption at rest: the content key", section 5).
--
-- SQL can't parse a body once bodies are sealed, so the trigger that read a
-- file's text on every change goes, with its parsing helpers. The server
-- that writes a version has the plaintext: it finds the references
-- (web/src/references.ts, the same file as mcp/src/references.ts) and
-- passes them as p_references to write_file, decide and edit_and_approve,
-- which replace the file's rows. A write without the parameter clears them,
-- so no stale row outlives a text that no longer makes it. The function
-- trusts the list: paths are metadata, and who may read a reference is
-- unchanged (20261017100000_file_references.sql); the hostile test that a
-- writer can't name a target its text doesn't contain is on the servers.
--
-- Postgres can't tell write_file(uuid, text, text, uuid) from the same with
-- a defaulted fifth parameter, so the old signatures are dropped first.

drop trigger files_keep_references on public.files;
drop function private.keep_file_references();
drop function private.references_in(text, text);
drop function private.reference_target(text, text, boolean);

-- A file's references, replaced. Empty, blank, over-long and self entries
-- are dropped rather than refused: the writer's list is advisory metadata.
create function private.set_file_references(p_vault uuid, p_path text, p_references text[]) returns void
language sql volatile security definer set search_path = '' as $$
  delete from public.file_references where vault_id = p_vault and source_path = p_path;
  insert into public.file_references (vault_id, source_path, target_path)
  select distinct p_vault, p_path, r
    from unnest(coalesce(p_references, '{}')) r
   where r <> '' and r <> p_path and length(r) <= 1024;
$$;
revoke all on function private.set_file_references(uuid, text, text[]) from public, anon, authenticated;

drop function public.write_file(uuid, text, text, uuid);
create function public.write_file(p_vault uuid, p_path text, p_body text, p_expected_version uuid default null,
  p_references text[] default null)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_version uuid;
begin
  perform private.require_person();
  perform private.valid_path(p_path);
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if (private.policy_for(p_vault, p_path)).policy <> 'open' then
    raise exception '% is canon: use propose()', p_path using errcode = '42501';
  end if;
  perform private.check_expected_version(p_vault, p_path, p_expected_version);
  v_version := private.apply_write(p_vault, p_path, p_body, private.uid(), private.agent(), null);
  perform private.set_file_references(p_vault, p_path, p_references);
  return v_version;
end $$;
revoke all on function public.write_file(uuid, text, text, uuid, text[]) from public, anon;
grant execute on function public.write_file(uuid, text, text, uuid, text[]) to authenticated;

create or replace function public.delete_file(p_vault uuid, p_path text, p_expected_version uuid default null)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_person();
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if (private.policy_for(p_vault, p_path)).policy <> 'open' then
    raise exception '% is canon: use propose()', p_path using errcode = '42501';
  end if;
  perform private.check_expected_version(p_vault, p_path, p_expected_version);
  update public.files set deleted_at = now(), updated_at = now()
  where vault_id = p_vault and path = p_path and deleted_at is null;
  if not found then
    raise exception 'no such file' using errcode = 'P0002';
  end if;
  perform private.set_file_references(p_vault, p_path, null);
  perform private.log_event(p_vault, 'file.delete', p_path, null, null);
end $$;

-- decide and edit_and_approve as 20261009190428_proposal_approval_integrity.sql
-- left them, plus p_references: set when the write applies, cleared when a
-- delete does.
drop function public.edit_and_approve(uuid, text, text, int);
drop function public.decide(uuid, text, text, int);

create function public.decide(p_proposal uuid, p_decision text, p_note text default null,
  p_expected_revision int default null, p_references text[] default null)
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
    perform private.set_file_references(p.vault_id, p.path, null);
    insert into public.log (vault_id, actor, agent, event, path, proposal_id)
    values (p.vault_id, coalesce(p.edited_by, p.proposed_by),
            case when p.edited_by is null then p.agent end, 'file.delete', p.path, p.id);
  else
    perform private.apply_write(p.vault_id, p.path, p.body, coalesce(p.edited_by, p.proposed_by),
      case when p.edited_by is null then p.agent end, p.id);
    perform private.set_file_references(p.vault_id, p.path, p_references);
  end if;
  update public.proposals set status = 'applied', decided_at = now() where id = p.id;
  return 'applied';
end $$;

create function public.edit_and_approve(p_proposal uuid, p_body text, p_note text default null,
  p_expected_revision int default null, p_references text[] default null)
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
  return public.decide(p.id, 'approve', null, null, p_references);
end $$;

revoke all on function public.decide(uuid, text, text, int, text[]), public.edit_and_approve(uuid, text, text, int, text[])
  from public, anon;
grant execute on function public.decide(uuid, text, text, int, text[]), public.edit_and_approve(uuid, text, text, int, text[])
  to authenticated;
