-- When someone leaves a vault, is removed from it, or it is deleted, the
-- tokens they scoped to it stop reaching it for good. Before, role_in only
-- refused them while they weren't a member, so a later re-invite brought an
-- old token (or OAuth grant, or CLI sign-in) back to life.
-- - A token scoped to that vault alone is revoked.
-- - A token scoped to several vaults drops that vault from its scope
--   (narrowing is always safe; scope can still never widen).
-- - An all-vaults token belongs to the person, not the vault: untouched.

create or replace function private.drop_member_tokens() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.access_tokens
     set revoked_at = now()
   where user_id = old.user_id and revoked_at is null
     and not all_vaults and vault_ids <@ array[old.vault_id];
  update public.access_tokens
     set vault_ids = array_remove(vault_ids, old.vault_id)
   where user_id = old.user_id
     and not all_vaults and old.vault_id = any(vault_ids)
     and cardinality(vault_ids) > 1;
  return old;
end $$;

create trigger vault_members_drop_tokens after delete on public.vault_members
  for each row execute function private.drop_member_tokens();

revoke all on function private.drop_member_tokens() from public, anon, authenticated;
