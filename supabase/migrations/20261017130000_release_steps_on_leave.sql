-- A claimed step used to go with its holder's membership: work_plan_steps'
-- (vault_id, holder) FK cascades from vault_members, so leave_vault,
-- set_member's removal and delete_account each deleted the step and its
-- blocker rows outright, and the plan silently lost a step (issue #383).
-- The membership delete now releases the member's claimed steps first, the
-- way release_step does (open, no holder, same fence, logged), so the
-- cascade finds nothing to delete. The FK stays as it is: once the holder
-- is null it never fires. work_plan_places keeps cascading on purpose: a
-- place in line belongs to the member.
--
-- Skipped when the vault itself is going: then the members are cascading
-- from the vault row, which is already gone, so a log row can't reference it
-- and the steps follow the vault anyway.
create function private.release_steps_of_leaving_member() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_row record;
begin
  if not exists (select 1 from public.vaults where id = old.vault_id) then
    return old;
  end if;
  for v_row in
    update public.work_plan_steps s
       set status = 'open', holder = null, holder_token = null, holder_label = null, secret_hash = null,
           claimed_at = null, expires_at = null
      from public.work_plans p
     where p.id = s.plan_id and s.vault_id = old.vault_id and s.holder = old.user_id and s.status = 'claimed'
    returning p.path, p.id as plan_id, s.key, s.fence
  loop
    perform private.log_event(old.vault_id, 'step.release', v_row.path, null, null,
      jsonb_build_object('plan', v_row.plan_id, 'step', v_row.key, 'fence', v_row.fence,
        'reason', 'holder left the vault', 'user', old.user_id));
  end loop;
  return old;
end $$;
revoke all on function private.release_steps_of_leaving_member() from public, anon, authenticated;

create trigger release_steps_before_member_leaves
  before delete on public.vault_members
  for each row execute function private.release_steps_of_leaving_member();
