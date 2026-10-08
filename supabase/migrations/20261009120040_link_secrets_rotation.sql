-- Link credentials join key rotation (docs/variables.md, "Key rotation";
-- the runbook's "Rotating VARIABLES_KEY").
--
-- private.link_secrets is sealed with the same VARIABLES_KEYS as variable
-- values (20260928120000_links), but the rotation functions
-- (20260925170000_variables_keys, 20260925190000_final_sweep) read only
-- values and pending imports. So a rotation left every link credential on
-- the old key while reporting everything moved, the web app's start-up check
-- (private.stored_key_ids, which reads variable_key_ids) didn't see their key
-- ids, and dropping the old key, as the runbook then says to, made every
-- link call fail to decrypt.
--
-- Each function now covers kind 'link' too:
--   variable_key_ids   a new `links` count per key id, so stored_key_ids and
--                      the start-up check see a link's key id
--   rekey_vaults       vaults with a link credential on another key
--   sealed_rows        a vault's link credentials (environment null: a
--                      link's additional data is its vault only, linkAad in
--                      web/src/secrets.ts)
--   reseal             swaps a link's credential, guarded by its old nonce
--                      and its vault as values are, for rotate_key only (a
--                      link item must have no environment, and a rename
--                      reseal needs one), counted as detail.links in the one
--                      rotate_key row per vault. The row's names stay
--                      variable names: the access log lists variables.

-- A new column changes the return type, which create or replace can't.
drop function private.variable_key_ids();
create function private.variable_key_ids()
returns table (key_id text, "values" bigint, imports bigint, links bigint)
language sql stable security definer set search_path = '' as $$
  select x.key_id, count(*) filter (where x.kind = 'value'), count(*) filter (where x.kind = 'import'),
         count(*) filter (where x.kind = 'link')
    from (select s.key_id, 'value' as kind from private.variable_secrets s
          union all
          select s.key_id, 'import' from private.env_import_secrets s
            join public.env_imports i on i.id = s.import_id
           where i.status = 'pending' and i.expires_at > now()
          union all
          select s.key_id, 'link' from private.link_secrets s) x
   group by x.key_id
   order by x.key_id
$$;
revoke all on function private.variable_key_ids() from public, anon, authenticated;
grant execute on function private.variable_key_ids() to reliquary_ops;

create or replace function private.rekey_vaults(p_key_id text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select vv.vault_id from private.variable_secrets s
    join public.variable_values vv on vv.variable_id = s.variable_id and vv.environment = s.environment
   where s.key_id is distinct from p_key_id
  union
  select i.vault_id from private.env_import_secrets s
    join public.env_imports i on i.id = s.import_id
   where i.status = 'pending' and i.expires_at > now() and s.key_id is distinct from p_key_id
  union
  select l.vault_id from private.link_secrets s
    join public.links l on l.id = s.link_id
   where s.key_id is distinct from p_key_id
$$;

create or replace function private.sealed_rows(p_vault uuid, p_environment text default null, p_not_key text default null)
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
  union all
  select 'link', s.link_id, l.name, null, s.key_id, s.nonce, s.ciphertext
    from private.link_secrets s
    join public.links l on l.id = s.link_id
   where l.vault_id = p_vault and p_environment is null
     and (p_not_key is null or s.key_id <> p_not_key)
   order by 1, 3, 4
$$;

-- As in 20260925190000_final_sweep, plus kind 'link'.
create or replace function private.reseal(p_vault uuid, p_reason text, p_items jsonb)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  x record;
  n int := 0;
  v_rows int;
  n_values int := 0;
  n_imports int := 0;
  n_links int := 0;
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
    if p_reason = 'rename_environment' and not private.renaming(p_vault, x.environment) then
      raise exception 'values are sealed again for a new name only in that rename''s transaction' using errcode = '42501';
    end if;
    begin
      v_old := decode(x.old_nonce, 'base64');
      v_nonce := decode(x.nonce, 'base64');
      v_ct := decode(x.ciphertext, 'base64');
    exception when others then
      raise exception 'nonces and ciphertexts are base64' using errcode = '22023';
    end;
    if x.kind is null or x.kind not in ('value', 'import', 'link') or x.ref is null or x.name is null
       or (x.environment is null) <> (x.kind = 'link')
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
    elsif x.kind = 'import' then
      update private.env_import_secrets s set key_id = x.key_id, nonce = v_nonce, ciphertext = v_ct
        from public.env_imports i
       where s.import_id = x.ref and s.name = x.name and s.environment = x.environment and s.nonce = v_old
         and i.id = s.import_id and i.vault_id = p_vault and i.status = 'pending';
      get diagnostics v_rows = row_count;
      n_imports := n_imports + v_rows;
    else
      -- No name match: a link's additional data is its vault alone, so a
      -- rename meanwhile doesn't make the new ciphertext wrong.
      update private.link_secrets s set key_id = x.key_id, nonce = v_nonce, ciphertext = v_ct
        from public.links l
       where s.link_id = x.ref and s.nonce = v_old and l.id = s.link_id and l.vault_id = p_vault;
      get diagnostics v_rows = row_count;
      n_links := n_links + v_rows;
    end if;
    if v_rows > 0 then
      if x.kind <> 'link' then
        v_names := array_append(v_names, x.name);
      end if;
      v_keys := array_append(v_keys, x.key_id);
    end if;
  end loop;
  n := n_values + n_imports + n_links;
  if p_reason = 'rotate_key' and n > 0 then
    insert into public.env_access_log (vault_id, actor, agent, action, environment, names, detail)
    values (p_vault, null, 'Reliquary operator', 'rotate_key', null,
            array(select distinct u from unnest(v_names) u order by u),
            jsonb_build_object('key_ids', to_jsonb(array(select distinct u from unnest(v_keys) u order by u)),
                               'values', n_values, 'imports', n_imports)
            || case when n_links > 0 then jsonb_build_object('links', n_links) else '{}' end);
  end if;
  return n;
end $$;
