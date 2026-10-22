-- One limit per person across all their tokens (issue #487; owner's
-- decision 2026-10-22; docs/public/reference/limits.md, "Rate limits";
-- docs/research/server-load.md, "Waiting in line through the MCP server,
-- simulated").
--
-- The MCP server's limits were per token (grant), so a person with many
-- connections had that many allowances: a crowd of 500 connections asking
-- at once got 30 evaluations each before any was refused, and that start-up
-- herd is what slowed every vault. A person may connect as many agents as
-- they like; their calls now also count together, against the person.
--
-- private.rate_limit_token_and_person(token hash, token buckets..., person
-- buckets...): rate_limit_token's lookup (20260925200000_rate_limits.sql,
-- unchanged), also reading whose grant it is, then one rate_limit_hit over
-- both: the token buckets keyed by the grant, the person buckets by a hash
-- of the person's id. One call, so a refusal still counts nothing in any
-- bucket. o_person says the refusal was the person's (a person bucket has
-- no room for this call), so the MCP server can refuse that person's other
-- tokens from memory, as it does a refused token's calls.
--
-- rate_limit_token stays as it was: the web app calls it, and a server of
-- the previous release keeps calling it until it is replaced.

create function private.rate_limit_token_and_person(p_token_hash text,
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
        on r.bucket = u.b and r.key = v_pkey and r.window_start = to_timestamp(floor(v_now / u.w) * u.w)
     where coalesce(r.hits, 0) + u.c > u.l);
end $$;

revoke all on function private.rate_limit_token_and_person(text, text[], int[], int[], int[], text[], int[], int[], int[])
  from public, anon, authenticated;
grant execute on function private.rate_limit_token_and_person(text, text[], int[], int[], int[], text[], int[], int[], int[])
  to reliquary_mcp;
