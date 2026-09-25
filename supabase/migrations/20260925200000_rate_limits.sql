-- Rate limits on the public surfaces (docs/public/reference/limits.md,
-- "Rate limits"; docs/research/server-load.md, "Rate limits").
--
-- The apps run as many short-lived serverless instances, so a counter kept
-- in one instance's memory limits nothing. The counters live here, in one
-- small table of fixed windows keyed by (bucket, key, window start), and a
-- request's buckets are counted in one statement.
--
-- 1. private.rate_limits: the counters. Unlogged (a crash may reset them,
--    which only forgives some requests) and pruned by pg_cron. A key is
--    always 64 hex digits: an HMAC the app computed (of an IP address, an
--    email address, a session) or, for a token, a hash of its grant's id.
--    A raw IP address or email address can't be stored: the check refuses
--    anything else.
-- 2. private.rate_limit_salt(): the HMAC key the apps use, made here at
--    random once, so no new secret has to be configured and both apps and
--    every instance share it. Only the apps' roles may read it.
-- 3. private.rate_limit_hit(buckets, keys, windows, limits, costs): counts
--    one request against each bucket, in one upsert. Returns 0 when every
--    bucket is within its limit, else the seconds until the fullest window
--    ends (the Retry-After). A refused request counts against nothing: its
--    increments are taken back in the same transaction, so hammering while
--    refused doesn't extend or use up another bucket.
-- 4. private.rate_limit_token(token hash, ...): the same, keyed by the grant
--    a live access token belongs to (a personal token, or an OAuth or CLI
--    grant's current access token), so a grant's limit holds across its
--    hourly access tokens. A token that isn't live counts nothing.
-- 5. private.prune_rate_limits(): deletes windows that have ended. pg_cron
--    runs it every five minutes where the platform has pg_cron; without it,
--    about one hit in a hundred prunes.
--
-- Only the web app's and the MCP server's roles may call 2 to 4. People,
-- agents and anonymous callers can't read, write or reset a counter.

-- ---------------------------------------------------------------------------
-- 1. Counters

create unlogged table private.rate_limits (
  bucket       text not null check (bucket ~ '^[a-z][a-z0-9_]{0,39}$'),
  key          text not null check (key ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  expires_at   timestamptz not null,
  hits         int not null check (hits >= 0),
  primary key (bucket, key, window_start)
);
create index rate_limits_expires_at_idx on private.rate_limits (expires_at);
alter table private.rate_limits enable row level security;
revoke all on private.rate_limits from public, anon, authenticated, reliquary_web, reliquary_mcp;

-- ---------------------------------------------------------------------------
-- 2. The HMAC key

create table private.rate_limit_salt (
  id   boolean primary key default true check (id),
  salt text not null check (salt ~ '^[0-9a-f]{64}$')
);
alter table private.rate_limit_salt enable row level security;
revoke all on private.rate_limit_salt from public, anon, authenticated, reliquary_web, reliquary_mcp;
-- Two random UUIDs: 244 random bits.
insert into private.rate_limit_salt (salt)
values (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''));

create function private.rate_limit_salt() returns text
language sql stable security definer set search_path = '' as $$
  select s.salt from private.rate_limit_salt s
$$;

-- ---------------------------------------------------------------------------
-- 5. Pruning (before 3, which may call it)

create function private.prune_rate_limits() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  n int;
begin
  delete from private.rate_limits where expires_at <= now();
  get diagnostics n = row_count;
  return n;
end $$;

-- Whether pg_cron prunes here (the job below exists and is active).
create function private.rate_limits_pruned_by_cron() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v boolean;
begin
  if to_regclass('cron.job') is null then
    return false;
  end if;
  execute 'select exists (select 1 from cron.job where jobname = $1 and active)'
    into v using 'reliquary-rate-limits';
  return coalesce(v, false);
exception when others then
  return false;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Counting a request

create function private.rate_limit_hit(p_buckets text[], p_keys text[], p_windows int[], p_limits int[], p_costs int[])
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
           to_timestamp(floor(v_now / u.w) * u.w) as ws,
           to_timestamp(floor(v_now / u.w) * u.w + u.w) as we
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
     where r.bucket = u.b and r.key = u.k and r.window_start = to_timestamp(floor(v_now / u.w) * u.w);
  end if;

  if random() < 0.01 and not private.rate_limits_pruned_by_cron() then
    perform private.prune_rate_limits();
  end if;
  return v_wait;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Counting a token's request against its grant

create function private.rate_limit_token(p_token_hash text, p_buckets text[], p_windows int[], p_limits int[], p_costs int[])
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_grant uuid;
  v_key text;
begin
  if coalesce(p_token_hash, '') !~ '^[0-9a-f]{64}$' then
    return 0;
  end if;
  select g into v_grant from (
    select a.id as g from public.access_tokens a
     where a.token_hash = p_token_hash and a.kind = 'pat'
       and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())
    union all
    select k.grant_id from private.oauth_tokens k
      join public.access_tokens a on a.id = k.grant_id
     where k.token_hash = p_token_hash and k.kind = 'access' and k.expires_at > now()
       and a.revoked_at is null and a.expires_at > now()
  ) x limit 1;
  if v_grant is null then
    return 0;
  end if;
  v_key := encode(sha256(convert_to('grant:' || v_grant::text, 'UTF8')), 'hex');
  return private.rate_limit_hit(p_buckets, array_fill(v_key, array[coalesce(cardinality(p_buckets), 0)]),
    p_windows, p_limits, p_costs);
end $$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.rate_limit_salt(), private.prune_rate_limits(), private.rate_limits_pruned_by_cron(),
  private.rate_limit_hit(text[], text[], int[], int[], int[]),
  private.rate_limit_token(text, text[], int[], int[], int[])
  from public, anon, authenticated;
grant execute on function private.rate_limit_salt(),
  private.rate_limit_hit(text[], text[], int[], int[], int[]),
  private.rate_limit_token(text, text[], int[], int[], int[])
  to reliquary_web, reliquary_mcp;

-- pg_cron, where the platform has it (Supabase does; plain Postgres, as in
-- the tests, doesn't). Without it, hits prune now and then (section 3).
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      perform cron.schedule('reliquary-rate-limits', '*/5 * * * *',
        'select private.prune_rate_limits()');
    exception when others then
      raise notice 'pg_cron is not usable here (%); rate limit windows are pruned at request time', sqlerrm;
    end;
  end if;
end $$;
