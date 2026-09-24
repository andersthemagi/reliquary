-- Hardening and server load (docs/research/server-load.md, docs/parity.md).
--
-- 1. Revoking a token is a person's act. It was require_person, so any agent
--    (an MCP token, an OAuth client, the CLI) could revoke every other token
--    of its person: grant management, which the ceiling keeps with people.
--    An OAuth client can still end its own grant through the token endpoint
--    (RFC 7009, private.oauth_revoke), which only the web app's role calls.
-- 2. Paths and vault names carry no control characters and paths are at most
--    1024 characters, and the path error no longer echoes the path. A path
--    with a newline in it could forge lines in an agent's file list or feed.
-- 3. Size ceilings on stored text, so no surface can store more than the
--    apps accept: file and proposal text 1 MiB, reasons and notes 4000
--    characters. NOT VALID: existing rows are not rechecked, new ones are.
-- 4. Resolving a token writes last_used_at at most once a minute, not on
--    every request: fewer row locks and WAL on the hottest path.
-- 5. Indexes: the foreign keys the Supabase advisor flagged as unindexed,
--    and the log by path, which a file's history and a rule's "set by" read.
-- 6. A connection left idle inside a transaction is closed after 15 s, so a
--    stuck request can't hold one of the pooler's few connections.

-- ---------------------------------------------------------------------------
-- 1. Revoking tokens: people only

create or replace function public.revoke_access_token(p_id uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  update public.access_tokens set revoked_at = coalesce(revoked_at, now())
  where id = p_id and user_id = private.uid();
  if not found then
    raise exception 'no such token' using errcode = 'P0002';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Paths and names

create or replace function private.valid_path(p_path text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_path is null or p_path !~ '^[^/].*[^/]$' or p_path ~ '//' or p_path ~ '(^|/)\.\.?(/|$)'
     or p_path ~ '[[:cntrl:]]' or length(p_path) > 1024 then
    raise exception 'invalid path: use folder/name.md, at most 1024 characters, no control characters, no . or .. segments'
      using errcode = '22023';
  end if;
  return p_path;
end $$;

alter table public.files add constraint files_path_clean
  check (path !~ '[[:cntrl:]]' and length(path) <= 1024) not valid;
alter table public.proposals add constraint proposals_path_clean
  check (path !~ '[[:cntrl:]]' and length(path) <= 1024) not valid;
alter table public.path_policies add constraint path_policies_path_clean
  check (path !~ '[[:cntrl:]]' and length(path) <= 1024) not valid;
alter table public.vaults add constraint vaults_name_clean
  check (name !~ '[[:cntrl:]]') not valid;

-- ---------------------------------------------------------------------------
-- 3. Size ceilings

alter table public.file_versions add constraint file_versions_body_size
  check (octet_length(body) <= 1048576) not valid;
alter table public.proposals add constraint proposals_body_size
  check (octet_length(body) <= 1048576) not valid;
alter table public.proposals add constraint proposals_reason_size
  check (length(reason) <= 4000) not valid;
alter table public.proposal_notes add constraint proposal_notes_body_size
  check (length(body) <= 4000) not valid;

-- ---------------------------------------------------------------------------
-- 4. Token resolution: read, then touch last_used_at only when stale

create or replace function private.resolve_access_token(p_token_hash text)
returns table (token_id uuid, user_id uuid, name text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  t public.access_tokens;
begin
  select * into t from public.access_tokens a
   where a.token_hash = p_token_hash
     and a.kind = 'pat'
     and a.revoked_at is null
     and (a.expires_at is null or a.expires_at > now());
  if not found then
    return;
  end if;
  if t.last_used_at is null or t.last_used_at < now() - interval '1 minute' then
    update public.access_tokens a set last_used_at = now() where a.id = t.id;
  end if;
  token_id := t.id;
  user_id := t.user_id;
  name := t.name;
  return next;
end $$;

create or replace function private.resolve_oauth_token(p_token_hash text, p_resource text)
returns table (token_id uuid, user_id uuid, name text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  g public.access_tokens;
begin
  select a.* into g
    from private.oauth_tokens k
    join public.access_tokens a on a.id = k.grant_id
   where k.token_hash = p_token_hash
     and k.kind = 'access'
     and k.expires_at > now()
     and a.kind = 'oauth'
     and a.revoked_at is null
     and a.expires_at > now()
     and a.resource = p_resource;
  if not found then
    return;
  end if;
  if g.last_used_at is null or g.last_used_at < now() - interval '1 minute' then
    update public.access_tokens a set last_used_at = now() where a.id = g.id;
  end if;
  token_id := g.id;
  user_id := g.user_id;
  name := g.name;
  return next;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Indexes

create index if not exists file_versions_vault_id_idx on public.file_versions (vault_id);
create index if not exists proposal_notes_vault_id_idx on public.proposal_notes (vault_id);
create index if not exists review_snoozes_proposal_id_idx on public.review_snoozes (proposal_id);
create index if not exists review_snoozes_vault_id_idx on public.review_snoozes (vault_id);
create index if not exists log_vault_path_seq_idx on public.log (vault_id, path, seq) where path is not null;

-- ---------------------------------------------------------------------------
-- 6. Idle transactions

alter role reliquary_web set idle_in_transaction_session_timeout = '15s';
alter role reliquary_mcp set idle_in_transaction_session_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 7. RLS: one membership lookup per query, not one per row
--
-- Every read policy called private.is_member(vault_id) for each row it
-- looked at: two security-definer calls, a claims parse and a token join per
-- row, about 0.1 ms each. A 2000-file vault took 185 ms to list before any
-- work was done (docs/research/server-load.md). The policies now compare
-- vault_id with the set of vaults the caller can read, which Postgres
-- computes once per statement (a hashed subplan).
--
-- Same rule as before: readable_vaults() is exactly the vaults where
-- role_in() is not null, and role_in() still applies token scope, read-only
-- tokens and CLI grants. The hostile tests in supabase/tests run unchanged
-- against these policies. Tables added by later migrations (variables) keep
-- is_member() until they move too.

create function private.readable_vaults() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.vault_id from public.vault_members m
   where m.user_id = private.uid() and private.role_in(m.vault_id) is not null
$$;
revoke all on function private.readable_vaults() from public, anon;
grant execute on function private.readable_vaults() to authenticated;

alter policy member_read on public.vaults using (id in (select private.readable_vaults()));
alter policy member_read on public.vault_members using (vault_id in (select private.readable_vaults()));
alter policy member_read on public.path_policies using (vault_id in (select private.readable_vaults()));
alter policy member_read on public.files using (vault_id in (select private.readable_vaults()));
alter policy member_read on public.file_versions using (vault_id in (select private.readable_vaults()));
alter policy member_read on public.proposals using (vault_id in (select private.readable_vaults()));
alter policy member_read on public.log using (vault_id in (select private.readable_vaults()));
alter policy member_read on public.proposal_notes using (vault_id in (select private.readable_vaults()));
alter policy member_read on public.approvals using (exists (
  select 1 from public.proposals p where p.id = proposal_id and p.vault_id in (select private.readable_vaults())));
alter policy own_snoozes on public.review_snoozes
  using (user_id = private.uid() and vault_id in (select private.readable_vaults()));

-- ---------------------------------------------------------------------------
-- 8. Rules for many paths at once
--
-- Listing a vault asked rule_for() once per file (a membership check and a
-- rule lookup each). rules_for() checks membership once and answers for a
-- whole list of paths. The matching is policy_for()'s: the exact path, then
-- the longest folder prefix, then the vault's default (quorum 1);
-- supabase/tests/hardening_test.sql checks the two agree.

create function private.rules_for(p_vault uuid, p_paths text[])
returns table (path text, policy text, quorum int)
language sql stable security definer set search_path = '' as $$
  select p.path, coalesce(pp.policy, v.default_policy), coalesce(pp.quorum, 1)
    from public.vaults v
    cross join unnest(p_paths) as p(path)
    left join lateral (
      select r.policy, r.quorum from public.path_policies r
       where r.vault_id = p_vault
         and (r.path = p.path or (right(r.path, 1) = '/' and starts_with(p.path, r.path)))
       order by (r.path = p.path) desc, length(r.path) desc
       limit 1) pp on true
   where v.id = p_vault and coalesce(private.is_member(p_vault), false)
$$;
revoke all on function private.rules_for(uuid, text[]) from public, anon;
grant execute on function private.rules_for(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. Erasing nothing is an error
--
-- erase_file logged a file.erase for any path, even one with nothing at it,
-- which put a false entry in the vault's log. It now refuses (P0002) a path
-- with no file (live or deleted) and no proposal. A path with only
-- proposals still erases their text and discussion. Otherwise as in
-- 20260924150000_review.sql.

create or replace function public.erase_file(p_vault uuid, p_path text)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners erase' using errcode = '42501';
  end if;
  if not exists (select 1 from public.files where vault_id = p_vault and path = p_path)
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
  perform private.log_event(p_vault, 'file.erase', p_path, null, null,
    jsonb_build_object('versions', n));
  return n;
end $$;
