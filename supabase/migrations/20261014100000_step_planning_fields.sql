-- A step's planning fields (docs/design.md "Claims and work plans", item
-- 13; issue #334): an optional due date, priority, one line of notes and
-- who it is meant for, stored per step at registration from the registered
-- version, like its title.
--
-- None of them is an access or claim rule: claim_step, take_step and
-- request_work read none of these columns, and must not. A hint that gated
-- claims would be a second permission system living in file text.
--
-- `for` names a member by email in the file; the step stores their user id,
-- never the email, so a member who changes address stays the one it means.
-- Resolved at registration only: a member who leaves later stays named,
-- which is why for_member has no foreign key to vault_members (one would
-- either cascade-delete the step or need a rule for a hint nobody acts on).
--
-- A step already registered can't change its planning fields either, the
-- same rule as its title (item 6): register_work_plan's "differ" check now
-- covers them. Refusals name the step and, when the caller passed it, the
-- plan file's line; never the value, which is file text.

alter table public.work_plan_steps
  add column due date,
  add column priority smallint check (priority between 1 and 4),
  -- One line, like a title: no line break or other control character but a tab.
  add column notes text check (length(notes) between 1 and 2000 and notes !~ '[\x01-\x08\x0a-\x1f\x7f]'),
  add column for_kind text check (for_kind in ('agents', 'people', 'member')),
  add column for_member uuid,
  add constraint work_plan_steps_for_member check ((for_kind is not distinct from 'member') = (for_member is not null));

grant select (due, priority, notes, for_kind, for_member) on public.work_plan_steps to authenticated;

-- A step's planning lines, checked and resolved: what register_work_plan
-- stores and compares. Raises 22023 naming the step (and line) on the
-- first bad value.
create function private.step_planning(p_vault uuid, p_steps jsonb)
returns table (key text, due date, priority smallint, notes text, for_kind text, for_member uuid)
language plpgsql stable security definer set search_path = '' as $$
declare
  x record;
  v_where text;
  v_due date;
  v_ids uuid[];
begin
  for x in select * from jsonb_to_recordset(p_steps)
             as r(key text, line int, due text, priority text, notes text, "for" text)
  loop
    v_where := format('step "%s"', x.key) || coalesce(format(' (line %s)', x.line), '');
    v_due := null;
    if x.due is not null then
      if x.due !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception '%: due must be a date written YYYY-MM-DD', v_where using errcode = '22023';
      end if;
      begin
        v_due := x.due::date;
      exception when others then
        raise exception '%: due is not a real date', v_where using errcode = '22023';
      end;
    end if;
    if x.priority is not null and x.priority !~ '^[1-4]$' then
      raise exception '%: priority must be 1, 2, 3 or 4 (1 is highest)', v_where using errcode = '22023';
    end if;
    if x.notes is not null and (length(x.notes) not between 1 and 2000 or x.notes ~ '[\x01-\x08\x0a-\x1f\x7f]') then
      raise exception '%: notes must be one line of 1 to 2000 characters', v_where using errcode = '22023';
    end if;
    key := x.key; due := v_due; priority := x.priority::smallint; notes := x.notes;
    for_kind := null; for_member := null;
    if x."for" in ('agents', 'people') then
      for_kind := x."for";
    elsif x."for" is not null then
      select array_agg(m.user_id) into v_ids
        from public.vault_members m join auth.users u on u.id = m.user_id
       where m.vault_id = p_vault and private.email_key(u.email::text) = private.email_key(x."for");
      if cardinality(v_ids) is distinct from 1 then
        raise exception '%: for must be agents, people or the email of a member of this vault, and it names no member', v_where
          using errcode = '22023';
      end if;
      for_kind := 'member'; for_member := v_ids[1];
    end if;
    return next;
  end loop;
end $$;
revoke all on function private.step_planning(uuid, jsonb) from public, anon, authenticated;

-- As 20261013160000_work_plan_gains_steps.sql, plus the planning fields:
-- checked for every step in the file, compared for steps already
-- registered, stored for new ones.
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
  create temp table pf on commit drop as select * from private.step_planning(p_vault, p_steps);

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
      join pf on pf.key = st.key
     where st.plan_id = v_plan_id
       and ((st.title, st.gate, st.due, st.priority, st.notes, st.for_kind, st.for_member)
              is distinct from (f.title, f.gate, pf.due, pf.priority, pf.notes, pf.for_kind, pf.for_member)
         or coalesce((select jsonb_agg(b.key order by b.key) from public.work_plan_step_blockers d
                        join public.work_plan_steps b on b.id = d.blocker_id where d.step_id = st.id), '[]'::jsonb) <> f.blocked
         or coalesce((select jsonb_agg(jsonb_build_object('path', ct.path, 'version', ct.version) order by ct.path)
                        from public.work_plan_step_cites ct where ct.step_id = st.id), '[]'::jsonb) <> f.cites);
    if v_keys is not null then
      raise exception 'steps already registered can''t change, and these differ from the plan as registered (title, gate, blocked_by, cites, due, priority, notes or for): %. Put them back as registered; only new steps can be added',
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

  insert into public.work_plan_steps (plan_id, vault_id, key, title, gate, due, priority, notes, for_kind, for_member)
    select v_plan_id, p_vault, n.key, n.title, n.gate, pf.due, pf.priority, pf.notes, pf.for_kind, pf.for_member
      from n join pf on pf.key = n.key order by n.ord;

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
  drop table n; drop table pf;

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

-- As 20261013233000_review_gate.sql, plus the planning fields. A new
-- return type needs drop and create; list_work_plans reads it by column
-- name, so it keeps working unchanged.
drop function public.work_plan_status(uuid, text);
create function public.work_plan_status(p_vault uuid, p_path text)
returns table (o_key text, o_title text, o_state text, o_holder_label text, o_expires_at timestamptz, o_moved text[],
               o_due date, o_priority smallint, o_notes text, o_for_kind text, o_for_member uuid)
language sql stable set search_path = '' as $$
  select s.key, s.title,
    case
      when s.status = 'done' then 'done'
      when s.status = 'cancelled' then 'cancelled'
      when s.status = 'review' then 'awaiting_review'
      when s.status = 'claimed' and s.expires_at > clock_timestamp() then 'claimed'
      when exists (select 1 from public.work_plan_step_blockers d join public.work_plan_steps b on b.id = d.blocker_id
                    where d.step_id = s.id and b.status = 'cancelled') then 'blocked_by_cancelled'
      when s.open_blockers > 0 then 'blocked'
      else 'ready'
    end,
    s.holder_label, s.expires_at,
    array(select ct.path from public.work_plan_step_cites ct
            join public.files f on f.vault_id = s.vault_id and f.path = ct.path
           where ct.step_id = s.id and s.status in ('open', 'claimed')
             and f.deleted_at is null and f.current_version_id is distinct from ct.version
             and exists (select 1 from public.file_versions fv where fv.id = ct.version and fv.file_id = f.id)
           order by ct.path),
    s.due, s.priority, s.notes, s.for_kind, s.for_member
  from public.work_plan_steps s
  join public.work_plans p on p.id = s.plan_id
  where p.vault_id = p_vault and p.path = p_path
  order by s.id
$$;
revoke all on function public.work_plan_status(uuid, text) from public, anon;
grant execute on function public.work_plan_status(uuid, text) to authenticated;
