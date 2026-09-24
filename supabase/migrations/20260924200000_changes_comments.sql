-- The feed carries the discussion: agents learn about new comments and review
-- notes from changes_since, instead of polling read_proposal.
--
-- - The log already records every note-bearing event, without its text:
--   proposal.comment (detail.note names the note), and proposal.
--   request_changes / reject / revise / edit (detail.revision). Bodies stay
--   out of the log, so erasure never has to touch it.
-- - change_notes() returns, for the log events in a seq window, the note each
--   one wrote. It runs as the caller (security invoker), so RLS on both log
--   and proposal_notes decides what comes back: members only, limited by the
--   token's scope through private.role_in(). An erased note comes back with
--   no body and erased = true.
-- - A non-comment event is matched to its note by proposal, kind, revision
--   and author. That is unique: request_changes and reject are one decision
--   per person per revision (the approvals key), and revise and edit each
--   make a new revision.

create or replace function public.change_notes(p_vault uuid, p_after bigint, p_upto bigint)
returns table (seq bigint, note_id uuid, proposal_id uuid, path text, kind text,
  revision int, author uuid, agent text, body text, erased boolean, at timestamptz)
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
