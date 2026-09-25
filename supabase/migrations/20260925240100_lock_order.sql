-- Lock order, found by stress-testing plans, limits and invites
-- (web/test/races.test.mjs, "races, lock order"). Two operations that lock
-- the same rows in opposite orders deadlock (40P01: Postgres aborts one of
-- them) when their steps interleave. Found and fixed here:
-- - erase_file locked a file's versions (and, through the storage
--   trigger, the vault's counter) before the file's row, and a write
--   locks the file's row before the counter. A write and an erasure of
--   the same file at once deadlocked (21 of 96 operations in a run of
--   mixed writes, deletes and erasures). erase_file now locks the file's
--   row first.
-- - accept_invite locked the invite, then the vault; create_invite
--   (replacing an invite to the same address) and delete_vault lock the
--   vault, then its invites. Each pair deadlocked whenever they
--   interleaved. accept_invite now locks the vault first.
-- - delete_vault locked the vault's row, then (through the cascade) its
--   files and variable values; a write or a rotation holds its file's or
--   value's row, then needs the vault's row or its counter. A write or a
--   rotation during a deletion deadlocked. delete_vault now locks them
--   first.
-- The limits themselves held under every crowd tried (the counter's row,
-- the vault's row and the per-account lock already serialise them).

-- As in 20260925240000_admission, but the vault's row is locked before the
-- invite's (create_invite and delete_vault take them in that order).
create or replace function public.accept_invite(p_token text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  i private.vault_invites;
  v_vault uuid;
  v_state text;
begin
  perform private.require_human();
  if coalesce(p_token, '') ~ '^rli_[0-9a-f]{64}$' then
    select x.vault_id into v_vault from private.vault_invites x where x.token_hash = private.token_hash(p_token);
    perform 1 from public.vaults where id = v_vault for update;
    select * into i from private.vault_invites where token_hash = private.token_hash(p_token) for update;
  end if;
  if i.id is null then
    raise exception 'this invite link is not valid: check you copied all of it' using errcode = 'P0002';
  end if;
  v_state := private.invite_state(i.accepted_at, i.revoked_at, i.expires_at);
  if v_state = 'accepted' then
    raise exception 'this invite has already been used' using errcode = '55000';
  elsif v_state = 'revoked' then
    raise exception 'this invite was withdrawn' using errcode = '55000';
  elsif v_state = 'expired' then
    raise exception 'this invite has expired' using errcode = '55000';
  end if;
  if private.email_of(private.uid()) is distinct from i.email then
    raise exception 'this invite is for a different email address' using errcode = '42501';
  end if;
  if not exists (select 1 from public.vault_members where vault_id = i.vault_id and user_id = private.uid()) then
    perform private.require_people_room(i.vault_id, false);
  end if;
  insert into public.vault_members (vault_id, user_id, role)
  values (i.vault_id, private.uid(), i.role)
  on conflict (vault_id, user_id) do nothing;
  update private.vault_invites set accepted_at = now(), accepted_by = private.uid() where id = i.id;
  perform private.admit(private.uid(), 'invite');
  perform private.log_event(i.vault_id, 'invite.accept', null, null, null,
    jsonb_build_object('invite', i.id, 'role', i.role));
  return i.vault_id;
end $$;

-- As in 20260925110000_hardening, plus the file's row locked before its
-- versions (and so before the vault's storage counter), the order a write
-- takes them in.
create or replace function public.erase_file(p_vault uuid, p_path text)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners erase' using errcode = '42501';
  end if;
  perform 1 from public.files where vault_id = p_vault and path = p_path for update;
  if not found
     and not exists (select 1 from public.proposals where vault_id = p_vault and path = p_path) then
    raise exception 'no such file' using errcode = 'P0002';
  end if;
  update public.file_versions v set body = null, erased_at = now()
  from public.files f
  where f.id = v.file_id and f.vault_id = p_vault and f.path = p_path and v.erased_at is null;
  get diagnostics n = row_count;
  update public.proposals set body = null
  where vault_id = p_vault and path = p_path;
  update public.proposal_notes set body = null, erased_at = now()
  where erased_at is null and proposal_id in
    (select id from public.proposals where vault_id = p_vault and path = p_path);
  update public.files set deleted_at = coalesce(deleted_at, now())
  where vault_id = p_vault and path = p_path;
  perform private.log_event(p_vault, 'file.erase', p_path, null, null,
    jsonb_build_object('versions', n));
  return n;
end $$;

-- As in 20260925160000_membership_polish, plus: the vault's files and
-- variable values are locked before the vault's row. A write holds its
-- file's row (a rotation its value's) and then needs the vault's row (the
-- foreign key) or its counter; delete_vault held the vault's row and then
-- needed theirs through the cascade, and the two deadlocked. Now a write in
-- flight finishes first, and one that starts after waits and then finds no
-- vault.
create or replace function public.delete_vault(p_vault uuid, p_confirm_name text)
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
  perform 1 from public.files where vault_id = p_vault order by id for update;
  perform 1 from public.variable_values where vault_id = p_vault order by variable_id, environment for update;
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

  -- What the other members are told, once (see 20260925160000).
  delete from private.vault_deletion_notices
   where deleted_at < now() - make_interval(days => private.notice_days());
  insert into private.vault_deletion_notices (user_id, vault_name, deleted_by)
  select m.user_id, v.name, private.uid() from public.vault_members m
   where m.vault_id = p_vault and m.user_id <> private.uid();

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
