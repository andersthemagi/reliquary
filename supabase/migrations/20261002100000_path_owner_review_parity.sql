-- Path ownership: comment_on_proposal and edit_and_approve (F407-F409's
-- own follow-up, left deliberately out of 20260928130000_path_ownership.sql:
-- "the one-step edit-and-approve convenience and commenting stay
-- editor/owner-only for now"). A path's named owner already writes and
-- deletes it directly and calls decide() on its proposals
-- (private.can_write_path); these two still checked private.can_write(vault)
-- alone, so a viewer named owner of a path could approve or reject a
-- proposal on it but not comment on it or use the one-step edit-and-approve,
-- unless they also held ordinary editor or owner access. Closed the same
-- way decide() already was: can_write(vault) becomes can_write_path(vault,
-- path); nothing else in either function changes.
--
-- Also private.writable_path(): a client-callable (authenticated) read of
-- that same can_write_path() decision, mirroring how private.rule_for()
-- already wraps policy_for() for the web app. Without it, the web app had
-- no caller-safe way to ask "can I write this specific path", so the file,
-- editor and proposal pages gated their Edit, Approve/Reject,
-- Edit-and-approve and Comment controls on vault role alone (canWrite()):
-- a named owner who was a plain viewer saw none of them, even for actions
-- the database already let them take. Wiring web/ to call it is a separate
-- change.
--
-- Deliberately NOT touched, same as 20260928130000_path_ownership.sql:
-- propose() (nothing about ownership changes who may propose) and
-- revise_proposal() (proposer-only; a path's named owner never becomes one
-- for their own owned path, since they write directly instead of
-- proposing, so this never applies to them regardless).

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
  if not private.can_write_path(p.vault_id, p.path) then
    raise exception 'only editors, owners and a path''s named owners comment on proposals' using errcode = '42501';
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

create or replace function public.edit_and_approve(p_proposal uuid, p_body text, p_note text default null)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
begin
  perform private.require_human();
  select * into p from public.proposals where id = p_proposal for update;
  if p.id is null or not private.can_write_path(p.vault_id, p.path) then
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

create function private.writable_path(p_vault uuid, p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.is_member(p_vault), false) and private.can_write_path(p_vault, p_path)
$$;

revoke all on function private.writable_path(uuid, text) from public, anon;
grant execute on function private.writable_path(uuid, text) to authenticated;
