-- Waiting settings refused in words (issue #346). The Rules page now sets a
-- rule's place-in-line time, longest check-again hint and minimum gap
-- (design.md "Claims and work plans" item 3), so a bad one has to come back
-- as a sentence a person can act on. The table's own check (min_gap_seconds
-- >= 10, 20260930220000_claim_rules.sql) already holds the floor, but a
-- check violation reaches people as its constraint name only; and nothing
-- stopped a place or a hint of zero minutes, which request_work would turn
-- into a place that lapses at once or a wait of nothing. Same body as
-- 20261009110000_claim_rule_whole_vault.sql otherwise.

create or replace function public.set_claim_rule(p_vault uuid, p_path text,
  p_lease_minutes int, p_hold_limit_minutes int, p_max_lease_minutes int default null,
  p_connection_cap int default 1, p_person_cap int default 5,
  p_place_in_line_minutes int default null, p_check_again_minutes int default null,
  p_min_gap_seconds int default null, p_free_lapses int default 1, p_cooldown_cap_minutes int default null)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_problem text;
  v_max int := coalesce(p_max_lease_minutes, p_lease_minutes);
  v_cooldown int := coalesce(p_cooldown_cap_minutes, p_lease_minutes);
  v_place int := coalesce(p_place_in_line_minutes, p_lease_minutes);
  v_hint int := coalesce(p_check_again_minutes, p_lease_minutes);
  v_gap int := coalesce(p_min_gap_seconds, 10);
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners set claim rules' using errcode = '42501';
  end if;
  if p_path = '' or (p_lease_minutes is null and exists (select 1 from public.claim_rules where vault_id = p_vault and path = p_path)) then
    v_problem := null;
  else
    v_problem := private.rule_path_problem(p_path);
  end if;
  if v_problem is not null then
    raise exception '%', v_problem using errcode = '22023';
  end if;

  -- Only what was passed: one left out follows the lease, which the table checks.
  if p_lease_minutes is not null then
    if p_place_in_line_minutes < 1 then
      raise exception 'A place in line has to last at least 1 minute. Nothing was saved' using errcode = '22023';
    end if;
    if p_check_again_minutes < 1 then
      raise exception 'The longest check-again hint has to be at least 1 minute. Nothing was saved' using errcode = '22023';
    end if;
    if p_min_gap_seconds < 10 then
      raise exception 'The minimum gap between checks has to be at least 10 seconds: a shorter one multiplies how often every waiting agent may ask. Nothing was saved'
        using errcode = '22023';
    end if;
  end if;

  if p_lease_minutes is null then
    delete from public.claim_rules where vault_id = p_vault and path = p_path;
  else
    insert into public.claim_rules as cr (
      vault_id, path, lease_minutes, max_lease_minutes, hold_limit_minutes, connection_cap, person_cap,
      place_in_line_minutes, check_again_minutes, min_gap_seconds, free_lapses, cooldown_cap_minutes, set_by)
    values (
      p_vault, p_path, p_lease_minutes, v_max, p_hold_limit_minutes, p_connection_cap, p_person_cap,
      v_place, v_hint, v_gap, p_free_lapses, v_cooldown, private.uid())
    on conflict (vault_id, path) do update
       set lease_minutes = excluded.lease_minutes, max_lease_minutes = excluded.max_lease_minutes,
           hold_limit_minutes = excluded.hold_limit_minutes, connection_cap = excluded.connection_cap,
           person_cap = excluded.person_cap, place_in_line_minutes = excluded.place_in_line_minutes,
           check_again_minutes = excluded.check_again_minutes, min_gap_seconds = excluded.min_gap_seconds,
           free_lapses = excluded.free_lapses, cooldown_cap_minutes = excluded.cooldown_cap_minutes,
           set_by = excluded.set_by, set_at = now();
  end if;
  -- The log's path is a file or folder; the whole vault has none.
  perform private.log_event(p_vault, 'claim_rule.set', nullif(p_path, ''), null, null,
    jsonb_build_object('lease_minutes', p_lease_minutes, 'max_lease_minutes', p_max_lease_minutes, 'whole_vault', p_path = ''));
end $$;
