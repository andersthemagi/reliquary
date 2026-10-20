-- Every write seals (#462, second PR; part of #238; docs/design.md,
-- "Encryption at rest: the content key", sections 2 and 5).
--
-- The servers hold the content key, so they seal a body before it reaches
-- SQL: each function that writes content gains a bytea form that takes the
-- sealed body and does everything but read the text (access, status,
-- locks, counts, the log). What was checked on the text, blank or over a
-- character ceiling, the server checks before sealing; the thread message
-- ceiling stays SQL's refusal, from the count the server passes. The text
-- forms stay for the SQL tests, which hold no key, until the plaintext
-- path goes (#466).
--
-- What SQL hands back as text now comes back as bytes (or base64 inside
-- JSON) for the server to open: the embedding queue, change_notes, the
-- export and read_thread.

-- ---------------------------------------------------------------------------
-- 1. Files

-- The envelope is about 40 bytes over the text (docs/design.md, section 2):
-- a sealed body (first byte NUL) gets that room, so a 1 MiB text still
-- fits and a plaintext one keeps the ceiling as it was. A note's character
-- count is checked on plaintext as before; the servers check a sealed
-- note's before sealing.
create function private.sealed(p bytea) returns boolean
language sql immutable set search_path = '' as $$
  select p is not null and octet_length(p) > 0 and get_byte(p, 0) = 0
$$;
revoke all on function private.sealed(bytea) from public, anon, authenticated;
alter table public.file_versions drop constraint file_versions_body_size;
alter table public.file_versions add constraint file_versions_body_size
  check (octet_length(body) <= 1048576 + case when private.sealed(body) then 64 else 0 end) not valid;
alter table public.proposals drop constraint proposals_body_size;
alter table public.proposals add constraint proposals_body_size
  check (octet_length(body) <= 1048576 + case when private.sealed(body) then 64 else 0 end) not valid;
alter table public.proposal_notes drop constraint proposal_notes_body_size;
alter table public.proposal_notes add constraint proposal_notes_body_size
  check (private.sealed(body) or length(convert_from(body, 'UTF8')) <= 4000) not valid;

create function public.write_file(p_vault uuid, p_path text, p_body bytea, p_expected_version uuid default null,
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
revoke all on function public.write_file(uuid, text, bytea, uuid, text[]) from public, anon;
grant execute on function public.write_file(uuid, text, bytea, uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Proposals and their notes

create function private.add_note(p public.proposals, p_kind text, p_body bytea)
returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.proposal_notes (proposal_id, vault_id, author, agent, revision, kind, body)
  values (p.id, p.vault_id, private.uid(), private.agent(), p.revision, p_kind, p_body)
$$;
revoke all on function private.add_note(public.proposals, text, bytea) from public, anon, authenticated;

create function public.propose(p_vault uuid, p_path text, p_body bytea,
  p_reason text default '', p_delete boolean default false)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
  v_base uuid;
begin
  perform private.require_person();
  perform private.valid_path(p_path);
  if not private.can_write(p_vault) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  select current_version_id into v_base from public.files
  where vault_id = p_vault and path = p_path and deleted_at is null;
  insert into public.proposals (vault_id, kind, path, body, reason, base_version_id,
                                proposed_by, agent)
  values (p_vault, case when p_delete then 'delete' else 'write' end, p_path,
          case when p_delete then null else p_body end, coalesce(p_reason, ''), v_base,
          private.uid(), private.agent())
  returning id into v_id;
  perform private.log_event(p_vault, 'proposal.open', p_path, null, v_id,
    jsonb_build_object('kind', case when p_delete then 'delete' else 'write' end));
  return v_id;
end $$;
revoke all on function public.propose(uuid, text, bytea, text, boolean) from public, anon;
grant execute on function public.propose(uuid, text, bytea, text, boolean) to authenticated;

-- p_note: the reason, sealed, for the note; p_reason: the plain reason the
-- proposal keeps (metadata, shown in lists), or null to keep the old one.
create function public.revise_proposal(p_proposal uuid, p_body bytea, p_reason text, p_note bytea)
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
  perform private.add_note(p, 'revise', p_note);
  perform private.log_event(p.vault_id, 'proposal.revise', p.path, null, p.id,
    jsonb_build_object('revision', p.revision));
  return p.revision;
end $$;
revoke all on function public.revise_proposal(uuid, bytea, text, bytea) from public, anon;
grant execute on function public.revise_proposal(uuid, bytea, text, bytea) to authenticated;

-- The server checked the comment has text and at most 4000 characters.
create function public.comment_on_proposal(p_proposal uuid, p_body bytea)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
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
  if p_body is null or octet_length(p_body) = 0 then
    raise exception 'a comment needs some text' using errcode = '22023';
  end if;
  if (select count(*) from public.proposal_notes
       where proposal_id = p.id and kind = 'comment') >= 200 then
    raise exception 'this thread has reached 200 comments; propose again to continue'
      using errcode = '22023';
  end if;
  insert into public.proposal_notes (proposal_id, vault_id, author, agent, revision, kind, body)
  values (p.id, p.vault_id, private.uid(), private.agent(), p.revision, 'comment', p_body)
  returning id into v_id;
  perform private.log_event(p.vault_id, 'proposal.comment', p.path, null, p.id,
    jsonb_build_object('note', v_id, 'revision', p.revision));
  return v_id;
end $$;
revoke all on function public.comment_on_proposal(uuid, bytea) from public, anon;
grant execute on function public.comment_on_proposal(uuid, bytea) to authenticated;

-- decide and edit_and_approve as 20261019170000_references_from_writer.sql
-- left them, the note sealed: the server passes null for a blank one.
create function public.decide(p_proposal uuid, p_decision text, p_note bytea,
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
  if p_decision <> 'approve' and p_note is null then
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

create function public.edit_and_approve(p_proposal uuid, p_body bytea, p_note bytea,
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
  return public.decide(p.id, 'approve', null::bytea, null, p_references);
end $$;

revoke all on function public.decide(uuid, text, bytea, int, text[]), public.edit_and_approve(uuid, bytea, bytea, int, text[])
  from public, anon;
grant execute on function public.decide(uuid, text, bytea, int, text[]), public.edit_and_approve(uuid, bytea, bytea, int, text[])
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Threads

-- The ceiling private.thread_body checks on the text, from the count the
-- server made before sealing; blank and control characters are the
-- server's to refuse.
create function private.thread_body_fits(p_vault uuid, p_body bytea, p_chars int) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_body is null or octet_length(p_body) = 0 then
    raise exception 'a message needs some text' using errcode = '22023';
  end if;
  if p_chars > private.thread_message_max_chars() then
    perform private.thread_limit_refusal(p_vault, 'thread_message_size', p_chars, private.thread_message_max_chars());
  end if;
end $$;
revoke all on function private.thread_body_fits(uuid, bytea, int) from public, anon, authenticated;

-- No defaults: a call with untyped arguments must still resolve to one
-- open_thread, and the servers pass every argument.
create function public.open_thread(p_vault uuid, p_title text, p_body bytea, p_chars int,
  p_addressees uuid[], p_anchor_path text, p_anchor_step bigint, p_anchor_proposal uuid)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
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
  perform private.thread_body_fits(p_vault, p_body, p_chars);

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
  values (v_thread, p_vault, private.uid(), private.agent(), p_body)
  returning id into v_message;
  perform private.log_event(p_vault, 'thread.open', null, null, null,
    jsonb_build_object('thread', v_thread, 'message', v_message));
  return v_thread;
end $$;

create function public.post_message(p_thread uuid, p_body bytea, p_chars int)
returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid := private.thread_writer(p_thread);
  th public.threads;
  v_message bigint;
begin
  perform private.thread_body_fits(v_vault, p_body, p_chars);
  perform private.lock_thread_vault(v_vault, 'no such thread');
  select * into th from public.threads where id = p_thread for share;
  if th.id is null then
    raise exception 'no such thread' using errcode = 'P0002';
  end if;
  if th.resolved_at is not null then
    raise exception 'this thread is resolved: reopen it to post again' using errcode = '55000';
  end if;
  perform private.require_thread_room(v_vault, 0);
  insert into public.thread_messages (thread_id, vault_id, author, agent, body)
  values (th.id, v_vault, private.uid(), private.agent(), p_body)
  returning id into v_message;
  perform private.log_event(v_vault, 'thread.post', null, null, null,
    jsonb_build_object('thread', th.id, 'message', v_message));
  return v_message;
end $$;

revoke all on function public.open_thread(uuid, text, bytea, int, uuid[], text, bigint, uuid), public.post_message(uuid, bytea, int)
  from public, anon;
grant execute on function public.open_thread(uuid, text, bytea, int, uuid[], text, bigint, uuid), public.post_message(uuid, bytea, int)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4. What comes back as bytes

drop function private.embedding_pending(uuid, int);
create function private.embedding_pending(p_vault uuid, p_max int)
returns table (file_id uuid, version_id uuid, vault_id uuid, body bytea)
language sql stable security definer set search_path = '' as $$
  select q.file_id, q.version_id, q.vault_id, v.body
    from private.embedding_queue q
    join public.file_versions v on v.id = q.version_id
   where q.vault_id = p_vault
     and p_vault in (select private.readable_vaults())
     and v.body is not null
   order by q.queued_at
   limit least(greatest(coalesce(p_max, 8), 1), 50)
$$;
revoke all on function private.embedding_pending(uuid, int) from public, anon;
grant execute on function private.embedding_pending(uuid, int) to authenticated;

drop function public.change_notes(uuid, bigint, bigint);
create function public.change_notes(p_vault uuid, p_after bigint, p_upto bigint)
returns table (seq bigint, note_id uuid, proposal_id uuid, path text, kind text,
  revision int, author uuid, agent text, body bytea, erased boolean, at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select l.seq, n.id, n.proposal_id, l.path, n.kind, n.revision, n.author, n.agent,
         case when n.erased_at is null then n.body end, n.erased_at is not null, n.at
    from public.log l
    join public.proposal_notes n
      on n.proposal_id = l.proposal_id
     and n.vault_id = l.vault_id
     and case l.event
           when 'proposal.comment' then
             n.kind = 'comment' and n.id::text = l.detail ->> 'note'
           when 'proposal.request_changes' then
             n.kind = 'request_changes' and n.revision::text = l.detail ->> 'revision' and n.author = l.actor
           when 'proposal.reject' then
             n.kind = 'reject' and n.revision::text = l.detail ->> 'revision' and n.author = l.actor
           when 'proposal.revise' then
             n.kind = 'revise' and n.revision::text = l.detail ->> 'revision' and n.author = l.actor
           when 'proposal.edit' then
             n.kind = 'edit' and n.revision::text = l.detail ->> 'revision' and n.author = l.actor
           else false
         end
   where l.vault_id = p_vault
     and l.seq > coalesce(p_after, 0)
     and l.seq <= coalesce(p_upto, 0)
   order by l.seq
   limit 500
$$;
revoke all on function public.change_notes(uuid, bigint, bigint) from public, anon;
grant execute on function public.change_notes(uuid, bigint, bigint) to authenticated;

drop function public.export_files(uuid, text, int, uuid);
create function public.export_files(p_vault uuid, p_after text default '', p_limit int default 200,
                                    p_export uuid default null)
returns table (path text, body bytea, updated_at timestamptz, version_id uuid)
language plpgsql stable security definer set search_path = '' as $$
declare v_export uuid;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners export a vault' using errcode = '42501';
  end if;
  select e.id into v_export from private.vault_exports e
   where e.vault_id = p_vault and e.started_by = private.uid()
     and (p_export is null or e.id = p_export)
     and e.started_at > now() - interval '2 hours'
   order by e.started_at desc limit 1;
  if v_export is null then
    raise exception 'this export has expired or was never started: start it again' using errcode = '55000';
  end if;
  return query
    select x.path, fv.body, x.updated_at, fv.id
      from private.vault_export_files x join public.file_versions fv on fv.id = x.version_id
     where x.export_id = v_export and fv.body is not null
       and x.path > coalesce(p_after, '')
     order by x.path
     limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;
revoke all on function public.export_files(uuid, text, int, uuid) from public, anon;
grant execute on function public.export_files(uuid, text, int, uuid) to authenticated;

drop function public.export_messages(uuid, uuid, uuid, bigint, int);
create function public.export_messages(p_vault uuid, p_export uuid, p_thread uuid,
                                       p_after bigint default 0, p_limit int default 500)
returns table (id bigint, author uuid, agent text, at timestamptz, body bytea,
               redacted_at timestamptz, redacted_by uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_started boolean;
  v_last bigint;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners export a vault' using errcode = '42501';
  end if;
  select true, e.last_message_id into v_started, v_last from private.vault_exports e
   where e.id = p_export and e.vault_id = p_vault and e.started_by = private.uid()
     and e.started_at > now() - interval '2 hours';
  if v_started is null then
    raise exception 'this export has expired or was never started: start it again' using errcode = '55000';
  end if;
  return query
    select m.id, m.author, m.agent, m.at, m.body, m.redacted_at, m.redacted_by
      from public.thread_messages m
     where m.vault_id = p_vault and m.thread_id = p_thread
       and m.id <= v_last and m.id > coalesce(p_after, 0)
     order by m.id
     limit least(greatest(coalesce(p_limit, 500), 1), 500);
end $$;
revoke all on function public.export_messages(uuid, uuid, uuid, bigint, int) from public, anon;
grant execute on function public.export_messages(uuid, uuid, uuid, bigint, int) to authenticated;

-- A message's body travels inside the JSON as base64.
create or replace function public.read_thread(p_thread uuid, p_after bigint default null, p_limit int default 100)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_thread jsonb;
  v_messages jsonb;
  v_n int;
begin
  select to_jsonb(s) into v_thread from public.thread_summaries s where s.id = p_thread;
  if v_thread is null then
    raise exception 'no such thread' using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'author', m.author, 'agent', m.agent, 'at', m.at,
           'body', encode(m.body, 'base64'), 'redacted_at', m.redacted_at, 'redacted_by', m.redacted_by) order by m.id)
           filter (where m.n <= v_limit), '[]'::jsonb),
         count(*)
    into v_messages, v_n
    from (select x.*, row_number() over (order by x.id) as n
            from public.thread_messages x
           where x.vault_id = (v_thread ->> 'vault_id')::uuid and x.thread_id = p_thread
             and x.id > coalesce(p_after, 0)
           order by x.id
           limit v_limit + 1) m;
  return jsonb_build_object('thread', v_thread, 'messages', v_messages, 'more', v_n > v_limit);
end $$;
