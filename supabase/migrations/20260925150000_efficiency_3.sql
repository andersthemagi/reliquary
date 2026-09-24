-- Server load, third pass (docs/research/server-load.md, "Third pass").
--
-- 1. private.vault_ref(): an MCP tool names a vault by id or by name; the
--    lookup now runs inside the tool's own query instead of a round trip
--    before it. Same answers as the lookup it replaces.
-- 2. private.env_begin(): the env API resolves a CLI token and becomes its
--    person at the start of the request's transaction, as private.mcp_begin
--    does for the MCP server, so `reliquary run` checks out one pooled
--    connection instead of two.
-- 3. private.rules_for_pairs(): the rule for many (vault, path) pairs at
--    once, with one set-based membership check, for lists that span vaults
--    (Review, Home), which called rule_for() once per waiting proposal.
-- 4. Search words for current versions only. Each version stored its words
--    (20260925130000_efficiency_2.sql, section 3); only a file's current
--    version is ever searched, so a superseded version's words are cleared
--    when a newer version replaces it, and existing history is cleared here.

-- ---------------------------------------------------------------------------
-- 1. The vault an MCP tool names

-- The vault p_ref names for the caller, as the MCP server's lookup did: by
-- id when it is shaped like one (a primary-key lookup), else by name among
-- the caller's own memberships, and only when exactly one matches. Security
-- invoker, so RLS and the token's scope decide, as before. Raises RLV01
-- ("no vault"), which the MCP server answers with its "No vault with that
-- name or id" message, so a tool's query can name the vault inline and
-- still tell "no such vault" from "nothing in it".
create function private.vault_ref(p_ref text) returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v uuid;
  n int;
begin
  if p_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select x.id into v from public.vaults x where x.id = p_ref::uuid;
  else
    select (array_agg(x.id))[1], count(*) into v, n
      from public.vault_members m join public.vaults x on x.id = m.vault_id
     where m.user_id = private.uid() and x.name = p_ref;
    if n <> 1 then
      v := null;
    end if;
  end if;
  if v is null then
    raise exception 'no vault with that name or id' using errcode = 'RLV01';
  end if;
  return v;
end $$;
revoke all on function private.vault_ref(text) from public, anon;
grant execute on function private.vault_ref(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. The env API's token, resolved inside its transaction

-- As private.mcp_begin (20260925130000_efficiency_2.sql, section 1), for a
-- CLI grant's access token and the env API's resource: resolves it
-- (private.resolve_cli_token, last_used_at at most once a minute) and makes
-- the rest of the transaction run as its person through the grant (role
-- authenticated; claims sub, role, act {sub, name, tok}). No row, and
-- nothing set, when the token doesn't resolve. Only the web app's role
-- calls it, as it already calls resolve_cli_token and sets claims.
create function private.env_begin(p_token_hash text, p_resource text)
returns table (token_id uuid, user_id uuid, name text)
language plpgsql volatile set search_path = '' as $$
declare
  r record;
begin
  select x.token_id, x.user_id, x.name into r from private.resolve_cli_token(p_token_hash, p_resource) x;
  if r.token_id is null then
    return;
  end if;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', r.user_id, 'role', 'authenticated',
    'act', jsonb_build_object('sub', r.token_id, 'name', r.name, 'tok', r.token_id))::text, true);
  perform set_config('role', 'authenticated', true);
  token_id := r.token_id;
  user_id := r.user_id;
  name := r.name;
  return next;
end $$;
revoke all on function private.env_begin(text, text) from public, anon, authenticated;
grant execute on function private.env_begin(text, text) to reliquary_web;

-- ---------------------------------------------------------------------------
-- 3. Rules for (vault, path) pairs

-- The rule for each pair, matched as private.rules_for() matches (the exact
-- path, then the longest folder prefix, then the vault's default, quorum
-- 1), answered only for vaults the caller can read: one set-based check
-- (private.readable_vaults(), token scope included) for the whole list,
-- where rule_for() per row checked membership once per row. Pairs are
-- taken as given: pass each pair once.
create function private.rules_for_pairs(p_vaults uuid[], p_paths text[])
returns table (vault_id uuid, path text, policy text, quorum int)
language sql stable security definer set search_path = '' as $$
  select p.vault_id, p.path, coalesce(pp.policy, v.default_policy), coalesce(pp.quorum, 1)
    from unnest(p_vaults, p_paths) as p(vault_id, path)
    join public.vaults v on v.id = p.vault_id
    left join lateral (
      select r.policy, r.quorum from public.path_policies r
       where r.vault_id = p.vault_id
         and (r.path = p.path or (right(r.path, 1) = '/' and starts_with(p.path, r.path)))
       order by (r.path = p.path) desc, length(r.path) desc
       limit 1) pp on true
   where p.vault_id in (select private.readable_vaults())
$$;
revoke all on function private.rules_for_pairs(uuid[], text[]) from public, anon;
grant execute on function private.rules_for_pairs(uuid[], text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Search words for current versions only

-- body_tsv stops being generated (its values stay) and is kept by triggers:
-- a new version gets its words when it is written (every new version
-- becomes its file's current one, private.apply_write); the version it
-- replaces loses them; erasing a version erases them.
alter table public.file_versions alter column body_tsv drop expression;

create function private.version_words() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.body_tsv := case when new.body is null then null else to_tsvector('simple', new.body) end;
  elsif new.body is null then
    new.body_tsv := null;
  end if;
  return new;
end $$;
revoke all on function private.version_words() from public, anon, authenticated;
create trigger file_versions_words before insert or update of body on public.file_versions
  for each row execute function private.version_words();

-- When a file's current version changes, the one it replaces is history:
-- search never reads it, so its words go.
create function private.clear_superseded_words() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.file_versions set body_tsv = null
   where id = old.current_version_id and body_tsv is not null;
  return null;
end $$;
revoke all on function private.clear_superseded_words() from public, anon, authenticated;
create trigger files_clear_superseded_words after update of current_version_id on public.files
  for each row when (old.current_version_id is not null
                     and old.current_version_id is distinct from new.current_version_id)
  execute function private.clear_superseded_words();

-- file_versions stays insert-only except for erasure (20260925120000_vault_admin.sql),
-- plus one derived change: clearing a version's search words, with every
-- other column as it was.
create or replace function private.versions_erase_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if private.purging(old.vault_id) then
      return old;
    end if;
    raise exception 'file_versions rows are never deleted' using errcode = '42501';
  end if;
  if new.body_tsv is null
     and (new.id, new.file_id, new.vault_id, new.author, new.created_at) = (old.id, old.file_id, old.vault_id, old.author, old.created_at)
     and new.body is not distinct from old.body and new.agent is not distinct from old.agent
     and new.erased_at is not distinct from old.erased_at then
    return new;
  end if;
  if new.body is not null or new.erased_at is null
     or new.id <> old.id or new.file_id <> old.file_id or new.author <> old.author
     or new.created_at <> old.created_at then
    raise exception 'file_versions rows can only be erased' using errcode = '42501';
  end if;
  return new;
end $$;

-- Clears the words of every version that isn't its file's current one, and
-- of erased versions (the generated column gave them an empty set). Returns
-- how many it cleared. Run once below, as the backfill; no app role calls it.
create function private.clear_history_words() returns int
language plpgsql volatile security definer set search_path = '' as $$
declare n int;
begin
  update public.file_versions v set body_tsv = null
   where v.body_tsv is not null
     and (v.body is null
          or not exists (select 1 from public.files f where f.current_version_id = v.id));
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function private.clear_history_words() from public, anon, authenticated;

do $$ begin perform private.clear_history_words(); end $$;
