-- Claim rules (CL-2.7, tracking issue #52; design.md "Claims and work
-- plans" item 3, item 12's guard settings). How long a claim holds a path
-- is a rule, not a constant: a vault-and-path-prefix-keyed override of the
-- fixed defaults 20260930200000_path_claims.sql hard-coded (its own
-- comment named them the design's Org preset). Same specificity
-- resolution path_policies already uses (exact path, then longest folder
-- prefix) -- private.matched_policy_path, 20260928130000_path_ownership.sql.
--
-- Two design points this issue left implicit, resolved here (noted on the
-- tracking issue, #69, rather than guessed silently and left unexplained):
-- lease_minutes and max_lease_minutes are separate columns (a vault owner
-- can diverge them later), but every shipped preset below sets them equal,
-- matching claim_path's current behaviour exactly when no rule exists.
-- And the prefix match is LIKE, not starts_with() (path_policies' own
-- mechanism): the issue calls out escaping % and _ in prefixes, which
-- only matters for LIKE, and a LIKE prefix (vs. starts_with()) can use a
-- plain index -- this lookup runs on every claim_path/renew_claim call,
-- unlike rule_for's occasional read.
--
-- Phase-3-only columns (place_in_line_minutes, check_again_minutes,
-- min_gap_seconds, free_lapses, cooldown_cap_minutes) are stored and
-- settable from day one, so CL-3.x never needs a schema change, but
-- claim_path and renew_claim below only read the five phase-2 columns
-- they have a mechanism for.

create table public.claim_rules (
  vault_id              uuid not null references public.vaults on delete cascade,
  path                  text not null,
  lease_minutes         int not null check (lease_minutes >= 1),
  max_lease_minutes     int not null check (max_lease_minutes >= lease_minutes),
  hold_limit_minutes    int not null check (hold_limit_minutes >= max_lease_minutes),
  connection_cap        int not null default 1 check (connection_cap >= 1),
  person_cap            int not null default 5 check (person_cap >= connection_cap),
  -- Phase 3 (work plans, CL-3.x): not read by anything yet.
  place_in_line_minutes int not null,
  check_again_minutes   int not null,
  min_gap_seconds       int not null check (min_gap_seconds >= 10),
  free_lapses           int not null default 1 check (free_lapses >= 0),
  cooldown_cap_minutes  int not null,
  set_by                uuid not null,
  set_at                timestamptz not null default now(),
  primary key (vault_id, path)
);
-- A rule's path follows the same shape a policy rule's does (private.
-- rule_path_problem, 20260926120000_rule_paths.sql): not validated here
-- (NOT VALID, so existing rows -- none yet -- are unaffected), same
-- reasoning as path_policies_path_inside.
alter table public.claim_rules add constraint claim_rules_path_inside
  check (path ~ '^[^/].*' and path !~ '//') not valid;

alter table public.claim_rules enable row level security;
create policy member_read on public.claim_rules for select to authenticated
  using (vault_id in (select private.readable_vaults()));
revoke all on public.claim_rules from public, anon, authenticated;
grant select on public.claim_rules to authenticated;

-- The rule that applies to a path: the longest matching prefix (exact
-- path wins over any folder), or the fixed defaults when nothing matches
-- (the design's Org preset, claim_path's own behaviour before this
-- migration). security definer and unchecked, like private.policy_for:
-- callers that need access-checked, public-facing results wrap this, the
-- same split policy_for/rule_for already has.
create function private.claim_rule_for(p_vault uuid, p_path text,
  out lease_minutes int, out max_lease_minutes int, out hold_limit_minutes int,
  out connection_cap int, out person_cap int)
language sql stable security definer set search_path = '' as $$
  select coalesce(cr.lease_minutes, 48 * 60), coalesce(cr.max_lease_minutes, 48 * 60),
         coalesce(cr.hold_limit_minutes, 7 * 24 * 60), coalesce(cr.connection_cap, 1), coalesce(cr.person_cap, 5)
  from (select 1) x
  left join lateral (
    select * from public.claim_rules cr
     where cr.vault_id = p_vault
       and (cr.path = p_path
            or (right(cr.path, 1) = '/'
                and p_path like replace(replace(cr.path, '%', '\%'), '_', '\_') || '%' escape '\'))
     order by (cr.path = p_path) desc, length(cr.path) desc
     limit 1
  ) cr on true
$$;
revoke all on function private.claim_rule_for(uuid, text) from public, anon, authenticated;

-- claim_path and renew_claim: the same two functions
-- 20260930200000_path_claims.sql defined, now reading their lease, hold
-- limit and caps from the rule instead of the fixed defaults. Neither
-- function's signature changes. A rule set after a claim is granted never
-- touches that claim's own expires_at (design's own Accept criterion):
-- these calls only ever run at claim or renewal time.

create or replace function public.claim_path(p_vault uuid, p_path text, p_label text default null, p_ttl_minutes int default null)
returns table (o_secret text, o_fence int, o_expires timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_label text := nullif(trim(coalesce(p_label, '')), '');
  v_rule record;
  v_ttl interval;
  v_fence int;
  v_expires timestamptz;
  v_cur public.path_claims;
begin
  perform private.require_person();
  perform private.valid_path(p_path);
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if v_label is not null and length(v_label) > 200 then
    raise exception 'a claim label is at most 200 characters' using errcode = '22023';
  end if;
  if p_ttl_minutes is not null and p_ttl_minutes < 1 then
    raise exception 'a claim lasts at least one minute' using errcode = '22023';
  end if;
  select * into v_rule from private.claim_rule_for(p_vault, p_path);
  v_ttl := least(coalesce(p_ttl_minutes, v_rule.lease_minutes), v_rule.max_lease_minutes) * interval '1 minute';

  -- Connection and person caps (design items 3 and 12e): the rule's own
  -- connection_cap and person_cap, in this vault.
  if (select count(*) from public.path_claims pc
       where pc.vault_id = p_vault and pc.expires_at > clock_timestamp()
         and pc.holder = private.uid() and pc.holder_token is not distinct from private.token_id()) >= v_rule.connection_cap
  then
    raise exception 'this connection already holds a claim in this vault; release it first' using errcode = 'RLC03';
  end if;
  if (select count(*) from public.path_claims pc
       where pc.vault_id = p_vault and pc.expires_at > clock_timestamp() and pc.holder = private.uid()) >= v_rule.person_cap
  then
    raise exception 'you already hold % claims in this vault, across your agents; release one first', v_rule.person_cap using errcode = 'RLC03';
  end if;

  insert into public.path_claims as c (vault_id, path, fence, holder, holder_token, holder_label, secret_hash, granted_at, renewed_at, expires_at)
  values (p_vault, p_path, 1, private.uid(), private.token_id(), v_label, private.token_hash(v_secret), clock_timestamp(), clock_timestamp(), clock_timestamp() + v_ttl)
  on conflict (vault_id, path) do update
     set fence = c.fence + 1, holder = excluded.holder, holder_token = excluded.holder_token,
         holder_label = excluded.holder_label, secret_hash = excluded.secret_hash,
         granted_at = clock_timestamp(), renewed_at = clock_timestamp(), expires_at = excluded.expires_at
   where c.expires_at <= clock_timestamp()
  returning c.fence, c.expires_at into v_fence, v_expires;

  if v_fence is null then
    select * into v_cur from public.path_claims pc where pc.vault_id = p_vault and pc.path = p_path;
    raise exception 'already claimed by % until %', coalesce(v_cur.holder_label, 'someone'), v_cur.expires_at
      using errcode = 'RLC01';
  end if;

  perform private.log_event(p_vault, 'claim.grant', p_path, null, null, jsonb_build_object('fence', v_fence, 'label', v_label));
  return query select v_secret, v_fence, v_expires;
end $$;

create or replace function public.renew_claim(p_vault uuid, p_path text, p_fence int, p_secret text, p_ttl_minutes int default null)
returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_rule record;
  v_ttl interval;
  v_expires timestamptz;
  v_row public.path_claims;
begin
  perform private.require_person();
  if p_ttl_minutes is not null and p_ttl_minutes < 1 then
    raise exception 'a claim lasts at least one minute' using errcode = '22023';
  end if;

  select * into v_row from public.path_claims where vault_id = p_vault and path = p_path for update;
  if v_row.path is null then
    raise exception 'no such claim' using errcode = 'P0002';
  end if;
  if v_row.fence <> p_fence or v_row.secret_hash is distinct from private.token_hash(p_secret)
     or v_row.holder is distinct from private.uid() or v_row.holder_token is distinct from private.token_id()
     or v_row.expires_at <= clock_timestamp()
  then
    raise exception 'this claim is no longer yours to renew (wrong secret or fence, a different connection, or already expired)' using errcode = 'RLC02';
  end if;

  select * into v_rule from private.claim_rule_for(p_vault, p_path);
  v_ttl := least(coalesce(p_ttl_minutes, v_rule.lease_minutes), v_rule.max_lease_minutes) * interval '1 minute';
  v_expires := least(clock_timestamp() + v_ttl, v_row.granted_at + v_rule.hold_limit_minutes * interval '1 minute');
  if v_expires <= clock_timestamp() then
    raise exception 'this claim is past its hold limit; release it and claim again' using errcode = 'RLC04';
  end if;

  update public.path_claims set renewed_at = clock_timestamp(), expires_at = v_expires
   where vault_id = p_vault and path = p_path;
  perform private.log_event(p_vault, 'claim.renew', p_path, null, null, jsonb_build_object('fence', p_fence));
  return v_expires;
end $$;

-- The setter: a person, owner of the vault, same ceiling and shape as
-- set_policy (20260926120000_rule_paths.sql). p_lease_minutes null
-- removes the rule, same as set_policy's p_policy null. p_hold_limit_minutes
-- has no default on purpose: silently defaulting it to one lease would make
-- every renewal a no-op (expires_at already capped at granted_at + one
-- lease), a footgun worse than asking the caller to say what they mean.
create function public.set_claim_rule(p_vault uuid, p_path text,
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
  if p_lease_minutes is null and exists (select 1 from public.claim_rules where vault_id = p_vault and path = p_path) then
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
    -- Range checks (lease at least a minute, hold limit at least a lease,
    -- caps at least 1) are the table's own CHECK constraints, 23514, the
    -- same split set_policy's quorum and policy already use: not
    -- duplicated here.
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
  perform private.log_event(p_vault, 'claim_rule.set', p_path, null, null,
    jsonb_build_object('lease_minutes', p_lease_minutes, 'max_lease_minutes', p_max_lease_minutes));
end $$;

revoke all on function public.set_claim_rule(uuid, text, int, int, int, int, int, int, int, int, int, int) from public, anon;
grant execute on function public.set_claim_rule(uuid, text, int, int, int, int, int, int, int, int, int, int) to authenticated;
