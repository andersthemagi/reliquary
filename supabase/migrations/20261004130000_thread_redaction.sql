-- Redacting a thread message. Messages are append-only
-- (20261004100000_threads.sql), and a person can still paste a secret into
-- one. Redaction is the one way out: the vault's owner, in person in the
-- web app (require_human, so never an agent, a token or a connected app),
-- blanks a message's body. The message keeps its place, author, agent and
-- time, and says who redacted it and when; the table's trigger allows that
-- change and no other, once.
--
-- Modelled on erase_file: the owner only, in person, the text gone and a
-- log row saying it happened (thread.redact, with the thread's and the
-- message's ids). The log never held the text (20261004110000_thread_writes),
-- so nothing of it is left there either. A secret belongs in a variable,
-- never in a thread; redaction cleans up after a mistake, and doesn't take
-- back what anyone already read.
--
-- Lock order as in 20261004110000_thread_writes: the vault's row, then the
-- message's.
create function public.redact_message(p_message bigint)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
  m public.thread_messages;
begin
  perform private.require_human();
  select x.vault_id into v_vault from public.thread_messages x where x.id = p_message;
  if v_vault is null or private.role_in(v_vault) is null then
    raise exception 'no such message' using errcode = 'P0002';
  end if;
  if private.role_in(v_vault) is distinct from 'owner' then
    raise exception 'only owners redact messages' using errcode = '42501';
  end if;
  perform 1 from public.vaults where id = v_vault for key share;
  select * into m from public.thread_messages where id = p_message for update;
  if m.id is null then
    raise exception 'no such message' using errcode = 'P0002';
  end if;
  if m.redacted_at is not null then
    raise exception 'this message is already redacted' using errcode = '55000';
  end if;
  update public.thread_messages set body = null, redacted_at = now(), redacted_by = private.uid()
   where id = m.id;
  perform private.log_event(v_vault, 'thread.redact', null, null, null,
    jsonb_build_object('thread', m.thread_id, 'message', m.id));
end $$;

revoke all on function public.redact_message(bigint) from public, anon;
grant execute on function public.redact_message(bigint) to authenticated;
