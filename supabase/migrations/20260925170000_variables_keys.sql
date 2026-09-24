-- Variables, hardened (docs/variables.md): rotating VARIABLES_KEY without
-- downtime, custom environments, and limits.
--
-- 1. Key rotation. The web app holds several keys by id (VARIABLES_KEYS) and
--    seals with the first. Moving every stored ciphertext to it is an
--    operator's job (scripts/rotate-variables-key.sh runs the web app's
--    re-encryption against the database as reliquary_web), through three
--    functions only that role may call:
--      private.variable_key_ids()   which key ids stored values use (the web
--                                   app refuses to start without one of them)
--      private.rekey_vaults(key)    vaults with a value on another key
--      private.sealed_rows(...)     a vault's sealed values and pending
--                                   imports' values, to open and seal again
--      private.reseal(...)          swaps ciphertext and key id in place
--    A reseal changes no version, updated_by or updated_at, writes no feed
--    event and no `set`: it logs one `rotate_key` row per vault in
--    env_access_log (who: the operator; what: names and counts, never a
--    value). It only replaces the ciphertext it was given the nonce of, so a
--    value a person set meanwhile is left alone.
-- 2. Custom environments. Owners, in person, create, rename and delete a
--    vault's environments (public.create_environment, rename_environment,
--    delete_environment). The additional data a value is sealed with names
--    its environment, so a rename seals the moved values again for the new
--    name, in the same transaction (the web app does it through
--    private.reseal, allowed for exactly that vault and environment only
--    after rename_environment ran in the transaction). A default
--    environment (development, preview, production) keeps its name and is
--    deleted only when empty; deleting another destroys its values, and
--    only with its name typed. Pending imports for an environment that is
--    renamed or deleted are rejected (their values were sealed for it).
-- 3. Limits: 20 environments and 1000 variables a vault.

-- ---------------------------------------------------------------------------
-- The access log's new actions

alter table public.env_access_log drop constraint env_access_log_action_check;
alter table public.env_access_log add constraint env_access_log_action_check
  check (action in ('set', 'rotate', 'delete', 'read', 'reveal', 'refused', 'push', 'reject',
                    'rotate_key', 'create_environment', 'rename_environment', 'delete_environment'));

-- ---------------------------------------------------------------------------
-- A renamed environment carries its values: the foreign keys cascade updates.

do $$
declare
  c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.variable_values'::regclass and contype = 'f'
     and confrelid = 'public.environments'::regclass;
  execute format('alter table public.variable_values drop constraint %I', c);
  select conname into c from pg_constraint
   where conrelid = 'private.variable_secrets'::regclass and contype = 'f'
     and confrelid = 'public.variable_values'::regclass;
  execute format('alter table private.variable_secrets drop constraint %I', c);
end $$;
alter table public.variable_values add constraint variable_values_environment_fkey
  foreign key (vault_id, environment) references public.environments (vault_id, name)
  on update cascade on delete cascade;
alter table private.variable_secrets add constraint variable_secrets_value_fkey
  foreign key (variable_id, environment) references public.variable_values (variable_id, environment)
  on update cascade on delete cascade;

-- ---------------------------------------------------------------------------
-- 1. Key rotation (reliquary_web only)

-- The key ids that sealed what is stored: every value, and every pending
-- import's values that can still be applied. Ids only.
create function private.variable_key_ids()
returns table (key_id text, "values" bigint, imports bigint)
language sql stable security definer set search_path = '' as $$
  select x.key_id, count(*) filter (where x.kind = 'value'), count(*) filter (where x.kind = 'import')
    from (select s.key_id, 'value' as kind from private.variable_secrets s
          union all
          select s.key_id, 'import' from private.env_import_secrets s
            join public.env_imports i on i.id = s.import_id
           where i.status = 'pending' and i.expires_at > now()) x
   group by x.key_id
   order by x.key_id
$$;

-- The vaults with anything sealed under a key other than p_key_id.
create function private.rekey_vaults(p_key_id text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select vv.vault_id from private.variable_secrets s
    join public.variable_values vv on vv.variable_id = s.variable_id and vv.environment = s.environment
   where s.key_id is distinct from p_key_id
  union
  select i.vault_id from private.env_import_secrets s
    join public.env_imports i on i.id = s.import_id
   where i.status = 'pending' and i.expires_at > now() and s.key_id is distinct from p_key_id
$$;

-- One vault's sealed values ('value', the variable id) and pending imports'
-- values ('import', the import id), optionally one environment's, optionally
-- only those not under p_not_key.
create function private.sealed_rows(p_vault uuid, p_environment text default null, p_not_key text default null)
returns table (kind text, ref uuid, name text, environment text, key_id text, nonce bytea, ciphertext bytea)
language sql stable security definer set search_path = '' as $$
  select 'value', s.variable_id, v.name, s.environment, s.key_id, s.nonce, s.ciphertext
    from private.variable_secrets s
    join public.variables v on v.id = s.variable_id
   where v.vault_id = p_vault
     and (p_environment is null or s.environment = p_environment)
     and (p_not_key is null or s.key_id <> p_not_key)
  union all
  select 'import', s.import_id, s.name, s.environment, s.key_id, s.nonce, s.ciphertext
    from private.env_import_secrets s
    join public.env_imports i on i.id = s.import_id
   where i.vault_id = p_vault and i.status = 'pending' and i.expires_at > now()
     and (p_environment is null or s.environment = p_environment)
     and (p_not_key is null or s.key_id <> p_not_key)
   order by 1, 3, 4
$$;

-- Replaces sealed values in place. p_items: [{"kind": "value" | "import",
-- "ref", "name", "environment", "old_nonce", "key_id", "nonce",
-- "ciphertext"}] (bytes in base64). Each replaces only the row of this vault
-- that still has old_nonce, so a value set meanwhile stays as it is.
-- p_reason: 'rotate_key' (the operator's re-encryption: logged, one row per
-- vault) or 'rename_environment' (only in the transaction of a rename, for
-- that vault and new name; the rename logged itself). Returns how many rows
-- it replaced. Never touches version, updated_by, updated_at or the feed.
create function private.reseal(p_vault uuid, p_reason text, p_items jsonb)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  x record;
  n int := 0;
  v_rows int;
  n_values int := 0;
  n_imports int := 0;
  v_names text[] := '{}';
  v_keys text[] := '{}';
  v_nonce bytea;
  v_old bytea;
  v_ct bytea;
begin
  if p_reason is null or p_reason not in ('rotate_key', 'rename_environment') then
    raise exception 'a reseal is for rotate_key or rename_environment' using errcode = '22023';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or exists (select 1 from jsonb_array_elements(p_items) e where jsonb_typeof(e) <> 'object') then
    raise exception 'items are a list of objects' using errcode = '22023';
  end if;
  for x in select * from jsonb_to_recordset(p_items) as r(kind text, ref uuid, name text, environment text,
                                                          old_nonce text, key_id text, nonce text, ciphertext text) loop
    if p_reason = 'rename_environment'
       and current_setting('reliquary.resealing', true) is distinct from p_vault::text || '/' || coalesce(x.environment, '') then
      raise exception 'values are sealed again for a new name only in that rename''s transaction' using errcode = '42501';
    end if;
    begin
      v_old := decode(x.old_nonce, 'base64');
      v_nonce := decode(x.nonce, 'base64');
      v_ct := decode(x.ciphertext, 'base64');
    exception when others then
      raise exception 'nonces and ciphertexts are base64' using errcode = '22023';
    end;
    if x.kind is null or x.kind not in ('value', 'import') or x.ref is null or x.name is null or x.environment is null
       or x.key_id is null or x.key_id !~ '^[A-Za-z0-9_-]{1,32}$' or v_old is null or v_nonce is null
       or length(v_nonce) <> 12 or v_ct is null or length(v_ct) not between 16 and 65552 then
      raise exception 'that isn''t a sealed value' using errcode = '22023';
    end if;
    if x.kind = 'value' then
      update private.variable_secrets s set key_id = x.key_id, nonce = v_nonce, ciphertext = v_ct
        from public.variables v
       where s.variable_id = x.ref and s.environment = x.environment and s.nonce = v_old
         and v.id = s.variable_id and v.vault_id = p_vault and v.name = x.name;
      get diagnostics v_rows = row_count;
      n_values := n_values + v_rows;
    else
      update private.env_import_secrets s set key_id = x.key_id, nonce = v_nonce, ciphertext = v_ct
        from public.env_imports i
       where s.import_id = x.ref and s.name = x.name and s.environment = x.environment and s.nonce = v_old
         and i.id = s.import_id and i.vault_id = p_vault and i.status = 'pending';
      get diagnostics v_rows = row_count;
      n_imports := n_imports + v_rows;
    end if;
    if v_rows > 0 then
      v_names := array_append(v_names, x.name);
      v_keys := array_append(v_keys, x.key_id);
    end if;
  end loop;
  n := n_values + n_imports;
  if p_reason = 'rotate_key' and n > 0 then
    insert into public.env_access_log (vault_id, actor, agent, action, environment, names, detail)
    values (p_vault, null, 'Reliquary operator', 'rotate_key', null,
            array(select distinct u from unnest(v_names) u order by u),
            jsonb_build_object('key_ids', to_jsonb(array(select distinct u from unnest(v_keys) u order by u)),
                               'values', n_values, 'imports', n_imports));
  end if;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Environments

-- An owner, in person (no agent, no CLI grant, not the MCP server's role).
-- Returns nothing; raises P0002 for a non-member, 42501 for anyone else.
create function private.require_env_owner(p_vault uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text;
begin
  perform private.require_human();
  if session_user::text = 'reliquary_mcp' then
    raise exception 'this action needs the person, not their agent' using errcode = '42501';
  end if;
  v_role := private.role_in(p_vault);
  if v_role is null then
    raise exception 'no such vault' using errcode = 'P0002';
  end if;
  if v_role <> 'owner' then
    raise exception 'only owners manage environments' using errcode = '42501';
  end if;
end $$;

create function private.valid_environment_name(p_name text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_name is null or p_name !~ '^[a-z][a-z0-9_-]{0,31}$' then
    raise exception 'an environment name is lowercase letters, digits, - and _, starting with a letter, up to 32 characters'
      using errcode = '22023';
  end if;
  return p_name;
end $$;

create function private.default_environment(p_name text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_name in ('development', 'preview', 'production'), false)
$$;

-- Rejects the pending imports (drafts and pushes) that are for this
-- environment: their values were sealed for it. Logs each as `reject`.
create function private.reject_imports_for(p_vault uuid, p_environment text, p_reason text) returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  n int := 0;
begin
  for r in
    update public.env_imports i
       set status = case when i.expires_at <= now() then 'expired' else 'rejected' end,
           decided_by = case when i.expires_at <= now() then null else private.uid() end,
           decided_at = case when i.expires_at <= now() then null else now() end
     where i.vault_id = p_vault and i.status = 'pending' and p_environment = any(i.environments)
    returning i.id, i.names, i.status
  loop
    delete from private.env_import_secrets where import_id = r.id;
    if r.status = 'rejected' then
      perform private.env_log(p_vault, 'reject', p_environment, r.names,
        jsonb_build_object('import', r.id, 'reason', p_reason));
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- Adds an environment to a vault. p_owners_only: only owners set and use
-- its values (as production).
create function public.create_environment(p_vault uuid, p_name text, p_owners_only boolean default false)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_env_owner(p_vault);
  perform private.valid_environment_name(p_name);
  -- One at a time per vault, so the count below holds.
  perform 1 from public.vaults where id = p_vault for update;
  if exists (select 1 from public.environments where vault_id = p_vault and name = p_name) then
    raise exception 'there is already an environment named %', p_name using errcode = '23505';
  end if;
  if (select count(*) from public.environments where vault_id = p_vault) >= 20 then
    raise exception 'a vault has at most 20 environments' using errcode = '55000';
  end if;
  insert into public.environments (vault_id, name, owners_only) values (p_vault, p_name, coalesce(p_owners_only, false));
  perform private.env_log(p_vault, 'create_environment', p_name, '{}',
    jsonb_build_object('owners_only', coalesce(p_owners_only, false)));
  perform private.log_event(p_vault, 'environment.create', null, null, null,
    jsonb_build_object('name', p_name, 'owners_only', coalesce(p_owners_only, false)));
end $$;

-- Renames an environment that isn't one of the three defaults, with its
-- values. The caller (the web app) must then seal every moved value again
-- for the new name, in the same transaction, through private.reseal with
-- 'rename_environment': until then they don't decrypt. Returns
-- {"moved": n, "names": [...], "rejected_imports": n}.
create function public.rename_environment(p_vault uuid, p_name text, p_new_name text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_names text[];
  v_rejected int;
begin
  perform private.require_env_owner(p_vault);
  perform 1 from public.vaults where id = p_vault for update;
  if not exists (select 1 from public.environments where vault_id = p_vault and name = p_name) then
    raise exception 'no environment named %', coalesce(p_name, 'null') using errcode = 'P0002';
  end if;
  if private.default_environment(p_name) then
    raise exception 'the default environments (development, preview, production) keep their names' using errcode = '55000';
  end if;
  perform private.valid_environment_name(p_new_name);
  if p_new_name = p_name then
    raise exception 'that is its name already' using errcode = '22023';
  end if;
  if exists (select 1 from public.environments where vault_id = p_vault and name = p_new_name) then
    raise exception 'there is already an environment named %', p_new_name using errcode = '23505';
  end if;
  select coalesce(array_agg(v.name order by v.name), '{}') into v_names
    from public.variable_values vv join public.variables v on v.id = vv.variable_id
   where vv.vault_id = p_vault and vv.environment = p_name;
  v_rejected := private.reject_imports_for(p_vault, p_name, 'environment renamed');
  update public.environments set name = p_new_name where vault_id = p_vault and name = p_name;
  perform set_config('reliquary.resealing', p_vault::text || '/' || p_new_name, true);
  perform private.env_log(p_vault, 'rename_environment', p_new_name, v_names,
    jsonb_build_object('from', p_name, 'to', p_new_name));
  perform private.log_event(p_vault, 'environment.rename', null, null, null,
    jsonb_build_object('from', p_name, 'to', p_new_name));
  return jsonb_build_object('moved', cardinality(v_names), 'names', to_jsonb(v_names), 'rejected_imports', v_rejected);
end $$;

-- Deletes an environment and every value in it. p_confirm must be its name,
-- typed. A default environment is deleted only when it holds no value, and
-- a vault keeps at least one environment. A variable left with no value in
-- any environment goes too. Returns {"deleted": n, "names": [...]}.
create function public.delete_environment(p_vault uuid, p_name text, p_confirm text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_names text[];
begin
  perform private.require_env_owner(p_vault);
  perform 1 from public.vaults where id = p_vault for update;
  if not exists (select 1 from public.environments where vault_id = p_vault and name = p_name) then
    raise exception 'no environment named %', coalesce(p_name, 'null') using errcode = 'P0002';
  end if;
  if p_confirm is distinct from p_name then
    raise exception 'type the environment''s name to delete it' using errcode = '22023';
  end if;
  select coalesce(array_agg(v.name order by v.name), '{}') into v_names
    from public.variable_values vv join public.variables v on v.id = vv.variable_id
   where vv.vault_id = p_vault and vv.environment = p_name;
  if private.default_environment(p_name) and cardinality(v_names) > 0 then
    raise exception '% still holds values; a default environment is deleted only when empty', p_name using errcode = '55000';
  end if;
  if (select count(*) from public.environments where vault_id = p_vault) <= 1 then
    raise exception 'a vault keeps at least one environment' using errcode = '55000';
  end if;
  perform private.reject_imports_for(p_vault, p_name, 'environment deleted');
  delete from public.environments where vault_id = p_vault and name = p_name;
  delete from public.variables v
   where v.vault_id = p_vault
     and not exists (select 1 from public.variable_values vv where vv.variable_id = v.id);
  perform private.env_log(p_vault, 'delete_environment', p_name, v_names,
    jsonb_build_object('values', cardinality(v_names)));
  perform private.log_event(p_vault, 'environment.delete', null, null, null,
    jsonb_build_object('name', p_name, 'values', cardinality(v_names)));
  return jsonb_build_object('deleted', cardinality(v_names), 'names', to_jsonb(v_names));
end $$;

-- ---------------------------------------------------------------------------
-- 3. At most 1000 variables a vault. As in 20260925100000_env_imports, plus
-- the limit on a new name.

create or replace function private.put_variable(p_vault uuid, p_name text, p_environment text,
  p_key_id text, p_nonce bytea, p_ciphertext bytea, p_detail jsonb default '{}')
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_var uuid;
  v_version int;
  v_action text;
begin
  perform private.valid_variable_name(p_name);
  if p_key_id is null or p_key_id !~ '^[A-Za-z0-9_-]{1,32}$' or p_nonce is null or length(p_nonce) <> 12
     or p_ciphertext is null or length(p_ciphertext) not between 16 and 65552 then
    raise exception 'that isn''t an encrypted value (or it is over 64 KiB)' using errcode = '22023';
  end if;

  select id into v_var from public.variables where vault_id = p_vault and name = p_name;
  if v_var is null then
    perform 1 from public.vaults where id = p_vault for update;
    if (select count(*) from public.variables where vault_id = p_vault) >= 1000 then
      raise exception 'a vault holds at most 1000 variables' using errcode = '55000';
    end if;
    insert into public.variables (vault_id, name, created_by) values (p_vault, p_name, private.uid())
    on conflict (vault_id, name) do nothing;
    select id into v_var from public.variables where vault_id = p_vault and name = p_name;
  end if;
  insert into public.variable_values (variable_id, vault_id, environment, updated_by)
  values (v_var, p_vault, p_environment, private.uid())
  on conflict (variable_id, environment) do update
    set version = public.variable_values.version + 1, updated_by = excluded.updated_by, updated_at = now()
  returning version into v_version;
  insert into private.variable_secrets (variable_id, environment, key_id, nonce, ciphertext)
  values (v_var, p_environment, p_key_id, p_nonce, p_ciphertext)
  on conflict (variable_id, environment) do update
    set key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext;

  v_action := case when v_version = 1 then 'set' else 'rotate' end;
  perform private.env_log(p_vault, v_action, p_environment, array[p_name], coalesce(p_detail, '{}'));
  perform private.log_event(p_vault, 'variable.' || v_action, null, null, null,
    jsonb_build_object('name', p_name, 'environment', p_environment));
  return v_action;
end $$;

-- ---------------------------------------------------------------------------
-- Grants

revoke all on function private.variable_key_ids(), private.rekey_vaults(text),
  private.sealed_rows(uuid, text, text), private.reseal(uuid, text, jsonb),
  private.require_env_owner(uuid), private.valid_environment_name(text),
  private.default_environment(text), private.reject_imports_for(uuid, text, text),
  private.put_variable(uuid, text, text, text, bytea, bytea, jsonb)
  from public, anon, authenticated;
grant execute on function private.variable_key_ids(), private.rekey_vaults(text),
  private.sealed_rows(uuid, text, text), private.reseal(uuid, text, jsonb)
  to reliquary_web;

revoke all on function public.create_environment(uuid, text, boolean),
  public.rename_environment(uuid, text, text), public.delete_environment(uuid, text, text)
  from public, anon;
grant execute on function public.create_environment(uuid, text, boolean),
  public.rename_environment(uuid, text, text), public.delete_environment(uuid, text, text)
  to authenticated;
