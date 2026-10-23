-- The backfill and the content key's rotation (#465, step 3 of #238;
-- docs/design.md, "Encryption at rest: the content key", section 6).
--
-- Rows written before writes sealed are plain bytes; rows sealed under a
-- key that is being retired name it in their envelope. The operator's
-- re-encryption (web/src/seal-content.ts, run by scripts/seal-content.sh as
-- reliquary_ops, the role that serves no requests) reads those rows a batch
-- at a time, opens and seals each under the current key in the app, and
-- swaps the body in place. Nothing else about a row changes: no version,
-- author, time, log row or feed entry, since the text is the same.
--
-- file_versions, proposal_notes and thread_messages only ever lose a body
-- (erasure, redaction), and their triggers say so. They let one more
-- change through: a body swapped for a sealed one, every other column as
-- it was, inside private.seal_content's own transaction (recorded in
-- private.content_sealings, a table no role can write, not a setting any
-- role could set). The same marker keeps the swap from being refused by a
-- vault's storage limit: the envelope's ~40 bytes still count, but a vault
-- at its limit must still be sealable.

create table private.content_sealings (txid bigint primary key);
alter table private.content_sealings enable row level security;
revoke all on private.content_sealings from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;

create function private.sealing_content() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.content_sealings where txid = txid_current())
$$;

-- The key id a stored body names, or null for plain bytes. Reads only the
-- head (a key id is at most 32 bytes), so a large toasted body isn't
-- decompressed whole; escape-encoded so stray bytes can't make it fail.
create function private.content_key_id(p bytea) returns text
language sql immutable set search_path = '' as $$
  select case when private.sealed(h) then encode(substring(h from 3 for get_byte(h, 1)), 'escape') end
    from (select substring(p from 1 for 34) as h) s
$$;

-- ---------------------------------------------------------------------------
-- 1. The three append-only tables let the swap through

create or replace function private.versions_erase_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if private.purging(old.vault_id) then
      return old;
    end if;
    raise exception 'file_versions rows are never deleted' using errcode = '42501';
  end if;
  if private.sealing_content() and old.body is not null and private.sealed(new.body)
     and to_jsonb(new) - 'body' = to_jsonb(old) - 'body' then
    return new;
  end if;
  if new.body is not null or new.erased_at is null
     or new.id <> old.id or new.file_id <> old.file_id or new.author <> old.author
     or new.created_at <> old.created_at then
    raise exception 'file_versions rows can only be erased' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function private.notes_erase_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if private.purging(old.vault_id) then
      return old;
    end if;
    raise exception 'proposal_notes rows are never deleted' using errcode = '42501';
  end if;
  if private.sealing_content() and old.body is not null and private.sealed(new.body)
     and to_jsonb(new) - 'body' = to_jsonb(old) - 'body' then
    return new;
  end if;
  if new.body is not null or new.erased_at is null or new.id <> old.id
     or new.author <> old.author or new.at <> old.at or new.kind <> old.kind then
    raise exception 'proposal_notes rows can only be erased' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function private.thread_messages_redact_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if private.purging(old.vault_id) then
      return old;
    end if;
    raise exception 'thread messages are never deleted' using errcode = '42501';
  end if;
  if private.sealing_content() and old.body is not null and private.sealed(new.body)
     and to_jsonb(new) - 'body' = to_jsonb(old) - 'body' then
    return new;
  end if;
  if old.redacted_at is not null or new.body is not null or new.redacted_at is null or new.redacted_by is null
     or new.id <> old.id or new.thread_id <> old.thread_id or new.vault_id <> old.vault_id
     or new.author <> old.author or new.agent is distinct from old.agent or new.at <> old.at then
    raise exception 'thread messages can only be redacted' using errcode = '42501';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Storage limits don't refuse it

create or replace function private.add_storage(p_vault uuid, p_delta bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_now bigint;
  v_max bigint;
begin
  update private.vault_storage set bytes = bytes + p_delta where vault_id = p_vault
  returning bytes into v_now;
  if not found or p_delta <= 0 or private.sealing_content() then
    return;
  end if;
  v_max := (private.vault_limits(p_vault)).max_bytes;
  if v_now > v_max then
    perform private.storage_refusal(p_vault, v_now - p_delta, p_delta);
  end if;
end $$;

create or replace function private.proposal_fits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_used bigint;
  v_add bigint := coalesce(octet_length(new.body), 0);
begin
  if new.kind <> 'write' or v_add = 0 or new.status not in ('open', 'changes_requested')
     or private.sealing_content() then
    return new;
  end if;
  select s.bytes into v_used from private.vault_storage s where s.vault_id = new.vault_id;
  if v_used + v_add > (private.vault_limits(new.vault_id)).max_bytes then
    perform private.storage_refusal(new.vault_id, v_used, v_add);
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 3. The operator's functions

-- How many stored bodies each content table holds under each key id (null:
-- plain bytes). Counts only.
create function private.content_key_ids()
returns table (content text, key_id text, n bigint)
language sql stable security definer set search_path = '' as $$
  select x.content, x.key_id, count(*)
    from (
      select 'file_versions' as content, private.content_key_id(body) as key_id from public.file_versions where body is not null
      union all
      select 'proposals', private.content_key_id(body) from public.proposals where body is not null
      union all
      select 'proposal_notes', private.content_key_id(body) from public.proposal_notes where body is not null
      union all
      select 'thread_messages', private.content_key_id(body) from public.thread_messages where body is not null
      union all
      select 'file_embeddings', private.content_key_id(embedding) from public.file_embeddings
    ) x
   group by x.content, x.key_id
   order by x.content, x.key_id nulls first
$$;

-- The next batch of one table's bodies that aren't sealed under p_key, in
-- key order after p_after ('' for the start: a row's ref as this returned
-- it), so a run walks each table once and a row that won't open is passed,
-- not read again. Resuming is starting again: what is sealed is skipped.
create function private.content_to_seal(p_content text, p_key text, p_after text, p_limit int)
returns table (ref text, vault_id uuid, body bytea)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_uuid uuid;
begin
  if p_content <> 'thread_messages' then
    v_uuid := coalesce(nullif(split_part(coalesce(p_after, ''), ':', 1), '')::uuid, '00000000-0000-0000-0000-000000000000');
  end if;
  if p_content = 'file_versions' then
    return query select t.id::text, t.vault_id, t.body from public.file_versions t
      where t.id > v_uuid and t.body is not null and private.content_key_id(t.body) is distinct from p_key
      order by t.id limit v_limit;
  elsif p_content = 'proposals' then
    return query select t.id::text, t.vault_id, t.body from public.proposals t
      where t.id > v_uuid and t.body is not null and private.content_key_id(t.body) is distinct from p_key
      order by t.id limit v_limit;
  elsif p_content = 'proposal_notes' then
    return query select t.id::text, t.vault_id, t.body from public.proposal_notes t
      where t.id > v_uuid and t.body is not null and private.content_key_id(t.body) is distinct from p_key
      order by t.id limit v_limit;
  elsif p_content = 'thread_messages' then
    return query select t.id::text, t.vault_id, t.body from public.thread_messages t
      where t.id > coalesce(nullif(p_after, '')::bigint, 0) and t.body is not null
        and private.content_key_id(t.body) is distinct from p_key
      order by t.id limit v_limit;
  elsif p_content = 'file_embeddings' then
    return query select t.file_id::text || ':' || t.chunk, t.vault_id, t.embedding from public.file_embeddings t
      where (t.file_id, t.chunk) > (v_uuid, coalesce(nullif(split_part(coalesce(p_after, ''), ':', 2), '')::smallint, -1::smallint))
        and private.content_key_id(t.embedding) is distinct from p_key
      order by t.file_id, t.chunk limit v_limit;
  else
    raise exception 'no content table %', p_content using errcode = '22023';
  end if;
end $$;

-- Swaps in sealed bodies: p_items is [{ref, vault, old, body}], old the
-- SHA-256 (hex) of the body that was read and body the sealed one
-- (base64). A row whose body changed since (erased, redacted, revised) is
-- left alone. Returns how many were swapped.
create function private.seal_content(p_content text, p_items jsonb)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n int;
begin
  if p_content not in ('file_versions', 'proposals', 'proposal_notes', 'thread_messages', 'file_embeddings') then
    raise exception 'no content table %', p_content using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(coalesce(p_items, '[]')) as i(body text)
              where not coalesce(private.sealed(decode(i.body, 'base64')), false)) then
    raise exception 'only a sealed body can replace a stored one' using errcode = '22023';
  end if;
  insert into private.content_sealings values (txid_current()) on conflict do nothing;
  if p_content = 'file_versions' then
    update public.file_versions t set body = decode(i.body, 'base64')
      from jsonb_to_recordset(p_items) as i(ref text, vault uuid, old text, body text)
     where t.id = i.ref::uuid and t.vault_id = i.vault and sha256(t.body) = decode(i.old, 'hex');
  elsif p_content = 'proposals' then
    update public.proposals t set body = decode(i.body, 'base64')
      from jsonb_to_recordset(p_items) as i(ref text, vault uuid, old text, body text)
     where t.id = i.ref::uuid and t.vault_id = i.vault and sha256(t.body) = decode(i.old, 'hex');
  elsif p_content = 'proposal_notes' then
    update public.proposal_notes t set body = decode(i.body, 'base64')
      from jsonb_to_recordset(p_items) as i(ref text, vault uuid, old text, body text)
     where t.id = i.ref::uuid and t.vault_id = i.vault and sha256(t.body) = decode(i.old, 'hex');
  elsif p_content = 'thread_messages' then
    update public.thread_messages t set body = decode(i.body, 'base64')
      from jsonb_to_recordset(p_items) as i(ref text, vault uuid, old text, body text)
     where t.id = i.ref::bigint and t.vault_id = i.vault and sha256(t.body) = decode(i.old, 'hex');
  else
    update public.file_embeddings t set embedding = decode(i.body, 'base64')
      from jsonb_to_recordset(p_items) as i(ref text, vault uuid, old text, body text)
     where t.file_id = split_part(i.ref, ':', 1)::uuid and t.chunk = split_part(i.ref, ':', 2)::smallint
       and t.vault_id = i.vault and sha256(t.embedding) = decode(i.old, 'hex');
  end if;
  get diagnostics v_n = row_count;
  delete from private.content_sealings where txid = txid_current();
  return v_n;
end $$;

revoke all on function private.sealing_content(), private.content_key_id(bytea), private.content_key_ids(),
  private.content_to_seal(text, text, text, int), private.seal_content(text, jsonb)
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
grant execute on function private.content_key_ids(), private.content_to_seal(text, text, text, int),
  private.seal_content(text, jsonb)
  to reliquary_ops;
