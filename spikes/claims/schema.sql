-- Claim/lease spike. Throwaway; models the pattern, not Reliquary's real schema.
-- Conventions borrowed from Reliquary: one SQL function per operation, the
-- database clock decides expiry, every transition appends to an append-only log.

drop table if exists claims, tasks, log cascade;

create table log (
  seq bigint generated always as identity primary key,
  vault_id uuid not null,
  event text not null,
  path text,
  actor uuid,
  detail jsonb,
  at timestamptz not null default clock_timestamp()
);

-- Layer 1: path leases. One row per (vault, path) ever claimed.
create table claims (
  vault_id uuid not null,
  path text not null,
  fence bigint not null default 0,          -- bumped on every grant
  holder_token uuid,                        -- verified connection id
  holder_label text,                        -- self-reported, unverified
  secret_hash bytea,                        -- proof of ownership (bearer)
  lease_expires_at timestamptz,
  primary key (vault_id, path)
);

-- Layer 2: a queue of tasks (path = the task file).
create table tasks (
  id bigint generated always as identity primary key,
  vault_id uuid not null,
  path text not null,
  priority int not null default 0,
  status text not null default 'open' check (status in ('open','claimed','done')),
  fence bigint not null default 0,
  holder_token uuid,
  holder_label text,
  secret_hash bytea,
  lease_expires_at timestamptz,
  done_at timestamptz,
  done_fence bigint
);
create index tasks_pick on tasks (vault_id, priority desc, id) where status <> 'done';

create function h(s text) returns bytea language sql immutable as
  $$ select sha256(convert_to(s, 'utf8')) $$;

-- ---------------------------------------------------------------- claim
-- One statement decides the race: INSERT .. ON CONFLICT DO UPDATE .. WHERE.
-- A concurrent caller blocks on the row, then re-evaluates the WHERE against
-- the committed row, so exactly one caller sees the lease as free.
create function claim(p_vault uuid, p_path text, p_token uuid, p_label text, p_ttl interval)
returns table (o_granted boolean, o_fence bigint, o_secret text, o_holder text, o_expires timestamptz)
language plpgsql volatile as $$
declare
  v_secret text := gen_random_uuid()::text || gen_random_uuid()::text;
  v_fence bigint; v_exp timestamptz; v_holder text; v_hexp timestamptz;
begin
  insert into claims as c (vault_id, path, fence, holder_token, holder_label, secret_hash, lease_expires_at)
  values (p_vault, p_path, 1, p_token, p_label, h(v_secret), clock_timestamp() + p_ttl)
  on conflict (vault_id, path) do update
     set fence = c.fence + 1,
         holder_token = excluded.holder_token,
         holder_label = excluded.holder_label,
         secret_hash = excluded.secret_hash,
         lease_expires_at = excluded.lease_expires_at
   where c.holder_token is null or c.lease_expires_at <= clock_timestamp()
  returning c.fence, c.lease_expires_at into v_fence, v_exp;

  if v_fence is null then
    select c.holder_label, c.lease_expires_at into v_holder, v_hexp
      from claims c where c.vault_id = p_vault and c.path = p_path;
    return query select false, null::bigint, null::text, v_holder, v_hexp;
    return;
  end if;
  insert into log (vault_id, event, path, actor, detail)
  values (p_vault, 'claim.granted', p_path, p_token, jsonb_build_object('fence', v_fence, 'label', p_label));
  return query select true, v_fence, v_secret, p_label, v_exp;
end $$;

create function renew(p_vault uuid, p_path text, p_fence bigint, p_secret text, p_ttl interval)
returns boolean language sql volatile as $$
  with u as (
    update claims set lease_expires_at = clock_timestamp() + p_ttl
     where vault_id = p_vault and path = p_path and fence = p_fence
       and secret_hash = h(p_secret) and lease_expires_at > clock_timestamp()
    returning 1)
  select exists (select 1 from u) $$;

create function release(p_vault uuid, p_path text, p_fence bigint, p_secret text)
returns boolean language sql volatile as $$
  with u as (
    update claims set holder_token = null, secret_hash = null, lease_expires_at = null
     where vault_id = p_vault and path = p_path and fence = p_fence
       and secret_hash = h(p_secret) and lease_expires_at > clock_timestamp()
    returning 1)
  select exists (select 1 from u) $$;

-- ----------------------------------------------------------- claim_next
create function claim_next(p_vault uuid, p_token uuid, p_label text, p_ttl interval)
returns table (o_id bigint, o_path text, o_fence bigint, o_secret text, o_expires timestamptz)
language plpgsql volatile as $$
declare v_secret text := gen_random_uuid()::text || gen_random_uuid()::text;
begin
  return query
  with pick as (
    select t.id from tasks t
     where t.vault_id = p_vault and t.status <> 'done'
       and (t.status = 'open' or t.lease_expires_at <= clock_timestamp())
     order by t.priority desc, t.id
     for update skip locked
     limit 1),
  upd as (
    update tasks t
       set status = 'claimed', fence = t.fence + 1, holder_token = p_token,
           holder_label = p_label, secret_hash = h(v_secret),
           lease_expires_at = clock_timestamp() + p_ttl
      from pick
     where t.id = pick.id
    returning t.id, t.path, t.fence, t.lease_expires_at),
  lg as (
    insert into log (vault_id, event, path, actor, detail)
    select p_vault, 'task.claimed', upd.path, p_token,
           jsonb_build_object('task', upd.id, 'fence', upd.fence)
      from upd)
  select upd.id, upd.path, upd.fence, v_secret, upd.lease_expires_at from upd;
end $$;

create function complete_task(p_id bigint, p_fence bigint, p_secret text)
returns boolean language sql volatile as $$
  with u as (
    update tasks set status = 'done', done_at = clock_timestamp(), done_fence = p_fence
     where id = p_id and status = 'claimed' and fence = p_fence
       and secret_hash = h(p_secret) and lease_expires_at > clock_timestamp()
    returning 1)
  select exists (select 1 from u) $$;

-- ------------------------------------- the naive version, for comparison
-- What an app does with a plain read, a decision in code, then a write. The
-- gap parameter stands in for the network round trip between the two calls.
create function naive_claim(p_vault uuid, p_path text, p_token uuid, p_label text, p_ttl interval, p_gap float default 0)
returns table (o_granted boolean)
language plpgsql volatile as $$
declare cur claims%rowtype;
begin
  select * into cur from claims where vault_id = p_vault and path = p_path;
  if p_gap > 0 then perform pg_sleep(p_gap); end if;
  if cur.path is null or cur.holder_token is null or cur.lease_expires_at <= clock_timestamp() then
    insert into claims as c (vault_id, path, fence, holder_token, holder_label, secret_hash, lease_expires_at)
    values (p_vault, p_path, 1, p_token, p_label, null, clock_timestamp() + p_ttl)
    on conflict (vault_id, path) do update
       set fence = c.fence + 1, holder_token = excluded.holder_token,
           holder_label = excluded.holder_label, lease_expires_at = excluded.lease_expires_at;
    insert into log (vault_id, event, path, actor) values (p_vault, 'claim.granted', p_path, p_token);
    return query select true;
  else
    return query select false;
  end if;
end $$;
