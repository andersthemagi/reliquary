-- Lock order for path_claims against delete_vault (CL-2.2, tracking issue
-- #52). The same bug class 20260925240100_lock_order.sql already fixed
-- twice: claim_path's insert, when it re-grants an expired path, takes a
-- lock on the path_claims row and then (its holder changing sets off the
-- foreign key check) a FOR KEY SHARE lock on the vault_members row.
-- delete_vault locked the vault's row, then (through the cascade) its
-- vault_members, then (through path_claims' own foreign key) any claim
-- whose holder was still that member: the opposite order. A claim and a
-- deletion at once deadlocked whenever they interleaved (web/test/races.
-- test.mjs, "races, lock order"). delete_vault now deletes them first,
-- in the same fixed-order block as files and variable values.
--
-- This also closes a real gap, not just a deadlock: a released or broken
-- claim clears its holder (release_claim, break_claim, erase_file), and a
-- foreign key with default MATCH SIMPLE semantics is not enforced when
-- any of its columns is null, so that row was never reachable by the
-- vault_members cascade at all. delete_vault deleting path_claims
-- directly, rather than leaning on the cascade, removes every claim on
-- the vault, live or not, matching docs/design.md "Claims and work
-- plans" item 10.
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
  delete from public.path_claims where vault_id = p_vault;
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
