-- Links to upstream MCP servers (milestone 3, schema only). Spec:
-- docs/design.md, "Links" and its "Implementation plan (schema and
-- discovery)". Renamed from "connection" on 2026-09-28, before any of this
-- existed, because "connection" already meant the Connections page's
-- client-reaching-in (docs(design) 35d5078).
--
-- This migration is the core schema and the owner-only management
-- functions (add, edit, delete a link; set a per-role tool grant), matching
-- "Add or edit links: yes/no/no/never" in the access table. It does not
-- build discovery (public.link_tools stays empty; nothing populates it yet)
-- or the MCP proxy (public.link_calls stays empty; nothing writes to it
-- yet) -- both run server-side, in the web app and mcp/ respectively, and
-- design.md leaves open exactly how (synchronous vs background discovery,
-- how much an upstream's own readOnlyHint is trusted, key rotation). Those
-- are deliberately not resolved here.
--
-- Milestone 3 doesn't start until milestone 2's week of real use is done
-- (AGENTS.md, "Build order"); this migration is a deliberate early start,
-- Andrés's call, in place of waiting.
--
-- Enforced here:
-- - Members read a vault's links, their discovered tools and their grants
--   (RLS; nothing else changes what a role may do with them -- that's the
--   proxy, not built).
-- - Adding, editing or deleting a link, and setting a grant: owners, in
--   person (require_human; no agent, no token of any kind -- an MCP token,
--   an OAuth grant or a CLI grant are all refused, same as vault admin).
--   Editors, viewers, outsiders and anonymous are refused too.
-- - The credential lives in private.link_secrets (no grants, RLS with no
--   policies), encrypted by the web app with the same VARIABLES_KEYS as
--   environment variables and passed in already sealed: this migration
--   never sees a plaintext credential, matching set_variable's shape.
-- - public.link_calls is append-only (trigger, matching log and
--   env_access_log); owners and editors read their vault's.

create table public.links (
  id          uuid primary key default gen_random_uuid(),
  vault_id    uuid not null references public.vaults on delete cascade,
  name        text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$'),
  url         text not null check (url ~ '^https://[^/?#]+' and length(url) <= 2048),
  created_by  uuid not null,
  created_at  timestamptz not null default now(),
  unique (vault_id, name)
);
create index on public.links (vault_id);

-- The credential. No grants to anyone; RLS on with no policies. Same shape
-- as private.variable_secrets: a key id, a 12-byte nonce and ciphertext.
create table private.link_secrets (
  link_id     uuid primary key references public.links on delete cascade,
  key_id      text not null check (key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  nonce       bytea not null check (length(nonce) = 12),
  ciphertext  bytea not null check (length(ciphertext) between 16 and 65552)
);

-- Discovered tools. Populated by discovery (web app, server-side, when a
-- link is added), not typed by hand -- nothing here writes a row yet.
create table public.link_tools (
  id          uuid primary key default gen_random_uuid(),
  link_id     uuid not null references public.links on delete cascade,
  vault_id    uuid not null references public.vaults on delete cascade,
  tool_name   text not null,
  is_write    boolean not null default true,
  description text,
  created_at  timestamptz not null default now(),
  unique (link_id, tool_name)
);
create index on public.link_tools (vault_id);

-- Per-role allow list. Read tools default enabled for editor and owner at
-- discovery time (app logic, not built here); write tools default
-- disabled until an owner enables them, per design.md's "Links".
create table public.link_grants (
  id          uuid primary key default gen_random_uuid(),
  link_id     uuid not null references public.links on delete cascade,
  vault_id    uuid not null references public.vaults on delete cascade,
  role        text not null check (role in ('owner', 'editor', 'viewer')),
  tool_name   text not null,
  enabled     boolean not null default false,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  unique (link_id, role, tool_name)
);
create index on public.link_grants (vault_id);

-- Every proxied call. Append-only; never the arguments or the result body,
-- only their hashes. Nothing writes a row yet -- that's the mcp/ proxy.
-- link_id isn't a foreign key: a call's history outlives the link it was
-- about, the same way env_access_log outlives a deleted variable, so
-- deleting a link is never blocked or truncated by its own call log.
create table public.link_calls (
  id          bigint generated always as identity primary key,
  link_id     uuid not null,
  vault_id    uuid not null references public.vaults on delete cascade,
  actor       uuid,
  agent       text,
  tool_name   text not null,
  outcome     text not null check (outcome in ('ok', 'error', 'refused')),
  arg_hash    text,
  result_hash text,
  at          timestamptz not null default now()
);
create index on public.link_calls (link_id);
create index on public.link_calls (vault_id, at);

create trigger link_calls_append_only before update or delete on public.link_calls
  for each row execute function private.forbid_change();
create trigger link_calls_no_truncate before truncate on public.link_calls
  for each statement execute function private.forbid_change();

alter table public.links         enable row level security;
alter table public.link_tools    enable row level security;
alter table public.link_grants   enable row level security;
alter table public.link_calls    enable row level security;
alter table private.link_secrets enable row level security;

-- One membership lookup per query, not one per row (20260925110000_hardening,
-- "RLS: one membership lookup per query"): compare vault_id against
-- readable_vaults() rather than calling is_member(vault_id) per row.
create policy member_read on public.links for select to authenticated
  using (vault_id in (select private.readable_vaults()));
create policy member_read on public.link_tools for select to authenticated
  using (vault_id in (select private.readable_vaults()));
create policy member_read on public.link_grants for select to authenticated
  using (vault_id in (select private.readable_vaults()));
create policy writer_read on public.link_calls for select to authenticated
  using (coalesce(private.role_in(vault_id) in ('owner', 'editor'), false));

revoke all on public.links, public.link_tools, public.link_grants, public.link_calls
  from public, anon, authenticated;
grant select on public.links, public.link_tools, public.link_grants, public.link_calls
  to authenticated;
revoke all on private.link_secrets from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Management: owners, in person. Matches "Add or edit links" in the access
-- table -- an agent, an MCP token, an OAuth grant, a CLI grant, an editor,
-- a viewer, an outsider and anonymous are all refused, whatever surface
-- offers the call.

create function private.log_link(p_vault uuid, p_link uuid, p_event text, p_detail jsonb default '{}')
returns void
language sql volatile security definer set search_path = '' as $$
  select private.log_event(p_vault, p_event, null, null, null,
    p_detail || jsonb_build_object('link', p_link))
$$;

-- Adds a link with its already-sealed credential. p_key_id/p_nonce/
-- p_ciphertext are the web app's output, exactly as set_variable takes
-- them; this function never sees a plaintext credential.
create function public.create_link(p_vault uuid, p_name text, p_url text,
  p_key_id text, p_nonce bytea, p_ciphertext bytea)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_link uuid;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners add links' using errcode = '42501';
  end if;
  if p_name is null or p_name !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' then
    raise exception 'a link name is letters, digits and underscores, not starting with a digit, up to 64 characters'
      using errcode = '22023';
  end if;
  if p_url is null or p_url !~ '^https://[^/?#]+' or length(p_url) > 2048 then
    raise exception 'a link''s url must be https' using errcode = '22023';
  end if;
  if p_key_id is null or p_key_id !~ '^[A-Za-z0-9_-]{1,32}$' or p_nonce is null or length(p_nonce) <> 12
     or p_ciphertext is null or length(p_ciphertext) not between 16 and 65552 then
    raise exception 'that isn''t an encrypted credential (or it is over 64 KiB)' using errcode = '22023';
  end if;

  insert into public.links (vault_id, name, url, created_by)
  values (p_vault, p_name, p_url, private.uid())
  returning id into v_link;
  insert into private.link_secrets (link_id, key_id, nonce, ciphertext)
  values (v_link, p_key_id, p_nonce, p_ciphertext);
  perform private.log_link(p_vault, v_link, 'link.create', jsonb_build_object('name', p_name, 'url', p_url));
  return v_link;
end $$;

-- Renames a link or changes its url. The credential is untouched; rotating
-- it is a later function, once discovery/egress settle how a rotated
-- credential's tools get re-checked.
create function public.update_link(p_link uuid, p_name text, p_url text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
  v_old_name text;
  v_old_url text;
begin
  perform private.require_human();
  select vault_id, name, url into v_vault, v_old_name, v_old_url from public.links where id = p_link;
  if v_vault is null or private.role_in(v_vault) is distinct from 'owner' then
    raise exception 'only owners edit links' using errcode = '42501';
  end if;
  if p_name is null or p_name !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' then
    raise exception 'a link name is letters, digits and underscores, not starting with a digit, up to 64 characters'
      using errcode = '22023';
  end if;
  if p_url is null or p_url !~ '^https://[^/?#]+' or length(p_url) > 2048 then
    raise exception 'a link''s url must be https' using errcode = '22023';
  end if;
  if v_old_name = p_name and v_old_url = p_url then
    return;
  end if;
  update public.links set name = p_name, url = p_url where id = p_link;
  perform private.log_link(v_vault, p_link, 'link.update',
    jsonb_build_object('name', p_name, 'url', p_url, 'previous_name', v_old_name, 'previous_url', v_old_url));
end $$;

create function public.delete_link(p_link uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
  v_name text;
begin
  perform private.require_human();
  select vault_id, name into v_vault, v_name from public.links where id = p_link;
  if v_vault is null or private.role_in(v_vault) is distinct from 'owner' then
    raise exception 'only owners delete links' using errcode = '42501';
  end if;
  delete from public.links where id = p_link;
  perform private.log_link(v_vault, p_link, 'link.delete', jsonb_build_object('name', v_name));
end $$;

-- Sets one (role, tool) grant. Owners only, in person. tool_name isn't
-- checked against link_tools: discovery may not have run yet, and a grant
-- for a tool not yet discovered simply sits inert until it is.
create function public.set_link_grant(p_link uuid, p_role text, p_tool_name text, p_enabled boolean)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
begin
  perform private.require_human();
  select vault_id into v_vault from public.links where id = p_link;
  if v_vault is null or private.role_in(v_vault) is distinct from 'owner' then
    raise exception 'only owners grant a link''s tools' using errcode = '42501';
  end if;
  if p_role not in ('owner', 'editor', 'viewer') then
    raise exception 'a role is owner, editor or viewer' using errcode = '22023';
  end if;
  if p_tool_name is null or length(p_tool_name) = 0 then
    raise exception 'a tool name is required' using errcode = '22023';
  end if;
  insert into public.link_grants (link_id, vault_id, role, tool_name, enabled, updated_by)
  values (p_link, v_vault, p_role, p_tool_name, coalesce(p_enabled, false), private.uid())
  on conflict (link_id, role, tool_name) do update
    set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();
  perform private.log_link(v_vault, p_link, 'link.grant',
    jsonb_build_object('role', p_role, 'tool_name', p_tool_name, 'enabled', coalesce(p_enabled, false)));
end $$;

revoke all on function private.log_link(uuid, uuid, text, jsonb) from public, anon, authenticated;

revoke all on function public.create_link(uuid, text, text, text, bytea, bytea),
  public.update_link(uuid, text, text), public.delete_link(uuid),
  public.set_link_grant(uuid, text, text, boolean)
  from public, anon;
grant execute on function public.create_link(uuid, text, text, text, bytea, bytea),
  public.update_link(uuid, text, text), public.delete_link(uuid),
  public.set_link_grant(uuid, text, text, boolean)
  to authenticated;
