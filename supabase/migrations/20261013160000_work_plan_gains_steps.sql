-- A registered work plan gains new steps when its file changes (issue
-- #262; tracking issue #52). Registering a path that already has a plan,
-- from a newer version of its file, adds the steps whose keys are new and
-- keeps every step already registered exactly as it is, state included:
-- nothing done is reopened, nothing claimed is taken away.
--
-- The rule is "only add". A step already registered must still be in the
-- file, with the same title, gate, blocked_by and cites; anything else is
-- refused, naming the steps. That one rule keeps every invariant without
-- a case for each: no done or claimed step can gain a blocker (its
-- blocked_by can't change), no step goes missing under someone holding
-- it, and a new step can't block an old one, so a cycle can only form
-- among the new steps, where the full-plan check below already finds it.
-- New steps may wait on old ones; one waiting on a done step doesn't
-- count it, and one waiting on a cancelled step is blocked by it, as at
-- first registration.
--
-- Registering again from the version the plan already has is refused, as
-- registering a path twice was before (23505): there is nothing new in it.
-- A newer version with no new steps is let through and recorded, so the
-- Tasks page's "Changed since registered" (list_work_plans compares the
-- file to work_plans.version_id) can be cleared by someone who read the
-- change and found nothing to add.
--
-- The stored open_blockers count of a new step reads its blockers' status,
-- and complete_step and skip_step (the only decrements) read the blocker
-- edges: a completion committing between the two would leave the new step
-- counting a done blocker forever. So the two serialize on one advisory
-- lock per plan, taken before any step row: shared by complete_step and
-- skip_step, exclusive here. Row locks on the blockers can't do it: a
-- completion locks its own step, then its dependents, in no order this
-- function could match (web/test/races.test.mjs, "a plan gains a step").
--
-- Who may do it is unchanged: whoever could write the path, agent or
-- person, as for the first registration. work_plans records who added
-- steps last and when; the log has every time (work_plan.update).

alter table public.work_plans
  add column updated_by uuid,
  add column updated_at timestamptz;

create or replace function public.register_work_plan(p_vault uuid, p_path text, p_version uuid, p_steps jsonb)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_current uuid;
  v_plan public.work_plans;
  v_plan_id uuid;
  v_n_steps int;
  v_removed text[];
  v_keys text[];
  v_added int;
begin
  perform private.require_person();
  perform private.valid_path(p_path);
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;

  perform 1 from public.files where vault_id = p_vault and path = p_path and deleted_at is null for update;
  if not found then
    raise exception 'no such file' using errcode = 'P0002';
  end if;
  select f.current_version_id into v_current from public.files f where f.vault_id = p_vault and f.path = p_path;
  if v_current is distinct from p_version then
    raise exception 'this file changed since you read it (you had version %); the current version is %',
      p_version, coalesce(v_current::text, 'no file yet') using errcode = 'RLF01';
  end if;

  select * into v_plan from public.work_plans where vault_id = p_vault and path = p_path for update;
  if v_plan.id is not null then
    if v_plan.version_id = p_version then
      raise exception '% is already registered from this version: change the file to add steps, then register it again', p_path
        using errcode = '23505';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('reliquary.work_plan:' || v_plan.id::text, 0));
  end if;

  select count(*) into v_n_steps from jsonb_array_elements(coalesce(p_steps, '[]'::jsonb));
  if v_n_steps = 0 then
    raise exception 'a work plan needs at least one step' using errcode = '22023';
  end if;
  if v_n_steps > 500 then
    raise exception 'a work plan has at most 500 steps' using errcode = '22023';
  end if;

  if exists (select 1 from jsonb_to_recordset(p_steps) as x(key text) where x.key is null) then
    raise exception 'every step needs a key' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_steps) as x(key text) where x.key !~ '^[a-z0-9]+(-[a-z0-9]+)*$') then
    raise exception 'every step key must be lowercase letters, digits and hyphens' using errcode = '22023';
  end if;
  create temp table s (k text primary key) on commit drop;
  create temp table e (step text, blocker text) on commit drop;
  begin
    insert into s (k) select x.key from jsonb_to_recordset(p_steps) as x(key text);
  exception when unique_violation then
    raise exception 'duplicate step key' using errcode = '22023';
  end;
  if exists (select 1 from jsonb_to_recordset(p_steps) as x(title text) where x.title is null or length(x.title) = 0) then
    raise exception 'every step needs a title' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_steps) as x(title text) where length(x.title) > 200) then
    raise exception 'a step title is at most 200 characters' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(p_steps) as x(gate text) where x.gate is not null and x.gate <> 'review') then
    raise exception 'gate must be "review"' using errcode = '22023';
  end if;

  insert into e (step, blocker)
    select x.key, b.k from jsonb_to_recordset(p_steps) as x(key text, blocked_by jsonb),
      jsonb_array_elements_text(coalesce(x.blocked_by, '[]'::jsonb)) as b(k);
  if exists (select step from e group by step having count(*) > 50) then
    raise exception 'a step has more than 50 blockers' using errcode = '22023';
  end if;
  if exists (select 1 from e where blocker not in (select k from s)) then
    raise exception 'a step is blocked by an unknown step' using errcode = '22023';
  end if;

  loop
    select array_agg(k) into v_removed from s
     where not exists (select 1 from e where e.step = s.k and e.blocker in (select k from s));
    exit when v_removed is null;
    delete from s where k = any (v_removed);
  end loop;
  if exists (select 1 from s) then
    if exists (select 1 from e where step = blocker and step in (select k from s)) then
      raise exception 'a step can''t be blocked by itself' using errcode = '22023';
    end if;
    raise exception 'the plan has a cycle in blocked_by' using errcode = '22023';
  end if;
  drop table s; drop table e;

  if v_plan.id is null then
    insert into public.work_plans (vault_id, path, version_id, registered_by)
    values (p_vault, p_path, p_version, private.uid())
    returning id into v_plan_id;
  else
    v_plan_id := v_plan.id;

    select array_agg(st.key order by st.id) into v_keys
      from public.work_plan_steps st
     where st.plan_id = v_plan_id
       and st.key not in (select x.key from jsonb_to_recordset(p_steps) as x(key text));
    if v_keys is not null then
      raise exception 'a registered plan only gains steps, and these registered steps are missing from the file: %. Put them back, then register it again',
        array_to_string(v_keys[1:10], ', ') || case when cardinality(v_keys) > 10 then format(' and %s more', cardinality(v_keys) - 10) else '' end
        using errcode = '22023';
    end if;

    with f as (
      select x.key, x.title, x.gate,
             coalesce((select jsonb_agg(distinct bb.k order by bb.k) from jsonb_array_elements_text(coalesce(x.blocked_by, '[]'::jsonb)) as bb(k)), '[]'::jsonb) as blocked,
             coalesce((select jsonb_agg(jsonb_build_object('path', c.path, 'version', c.version) order by c.path)
                         from jsonb_to_recordset(coalesce(x.cites, '[]'::jsonb)) as c(path text, version uuid)), '[]'::jsonb) as cites
        from jsonb_to_recordset(p_steps) as x(key text, title text, gate text, blocked_by jsonb, cites jsonb)
    )
    select array_agg(st.key order by st.id) into v_keys
      from public.work_plan_steps st
      join f on f.key = st.key
     where st.plan_id = v_plan_id
       and ((st.title, st.gate) is distinct from (f.title, f.gate)
         or coalesce((select jsonb_agg(b.key order by b.key) from public.work_plan_step_blockers d
                        join public.work_plan_steps b on b.id = d.blocker_id where d.step_id = st.id), '[]'::jsonb) <> f.blocked
         or coalesce((select jsonb_agg(jsonb_build_object('path', ct.path, 'version', ct.version) order by ct.path)
                        from public.work_plan_step_cites ct where ct.step_id = st.id), '[]'::jsonb) <> f.cites);
    if v_keys is not null then
      raise exception 'steps already registered can''t change, and these differ from the plan as registered (title, gate, blocked_by or cites): %. Put them back as registered; only new steps can be added',
        array_to_string(v_keys[1:10], ', ') || case when cardinality(v_keys) > 10 then format(' and %s more', cardinality(v_keys) - 10) else '' end
        using errcode = '22023';
    end if;
  end if;

  -- From here on, "new" is every step in the file not already in the plan:
  -- all of them on a first registration.
  create temp table n on commit drop as
    select x.key, x.title, x.gate, x.blocked_by, x.cites, j.ord
      from jsonb_array_elements(p_steps) with ordinality as j(step, ord)
      cross join lateral jsonb_to_record(j.step) as x(key text, title text, gate text, blocked_by jsonb, cites jsonb)
     where not exists (select 1 from public.work_plan_steps st where st.plan_id = v_plan_id and st.key = x.key);
  select count(*) into v_added from n;

  insert into public.work_plan_steps (plan_id, vault_id, key, title, gate)
    select v_plan_id, p_vault, n.key, n.title, n.gate from n order by n.ord;

  insert into public.work_plan_step_blockers (step_id, blocker_id)
    select st.id, bl.id
      from n cross join jsonb_array_elements_text(coalesce(n.blocked_by, '[]'::jsonb)) as b(k)
      join public.work_plan_steps st on st.plan_id = v_plan_id and st.key = n.key
      join public.work_plan_steps bl on bl.plan_id = v_plan_id and bl.key = b.k;

  update public.work_plan_steps st
     set open_blockers = (select count(*) from public.work_plan_step_blockers d
                            join public.work_plan_steps b on b.id = d.blocker_id
                           where d.step_id = st.id and b.status <> 'done')
   where st.plan_id = v_plan_id and st.key in (select n.key from n);

  insert into public.work_plan_step_cites (step_id, path, version)
    select st.id, c.path, c.version
      from n cross join jsonb_to_recordset(coalesce(n.cites, '[]'::jsonb)) as c(path text, version uuid)
      join public.work_plan_steps st on st.plan_id = v_plan_id and st.key = n.key;
  drop table n;

  if v_plan.id is null then
    perform private.log_event(p_vault, 'work_plan.register', p_path, p_version, null,
      jsonb_build_object('plan', v_plan_id, 'steps', v_n_steps));
  else
    update public.work_plans set version_id = p_version, updated_by = private.uid(), updated_at = clock_timestamp()
     where id = v_plan_id;
    perform private.log_event(p_vault, 'work_plan.update', p_path, p_version, null,
      jsonb_build_object('plan', v_plan_id, 'steps', v_n_steps, 'added', v_added, 'from', v_plan.version_id));
  end if;
  return v_plan_id;
end $$;

-- As 20261002200000_work_plans.sql, plus the plan's lock, shared, before
-- the step's row (see this file's header).
create or replace function public.complete_step(p_vault uuid, p_path text, p_key text, p_fence int, p_secret text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_plan_id uuid; v_row public.work_plan_steps;
begin
  perform private.require_person();
  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('reliquary.work_plan:' || v_plan_id::text, 0));
  select * into v_row from public.work_plan_steps where plan_id = v_plan_id and key = p_key for update;
  if v_row.id is null then
    raise exception 'no such step' using errcode = 'P0002';
  end if;
  if v_row.status <> 'claimed' or v_row.fence <> p_fence or v_row.secret_hash is distinct from private.token_hash(p_secret)
     or v_row.holder is distinct from private.uid() or v_row.holder_token is distinct from private.token_id()
     or v_row.expires_at <= clock_timestamp()
  then
    raise exception 'this step is no longer yours to complete (wrong secret or fence, a different connection, or the lease lapsed)'
      using errcode = 'RLW03';
  end if;

  update public.work_plan_steps set status = 'done', done_at = clock_timestamp() where id = v_row.id;
  perform private.unblock_dependents(v_row.id);
  perform private.log_event(p_vault, 'step.complete', p_path, null, null,
    jsonb_build_object('plan', v_plan_id, 'step', p_key, 'fence', p_fence));
end $$;

create or replace function public.skip_step(p_vault uuid, p_path text, p_key text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_plan_id uuid; v_row public.work_plan_steps;
begin
  perform private.require_human();
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock_shared(hashtextextended('reliquary.work_plan:' || v_plan_id::text, 0));
  select * into v_row from public.work_plan_steps where plan_id = v_plan_id and key = p_key for update;
  if v_row.id is null then
    raise exception 'no such step' using errcode = 'P0002';
  end if;
  if v_row.status = 'done' then
    raise exception 'step "%" is already done', p_key using errcode = 'RLW02';
  end if;
  if v_row.status = 'cancelled' then
    raise exception 'step "%" is cancelled; skipping it now would mean nothing', p_key using errcode = 'RLW02';
  end if;
  update public.work_plan_steps
     set status = 'done', holder = null, holder_token = null, holder_label = null, secret_hash = null,
         claimed_at = null, expires_at = null, done_at = clock_timestamp()
   where id = v_row.id;
  perform private.unblock_dependents(v_row.id);
  perform private.log_event(p_vault, 'step.skip', p_path, null, null, jsonb_build_object('plan', v_plan_id, 'step', p_key));
end $$;
