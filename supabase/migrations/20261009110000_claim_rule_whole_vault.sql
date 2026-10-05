-- A claim rule for the whole vault. design.md "Claim rules" and
-- docs/public/concepts/claims.md both describe "a vault-wide default, with
-- optional overrides by path prefix", but 20260930220000_claim_rules.sql
-- only stored rules on a path: an owner who wanted every path in a vault to
-- lease for 30 minutes had to name one folder at a time, and a file at the
-- vault's top level could not be covered at all.
--
-- The whole-vault rule is the rule whose path is the empty string. It is a
-- folder rule that covers everything, so it is the least specific match:
-- any folder or exact-path rule still beats it, and with none of those it
-- beats the fixed defaults. An empty path is only ever this rule, never an
-- unvalidated folder name: set_claim_rule accepts it, and every other path
-- goes through the same validator as before.

alter table public.claim_rules drop constraint claim_rules_path_inside;
alter table public.claim_rules add constraint claim_rules_path_inside
  check (path = '' or (path ~ '^[^/].*' and path !~ '//')) not valid;

create or replace function private.claim_rule_for(p_vault uuid, p_path text,
  out lease_minutes int, out max_lease_minutes int, out hold_limit_minutes int,
  out connection_cap int, out person_cap int)
language sql stable security definer set search_path = '' as $$
  select coalesce(cr.lease_minutes, 48 * 60), coalesce(cr.max_lease_minutes, 48 * 60),
         coalesce(cr.hold_limit_minutes, 7 * 24 * 60), coalesce(cr.connection_cap, 1), coalesce(cr.person_cap, 5)
  from (select 1) x
  left join lateral (
    select * from public.claim_rules cr
     where cr.vault_id = p_vault
       and (cr.path = ''
            or cr.path = p_path
            or (right(cr.path, 1) = '/'
                and p_path like replace(replace(cr.path, '%', '\%'), '_', '\_') || '%' escape '\'))
     order by (cr.path = p_path) desc, length(cr.path) desc
     limit 1
  ) cr on true
$$;

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

  if p_lease_minutes is null then
    delete from public.claim_rules where vault_id = p_vault and path = p_path;
  else
    insert into public.claim_rules as cr (
      vault_id, path, lease_minutes, max_lease_minutes, hold_limit_minutes, connection_cap, person_cap,
      place_in_line_minutes, check_again_minutes, min_gap_seconds, free_lapses, cooldown_cap_minutes, set_by)
    values (
      p_vault, p_path, p_lease_minutes, v_max, p_hold_limit_minutes, p_connection_cap, p_person_cap,
      coalesce(p_place_in_line_minutes, p_lease_minutes), coalesce(p_check_again_minutes, p_lease_minutes),
      coalesce(p_min_gap_seconds, 10), p_free_lapses, v_cooldown, private.uid())
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
