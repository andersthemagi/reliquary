-- Path claims (phase 2 of the claims, waiting and work plans effort,
-- tracking issue #52; design settled in docs/design.md, "Claims and work
-- plans", CL-0.2; the mechanism validated in spikes/claims/, CL-0.4). A
-- claim says who is working a path; it never gates a write on its own
-- (compare-and-swap, phase 1, already does that -- design item 5).
--
-- No claim_rules table yet (CL-2.7): the lease (48 hours) and hold limit
-- (7 days) are the design's Org preset, hard-coded below. CL-2.7 makes
-- them a vault- and path-prefix-settable rule without changing this
-- table's shape or these functions' signatures.
--
-- "list_claims" (design item 1's tool list) is not a SQL function here:
-- member_read below, plus the column grant, already let any member (and
-- their agents) select every claim in a vault they're in, the same way
-- list_vaults and list_files read straight from RLS-protected tables
-- (mcp/src/vaultfiles-tools.ts). CL-2.4 wires the MCP tool to that query.

create table public.path_claims (
  vault_id      uuid not null,
  path          text not null,
  fence         int not null default 0,
  holder        uuid,
  holder_token  uuid references public.access_tokens on delete cascade,
  holder_label  text check (holder_label is null or length(holder_label) <= 200),
  secret_hash   text,
  granted_at    timestamptz,
  renewed_at    timestamptz,
  expires_at    timestamptz not null default '-infinity',
  primary key (vault_id, path),
  foreign key (vault_id, holder) references public.vault_members (vault_id, user_id) on delete cascade
);
create index on public.path_claims (holder_token);
create index on public.path_claims (vault_id, holder);

alter table public.path_claims enable row level security;
create policy member_read on public.path_claims for select to authenticated
  using (vault_id in (select private.readable_vaults()));
revoke all on public.path_claims from public, anon, authenticated;
grant select (vault_id, path, fence, holder, holder_label, granted_at, renewed_at, expires_at)
  on public.path_claims to authenticated;

-- Whoever can write the path may claim it (design item 4); a claim label
-- is self-reported and quoted as data, never trusted for identity (item
-- 2). Exactly one of N concurrent callers is granted: the INSERT .. ON
-- CONFLICT DO UPDATE .. WHERE is one statement, so a concurrent caller
-- blocks on the row and re-evaluates the WHERE against the committed
-- row (spikes/claims/schema.sql, validated: 10,000 contended attempts on
-- 200 paths gave exactly 200 grants).
-- Out parameters are o_-prefixed (matching spikes/claims/schema.sql):
-- without it, a bare "fence" or "expires_at" inside the body would be
-- ambiguous with public.path_claims' own columns of the same name.
create function public.claim_path(p_vault uuid, p_path text, p_label text default null, p_ttl_minutes int default null)
returns table (o_secret text, o_fence int, o_expires timestamptz)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_secret text := encode(extensions.gen_random_bytes(32), 'hex');
  v_label text := nullif(trim(coalesce(p_label, '')), '');
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
  v_ttl := least(coalesce(p_ttl_minutes, 48 * 60), 48 * 60) * interval '1 minute';

  -- Connection and person caps (design items 3 and 12e): one active claim
  -- per connection, five per person across their agents, in this vault.
  if exists (
    select 1 from public.path_claims pc
     where pc.vault_id = p_vault and pc.expires_at > clock_timestamp()
       and pc.holder = private.uid() and pc.holder_token is not distinct from private.token_id()
  ) then
    raise exception 'this connection already holds a claim in this vault; release it first' using errcode = 'RLC03';
  end if;
  if (select count(*) from public.path_claims pc
       where pc.vault_id = p_vault and pc.expires_at > clock_timestamp() and pc.holder = private.uid()) >= 5
  then
    raise exception 'you already hold 5 claims in this vault, across your agents; release one first' using errcode = 'RLC03';
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

-- The check-in that restarts the lease: needs the fence, the secret, and
-- the same connection and person the grant (or last renewal) had (design
-- item 2). No amount of checking in holds a claim past the hold limit,
-- counted from the original grant, not the last renewal (design item 3).
create function public.renew_claim(p_vault uuid, p_path text, p_fence int, p_secret text, p_ttl_minutes int default null)
returns timestamptz
language plpgsql volatile security definer set search_path = '' as $$
declare
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

  v_ttl := least(coalesce(p_ttl_minutes, 48 * 60), 48 * 60) * interval '1 minute';
  v_expires := least(clock_timestamp() + v_ttl, v_row.granted_at + interval '7 days');
  if v_expires <= clock_timestamp() then
    raise exception 'this claim is past its hold limit; release it and claim again' using errcode = 'RLC04';
  end if;

  update public.path_claims set renewed_at = clock_timestamp(), expires_at = v_expires
   where vault_id = p_vault and path = p_path;
  perform private.log_event(p_vault, 'claim.renew', p_path, null, null, jsonb_build_object('fence', p_fence));
  return v_expires;
end $$;

-- Gives up a claim before it expires. Keeps the row (fence stays, never
-- reused for this path) so a stale holder that renews or releases late
-- still fails the identity check above, exactly as if it had expired.
create function public.release_claim(p_vault uuid, p_path text, p_fence int, p_secret text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.path_claims;
begin
  perform private.require_person();
  select * into v_row from public.path_claims where vault_id = p_vault and path = p_path for update;
  if v_row.path is null then
    raise exception 'no such claim' using errcode = 'P0002';
  end if;
  if v_row.fence <> p_fence or v_row.secret_hash is distinct from private.token_hash(p_secret)
     or v_row.holder is distinct from private.uid() or v_row.holder_token is distinct from private.token_id()
  then
    raise exception 'this claim is no longer yours to release (wrong secret or fence, or a different connection)' using errcode = 'RLC02';
  end if;
  update public.path_claims
     set holder = null, holder_token = null, holder_label = null, secret_hash = null, expires_at = clock_timestamp()
   where vault_id = p_vault and path = p_path;
  perform private.log_event(p_vault, 'claim.release', p_path, null, null, jsonb_build_object('fence', p_fence));
end $$;

-- Breaking someone else's claim needs a person present (design item 4):
-- no secret, since the point is you don't have it.
create function public.break_claim(p_vault uuid, p_path text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.path_claims;
begin
  perform private.require_human();
  if not private.can_write_path(p_vault, p_path) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  select * into v_row from public.path_claims where vault_id = p_vault and path = p_path for update;
  if v_row.path is null or v_row.expires_at <= clock_timestamp() then
    raise exception 'no active claim on this path' using errcode = 'P0002';
  end if;
  update public.path_claims
     set holder = null, holder_token = null, holder_label = null, secret_hash = null, expires_at = clock_timestamp()
   where vault_id = p_vault and path = p_path;
  perform private.log_event(p_vault, 'claim.break', p_path, null, null, jsonb_build_object('fence', v_row.fence, 'previous_holder', v_row.holder));
end $$;

-- A claim on a path whose content no longer exists is meaningless
-- (design item 10): erasing a file releases any claim on it, the same
-- way it already blanks the file's versions.
create or replace function public.erase_file(p_vault uuid, p_path text)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners erase' using errcode = '42501';
  end if;
  perform 1 from public.files where vault_id = p_vault and path = p_path for update;
  if not found
     and not exists (select 1 from public.proposals where vault_id = p_vault and path = p_path) then
    raise exception 'no such file' using errcode = 'P0002';
  end if;
  update public.file_versions v set body = null, erased_at = now()
  from public.files f
  where f.id = v.file_id and f.vault_id = p_vault and f.path = p_path and v.erased_at is null;
  get diagnostics n = row_count;
  update public.proposals set body = null
  where vault_id = p_vault and path = p_path;
  update public.proposal_notes set body = null, erased_at = now()
  where erased_at is null and proposal_id in
    (select id from public.proposals where vault_id = p_vault and path = p_path);
  update public.files set deleted_at = coalesce(deleted_at, now())
  where vault_id = p_vault and path = p_path;
  update public.path_claims
     set holder = null, holder_token = null, holder_label = null, secret_hash = null, expires_at = clock_timestamp()
   where vault_id = p_vault and path = p_path and expires_at > clock_timestamp();
  perform private.log_event(p_vault, 'file.erase', p_path, null, null,
    jsonb_build_object('versions', n));
  return n;
end $$;

revoke all on function public.claim_path(uuid, text, text, int), public.renew_claim(uuid, text, int, text, int),
  public.release_claim(uuid, text, int, text), public.break_claim(uuid, text)
  from public, anon;
grant execute on function public.claim_path(uuid, text, text, int), public.renew_claim(uuid, text, int, text, int),
  public.release_claim(uuid, text, int, text), public.break_claim(uuid, text)
  to authenticated;
