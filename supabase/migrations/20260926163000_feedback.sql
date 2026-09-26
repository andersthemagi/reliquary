-- Feedback and bug reports (docs/public/how-to/send-feedback.md; hostile
-- tests in supabase/tests/feedback_test.sql).
--
-- A person, in the web UI or through their agent over MCP, sends a bug, an
-- idea, a question or other feedback to the operator of this Reliquary (the
-- hosted service's, or a self-hosted instance's own: never anyone else).
--
-- 1. public.feedback: one row per message. RLS: a person reads their own
--    rows (what they sent and what their agents sent), nothing else; no
--    API role writes the table directly. The notice columns (notified_at
--    and the claim) are for the web app's mailer and aren't granted to
--    people.
-- 2. public.send_feedback(kind, message, vault, context): the only way in.
--    Any signed-in person, and any of their agents' connections, read-only
--    ones included: it writes nothing to a vault (docs/parity.md). A CLI
--    grant is refused (it only reads variables, private.require_person).
--    The message is trimmed, 1 to 5000 characters, with no control
--    characters but line breaks and tabs; the vault, when given, must be
--    one the caller (and their connection) can see; the context (the page
--    it was sent from, or what the agent was doing) is one line of at most
--    500 characters. Who sent it is recorded from the request, never taken
--    from the caller: the person, and for an agent the connection's name
--    and the client name it reported (access_tokens.client_name).
--    At most 20 an hour per person, web and agents together (54000).
-- 3. The operator (reliquary_ops, scripts/feedback.sh): lists, reads, and
--    sets a status (new, seen, planned, fixed, wont_fix) and a reply the
--    sender sees. No API role can.
-- 4. Notices by email (web/src/feedback.ts): the web app claims messages
--    not yet notified, emails the operator, and marks them notified. A
--    claim lapses after 10 minutes (a send that died with its instance is
--    tried again), at most 5 tries, and only for messages from the last 7
--    days. Failing to notify never touches the message itself. Only the
--    web app's role may claim.
-- 5. Deleting an account deletes its feedback; deleting a vault keeps the
--    feedback that named it, without the vault.

-- ---------------------------------------------------------------------------
-- 1. The table

create table public.feedback (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null,
  kind              text not null check (kind in ('bug', 'idea', 'question', 'other')),
  message           text not null check (
                      length(message) between 1 and 5000
                      and message = btrim(message, E' \t\r\n')
                      and message !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  vault_id          uuid references public.vaults (id) on delete set null,
  context           text check (length(context) between 1 and 500 and context !~ '[[:cntrl:]]'),
  source            text not null check (source in ('web', 'agent')),
  agent             text check (length(agent) <= 200),
  client_name       text check (length(client_name) <= 100),
  created_at        timestamptz not null default now(),
  status            text not null default 'new'
                      check (status in ('new', 'seen', 'planned', 'fixed', 'wont_fix')),
  status_at         timestamptz,
  reply             text check (length(reply) between 1 and 5000 and reply !~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]'),
  replied_at        timestamptz,
  notified_at       timestamptz,
  notify_claimed_at timestamptz,
  notify_attempts   int not null default 0 check (notify_attempts between 0 and 5),
  check ((source = 'web') = (agent is null))
);
create index feedback_user_created_idx on public.feedback (user_id, created_at desc);
create index feedback_status_created_idx on public.feedback (status, created_at desc);
-- For deleting a vault (the foreign key sets it to null).
create index feedback_vault_idx on public.feedback (vault_id) where vault_id is not null;
create index feedback_unnotified_idx on public.feedback (created_at) where notified_at is null;

alter table public.feedback enable row level security;
revoke all on public.feedback from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
grant select (id, user_id, kind, message, vault_id, context, source, agent, client_name, created_at,
              status, status_at, reply, replied_at)
  on public.feedback to authenticated;

-- Your own feedback, and your agents'. A CLI grant reads only variables.
create policy feedback_select_own on public.feedback for select to authenticated
  using (user_id = private.uid() and private.token_kind() is distinct from 'cli');

-- ---------------------------------------------------------------------------
-- 2. Sending

create function private.feedback_rate() returns int
language sql immutable set search_path = '' as $$ select 20 $$;

create function public.send_feedback(p_kind text, p_message text, p_vault uuid default null, p_context text default null)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_message text := btrim(coalesce(p_message, ''), E' \t\r\n');
  v_context text := nullif(left(btrim(regexp_replace(coalesce(p_context, ''), '[[:cntrl:]]+', ' ', 'g')), 500), '');
  v_agent text := private.agent();
  v_client text;
  v_id uuid;
begin
  perform private.require_person();
  -- An agent's request must come through a live token of this person's.
  if private.token_id() is not null then
    select t.client_name into v_client from public.access_tokens t
     where t.id = private.token_id() and t.user_id = private.uid()
       and t.revoked_at is null and t.expires_at > now();
    if not found then
      raise exception 'this connection was revoked or has expired: reconnect, then send the feedback again' using errcode = '42501';
    end if;
  end if;
  if p_kind is null or p_kind not in ('bug', 'idea', 'question', 'other') then
    raise exception 'choose what kind of feedback this is: bug, idea, question or other' using errcode = '22023';
  end if;
  if v_message = '' then
    raise exception 'write a message: feedback can''t be empty' using errcode = '22023';
  end if;
  if length(v_message) > 5000 then
    raise exception 'feedback is at most 5000 characters (this is %): shorten it or summarise the log', length(v_message)
      using errcode = '22023';
  end if;
  if v_message ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    raise exception 'feedback can''t contain control characters other than line breaks and tabs' using errcode = '22023';
  end if;
  if p_vault is not null and private.role_in(p_vault) is null then
    raise exception 'no vault with that id is available to you: leave the vault out, or choose one you''re a member of'
      using errcode = 'P0002';
  end if;
  -- One person's feedback, counted one call at a time, web and agents together.
  perform pg_advisory_xact_lock(hashtextextended('reliquary.feedback_rate:' || private.uid()::text, 0));
  if (select count(*) from public.feedback
       where user_id = private.uid() and created_at > now() - interval '1 hour') >= private.feedback_rate() then
    raise exception 'you have sent % feedback messages in the last hour, the most an hour takes: send this one after %',
        private.feedback_rate(),
        (select to_char((min(created_at) + interval '1 hour') at time zone 'UTC', 'HH24:MI "UTC"')
           from (select created_at from public.feedback
                  where user_id = private.uid() and created_at > now() - interval '1 hour'
                  order by created_at desc limit private.feedback_rate()) x)
      using errcode = '54000';
  end if;
  insert into public.feedback (user_id, kind, message, vault_id, context, source, agent, client_name)
  values (private.uid(), p_kind, v_message, p_vault, v_context,
          case when v_agent is null then 'web' else 'agent' end,
          left(v_agent, 200), left(v_client, 100))
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The operator's controls: postgres and reliquary_ops only

create function private.feedback_status_label(p_status text) returns text
language sql immutable set search_path = '' as $$
  select case p_status when 'wont_fix' then 'won''t fix' else p_status end
$$;

-- Newest first; p_status 'all' or one status. One line of each message.
create function private.feedback_list(p_status text default 'new', p_limit int default 50)
returns table (id uuid, sent text, kind text, sender text, via text, status text, notice text, message text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_status is null or p_status not in ('all', 'new', 'seen', 'planned', 'fixed', 'wont_fix') then
    raise exception 'a status is all, new, seen, planned, fixed or wont_fix' using errcode = '22023';
  end if;
  return query
    select f.id, to_char(f.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), f.kind,
           coalesce(private.email_of(f.user_id), f.user_id::text),
           case when f.source = 'web' then 'web UI' else 'agent: ' || f.agent end,
           private.feedback_status_label(f.status) || case when f.reply is not null then ' (replied)' else '' end,
           case when f.notified_at is not null then 'emailed'
                when f.notify_attempts >= 5 then 'not emailed (5 tries)'
                else 'not emailed' end,
           left(regexp_replace(f.message, '\s+', ' ', 'g'), 100)
      from public.feedback f
     where p_status = 'all' or f.status = p_status
     order by f.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 500));
end $$;

-- One message in full, with where it came from.
create function private.feedback_show(p_id uuid)
returns table (field text, value text)
language plpgsql stable security definer set search_path = '' as $$
declare
  f public.feedback;
begin
  select * into f from public.feedback where id = p_id;
  if f.id is null then
    raise exception 'no feedback with that id' using errcode = 'P0002';
  end if;
  return query values
    ('id', f.id::text),
    ('sent', to_char(f.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')),
    ('kind', f.kind),
    ('from', coalesce(private.email_of(f.user_id), 'account ' || f.user_id::text)),
    ('via', case when f.source = 'web' then 'web UI'
                 else 'agent: ' || f.agent || coalesce(' (client: ' || f.client_name || ')', '') end),
    ('vault', case when f.vault_id is null then '' else
       coalesce((select v.name from public.vaults v where v.id = f.vault_id), '') || ' (' || f.vault_id::text || ')' end),
    ('context', coalesce(f.context, '')),
    ('status', private.feedback_status_label(f.status)
       || coalesce(', since ' || to_char(f.status_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"'), '')),
    ('notice', case when f.notified_at is not null
                    then 'emailed ' || to_char(f.notified_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"')
                    else 'not emailed (' || f.notify_attempts || ' tries)' end),
    ('message', f.message),
    ('reply', coalesce(f.reply, ''));
end $$;

create function private.set_feedback_status(p_id uuid, p_status text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old text;
begin
  if p_status is null or p_status not in ('new', 'seen', 'planned', 'fixed', 'wont_fix') then
    raise exception 'a status is new, seen, planned, fixed or wont_fix' using errcode = '22023';
  end if;
  select f.status into v_old from public.feedback f where f.id = p_id for update;
  if v_old is null then
    raise exception 'no feedback with that id' using errcode = 'P0002';
  end if;
  update public.feedback set status = p_status, status_at = now() where id = p_id;
  return format('%s -> %s', private.feedback_status_label(v_old), private.feedback_status_label(p_status));
end $$;

-- The reply the sender sees (web UI and list_my_feedback). Empty clears it.
create function private.set_feedback_reply(p_id uuid, p_reply text) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_reply text := nullif(btrim(coalesce(p_reply, ''), E' \t\r\n'), '');
begin
  if length(v_reply) > 5000 then
    raise exception 'a reply is at most 5000 characters' using errcode = '22023';
  end if;
  if v_reply ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    raise exception 'a reply can''t contain control characters other than line breaks and tabs' using errcode = '22023';
  end if;
  update public.feedback set reply = v_reply, replied_at = case when v_reply is null then null else now() end
   where id = p_id;
  if not found then
    raise exception 'no feedback with that id' using errcode = 'P0002';
  end if;
  return case when v_reply is null then 'reply cleared' else 'reply saved' end;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Notices, for the web app's mailer

-- Up to p_limit messages to email the operator about, claimed for 10
-- minutes. Only what the notice says: kind, the first 600 characters, who
-- sent it and how.
create function private.claim_feedback_notices(p_limit int)
returns table (id uuid, kind text, message text, more boolean, sender text, via text, vault text, context text, created_at timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
begin
  return query
    with c as (
      select f.id from public.feedback f
       where f.notified_at is null and f.notify_attempts < 5
         and f.created_at > now() - interval '7 days'
         and (f.notify_claimed_at is null or f.notify_claimed_at < now() - interval '10 minutes')
       order by f.created_at
       limit greatest(1, least(coalesce(p_limit, 5), 20))
       for update skip locked
    ), u as (
      update public.feedback f set notify_claimed_at = now(), notify_attempts = f.notify_attempts + 1
        from c where f.id = c.id
      returning f.*
    )
    select u.id, u.kind, left(u.message, 600), length(u.message) > 600,
           coalesce(private.email_of(u.user_id), 'account ' || u.user_id::text),
           case when u.source = 'web' then 'the web UI'
                else 'an agent (' || u.agent || coalesce(', ' || u.client_name, '') || ')' end,
           (select v.name from public.vaults v where v.id = u.vault_id),
           u.context, u.created_at
      from u order by u.created_at;
end $$;

create function private.feedback_notified(p_id uuid) returns void
language sql volatile security definer set search_path = '' as $$
  update public.feedback set notified_at = now() where id = p_id and notified_at is null
$$;

-- ---------------------------------------------------------------------------
-- 5. Deleting an account (20260926140200_delete_account.sql)

-- A person's feedback is theirs, not a vault's: it goes with their account,
-- in the same transaction as public.delete_account, which records the
-- deletion in private.deleted_accounts. (A notice already emailed to the
-- operator can't be taken back.)
create function private.forget_feedback() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
begin
  delete from public.feedback where user_id = new.user_id;
  return new;
end $$;
create trigger deleted_accounts_forget_feedback after insert on private.deleted_accounts
  for each row execute function private.forget_feedback();

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.feedback_rate(), private.feedback_status_label(text),
  private.feedback_list(text, int), private.feedback_show(uuid), private.set_feedback_status(uuid, text),
  private.set_feedback_reply(uuid, text), private.claim_feedback_notices(int), private.feedback_notified(uuid),
  private.forget_feedback()
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
grant execute on function private.feedback_list(text, int), private.feedback_show(uuid),
  private.set_feedback_status(uuid, text), private.set_feedback_reply(uuid, text)
  to reliquary_ops;
grant execute on function private.claim_feedback_notices(int), private.feedback_notified(uuid) to reliquary_web;

revoke all on function public.send_feedback(text, text, uuid, text) from public, anon;
grant execute on function public.send_feedback(text, text, uuid, text) to authenticated;
