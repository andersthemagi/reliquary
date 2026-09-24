-- Agents may create vaults, through a token that could reach them.
-- See docs/parity.md and AGENTS.md ("An agent is its person, minus a
-- ceiling").
--
-- Creating a vault is not in the delegation ceiling (approving, revealing
-- variables, managing members, deleting or exporting a vault), so an agent
-- may do it for its person. But only through a token whose scope would
-- include the new vault: one that reaches all of the person's vaults
-- (including ones made later) with read-write access. A token scoped to
-- chosen vaults, or read-only, is refused: it was granted for less, and a
-- vault it creates would be one it can't reach anyway.
--
-- - The person owns the new vault (created_by and the owner row are `sub`,
--   never anything the caller passes), and the log records the agent.
-- - An agent request without a token (`act` with no `tok`) is refused: the
--   rule is about the token, so no token, no vault.
-- - A personal token and an OAuth grant are both access_tokens rows, so the
--   same check covers both: live (not revoked, not expired), the caller's
--   own, all vaults, write.
-- - Rules (set_policy) and members (set_member) stay human-only, so an
--   agent that creates a vault still can't make anything canon or share it.
--
-- Also: the name is trimmed and must be 1 to 100 characters, and the default
-- policy must be canon or open, each refused with a message (22023) instead
-- of a constraint error.

-- True when the caller may create a vault: the person themself, or their
-- agent through a live all-vaults, read-write token of theirs.
create function private.may_create_vault() returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when private.uid() is null then false
    when private.agent() is null then true
    when private.token_id() is null then false
    else exists (
      select 1 from public.access_tokens t
       where t.id = private.token_id()
         and t.user_id = private.uid()
         and t.revoked_at is null
         and t.expires_at > now()
         and t.all_vaults
         and t.access = 'write')
  end
$$;

create or replace function public.create_vault(p_name text, p_default_policy text default 'open')
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v uuid;
  v_name text := trim(coalesce(p_name, ''));
begin
  perform private.require_person();
  if not coalesce(private.may_create_vault(), false) then
    raise exception 'creating a vault needs a connection that reaches all your vaults with read-write access'
      using errcode = '42501';
  end if;
  if length(v_name) not between 1 and 100 then
    raise exception 'a vault name is 1 to 100 characters' using errcode = '22023';
  end if;
  if p_default_policy is null or p_default_policy not in ('canon', 'open') then
    raise exception 'the default policy is canon or open' using errcode = '22023';
  end if;
  insert into public.vaults (name, default_policy, created_by)
  values (v_name, p_default_policy, private.uid()) returning id into v;
  insert into public.vault_members (vault_id, user_id, role) values (v, private.uid(), 'owner');
  perform private.log_event(v, 'vault.create', null, null, null,
    jsonb_build_object('name', v_name, 'default_policy', p_default_policy));
  return v;
end $$;

revoke all on function private.may_create_vault() from public, anon, authenticated;
