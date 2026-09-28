-- Fixes a bug in 20260928130000_path_ownership.sql, found in review before
-- the web UI for it shipped (docs/design.md, "Path ownership"): a named
-- owner's write access to their path ignored their connection's scope.
--
-- private.can_write_path() and private.policy_for()'s owner branch checked
-- only `exists (... path_owners where user_id = private.uid())`, never
-- private.role_in() the way every other write-access check in this
-- codebase does (private.can_write(), the function right above
-- can_write_path in the original migration). role_in() is what enforces an
-- access token's scope (20260924160000_token_scope.sql): which vaults it
-- reaches, and whether it's read-only. Skipping it meant a named owner's
-- read-only token, or a token scoped only to a different vault, could
-- still call write_file/delete_file on the path they own -- the exact
-- thing token scoping exists to prevent, and the exact thing can_write()
-- already gets right for ordinary editor/owner access.
--
-- decide() is unaffected: it's require_human()-gated, and any access token
-- at all (read-only or not) carries an `act.tok` claim, which
-- private.agent() reads as an agent, which require_human() refuses outright
-- -- so no token, scoped correctly or not, ever reaches decide(). Only
-- write_file and delete_file, which allow a person's own token
-- (require_person(), not require_human()), were exposed.
--
-- role_in() can't be reused directly for this: a read-only token's role
-- collapses to 'viewer', indistinguishable from a genuine vault-viewer
-- using their own unrestricted session (no token at all) -- and a genuine
-- viewer named owner of a path is exactly who this feature exists to let
-- write directly. So the fix isn't "require role_in() in ('owner',
-- 'editor')"; it's a narrower question role_in() doesn't answer on its
-- own: is this connection write-capable at all, whatever the underlying
-- vault_members role turns out to be. private.connection_write_capable()
-- answers that, mirroring role_in()'s own token branches minus the role
-- lookup, and can_write_path()/policy_for() now require it before
-- consulting path_owners.
--
-- Enforced here:
-- - A named owner's own unrestricted session (web app, or a token-free MCP
--   claim) still writes their path directly, whatever their vault role,
--   exactly as before (supabase/tests/path_ownership_test.sql's existing
--   write: tests, unmodified, still pass).
-- - A named owner's read-only access token can't write it.
-- - A named owner's access token scoped only to a different vault can't
--   write it either, even though it's a live, unrevoked, write-access
--   token of theirs.
-- - A named owner's access token properly scoped to this vault, write
--   access, still can (the ordinary case for an agent connection).

create function private.connection_write_capable(p_vault uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when private.token_id() is null then true
    when t.id is null then false
    when coalesce(t.all_vaults or p_vault = any(t.vault_ids), false) is not true then false
    when t.access = 'write' then true
    else false
  end
  from (select 1) x
  left join public.access_tokens t
    on t.id = private.token_id()
   and t.user_id = private.uid()
   and t.revoked_at is null
   and t.expires_at > now()
$$;

create or replace function private.policy_for(p_vault uuid, p_path text,
  out policy text, out quorum int)
language sql stable security definer set search_path = '' as $$
  select
    case when private.connection_write_capable(p_vault) and exists (
      select 1 from public.path_owners po
      where po.vault_id = p_vault and po.path = private.matched_policy_path(p_vault, p_path)
        and po.user_id = private.uid()
    ) then 'open' else coalesce(pp.policy, v.default_policy) end,
    coalesce(pp.quorum, 1)
  from public.vaults v
  left join lateral (
    select policy, quorum from public.path_policies
    where vault_id = p_vault
      and (path = p_path or (right(path, 1) = '/' and starts_with(p_path, path)))
    order by (path = p_path) desc, length(path) desc
    limit 1
  ) pp on true
  where v.id = p_vault
$$;

create or replace function private.can_write_path(p_vault uuid, p_path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_write(p_vault) or (
    private.connection_write_capable(p_vault) and exists (
      select 1 from public.path_owners po
      where po.vault_id = p_vault and po.path = private.matched_policy_path(p_vault, p_path)
        and po.user_id = private.uid()
    )
  )
$$;

revoke all on function private.connection_write_capable(uuid) from public, anon, authenticated;
