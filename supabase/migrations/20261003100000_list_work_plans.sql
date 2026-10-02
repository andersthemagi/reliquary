-- list_work_plans: a vault's work plans, one row each, for the web app's
-- Tasks page (issue #76). Read-only. Nothing is stored for it.
--
-- Security invoker, like work_plan_status and list_claims: RLS on
-- work_plans, work_plan_steps and files already limits every row to a
-- vault the caller can read, token scope and read-only connections
-- included, so a second access check here would only be a second place to
-- get it wrong. What this function adds is the p_vault filter, so a
-- member of two vaults asking about one never gets the other's plans.
--
-- The counts come from work_plan_status, the one place a step's computed
-- state (ready, blocked, claimed, done, cancelled) is defined, so this
-- list and a plan's own page can never disagree about what "ready" means.
-- A lapsed claim therefore counts as ready, not claimed, exactly as it
-- does there. blocked includes a step blocked by a cancelled one.
--
-- o_file says whether the plan file moved on since the plan was
-- registered from it: 'changed' (a newer current version), 'deleted' (the
-- file is gone), else 'unchanged'. Only the file's version id is read,
-- never its text. A plan is never re-registered (register_work_plan
-- refuses a second plan on one path), so 'changed' stays until the plan
-- itself is gone.
create function public.list_work_plans(p_vault uuid)
returns table (
  o_path text,
  o_registered_version uuid,
  o_registered_at timestamptz,
  o_registered_by uuid,
  o_file text,
  o_current_version uuid,
  o_ready int,
  o_blocked int,
  o_claimed int,
  o_done int,
  o_cancelled int
)
language sql stable set search_path = '' as $$
  select p.path, p.version_id, p.registered_at, p.registered_by,
    case
      when f.id is null or f.deleted_at is not null then 'deleted'
      when f.current_version_id is distinct from p.version_id then 'changed'
      else 'unchanged'
    end,
    f.current_version_id,
    (count(st.o_key) filter (where st.o_state = 'ready'))::int,
    (count(st.o_key) filter (where st.o_state in ('blocked', 'blocked_by_cancelled')))::int,
    (count(st.o_key) filter (where st.o_state = 'claimed'))::int,
    (count(st.o_key) filter (where st.o_state = 'done'))::int,
    (count(st.o_key) filter (where st.o_state = 'cancelled'))::int
  from public.work_plans p
  left join public.files f on f.vault_id = p.vault_id and f.path = p.path
  left join lateral public.work_plan_status(p.vault_id, p.path) st on true
  where p.vault_id = p_vault
  group by p.id, f.id
  order by p.path
$$;

revoke all on function public.list_work_plans(uuid) from public, anon;
grant execute on function public.list_work_plans(uuid) to authenticated;
