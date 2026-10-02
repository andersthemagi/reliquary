-- Work plans (CL-3.2, phase 3 of the claims, waiting and work plans
-- effort, tracking issue #52; design settled in docs/design.md, "Claims
-- and work plans", CL-0.2; the dependency-gating and stored-count
-- mechanism validated in spikes/claims/guard.sql, CL-0.4). A work plan is
-- steps with dependencies, registered from a plan file's current
-- version, so no agent is handed a step before the ones blocking it are
-- done.
--
-- mcp/src/workplan-format.ts (CL-3.1) already parses a plan file's fenced
-- block and gives a person or agent clear, line-numbered errors before
-- any of this runs. Nothing here trusts that: register_work_plan
-- re-validates duplicate keys, unknown blockers, self-dependencies and
-- cycles from scratch (design item 12a's "one way in" -- a rule that
-- depended on the client having checked first wouldn't be a rule). CL-3.4
-- wires the two together: parse client-side for the good error, then
-- call this function, which is the actual gate.
--
-- Readiness is a stored count of unfinished blockers (design item 12f),
-- kept in step by complete_step and skip_step, the only two paths that
-- ever decrement it; cancel_step does not, so a step blocked by a
-- cancelled one stays blocked forever, matching design item 7 exactly
-- (work_plan_status, below, is the only place that still runs a join, to
-- tell a person "blocked_by_cancelled" apart from an ordinary "blocked" --
-- a display read, not the claim gate design item 12f is actually about).
--
-- checkin_step restarts a claimed step's lease without finishing it, the
-- same check-in-restarts-the-lease shape renew_claim already gives path
-- claims (design item 3). CL-3.2's own issue text doesn't name it, but
-- design item 12(a) does, listing agent_checkin_step as its own
-- agent-facing primitive, a peer of agent_complete_step and
-- agent_release_step -- not something CL-3.9's request_work wrapper
-- would produce, since #74's own text is scoped to the waiting queue's
-- ticket (refreshed by calling request_work again), never a claimed
-- step's lease. Flagged as a gap on #70 rather than silently decided
-- either way; included here on that basis.
--
-- Scoped out on purpose, matching exactly what CL-3.2's own issue asks
-- for and no more (checkin_step above is the one deliberate addition to
-- that list, for the reason just given):
-- * No queue, no fairness, no cooldowns, no caps on active steps. That is
--   request_work, CL-3.9 (design items 3's phase-3 columns, 8, 11, 12b/e/g),
--   which "wraps" claim_step -- this migration's claim_step is the direct
--   "claim this named step, or refuse" primitive it wraps, not the
--   any-ready-step-with-a-place-in-line version.
-- * No re-registration. A path gets one work plan; registering a second
--   time is refused. Changing a plan's steps after the fact isn't named
--   anywhere in issues #52's checklist either.
-- * No delete_vault/erase_file integration. vault_id references
--   public.vaults directly (not through vault_members, unlike path_claims'
--   holder column), so plain vault deletion already cascades cleanly with
--   no nullable-FK gap -- but the same deadlock risk 20260930210000_
--   claims_lock_order.sql fixed for path_claims (claim_step's update also
--   touches a vault_members-referencing FK, via holder) is left for CL-3.3
--   to find and fix with its own forced-interleaving race test, the same
--   split CL-2.1/CL-2.2 already used for claims.
--
-- skip_step's meaning isn't spelled out in design.md's twelve points
-- (flagged on CL-0.2, issue #58, rather than guessed and left
-- unexplained): implemented here as "mark done without doing it" --
-- same stored status as complete_step, same dependent-unblocking, but
-- person-only and without the holder/fence/secret check, the same
-- ceiling break_claim already uses to act without proof of identity.
-- cancel_step, by contrast, never unblocks anything (design item 7).

create table public.work_plans (
  id            uuid primary key default gen_random_uuid(),
  vault_id      uuid not null references public.vaults on delete cascade,
  path          text not null,
  version_id    uuid not null,
  registered_by uuid not null,
  registered_at timestamptz not null default clock_timestamp(),
  unique (vault_id, path)
);

create table public.work_plan_steps (
  id            bigint generated always as identity primary key,
  plan_id       uuid not null references public.work_plans on delete cascade,
  vault_id      uuid not null references public.vaults on delete cascade,
  key           text not null check (key ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  title         text not null check (length(title) between 1 and 200),
  gate          text check (gate is null or gate = 'review'),
  status        text not null default 'open' check (status in ('open', 'claimed', 'done', 'cancelled')),
  open_blockers int not null default 0 check (open_blockers >= 0),
  fence         int not null default 0,
  holder        uuid,
  holder_token  uuid references public.access_tokens on delete cascade,
  holder_label  text check (holder_label is null or length(holder_label) <= 200),
  secret_hash   text,
  claimed_at    timestamptz,
  expires_at    timestamptz,
  done_at       timestamptz,
  unique (plan_id, key),
  foreign key (vault_id, holder) references public.vault_members (vault_id, user_id) on delete cascade
);
create index on public.work_plan_steps (holder_token);
create index on public.work_plan_steps (vault_id, holder);
-- "is anything ready" without a join (design item 12f): a step is ready
-- exactly when it's open with no unfinished blocker.
create index work_plan_steps_ready on public.work_plan_steps (plan_id, id) where status = 'open' and open_blockers = 0;
create index work_plan_steps_claimed on public.work_plan_steps (plan_id, expires_at) where status = 'claimed';

create table public.work_plan_step_blockers (
  step_id    bigint not null references public.work_plan_steps on delete cascade,
  blocker_id bigint not null references public.work_plan_steps on delete cascade,
  primary key (step_id, blocker_id),
  check (step_id <> blocker_id)
);
create index on public.work_plan_step_blockers (blocker_id);

-- What a step cites (canon path and version it depends on), normalized so
-- CL-3.6's "canon moved" signal can look up "which open or claimed steps
-- cite this path" without scanning every plan.
create table public.work_plan_step_cites (
  step_id bigint not null references public.work_plan_steps on delete cascade,
  path    text not null,
  version uuid not null,
  primary key (step_id, path)
);
create index on public.work_plan_step_cites (path);

alter table public.work_plans enable row level security;
create policy member_read on public.work_plans for select to authenticated
  using (vault_id in (select private.readable_vaults()));
revoke all on public.work_plans from public, anon, authenticated;
grant select on public.work_plans to authenticated;

alter table public.work_plan_steps enable row level security;
create policy member_read on public.work_plan_steps for select to authenticated
  using (vault_id in (select private.readable_vaults()));
revoke all on public.work_plan_steps from public, anon, authenticated;
grant select (id, plan_id, vault_id, key, title, gate, status, open_blockers, fence, holder, holder_label,
  claimed_at, expires_at, done_at) on public.work_plan_steps to authenticated;

alter table public.work_plan_step_blockers enable row level security;
create policy member_read on public.work_plan_step_blockers for select to authenticated
  using (exists (select 1 from public.work_plan_steps s
                 where s.id = step_id and s.vault_id in (select private.readable_vaults())));
revoke all on public.work_plan_step_blockers from public, anon, authenticated;
grant select on public.work_plan_step_blockers to authenticated;

alter table public.work_plan_step_cites enable row level security;
create policy member_read on public.work_plan_step_cites for select to authenticated
  using (exists (select 1 from public.work_plan_steps s
                 where s.id = step_id and s.vault_id in (select private.readable_vaults())));
revoke all on public.work_plan_step_cites from public, anon, authenticated;
grant select on public.work_plan_step_cites to authenticated;

-- Shared by complete_step and skip_step: tell a finished step's
-- dependents. Locked in id order first, so two steps that finish together
-- and share a dependent take that row in the same order rather than
-- opposite ones (the deadlock design item 7's own accept criteria names).
create function private.unblock_dependents(p_step_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform 1 from public.work_plan_steps s
   where s.id in (select d.step_id from public.work_plan_step_blockers d where d.blocker_id = p_step_id)
   order by s.id for update;
  update public.work_plan_steps s set open_blockers = s.open_blockers - 1
   where s.id in (select d.step_id from public.work_plan_step_blockers d where d.blocker_id = p_step_id);
end $$;
revoke all on function private.unblock_dependents(bigint) from public, anon, authenticated;

-- p_steps: [{"key","title","gate","blocked_by":[...],"cites":[{"path","version"}]}, ...].
-- Refuses duplicate keys, unknown blockers, self-dependencies and cycles
-- (Kahn's algorithm in temp tables: repeatedly drop a step with no
-- unresolved blocker left; anything remaining is in a cycle -- the same
-- approach spikes/claims/plan.sql validated), a title missing or over 200
-- characters, a bad gate, more than 500 steps or 50 blockers on one step
-- (design item 8, confirmed by the maintainer 2026-10-02), and a stale
-- p_version (RLF01, the same family write_file's compare-and-swap check
-- uses, since this is the same kind of staleness: the file changed since
-- the caller read it).
create function public.register_work_plan(p_vault uuid, p_path text, p_version uuid, p_steps jsonb)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_current uuid;
  v_plan_id uuid;
  v_n_steps int;
  v_removed text[];
begin
  perform private.require_person();
  perform private.valid_path(p_path);
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if exists (select 1 from public.work_plans where vault_id = p_vault and path = p_path) then
    raise exception '% already has a registered work plan', p_path using errcode = '23505';
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

  insert into public.work_plans (vault_id, path, version_id, registered_by)
  values (p_vault, p_path, p_version, private.uid())
  returning id into v_plan_id;

  insert into public.work_plan_steps (plan_id, vault_id, key, title, gate)
    select v_plan_id, p_vault, x.key, x.title, x.gate
      from jsonb_to_recordset(p_steps) as x(key text, title text, gate text);

  insert into public.work_plan_step_blockers (step_id, blocker_id)
    select st.id, bl.id
      from (
        select x.key as step_key, b.k as blocker_key
          from jsonb_to_recordset(p_steps) as x(key text, blocked_by jsonb),
               jsonb_array_elements_text(coalesce(x.blocked_by, '[]'::jsonb)) as b(k)
      ) edges
      join public.work_plan_steps st on st.plan_id = v_plan_id and st.key = edges.step_key
      join public.work_plan_steps bl on bl.plan_id = v_plan_id and bl.key = edges.blocker_key;

  update public.work_plan_steps st
     set open_blockers = (select count(*) from public.work_plan_step_blockers d where d.step_id = st.id)
   where st.plan_id = v_plan_id;

  insert into public.work_plan_step_cites (step_id, path, version)
    select st.id, cited.cite_path, cited.cite_version
      from (
        select x.key as step_key, c.path as cite_path, c.version as cite_version
          from jsonb_to_recordset(p_steps) as x(key text, cites jsonb),
               jsonb_to_recordset(coalesce(x.cites, '[]'::jsonb)) as c(path text, version uuid)
      ) cited
      join public.work_plan_steps st on st.plan_id = v_plan_id and st.key = cited.step_key;

  perform private.log_event(p_vault, 'work_plan.register', p_path, p_version, null,
    jsonb_build_object('plan', v_plan_id, 'steps', v_n_steps));
  return v_plan_id;
end $$;

-- The claim and "every blocker is done" in one statement (design item
-- 12c): the UPDATE's own WHERE clause is the single predicate that grants
-- it, reading the stored open_blockers count, never a live join. Expired
-- claims are reclaimable (lazy expiry, like path_claims); a done or
-- cancelled step, one still blocked, or one actively held by someone else
-- is refused, each told apart for the message only, after the fact.
create function public.claim_step(p_vault uuid, p_path text, p_key text, p_label text default null, p_ttl_minutes int default null)
returns table (o_secret text, o_fence int, o_expires timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_label text := nullif(trim(coalesce(p_label, '')), '');
  v_rule record;
  v_ttl interval;
  v_plan_id uuid;
  v_fence int;
  v_expires timestamptz;
  v_cur public.work_plan_steps;
begin
  perform private.require_person();
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if v_label is not null and length(v_label) > 200 then
    raise exception 'a label is at most 200 characters' using errcode = '22023';
  end if;
  if p_ttl_minutes is not null and p_ttl_minutes < 1 then
    raise exception 'a claim lasts at least one minute' using errcode = '22023';
  end if;

  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.work_plan_steps where plan_id = v_plan_id and key = p_key) then
    raise exception 'no such step' using errcode = 'P0002';
  end if;

  select * into v_rule from private.claim_rule_for(p_vault, p_path);
  v_ttl := least(coalesce(p_ttl_minutes, v_rule.lease_minutes), v_rule.max_lease_minutes) * interval '1 minute';

  update public.work_plan_steps st
     set status = 'claimed', fence = st.fence + 1, holder = private.uid(), holder_token = private.token_id(),
         holder_label = v_label, secret_hash = private.token_hash(v_secret),
         claimed_at = clock_timestamp(), expires_at = clock_timestamp() + v_ttl
   where st.plan_id = v_plan_id and st.key = p_key and st.open_blockers = 0
     and (st.status = 'open' or (st.status = 'claimed' and st.expires_at <= clock_timestamp()))
  returning st.fence, st.expires_at into v_fence, v_expires;

  if v_fence is null then
    select * into v_cur from public.work_plan_steps where plan_id = v_plan_id and key = p_key;
    if v_cur.status in ('done', 'cancelled') then
      raise exception 'step "%" is already %', p_key, v_cur.status using errcode = 'RLW02';
    elsif v_cur.status = 'claimed' then
      raise exception 'step "%" is already claimed by % until %', p_key, coalesce(v_cur.holder_label, 'someone'), v_cur.expires_at
        using errcode = 'RLW01';
    else
      raise exception 'step "%" is blocked: % blocker(s) not finished', p_key, v_cur.open_blockers using errcode = 'RLW02';
    end if;
  end if;

  perform private.log_event(p_vault, 'step.claim', p_path, null, null,
    jsonb_build_object('plan', v_plan_id, 'step', p_key, 'fence', v_fence));
  return query select v_secret, v_fence, v_expires;
end $$;

-- Needs the secret, the fence, and the same connection and person that
-- hold the claim (design item 2), plus an unlapsed lease: a stale holder
-- reporting success for work nobody credits it for would be worse than
-- the refusal. Unblocks dependents (private.unblock_dependents).
create function public.complete_step(p_vault uuid, p_path text, p_key text, p_fence int, p_secret text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_plan_id uuid; v_row public.work_plan_steps;
begin
  perform private.require_person();
  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  end if;
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

-- Gives a step back unfinished; the same identity check as complete_step,
-- but (matching release_claim) no expiry check, since releasing an
-- already-lapsed claim you still think you hold is harmless.
create function public.release_step(p_vault uuid, p_path text, p_key text, p_fence int, p_secret text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_plan_id uuid; v_row public.work_plan_steps;
begin
  perform private.require_person();
  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  end if;
  select * into v_row from public.work_plan_steps where plan_id = v_plan_id and key = p_key for update;
  if v_row.id is null then
    raise exception 'no such step' using errcode = 'P0002';
  end if;
  if v_row.status <> 'claimed' or v_row.fence <> p_fence or v_row.secret_hash is distinct from private.token_hash(p_secret)
     or v_row.holder is distinct from private.uid() or v_row.holder_token is distinct from private.token_id()
  then
    raise exception 'this step is no longer yours to release (wrong secret or fence, or a different connection)' using errcode = 'RLW03';
  end if;
  update public.work_plan_steps
     set status = 'open', holder = null, holder_token = null, holder_label = null, secret_hash = null,
         claimed_at = null, expires_at = null
   where id = v_row.id;
  perform private.log_event(p_vault, 'step.release', p_path, null, null,
    jsonb_build_object('plan', v_plan_id, 'step', p_key, 'fence', p_fence));
end $$;

-- The check-in that restarts a claimed step's lease without finishing
-- it, the same shape renew_claim already gives path claims (design item
-- 3: "every check-in restarts the lease"). Needs the secret, the fence,
-- and the same connection and person as claim_step (design item 2), plus
-- an unlapsed lease -- the same reasoning complete_step uses, since
-- checking in on a step nobody still credits you for would be worse
-- than the refusal. No amount of checking in holds a step past the
-- claim rule's hold limit, counted from the original claim_step grant
-- (claimed_at), not the last check-in, the same shape renew_claim
-- already uses for path claims.
create function public.checkin_step(p_vault uuid, p_path text, p_key text, p_fence int, p_secret text, p_ttl_minutes int default null)
returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_plan_id uuid;
  v_rule record;
  v_ttl interval;
  v_expires timestamptz;
  v_row public.work_plan_steps;
begin
  perform private.require_person();
  if p_ttl_minutes is not null and p_ttl_minutes < 1 then
    raise exception 'a claim lasts at least one minute' using errcode = '22023';
  end if;

  select id into v_plan_id from public.work_plans where vault_id = p_vault and path = p_path;
  if v_plan_id is null then
    raise exception 'no work plan is registered at this path' using errcode = 'P0002';
  end if;
  select * into v_row from public.work_plan_steps where plan_id = v_plan_id and key = p_key for update;
  if v_row.id is null then
    raise exception 'no such step' using errcode = 'P0002';
  end if;
  if v_row.status <> 'claimed' or v_row.fence <> p_fence or v_row.secret_hash is distinct from private.token_hash(p_secret)
     or v_row.holder is distinct from private.uid() or v_row.holder_token is distinct from private.token_id()
     or v_row.expires_at <= clock_timestamp()
  then
    raise exception 'this step is no longer yours to check in on (wrong secret or fence, a different connection, or the lease lapsed)'
      using errcode = 'RLW03';
  end if;

  select * into v_rule from private.claim_rule_for(p_vault, p_path);
  v_ttl := least(coalesce(p_ttl_minutes, v_rule.lease_minutes), v_rule.max_lease_minutes) * interval '1 minute';
  v_expires := least(clock_timestamp() + v_ttl, v_row.claimed_at + v_rule.hold_limit_minutes * interval '1 minute');
  if v_expires <= clock_timestamp() then
    raise exception 'this step is past its hold limit; release it and claim again' using errcode = 'RLW04';
  end if;

  update public.work_plan_steps set expires_at = v_expires where id = v_row.id;
  perform private.log_event(p_vault, 'step.checkin', p_path, null, null,
    jsonb_build_object('plan', v_plan_id, 'step', p_key, 'fence', p_fence));
  return v_expires;
end $$;

-- A person's action, whoever can write the path (design items 1, 4): a
-- cancelled step never counts as done, so its dependents stay blocked
-- (open_blockers is never decremented here) until a person cancels them
-- too or reroutes the plan -- design item 7's own point of this state.
create function public.cancel_step(p_vault uuid, p_path text, p_key text)
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
  select * into v_row from public.work_plan_steps where plan_id = v_plan_id and key = p_key for update;
  if v_row.id is null then
    raise exception 'no such step' using errcode = 'P0002';
  end if;
  if v_row.status in ('done', 'cancelled') then
    raise exception 'step "%" is already %', p_key, v_row.status using errcode = 'RLW02';
  end if;
  update public.work_plan_steps
     set status = 'cancelled', holder = null, holder_token = null, holder_label = null, secret_hash = null,
         claimed_at = null, expires_at = null
   where id = v_row.id;
  perform private.log_event(p_vault, 'step.cancel', p_path, null, null, jsonb_build_object('plan', v_plan_id, 'step', p_key));
end $$;

-- A person's action: marks a step done without anyone having claimed or
-- completed it (see this file's header for why), the same no-proof
-- ceiling break_claim already uses. Unblocks dependents exactly as
-- complete_step does.
create function public.skip_step(p_vault uuid, p_path text, p_key text)
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

-- Computed status (design item 7), security invoker: RLS on
-- work_plan_steps/work_plan_step_blockers already limits this to vaults
-- the caller can read, the same reason list_claims needs no wrapper
-- function of its own. blocked_by_cancelled is the one case still worth a
-- join: a display read, not the stored-count claim gate item 12f is
-- about.
create function public.work_plan_status(p_vault uuid, p_path text)
returns table (o_key text, o_title text, o_state text, o_holder_label text, o_expires_at timestamptz)
language sql stable set search_path = '' as $$
  select s.key, s.title,
    case
      when s.status = 'done' then 'done'
      when s.status = 'cancelled' then 'cancelled'
      when s.status = 'claimed' and s.expires_at > clock_timestamp() then 'claimed'
      when exists (select 1 from public.work_plan_step_blockers d join public.work_plan_steps b on b.id = d.blocker_id
                    where d.step_id = s.id and b.status = 'cancelled') then 'blocked_by_cancelled'
      when s.open_blockers > 0 then 'blocked'
      else 'ready'
    end,
    s.holder_label, s.expires_at
  from public.work_plan_steps s
  join public.work_plans p on p.id = s.plan_id
  where p.vault_id = p_vault and p.path = p_path
  order by s.id
$$;

revoke all on function
  public.register_work_plan(uuid, text, uuid, jsonb), public.claim_step(uuid, text, text, text, int),
  public.complete_step(uuid, text, text, int, text), public.release_step(uuid, text, text, int, text),
  public.checkin_step(uuid, text, text, int, text, int),
  public.cancel_step(uuid, text, text), public.skip_step(uuid, text, text), public.work_plan_status(uuid, text)
  from public, anon;
grant execute on function
  public.register_work_plan(uuid, text, uuid, jsonb), public.claim_step(uuid, text, text, text, int),
  public.complete_step(uuid, text, text, int, text), public.release_step(uuid, text, text, int, text),
  public.checkin_step(uuid, text, text, int, text, int),
  public.cancel_step(uuid, text, text), public.skip_step(uuid, text, text), public.work_plan_status(uuid, text)
  to authenticated;
