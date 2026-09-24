-- Reliquary core: vaults, members, files with canon/open policies, proposals
-- with quorum, and the append-only log. See docs/design.md.
--
-- Identity comes from the Supabase JWT:
--   sub  the person (auth.uid())
--   act  {"sub": "<agent id>", "name": "..."} when an agent acts for them
-- A request with an `act` claim is an agent; one without is the person
-- themself. Human-present actions (approve, set policy, manage members,
-- erase) refuse agent requests.
--
-- All writes go through the security-definer functions below; the API roles
-- have no direct INSERT/UPDATE/DELETE on any table.

create extension if not exists pgcrypto;
create schema if not exists private;
revoke all on schema private from public;

-- ---------------------------------------------------------------------------
-- Identity helpers

create or replace function private.uid() returns uuid
language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;

-- The acting agent's label, or NULL when the person is acting directly.
create or replace function private.agent() returns text
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'act' ->> 'name',
    nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'act' ->> 'sub')
$$;

create or replace function private.require_person() returns void
language plpgsql stable as $$
begin
  if private.uid() is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
end $$;

create or replace function private.require_human() returns void
language plpgsql stable as $$
begin
  perform private.require_person();
  if private.agent() is not null then
    raise exception 'this action needs the person, not their agent'
      using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tables

create table public.vaults (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (length(name) between 1 and 100),
  default_policy text not null default 'open' check (default_policy in ('canon', 'open')),
  created_by     uuid not null,
  created_at     timestamptz not null default now()
);

create table public.vault_members (
  vault_id uuid not null references public.vaults on delete cascade,
  user_id  uuid not null,
  role     text not null check (role in ('owner', 'editor', 'viewer')),
  added_at timestamptz not null default now(),
  primary key (vault_id, user_id)
);
create index on public.vault_members (user_id);

-- A policy on a folder (prefix ending in '/') or a single file (exact path).
create table public.path_policies (
  vault_id uuid not null references public.vaults on delete cascade,
  path     text not null check (path ~ '^[^/].*' and path !~ '//'),
  policy   text not null check (policy in ('canon', 'open')),
  quorum   int  not null default 1 check (quorum between 1 and 20),
  primary key (vault_id, path)
);

create table public.files (
  id                 uuid primary key default gen_random_uuid(),
  vault_id           uuid not null references public.vaults on delete cascade,
  path               text not null check (path ~ '^[^/].*[^/]$' and path !~ '//'),
  current_version_id uuid,
  deleted_at         timestamptz,
  updated_at         timestamptz not null default now(),
  unique (vault_id, path)
);

-- Content lives here, insert-only except for erasure, which blanks body.
create table public.file_versions (
  id         uuid primary key default gen_random_uuid(),
  file_id    uuid not null references public.files on delete cascade,
  vault_id   uuid not null references public.vaults on delete cascade,
  body       text,
  author     uuid not null,
  agent      text,
  created_at timestamptz not null default now(),
  erased_at  timestamptz
);
create index on public.file_versions (file_id, created_at);

create table public.proposals (
  id              uuid primary key default gen_random_uuid(),
  vault_id        uuid not null references public.vaults on delete cascade,
  kind            text not null check (kind in ('write', 'delete')),
  path            text not null,
  body            text,
  reason          text not null default '',
  base_version_id uuid,
  proposed_by     uuid not null,
  agent           text,
  status          text not null default 'open'
                    check (status in ('open', 'applied', 'rejected', 'stale')),
  created_at      timestamptz not null default now(),
  decided_at      timestamptz
);
create index on public.proposals (vault_id, status);

create table public.approvals (
  proposal_id uuid not null references public.proposals on delete cascade,
  user_id     uuid not null,
  decision    text not null check (decision in ('approve', 'reject')),
  at          timestamptz not null default now(),
  primary key (proposal_id, user_id)
);

-- The log and the feed. Append-only: never updated or deleted.
create table public.log (
  seq         bigint generated always as identity primary key,
  vault_id    uuid not null references public.vaults on delete cascade,
  at          timestamptz not null default now(),
  actor       uuid,
  agent       text,
  event       text not null,
  path        text,
  version_id  uuid,
  proposal_id uuid,
  detail      jsonb not null default '{}'
);
create index on public.log (vault_id, seq);

create or replace function private.forbid_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;

create trigger log_append_only before update or delete on public.log
  for each row execute function private.forbid_change();
create trigger log_no_truncate before truncate on public.log
  for each statement execute function private.forbid_change();
create trigger approvals_append_only before update or delete on public.approvals
  for each row execute function private.forbid_change();

-- file_versions: only erasure may change a row, and only by blanking it.
create or replace function private.versions_erase_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'file_versions rows are never deleted' using errcode = '42501';
  end if;
  if new.body is not null or new.erased_at is null
     or new.id <> old.id or new.file_id <> old.file_id or new.author <> old.author
     or new.created_at <> old.created_at then
    raise exception 'file_versions rows can only be erased' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger file_versions_erase_only before update or delete on public.file_versions
  for each row execute function private.versions_erase_only();

-- ---------------------------------------------------------------------------
-- Access helpers (security definer: they read membership without RLS)

create or replace function private.role_in(p_vault uuid) returns text
language sql stable security definer set search_path = '' as $$
  select role from public.vault_members
  where vault_id = p_vault and user_id = private.uid()
$$;

create or replace function private.is_member(p_vault uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.role_in(p_vault) is not null
$$;

-- coalesce: a non-member's role is NULL, and NULL IN (...) is NULL, which an
-- IF NOT would treat as "allowed". Access checks must never return NULL.
create or replace function private.can_write(p_vault uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.role_in(p_vault) in ('owner', 'editor'), false)
$$;

-- Most specific wins: exact file path, then the longest folder prefix, then
-- the vault default (quorum 1).
create or replace function private.policy_for(p_vault uuid, p_path text,
  out policy text, out quorum int)
language sql stable security definer set search_path = '' as $$
  select coalesce(pp.policy, v.default_policy), coalesce(pp.quorum, 1)
  from public.vaults v
  left join lateral (
    select policy, quorum from public.path_policies
    where vault_id = p_vault
      and (path = p_path or (right(path, 1) = '/' and starts_with(p_path, path)))
    order by (path = p_path) desc, length(path) desc
    limit 1
  ) pp on true
  where v.id = p_vault
$$;

create or replace function private.log_event(p_vault uuid, p_event text, p_path text,
  p_version uuid, p_proposal uuid, p_detail jsonb default '{}')
returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.log (vault_id, actor, agent, event, path, version_id, proposal_id, detail)
  values (p_vault, private.uid(), private.agent(), p_event, p_path, p_version, p_proposal, p_detail)
$$;

create or replace function private.valid_path(p_path text) returns text
language plpgsql immutable as $$
begin
  if p_path is null or p_path !~ '^[^/].*[^/]$' or p_path ~ '//' or p_path ~ '(^|/)\.\.?(/|$)' then
    raise exception 'invalid path: %', coalesce(p_path, 'null') using errcode = '22023';
  end if;
  return p_path;
end $$;

-- Writes a new version (or deletion) of a file. Callers have already checked
-- permission and policy.
create or replace function private.apply_write(p_vault uuid, p_path text, p_body text,
  p_author uuid, p_agent text, p_proposal uuid)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_file uuid;
  v_version uuid;
begin
  insert into public.files (vault_id, path) values (p_vault, p_path)
  on conflict (vault_id, path) do update set deleted_at = null, updated_at = now()
  returning id into v_file;
  insert into public.file_versions (file_id, vault_id, body, author, agent)
  values (v_file, p_vault, p_body, p_author, p_agent)
  returning id into v_version;
  update public.files set current_version_id = v_version, updated_at = now()
  where id = v_file;
  insert into public.log (vault_id, actor, agent, event, path, version_id, proposal_id)
  values (p_vault, p_author, p_agent, 'file.write', p_path, v_version, p_proposal);
  return v_version;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: members read their vaults; nobody writes tables directly.

alter table public.vaults        enable row level security;
alter table public.vault_members enable row level security;
alter table public.path_policies enable row level security;
alter table public.files         enable row level security;
alter table public.file_versions enable row level security;
alter table public.proposals     enable row level security;
alter table public.approvals     enable row level security;
alter table public.log           enable row level security;

create policy member_read on public.vaults for select to authenticated
  using (private.is_member(id));
create policy member_read on public.vault_members for select to authenticated
  using (private.is_member(vault_id));
create policy member_read on public.path_policies for select to authenticated
  using (private.is_member(vault_id));
create policy member_read on public.files for select to authenticated
  using (private.is_member(vault_id));
create policy member_read on public.file_versions for select to authenticated
  using (private.is_member(vault_id));
create policy member_read on public.proposals for select to authenticated
  using (private.is_member(vault_id));
create policy member_read on public.approvals for select to authenticated
  using (exists (select 1 from public.proposals p
                 where p.id = proposal_id and private.is_member(p.vault_id)));
create policy member_read on public.log for select to authenticated
  using (private.is_member(vault_id));

revoke all on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;

-- ---------------------------------------------------------------------------
-- API (RPC). Every function checks who is calling, writes the log, and fails
-- closed.

create or replace function public.create_vault(p_name text, p_default_policy text default 'open')
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare v uuid;
begin
  perform private.require_human();
  insert into public.vaults (name, default_policy, created_by)
  values (p_name, p_default_policy, private.uid()) returning id into v;
  insert into public.vault_members (vault_id, user_id, role) values (v, private.uid(), 'owner');
  perform private.log_event(v, 'vault.create', null, null, null,
    jsonb_build_object('name', p_name, 'default_policy', p_default_policy));
  return v;
end $$;

create or replace function public.set_member(p_vault uuid, p_user uuid, p_role text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners manage members' using errcode = '42501';
  end if;
  if p_role is null then
    if p_user = private.uid() then
      raise exception 'owners cannot remove themselves' using errcode = '42501';
    end if;
    delete from public.vault_members where vault_id = p_vault and user_id = p_user;
  else
    insert into public.vault_members (vault_id, user_id, role) values (p_vault, p_user, p_role)
    on conflict (vault_id, user_id) do update set role = excluded.role;
  end if;
  perform private.log_event(p_vault, 'member.set', null, null, null,
    jsonb_build_object('user', p_user, 'role', p_role));
end $$;

create or replace function public.set_policy(p_vault uuid, p_path text, p_policy text, p_quorum int default 1)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners set policies' using errcode = '42501';
  end if;
  if p_policy is null then
    delete from public.path_policies where vault_id = p_vault and path = p_path;
  else
    insert into public.path_policies (vault_id, path, policy, quorum)
    values (p_vault, p_path, p_policy, p_quorum)
    on conflict (vault_id, path) do update set policy = excluded.policy, quorum = excluded.quorum;
  end if;
  perform private.log_event(p_vault, 'policy.set', p_path, null, null,
    jsonb_build_object('policy', p_policy, 'quorum', p_quorum));
end $$;

-- Direct write: open files only.
create or replace function public.write_file(p_vault uuid, p_path text, p_body text)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_person();
  perform private.valid_path(p_path);
  if not private.can_write(p_vault) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if (private.policy_for(p_vault, p_path)).policy <> 'open' then
    raise exception '% is canon: use propose()', p_path using errcode = '42501';
  end if;
  return private.apply_write(p_vault, p_path, p_body, private.uid(), private.agent(), null);
end $$;

create or replace function public.delete_file(p_vault uuid, p_path text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_person();
  if not private.can_write(p_vault) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  if (private.policy_for(p_vault, p_path)).policy <> 'open' then
    raise exception '% is canon: use propose()', p_path using errcode = '42501';
  end if;
  update public.files set deleted_at = now(), updated_at = now()
  where vault_id = p_vault and path = p_path and deleted_at is null;
  if not found then
    raise exception 'no such file' using errcode = 'P0002';
  end if;
  perform private.log_event(p_vault, 'file.delete', p_path, null, null);
end $$;

create or replace function public.propose(p_vault uuid, p_path text, p_body text,
  p_reason text default '', p_delete boolean default false)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
  v_base uuid;
begin
  perform private.require_person();
  perform private.valid_path(p_path);
  if not private.can_write(p_vault) then
    raise exception 'no write access to this vault' using errcode = '42501';
  end if;
  select current_version_id into v_base from public.files
  where vault_id = p_vault and path = p_path and deleted_at is null;
  insert into public.proposals (vault_id, kind, path, body, reason, base_version_id,
                                proposed_by, agent)
  values (p_vault, case when p_delete then 'delete' else 'write' end, p_path,
          case when p_delete then null else p_body end, coalesce(p_reason, ''), v_base,
          private.uid(), private.agent())
  returning id into v_id;
  perform private.log_event(p_vault, 'proposal.open', p_path, null, v_id,
    jsonb_build_object('kind', case when p_delete then 'delete' else 'write' end));
  return v_id;
end $$;

-- Approve or reject. People only. One reject closes the proposal; it applies
-- once distinct approvals reach the path's quorum at decision time. If the
-- file changed since the proposal was made, it goes stale instead.
create or replace function public.decide(p_proposal uuid, p_decision text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  p public.proposals;
  v_quorum int;
  v_approvals int;
  v_current uuid;
begin
  perform private.require_human();
  select * into p from public.proposals where id = p_proposal for update;
  if p.id is null or not private.can_write(p.vault_id) then
    raise exception 'no such proposal' using errcode = 'P0002';
  end if;
  if p.status <> 'open' then
    raise exception 'proposal is %', p.status using errcode = '55000';
  end if;
  if p_decision not in ('approve', 'reject') then
    raise exception 'decision must be approve or reject' using errcode = '22023';
  end if;

  insert into public.approvals (proposal_id, user_id, decision)
  values (p.id, private.uid(), p_decision)
  on conflict do nothing;
  if not found then
    raise exception 'you already decided on this proposal' using errcode = '23505';
  end if;
  perform private.log_event(p.vault_id, 'proposal.' || p_decision, p.path, null, p.id);

  if p_decision = 'reject' then
    update public.proposals set status = 'rejected', decided_at = now() where id = p.id;
    return 'rejected';
  end if;

  v_quorum := (private.policy_for(p.vault_id, p.path)).quorum;
  select count(*) into v_approvals from public.approvals a
  join public.vault_members m on m.vault_id = p.vault_id and m.user_id = a.user_id
  where a.proposal_id = p.id and a.decision = 'approve' and m.role in ('owner', 'editor');
  if v_approvals < v_quorum then
    return 'open';
  end if;

  select current_version_id into v_current from public.files
  where vault_id = p.vault_id and path = p.path and deleted_at is null;
  if v_current is distinct from p.base_version_id then
    update public.proposals set status = 'stale', decided_at = now() where id = p.id;
    perform private.log_event(p.vault_id, 'proposal.stale', p.path, null, p.id);
    return 'stale';
  end if;

  if p.kind = 'delete' then
    update public.files set deleted_at = now(), updated_at = now()
    where vault_id = p.vault_id and path = p.path;
    insert into public.log (vault_id, actor, agent, event, path, proposal_id)
    values (p.vault_id, p.proposed_by, p.agent, 'file.delete', p.path, p.id);
  else
    perform private.apply_write(p.vault_id, p.path, p.body, p.proposed_by, p.agent, p.id);
  end if;
  update public.proposals set status = 'applied', decided_at = now() where id = p.id;
  return 'applied';
end $$;

-- Right to be forgotten: blank every version of a file. The log keeps its
-- sequence; the content is gone. Owners only, in person.
create or replace function public.erase_file(p_vault uuid, p_path text)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners erase' using errcode = '42501';
  end if;
  update public.file_versions v set body = null, erased_at = now()
  from public.files f
  where f.id = v.file_id and f.vault_id = p_vault and f.path = p_path and v.erased_at is null;
  get diagnostics n = row_count;
  update public.proposals set body = null
  where vault_id = p_vault and path = p_path;
  update public.files set deleted_at = coalesce(deleted_at, now())
  where vault_id = p_vault and path = p_path;
  perform private.log_event(p_vault, 'file.erase', p_path, null, null,
    jsonb_build_object('versions', n));
  return n;
end $$;

-- The feed: events after a cursor, oldest first, capped.
create or replace function public.changes_since(p_vault uuid, p_cursor bigint default 0,
  p_limit int default 500)
returns setof public.log
language sql stable security invoker set search_path = '' as $$
  select * from public.log
  where vault_id = p_vault and seq > coalesce(p_cursor, 0)
  order by seq
  limit least(greatest(coalesce(p_limit, 500), 1), 500)
$$;

revoke all on all functions in schema public from public, anon;
revoke all on all functions in schema private from public, anon;
-- RLS policies call these as the requesting user, so they need EXECUTE. The
-- writing helpers (apply_write, log_event) stay callable only from the
-- security-definer API above.
grant usage on schema private to authenticated;
grant execute on function private.uid(), private.agent(), private.role_in(uuid),
  private.is_member(uuid), private.can_write(uuid), private.policy_for(uuid, text)
  to authenticated;
grant execute on function public.create_vault(text, text), public.set_member(uuid, uuid, text),
  public.set_policy(uuid, text, text, int), public.write_file(uuid, text, text),
  public.delete_file(uuid, text), public.propose(uuid, text, text, text, boolean),
  public.decide(uuid, text), public.erase_file(uuid, text),
  public.changes_since(uuid, bigint, int) to authenticated;
