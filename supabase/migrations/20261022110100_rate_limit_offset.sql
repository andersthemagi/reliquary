-- Each key's windows start at its own second of the minute (issue #487;
-- owner's decision 2026-10-22; docs/research/server-load.md, "Waiting in
-- line through the MCP server, simulated").
--
-- Every window was aligned to the minute, so every key over a limit was
-- let back at :00 together: the simulated load test's crowd, refused for
-- the rest of its minute, returned all at once and queued the pooler for 3
-- to 5 seconds each minute. Now a key's whole-minute windows (a minute, 10
-- or 15 minutes, an hour, a day) start at an offset of 0 to 59 seconds,
-- from the key's first 8 hex digits, so keys come back spread over the
-- minute. A window is as long as before; only where it starts moves.
-- Retry-After and the MCP server's memory of a refusal come from the
-- window's own end (expires_at), so nobody waits past their window.
-- Windows that aren't whole minutes (the test suites' 2 second ones) keep
-- starting on their multiple.
--
-- 1. private.rate_limit_window_start(key, window, epoch): the one place a
--    window's start is computed.
-- 2. private.rate_limit_hit: as in 20260925200000_rate_limits.sql (its only
--    definition), its windows from 1.
-- 3. private.rate_limit_token_and_person: as in
--    20261022110000_rate_limit_person.sql, its check of the person's
--    window from 1.
--
-- Counts in a window that started on the minute before this migration are
-- not carried over: a key's first window after it starts fresh, which only
-- forgives some requests once.

-- ---------------------------------------------------------------------------
-- 1. Where a key's window starts

create function private.rate_limit_window_start(p_key text, p_window int, p_now double precision)
returns timestamptz
language sql immutable set search_path = '' as $$
  select to_timestamp(floor((p_now - x.o) / p_window) * p_window + x.o)
    from (select case when p_window % 60 = 0 and p_key ~ '^[0-9a-f]{8}'
                      then ('x' || substr(p_key, 1, 8))::bit(32)::bigint % 60 else 0 end as o) x
$$;
revoke all on function private.rate_limit_window_start(text, int, double precision) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Counting a request

create or replace function private.rate_limit_hit(p_buckets text[], p_keys text[], p_windows int[], p_limits int[], p_costs int[])
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  n int := cardinality(p_buckets);
  v_now double precision := extract(epoch from now());
  v_wait int;
begin
  if n is null or n < 1 or n > 8
     or cardinality(p_keys) is distinct from n or cardinality(p_windows) is distinct from n
     or cardinality(p_limits) is distinct from n or cardinality(p_costs) is distinct from n then
    raise exception 'rate limit: one key, window, limit and cost per bucket, 1 to 8 buckets' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(p_windows, p_limits, p_costs) as u(w, l, c)
              where w is null or w < 1 or w > 604800 or l is null or l < 1 or c is null or c < 0 or c > 1000) then
    raise exception 'rate limit: a window is 1 s to 7 days, a limit at least 1, a cost 0 to 1000' using errcode = '22023';
  end if;
  if (select count(distinct (b, k)) from unnest(p_buckets, p_keys) as u(b, k)) <> n then
    raise exception 'rate limit: a bucket and key only once per call' using errcode = '22023';
  end if;

  with w as (
    select u.b, u.k, u.l, u.c,
           private.rate_limit_window_start(u.k, u.w, v_now) as ws,
           private.rate_limit_window_start(u.k, u.w, v_now) + make_interval(secs => u.w) as we
      from unnest(p_buckets, p_keys, p_windows, p_limits, p_costs) as u(b, k, w, l, c)
  ), h as (
    insert into private.rate_limits as r (bucket, key, window_start, expires_at, hits)
    select w.b, w.k, w.ws, w.we, w.c from w
    on conflict (bucket, key, window_start) do update set hits = r.hits + excluded.hits
    returning r.bucket, r.key, r.expires_at, r.hits
  )
  select coalesce(max(greatest(1, ceil(extract(epoch from h.expires_at - now()))::int)) filter (where h.hits > w.l), 0)
    into v_wait
    from h join w on w.b = h.bucket and w.k = h.key;

  -- Refused: nothing counts. The rows stay locked by the upsert until the
  -- transaction ends, so a concurrent request sees the undone count.
  if v_wait > 0 then
    update private.rate_limits r set hits = greatest(0, r.hits - u.c)
      from unnest(p_buckets, p_keys, p_windows, p_costs) as u(b, k, w, c)
     where r.bucket = u.b and r.key = u.k and r.window_start = private.rate_limit_window_start(u.k, u.w, v_now);
  end if;

  if random() < 0.01 and not private.rate_limits_pruned_by_cron() then
    perform private.prune_rate_limits();
  end if;
  return v_wait;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Counting a token's request against its grant and its person

create or replace function private.rate_limit_token_and_person(p_token_hash text,
  p_buckets text[], p_windows int[], p_limits int[], p_costs int[],
  p_person_buckets text[], p_person_windows int[], p_person_limits int[], p_person_costs int[])
returns table (o_wait int, o_person boolean)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_grant uuid;
  v_user uuid;
  v_key text;
  v_pkey text;
  v_now double precision := extract(epoch from now());
  v_wait int;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    return query select 0, false;
    return;
  end if;
  select x.g, x.u into v_grant, v_user from (
    select a.id as g, a.user_id as u from public.access_tokens a
     where a.token_hash = p_token_hash and a.kind = 'pat'
       and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())
    union all
    select k.grant_id, a.user_id from private.oauth_tokens k
      join public.access_tokens a on a.id = k.grant_id
     where k.token_hash = p_token_hash and k.kind = 'access' and k.expires_at > now()
       and a.revoked_at is null and a.expires_at > now()
  ) x limit 1;
  if v_grant is null then
    return query select 0, false;
    return;
  end if;
  v_key := encode(sha256(convert_to('grant:' || v_grant::text, 'UTF8')), 'hex');
  v_pkey := encode(sha256(convert_to('person:' || v_user::text, 'UTF8')), 'hex');
  v_wait := private.rate_limit_hit(
    coalesce(p_buckets, '{}') || coalesce(p_person_buckets, '{}'),
    array_fill(v_key, array[coalesce(cardinality(p_buckets), 0)])
      || array_fill(v_pkey, array[coalesce(cardinality(p_person_buckets), 0)]),
    coalesce(p_windows, '{}') || coalesce(p_person_windows, '{}'),
    coalesce(p_limits, '{}') || coalesce(p_person_limits, '{}'),
    coalesce(p_costs, '{}') || coalesce(p_person_costs, '{}'));
  -- Refused, the counts are back where they were (rate_limit_hit), so a
  -- person bucket refused this call if this call doesn't fit in it.
  return query select v_wait, v_wait > 0 and exists (
    select 1 from unnest(p_person_buckets, p_person_windows, p_person_limits, p_person_costs) as u(b, w, l, c)
      left join private.rate_limits r
        on r.bucket = u.b and r.key = v_pkey and r.window_start = private.rate_limit_window_start(v_pkey, u.w, v_now)
     where coalesce(r.hits, 0) + u.c > u.l);
end $$;
