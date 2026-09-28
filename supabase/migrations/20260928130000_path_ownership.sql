-- Path ownership (milestone 3, alongside links; not a numbered milestone
-- of its own). Spec: docs/design.md, "Path ownership". Started early
-- (owner's decision, 2026-09-28), same call as links; this touches the
-- functions every other feature already depends on (policy_for, write_file,
-- delete_file, decide), so it gets at least as much scrutiny as core
-- schema work, not less because it rode in beside a smaller feature.
--
-- A path with named owners narrows policy_for from a fixed per-path
-- setting to one that depends on who's asking: open for the people on its
-- owner list, canon (its existing rule, quorum drawn from that same list)
-- for everyone else. An owner list only attaches to a path that already
-- has an explicit policy rule (public.path_policies): this resolves the
-- open question design.md left about that, in favour of reusing
-- path_policies' existing specificity resolution (exact path, then
-- longest folder prefix) rather than a second, independent one running in
-- parallel. Naming an owner on an otherwise-open path is allowed and
-- harmless (open already means everyone writes directly); it just has no
-- effect until the path's policy becomes canon.
--
-- An owner may be a vault-wide viewer (owner's decision, 2026-09-28):
-- naming one promotes them to write access for that one path, and to
-- calling decide() on proposals for it, without granting anything
-- elsewhere in the vault. Confirming a grant in the product (typed name or
-- a second click) is a web-app concern, not a database one, the same way
-- delete_vault's typed-name confirmation lives in the UI, not here.
--
-- Enforced here:
-- - Members read a vault's path owners (RLS); everyone already saw the
--   underlying path_policies rule.
-- - Naming or removing an owner: owners, in person (require_human; no
--   agent, no token of any kind), matching "Add or edit links" -- err,
--   matching the same ceiling shape as vault admin and links. The target
--   must already be a vault member (any role); the path must already have
--   a policy row (a friendly error names what to do, not a raw foreign-key
--   violation).
-- - write_file, delete_file and decide(): a path's named owners pass the
--   write-access gate for that path alone, on top of (never instead of)
--   the vault's own can_write() check for everyone else. This is the one
--   ripple into functions every other feature already relies on; a path
--   with no owner row behaves exactly as it did before this migration,
--   which the hostile tests prove directly.
-- - decide()'s quorum count: when a path has named owners, only their
--   approvals count, whatever their vault role; otherwise unchanged
--   (any owner or editor, as today).
-- - Deliberately NOT touched in this pass: propose() (a non-owner with
--   vault write access already proposes on a canon path exactly as
--   today; nothing about ownership changes who may propose), and
--   revise_proposal / edit_and_approve / comment_on_proposal (a
--   path-owning viewer can still use plain decide() to approve or reject;
--   the one-step edit-and-approve convenience and commenting stay
--   editor/owner-only for now). Each is a narrower follow-up, not a gap
--   this migration pretends to close.

create table public.path_owners (
  vault_id  uuid not null,
  path      text not null,
  user_id   uuid not null,
  added_by  uuid not null,
  added_at  timestamptz not null default now(),
  primary key (vault_id, path, user_id),
  foreign key (vault_id, path) references public.path_policies (vault_id, path) on delete cascade
);
create index on public.path_owners (vault_id);
create index on public.path_owners (user_id);

alter table public.path_owners enable row level security;
create policy member_read on public.path_owners for select to authenticated
  using (vault_id in (select private.readable_vaults()));
revoke all on public.path_owners from public, anon, authenticated;
grant select on public.path_owners to authenticated;

-- ---------------------------------------------------------------------------
-- Resolution: the same specificity rule policy_for already uses (exact
-- path, then the longest folder prefix), factored out so path ownership
-- and quorum-filtering resolve against the identical rule, never two that
-- could disagree.

create function private.matched_policy_path(p_vault uuid, p_path text) returns text
language sql stable security definer set search_path = '' as $$
  select path from public.path_policies
  where vault_id = p_vault
    and (path = p_path or (right(path, 1) = '/' and starts_with(p_path, path)))
  order by (path = p_path) desc, length(path) desc
  limit 1
$$;

-- Every owner of the path rule that applies to p_path, or no rows if none
-- applies or none is owned.
create function private.path_owner_ids(p_vault uuid, p_path text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select user_id from public.path_owners
  where vault_id = p_vault and path = private.matched_policy_path(p_vault, p_path)
$$;

-- Open for a path's named owners, whatever the underlying rule says;
-- everyone else gets the rule (or the vault default) exactly as before.
-- Same signature as before this migration, so every existing grant and
-- every existing caller (write_file, delete_file, decide, the web app)
-- picks this up with no call site needing to change just to keep working.
create or replace function private.policy_for(p_vault uuid, p_path text,
  out policy text, out quorum int)
language sql stable security definer set search_path = '' as $$
  select
    case when exists (
      select 1 from public.path_owners po
      where po.vault_id = p_vault and po.path = private.matched_policy_path(p_vault, p_path)
        and po.user_id = private.uid()
    ) then 'open' else coalesce(pp.policy, v.default_policy) end,
    coalesce(pp.quorum, 1)
  from public.vaults v
  left join lateral (
    select policy, quorum from public.path_policies
    where vault_id = p_vault
      and (path = p_path or (right(path, 1) = '/' and starts_with(p_path, path)))
    order by (path = p_path) desc, length(path) desc
    limit 1
  ) pp on true
  where v.id = p_vault
$$;

-- can_write(vault), plus a path's named owners for that path alone. Never
-- replaces can_write(); every existing caller with vault-wide write access
-- still passes exactly as before.
create function private.can_write_path(p_vault uuid, p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_write(p_vault) or exists (
    select 1 from public.path_owners po
    where po.vault_id = p_vault and po.path = private.matched_policy_path(p_vault, p_path)
      and po.user_id = private.uid()
  )
$$;

-- ---------------------------------------------------------------------------
-- write_file, delete_file, decide: can_write(vault) becomes
-- can_write_path(vault, path). Nothing else in either function changes.

create or replace function public.write_file(p_vault uuid, p_path text, p_body text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_person();
  perform private.valid_path(p_path);
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if (private.policy_for(p_vault, p_path)).policy <> 'open' then
    raise exception '% is canon: use propose()', p_path using errcode = '42501';
  end if;
  return private.apply_write(p_vault, p_path, p_body, private.uid(), private.agent(), null);
end $$;

create or replace function public.delete_file(p_vault uuid, p_path text)
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
  update public.files set deleted_at = now(), updated_at = now()
  where vault_id = p_vault and path = p_path and deleted_at is null;
  if not found then
    raise exception 'no such file' using errcode = 'P0002';
  end if;
  perform private.log_event(p_vault, 'file.delete', p_path, null, null);
end $$;

create or replace function public.decide(p_proposal uuid, p_decision text, p_note text default null)
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
  select * into p from public.proposals where id = p_proposal for update;
  if p.id is null or not private.can_write_path(p.vault_id, p.path) then
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

-- ---------------------------------------------------------------------------
-- Granting and revoking: owners, in person.

create function public.set_path_owner(p_vault uuid, p_path text, p_user uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners name a path''s owners' using errcode = '42501';
  end if;
  if not exists (select 1 from public.path_policies where vault_id = p_vault and path = p_path) then
    raise exception 'set a policy for % before naming an owner', coalesce(p_path, 'null')
      using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.vault_members where vault_id = p_vault and user_id = p_user) then
    raise exception 'that person isn''t a member of this vault' using errcode = 'P0002';
  end if;
  insert into public.path_owners (vault_id, path, user_id, added_by)
  values (p_vault, p_path, p_user, private.uid())
  on conflict (vault_id, path, user_id) do nothing;
  perform private.log_event(p_vault, 'path_owner.add', p_path, null, null,
    jsonb_build_object('user_id', p_user));
end $$;

create function public.remove_path_owner(p_vault uuid, p_path text, p_user uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners remove a path''s owners' using errcode = '42501';
  end if;
  delete from public.path_owners where vault_id = p_vault and path = p_path and user_id = p_user;
  if not found then
    raise exception '% is not a named owner of %', coalesce(p_user::text, 'null'), coalesce(p_path, 'null')
      using errcode = 'P0002';
  end if;
  perform private.log_event(p_vault, 'path_owner.remove', p_path, null, null,
    jsonb_build_object('user_id', p_user));
end $$;

revoke all on function private.matched_policy_path(uuid, text), private.path_owner_ids(uuid, text),
  private.can_write_path(uuid, text)
  from public, anon, authenticated;

revoke all on function public.set_path_owner(uuid, text, uuid), public.remove_path_owner(uuid, text, uuid)
  from public, anon;
grant execute on function public.set_path_owner(uuid, text, uuid), public.remove_path_owner(uuid, text, uuid)
  to authenticated;
