-- Lock order for work plan steps against delete_vault (CL-3.3, issue #72;
-- 20261002200000_work_plans.sql left it for this). claim_step,
-- complete_step and the other step functions lock a step's row first (and
-- claim_step, through the holder foreign key, its holder's vault_members
-- row), then need the vault's row for their log entry. delete_vault took
-- the vault's row, then through its cascade the members and the steps: the
-- opposite order, so a step claimed or finished during a deletion
-- deadlocked every time the two interleaved (web/test/races.test.mjs,
-- "races, lock order: ... step ...").
--
-- delete_vault now locks the vault's steps first, in id order, in the same
-- fixed-order block as files and variable values, before the vault's row.
-- Locked, not deleted there the way 20260930210000_claims_lock_order.sql
-- deletes path_claims: a thread anchored to a step goes with it (threads'
-- foreign key cascades), and deleting a thread before taking the vault's
-- row is the order post_message's own fix (20261004110000_thread_writes)
-- relies on deletion never taking.
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
  perform 1 from public.work_plan_steps where vault_id = p_vault order by id for update;
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
