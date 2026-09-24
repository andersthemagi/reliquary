-- Vault administration: rename, default policy, export and delete. See
-- docs/design.md ("Git mirror and export", "Privacy, erasure and
-- compliance") and docs/parity.md.
--
-- Every function here is an owner's, in person (require_human): renaming
-- and the default policy are policy, and exporting and deleting a vault are
-- in the delegation ceiling (AGENTS.md). An agent, an MCP token, an OAuth
-- grant, a CLI grant, an editor, a viewer, an outsider and anonymous are all
-- refused, whatever surface offers the call.
--
-- Deleting a vault is immediate and permanent. The vault row goes, and with
-- it (on delete cascade) every file, version, proposal, approval, note,
-- snooze, rule, membership, environment, variable, ciphertext, log row and
-- env_access_log row. There is no soft-deleted state to guard in every
-- policy, no purge job to run later and no window in which the data still
-- sits in the live database: erasure is done when the call returns.
-- Backups hold it until they age out, as the privacy policy says.
--
-- The log, approvals and env_access_log are append-only, and file_versions
-- and proposal_notes erase-only, by trigger. delete_vault is the one
-- sanctioned way around those triggers: it records the deletion in
-- private.vault_deletions with the current transaction id, and the triggers
-- allow a DELETE only of a row whose vault has such a record in the same
-- transaction. Nothing but delete_vault writes that table (no grants, RLS
-- with no policies), so no caller can forge the marker, and outside a
-- deletion every append-only rule holds exactly as before, even for the
-- table owner. TRUNCATE stays refused always.
--
-- What survives a deletion is private.vault_deletions itself: the vault id,
-- who deleted it, when, and counts. No name, path or text.
--
-- Tokens: a deleted vault's members lose their membership, so role_in gives
-- every token nothing there. Tokens (personal, OAuth and CLI grants) whose
-- only vault it was are revoked too, so none is left live and pointing at
-- nothing; tokens that also reach other vaults keep those.

-- ---------------------------------------------------------------------------
-- Rename and default policy

create function public.rename_vault(p_vault uuid, p_name text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_name text := trim(coalesce(p_name, ''));
  v_old text;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners rename a vault' using errcode = '42501';
  end if;
  if length(v_name) not between 1 and 100 then
    raise exception 'a vault name is 1 to 100 characters' using errcode = '22023';
  end if;
  select name into v_old from public.vaults where id = p_vault for update;
  if v_old = v_name then
    return;
  end if;
  update public.vaults set name = v_name where id = p_vault;
  perform private.log_event(p_vault, 'vault.rename', null, null, null,
    jsonb_build_object('name', v_name, 'previous', v_old));
end $$;

create function public.set_default_policy(p_vault uuid, p_policy text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_old text;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners set the default policy' using errcode = '42501';
  end if;
  if p_policy is null or p_policy not in ('canon', 'open') then
    raise exception 'the default policy is canon or open' using errcode = '22023';
  end if;
  select default_policy into v_old from public.vaults where id = p_vault for update;
  if v_old = p_policy then
    return;
  end if;
  update public.vaults set default_policy = p_policy where id = p_vault;
  perform private.log_event(p_vault, 'vault.default_policy', null, null, null,
    jsonb_build_object('default_policy', p_policy, 'previous', v_old));
end $$;

-- ---------------------------------------------------------------------------
-- Export
--
-- export_vault starts an export: it checks the caller, refuses a vault over
-- the size cap, logs vault.export, and returns the manifest's header (the
-- vault, its rules, its variables' names and environments: never a value,
-- ciphertext or nonce). export_files then returns the current text of live
-- files a page at a time, in path order, so the web app streams an archive
-- without one long transaction. Deleted and erased files are not exported.

-- The largest export, in bytes of current file text (100 MiB).
create function private.export_cap() returns bigint
language sql immutable set search_path = '' as $$ select 104857600::bigint $$;

create function public.export_vault(p_vault uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.vaults;
  v_files int;
  v_bytes bigint;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners export a vault' using errcode = '42501';
  end if;
  select * into v from public.vaults where id = p_vault;
  select count(*), coalesce(sum(octet_length(fv.body)), 0) into v_files, v_bytes
    from public.files f join public.file_versions fv on fv.id = f.current_version_id
   where f.vault_id = p_vault and f.deleted_at is null and fv.body is not null;
  if v_bytes > private.export_cap() then
    raise exception 'this vault holds % MiB of text, over the export limit of % MiB',
      ceil(v_bytes / 1048576.0), private.export_cap() / 1048576 using errcode = '54000';
  end if;
  perform private.log_event(p_vault, 'vault.export', null, null, null,
    jsonb_build_object('files', v_files, 'bytes', v_bytes));
  return jsonb_build_object(
    'vault', jsonb_build_object('id', v.id, 'name', v.name, 'default_policy', v.default_policy,
                                'created_at', v.created_at),
    'exported_at', now(),
    'exported_by', private.uid(),
    'files', v_files,
    'bytes', v_bytes,
    'rules', coalesce((select jsonb_agg(jsonb_build_object('path', pp.path, 'policy', pp.policy,
                                                           'quorum', pp.quorum) order by pp.path)
                         from public.path_policies pp where pp.vault_id = p_vault), '[]'),
    'variables', coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'environments', x.envs)
                                            order by x.name)
                             from (select va.name,
                                          coalesce((select jsonb_agg(vv.environment order by vv.environment)
                                                      from public.variable_values vv
                                                     where vv.variable_id = va.id), '[]') as envs
                                     from public.variables va where va.vault_id = p_vault) x), '[]'));
end $$;

create function public.export_files(p_vault uuid, p_after text default '', p_limit int default 200)
returns table (path text, body text, updated_at timestamptz, version_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners export a vault' using errcode = '42501';
  end if;
  return query
    select f.path, fv.body, f.updated_at, fv.id
      from public.files f join public.file_versions fv on fv.id = f.current_version_id
     where f.vault_id = p_vault and f.deleted_at is null and fv.body is not null
       and f.path > coalesce(p_after, '')
     order by f.path
     limit least(greatest(coalesce(p_limit, 200), 1), 500);
end $$;

-- ---------------------------------------------------------------------------
-- Delete

create table private.vault_deletions (
  vault_id   uuid primary key,
  deleted_by uuid not null,
  deleted_at timestamptz not null default now(),
  txid       bigint not null,
  counts     jsonb not null default '{}'
);
alter table private.vault_deletions enable row level security;
revoke all on private.vault_deletions from public, anon, authenticated;

-- True only inside the transaction that is deleting this vault.
create function private.purging(p_vault uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_vault is not null and exists (
    select 1 from private.vault_deletions d
     where d.vault_id = p_vault and d.txid = txid_current())
$$;

-- The vault a row belongs to, for the append-only triggers: its vault_id,
-- or for an approval, its proposal's.
create function private.row_vault(p_row jsonb) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce((p_row ->> 'vault_id')::uuid,
    (select p.vault_id from public.proposals p where p.id = (p_row ->> 'proposal_id')::uuid))
$$;

-- Append-only, except a delete by delete_vault (see the top of this file).
create or replace function private.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and tg_level = 'ROW' and private.purging(private.row_vault(to_jsonb(old))) then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;

create or replace function private.versions_erase_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if private.purging(old.vault_id) then
      return old;
    end if;
    raise exception 'file_versions rows are never deleted' using errcode = '42501';
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
  if new.body is not null or new.erased_at is null or new.id <> old.id
     or new.author <> old.author or new.at <> old.at or new.kind <> old.kind then
    raise exception 'proposal_notes rows can only be erased' using errcode = '42501';
  end if;
  return new;
end $$;

-- The deletion record itself is never changed, even during a deletion.
create function private.forbid_any_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
create trigger vault_deletions_append_only before update or delete on private.vault_deletions
  for each row execute function private.forbid_any_change();
create trigger vault_deletions_no_truncate before truncate on private.vault_deletions
  for each statement execute function private.forbid_any_change();

-- p_confirm_name: the vault's name as the person typed it. The database
-- checks it too, so no surface can skip the confirmation.
create function public.delete_vault(p_vault uuid, p_confirm_name text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.vaults;
  v_counts jsonb;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners delete a vault' using errcode = '42501';
  end if;
  select * into v from public.vaults where id = p_vault for update;
  if p_confirm_name is null or trim(p_confirm_name) <> v.name then
    raise exception 'type the vault''s name exactly to delete it' using errcode = '22023';
  end if;

  v_counts := jsonb_build_object(
    'members',   (select count(*) from public.vault_members where vault_id = p_vault),
    'files',     (select count(*) from public.files where vault_id = p_vault),
    'versions',  (select count(*) from public.file_versions where vault_id = p_vault),
    'proposals', (select count(*) from public.proposals where vault_id = p_vault),
    'variables', (select count(*) from public.variables where vault_id = p_vault),
    'log',       (select count(*) from public.log where vault_id = p_vault));

  -- The marker the append-only triggers look for, and the only record kept.
  insert into private.vault_deletions (vault_id, deleted_by, txid, counts)
  values (p_vault, private.uid(), txid_current(), v_counts);

  -- Tokens whose only vault this was reach nothing now; revoke them.
  update public.access_tokens set revoked_at = now()
   where revoked_at is null and not all_vaults and vault_ids <@ array[p_vault];

  -- Approvals hang off proposals, not the vault: delete them while their
  -- proposals still say which vault they're in. Then the vault, and with it
  -- everything else (on delete cascade), ciphertexts included.
  delete from public.approvals a using public.proposals p
   where p.id = a.proposal_id and p.vault_id = p_vault;
  delete from public.vaults where id = p_vault;
  return v_counts;
end $$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function public.rename_vault(uuid, text), public.set_default_policy(uuid, text),
  public.export_vault(uuid), public.export_files(uuid, text, int), public.delete_vault(uuid, text)
  from public, anon;
grant execute on function public.rename_vault(uuid, text), public.set_default_policy(uuid, text),
  public.export_vault(uuid), public.export_files(uuid, text, int), public.delete_vault(uuid, text)
  to authenticated;

revoke all on function private.export_cap(), private.purging(uuid), private.row_vault(jsonb),
  private.forbid_any_change() from public, anon, authenticated;
