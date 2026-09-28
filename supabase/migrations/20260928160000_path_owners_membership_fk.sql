-- Fix forward: public.path_owners (20260928130000_path_ownership.sql) had
-- no foreign key to public.vault_members and no trigger cleaning it up.
-- private.can_write_path() and private.policy_for() check path_owners
-- alone, so when a named owner left a vault, was removed
-- (set_member(vault, user, null)), or deleted their account, their row
-- stayed: they could still write_file / delete_file that path directly,
-- and decide() (via private.path_owner_ids) could still count their
-- approval toward its quorum, both with no access to the vault at all.
-- Verified against a fresh database with every migration up to and
-- including flags applied: an owner names a viewer the owner of a canon
-- path, removes them from the vault, and the removed person's
-- write_file('clients/after-removal.md') still succeeds and the file
-- exists. 20260928150000_flags.sql, written the same day, got this shape
-- right for its own two tables (flag_watermarks, subscriptions); this
-- migration brings path_owners in line with them.
--
-- Fixed the same way: a foreign key on (vault_id, user_id) to
-- vault_members(vault_id, user_id), on delete cascade. A role change is an
-- update to that row (public.set_member with a role), not a delete, so it
-- leaves a path_owners row alone; leaving (public.leave_vault), removal
-- (public.set_member(..., null)) and deleting the account
-- (public.delete_account, which deletes every vault_members row for the
-- caller) all delete the vault_members row, so all three now take the
-- path_owners row with them. Proved directly in
-- supabase/tests/path_ownership_test.sql#membership:.
--
-- set_path_owner's own membership check (a friendly "that person isn't a
-- member of this vault" rather than a raw foreign-key violation, when
-- naming someone who isn't one) still reads right afterward: it runs
-- before the insert, for the case of naming a non-member up front. The new
-- constraint backstops the case that check can't cover -- a person leaving
-- or being removed after they were already named -- so the two aren't
-- doing the same job.
--
-- First, one cleanup delete for any row already orphaned this way (a path
-- owner named before this migration ships, whose membership is already
-- gone by the time it runs): a fresh test database never has one, but a
-- database that ran 20260928130000_path_ownership.sql before this landed
-- might.
delete from public.path_owners po
where not exists (
  select 1 from public.vault_members m
  where m.vault_id = po.vault_id and m.user_id = po.user_id
);

-- Backs the new foreign key directly: path_owners' two existing indexes
-- (vault_id alone, user_id alone) don't cover (vault_id, user_id)
-- together, and deleting a vault_members row needs to find every
-- path_owners row for that pair without a sequential scan.
create index on public.path_owners (vault_id, user_id);

alter table public.path_owners
  add constraint path_owners_member_fk foreign key (vault_id, user_id)
  references public.vault_members (vault_id, user_id) on delete cascade;
