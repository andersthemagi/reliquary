-- Writers convert text to bytes themselves (#462, follow-up to
-- 20261019150000_content_bytea). That migration first relied on an
-- assignment cast (text as bytea) so the write functions could stay as
-- they were; a cast between two built-in types needs their owner, which
-- hosted Supabase's postgres role is not (v0.27.0's deploy: "must be owner
-- of type text or type bytea"), so the cast is gone and each function that
-- stores a body says convert_to(..., 'UTF8') where it assigns one. The
-- definitions below are the latest ones, that one expression changed in
-- each; erase_file and redact_message set null and need nothing.

-- from 20260924150000_review.sql
create or replace function private.add_note(p public.proposals, p_kind text, p_body text)
returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.proposal_notes (proposal_id, vault_id, author, agent, revision, kind, body)
  values (p.id, p.vault_id, private.uid(), private.agent(), p.revision, p_kind, convert_to(nullif(trim(p_body), ''), 'UTF8'))
$$;

-- from 20261002100000_path_owner_review_parity.sql
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
  values (p.id, p.vault_id, private.uid(), private.agent(), p.revision, 'comment', convert_to(v_body, 'UTF8'))
  returning id into v_id;
  perform private.log_event(p.vault_id, 'proposal.comment', p.path, null, p.id,
    jsonb_build_object('revision', p.revision, 'note', v_id));
  return v_id;
end $$;

-- from 20261019170000_references_from_writer.sql
create or replace function public.edit_and_approve(p_proposal uuid, p_body text, p_note text default null,
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
  set body = convert_to(p_body, 'UTF8'), revision = revision + 1, status = 'open', edited_by = private.uid()
  where id = p.id
  returning * into p;
  perform private.add_note(p, 'edit', p_note);
  perform private.log_event(p.vault_id, 'proposal.edit', p.path, null, p.id,
    jsonb_build_object('revision', p.revision));
  return public.decide(p.id, 'approve', null, null, p_references);
end $$;

-- from 20261004110000_thread_writes.sql
create or replace function public.open_thread(p_vault uuid, p_title text, p_body text,
  p_addressees uuid[] default null, p_anchor_path text default null,
  p_anchor_step bigint default null, p_anchor_proposal uuid default null)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
  v_body text;
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
  v_body := private.thread_body(p_vault, p_body);

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
  values (v_thread, p_vault, private.uid(), private.agent(), convert_to(v_body, 'UTF8'))
  returning id into v_message;
  perform private.log_event(p_vault, 'thread.open', null, null, null,
    jsonb_build_object('thread', v_thread, 'message', v_message));
  return v_thread;
end $$;

-- from 20261004110000_thread_writes.sql
create or replace function public.post_message(p_thread uuid, p_body text)
returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid := private.thread_writer(p_thread);
  v_body text := private.thread_body(v_vault, p_body);
  th public.threads;
  v_message bigint;
begin
  perform private.lock_thread_vault(v_vault, 'no such thread');
  -- For share: a resolve waits for this post, and this post for a resolve.
  select * into th from public.threads where id = p_thread for share;
  if th.id is null then
    raise exception 'no such thread' using errcode = 'P0002';
  end if;
  if th.resolved_at is not null then
    raise exception 'this thread is resolved: reopen it to post again' using errcode = '55000';
  end if;
  perform private.require_thread_room(v_vault, 0);
  insert into public.thread_messages (thread_id, vault_id, author, agent, body)
  values (th.id, v_vault, private.uid(), private.agent(), convert_to(v_body, 'UTF8'))
  returning id into v_message;
  perform private.log_event(v_vault, 'thread.post', null, null, null,
    jsonb_build_object('thread', th.id, 'message', v_message));
  return v_message;
end $$;

-- from 20260924120000_core.sql
create or replace function public.propose(p_vault uuid, p_path text, p_body text,
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
          case when p_delete then null else convert_to(p_body, 'UTF8') end, coalesce(p_reason, ''), v_base,
          private.uid(), private.agent())
  returning id into v_id;
  perform private.log_event(p_vault, 'proposal.open', p_path, null, v_id,
    jsonb_build_object('kind', case when p_delete then 'delete' else 'write' end));
  return v_id;
end $$;

-- from 20261009190428_proposal_approval_integrity.sql
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
  set body = convert_to(p_body, 'UTF8'), reason = coalesce(nullif(trim(p_reason), ''), reason),
      revision = revision + 1, status = 'open', edited_by = null
  where id = p.id
  returning * into p;
  perform private.add_note(p, 'revise', p_reason);
  perform private.log_event(p.vault_id, 'proposal.revise', p.path, null, p.id,
    jsonb_build_object('revision', p.revision));
  return p.revision;
end $$;
