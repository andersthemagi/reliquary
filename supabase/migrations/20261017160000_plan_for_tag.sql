-- A step's `for` names a member by their short tag, never by email (issue
-- #378, design principle 12). A plan file is vault content agents read, so
-- an address in one reached a model, and resolving it at registration told
-- the agent whether that address belonged to a member of the vault. The
-- tag is the first 8 characters of the member's id, what the web UI and
-- co_member_people (20261014150000_display_preferences.sql) show beside a
-- display name, so the same tag is where a person finds it.
--
-- Steps already registered with for_member from an email keep working as
-- stored (owner's call for #378): the column held the id, never the email.
-- Re-registering a plan whose file still names an email is refused by the
-- parser first (mcp/src/workplan-format.ts) and here second, both saying
-- to use the tag and neither looking the address up, so a refusal says
-- nothing about whether it belongs to anyone. Only this vault's members
-- are searched, so an unknown or ambiguous tag says nothing about anyone
-- outside it either.
--
-- Same signature as 20261014130000_step_planning_fields.sql's;
-- register_work_plan calls it by name and is unchanged.
create or replace function private.step_planning(p_vault uuid, p_steps jsonb)
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
      if position('@' in x."for") > 0 then
        raise exception '%: for can''t be an email; name the member by their short tag, the 8 characters shown beside their name', v_where
          using errcode = '22023';
      end if;
      if lower(btrim(x."for")) !~ '^[0-9a-f]{8}$' then
        raise exception '%: for must be agents, people or a member''s short tag (the 8 characters shown beside their name)', v_where
          using errcode = '22023';
      end if;
      select array_agg(m.user_id) into v_ids
        from public.vault_members m
       where m.vault_id = p_vault and left(m.user_id::text, 8) = lower(btrim(x."for"));
      if coalesce(cardinality(v_ids), 0) > 1 then
        raise exception '%: for names more than one member of this vault by that tag, so it can''t be used here', v_where
          using errcode = '22023';
      elsif coalesce(cardinality(v_ids), 0) <> 1 then
        raise exception '%: for must be agents, people or the short tag of one member of this vault, and it names none', v_where
          using errcode = '22023';
      end if;
      for_kind := 'member'; for_member := v_ids[1];
    end if;
    return next;
  end loop;
end $$;
revoke all on function private.step_planning(uuid, jsonb) from public, anon, authenticated;
