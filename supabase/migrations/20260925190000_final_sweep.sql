-- Final sweep (docs/variables.md, docs/research/server-load.md "Final sweep").
--
-- 1. An operator's role for re-encryption. The four functions that read and
--    swap stored ciphertext (private.variable_key_ids, rekey_vaults,
--    sealed_rows, reseal) move from the web app's role to reliquary_ops, a
--    role nothing runs as day to day: nologin until an owner gives it a
--    password (scripts/set-role-passwords.sh ops), and then only
--    scripts/rotate-variables-key.sh logs in as it. So the web app's role
--    reads ciphertext only as people do (reveal and read, each logged),
--    plus, inside an owner's rename of an environment, that environment's
--    values (to seal them again for the new name). The web app keeps:
--      private.stored_key_ids()        key ids only, for its start-up check
--      private.renamed_rows(v, env)    the values of an environment renamed
--                                      in this transaction, else 42501
--      private.reseal_renamed(v, items) the reseal for that rename only
--    A rename is recorded in private.environment_renames with the
--    transaction's id (by rename_environment, an owner in person), not in a
--    setting any role could set for itself.
-- 2. "Read since it was set" on the Variables page, exactly. Instead of the
--    vault's last 500 log rows, private.env_readers keeps, per reader
--    (environment, action, person, agent) and set of names, the newest read
--    or reveal; a trigger on env_access_log maintains it, and a group whose
--    names a newer read of the same reader covers is dropped as redundant.
--    public.variable_readers(vault) answers from it for owners and editors.
--    (An index on the log's reads alone still scanned every read since the
--    oldest value was set: 250 ms for 102,000 reads.)
-- 3. The access log's order for one vault. Its primary key was (seq), so
--    `where vault_id = $1 order by seq desc limit n` could walk the whole
--    table backwards when one vault's rows were the oldest (62 ms instead
--    of under 1 ms). The primary key is now (vault_id, seq), which replaces
--    the (vault_id, seq) index: no index orders the log across vaults, so
--    every plan for one vault's page starts at that vault. seq stays unique
--    (an identity column nobody may set).

-- ---------------------------------------------------------------------------
-- 1. reliquary_ops

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'reliquary_ops') then
    create role reliquary_ops nologin noinherit;
  end if;
end $$;
grant usage on schema private to reliquary_ops;
alter role reliquary_ops set statement_timeout = '60s';
alter role reliquary_ops set idle_in_transaction_session_timeout = '15s';

revoke execute on function private.variable_key_ids(), private.rekey_vaults(text),
  private.sealed_rows(uuid, text, text), private.reseal(uuid, text, jsonb)
  from reliquary_web;
grant execute on function private.variable_key_ids(), private.rekey_vaults(text),
  private.sealed_rows(uuid, text, text), private.reseal(uuid, text, jsonb)
  to reliquary_ops;

-- Renames in progress: one row per rename, by the transaction that made it.
-- Only this transaction's rows count; a vault's older ones are cleared by
-- its next rename.
create table private.environment_renames (
  txid        bigint not null,
  vault_id    uuid not null references public.vaults on delete cascade,
  environment text not null,
  primary key (txid, vault_id, environment)
);
create index on private.environment_renames (vault_id);
alter table private.environment_renames enable row level security;
revoke all on private.environment_renames from public, anon, authenticated;

create function private.renaming(p_vault uuid, p_environment text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.environment_renames r
                  where r.txid = txid_current_if_assigned() and r.vault_id = p_vault and r.environment = p_environment)
$$;

-- As in 20260925170000_variables_keys, but the rename is recorded for this
-- transaction instead of in a setting.
create or replace function public.rename_environment(p_vault uuid, p_name text, p_new_name text)
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
  delete from private.environment_renames where vault_id = p_vault and txid <> txid_current();
  insert into private.environment_renames (txid, vault_id, environment)
  values (txid_current(), p_vault, p_new_name) on conflict do nothing;
  perform private.env_log(p_vault, 'rename_environment', p_new_name, v_names,
    jsonb_build_object('from', p_name, 'to', p_new_name));
  perform private.log_event(p_vault, 'environment.rename', null, null, null,
    jsonb_build_object('from', p_name, 'to', p_new_name));
  return jsonb_build_object('moved', cardinality(v_names), 'names', to_jsonb(v_names), 'rejected_imports', v_rejected);
end $$;

-- As in 20260925170000_variables_keys, but 'rename_environment' is allowed
-- only for an environment renamed in this transaction (private.renaming).
create or replace function private.reseal(p_vault uuid, p_reason text, p_items jsonb)
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

-- The web app's start-up check: which key ids stored values name. Ids only.
create function private.stored_key_ids() returns setof text
language sql stable security definer set search_path = '' as $$
  select k.key_id from private.variable_key_ids() k
$$;

-- An environment's sealed values, only while it is being renamed in this
-- transaction (to open and seal again for its new name).
create function private.renamed_rows(p_vault uuid, p_environment text)
returns table (ref uuid, name text, key_id text, nonce bytea, ciphertext bytea)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.renaming(p_vault, p_environment) then
    raise exception 'an environment''s values are read for a rename only in that rename''s transaction' using errcode = '42501';
  end if;
  return query
    select s.variable_id, v.name, s.key_id, s.nonce, s.ciphertext
      from private.variable_secrets s join public.variables v on v.id = s.variable_id
     where v.vault_id = p_vault and s.environment = p_environment
     order by v.name;
end $$;

-- private.reseal for a rename only.
create function private.reseal_renamed(p_vault uuid, p_items jsonb) returns int
language sql volatile security definer set search_path = '' as $$
  select private.reseal(p_vault, 'rename_environment', p_items)
$$;

revoke all on function private.renaming(uuid, text), private.stored_key_ids(),
  private.renamed_rows(uuid, text), private.reseal_renamed(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function private.stored_key_ids(), private.renamed_rows(uuid, text),
  private.reseal_renamed(uuid, jsonb) to reliquary_web;

-- ---------------------------------------------------------------------------
-- 2. Readers since a value was set

create table private.env_readers (
  id          bigint generated always as identity primary key,
  vault_id    uuid not null references public.vaults on delete cascade,
  environment text,
  action      text not null check (action in ('read', 'reveal')),
  actor       uuid,
  agent       text,
  names       text[] not null,
  names_key   text not null,
  last_seq    bigint not null,
  last_at     timestamptz not null
);
create unique index env_readers_group on private.env_readers
  (vault_id, environment, action, actor, agent, names_key) nulls not distinct;
alter table private.env_readers enable row level security;
revoke all on private.env_readers from public, anon, authenticated;

-- One read or reveal: its group's newest, then drop the same reader's groups
-- it makes redundant (a proper subset of its names, none newer). Dropping
-- is best effort: rows another transaction holds are left for next time.
create function private.note_env_reader() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_key text := md5(new.names::text);
begin
  insert into private.env_readers as r (vault_id, environment, action, actor, agent, names, names_key, last_seq, last_at)
  values (new.vault_id, new.environment, new.action, new.actor, new.agent, new.names, v_key, new.seq, new.at)
  on conflict (vault_id, environment, action, actor, agent, names_key)
  do update set last_seq = greatest(r.last_seq, excluded.last_seq), last_at = greatest(r.last_at, excluded.last_at);
  delete from private.env_readers r
   where r.id in (select x.id from private.env_readers x
                   where x.vault_id = new.vault_id and x.environment is not distinct from new.environment
                     and x.action = new.action and x.actor is not distinct from new.actor
                     and x.agent is not distinct from new.agent and x.names_key <> v_key
                     and x.names <@ new.names and x.last_seq <= new.seq and x.last_at <= new.at
                     for update skip locked);
  return null;
end $$;
revoke all on function private.note_env_reader() from public, anon, authenticated;

create trigger env_access_log_readers after insert on public.env_access_log
  for each row when (new.action in ('read', 'reveal')) execute function private.note_env_reader();

-- The history so far.
insert into private.env_readers (vault_id, environment, action, actor, agent, names, names_key, last_seq, last_at)
select vault_id, environment, action, actor, agent, names, md5(names::text), max(seq), max(at)
  from public.env_access_log where action in ('read', 'reveal')
 group by vault_id, environment, action, actor, agent, names;
delete from private.env_readers a using private.env_readers b
 where b.vault_id = a.vault_id and b.environment is not distinct from a.environment and b.action = a.action
   and b.actor is not distinct from a.actor and b.agent is not distinct from a.agent
   and b.id <> a.id and a.names <@ b.names and a.names_key <> b.names_key
   and a.last_seq <= b.last_seq and a.last_at <= b.last_at;

-- Who read or revealed each of a vault's values since it was last set: one
-- row per variable, environment, action, person and agent, newest first
-- (`last`, the newest such log row's seq). For owners and editors, as the
-- access log is; anyone else gets no rows.
create function public.variable_readers(p_vault uuid)
returns table (name text, environment text, action text, actor uuid, agent text, last bigint)
language sql stable security definer set search_path = '' as $$
  select n.name, r.environment, r.action, r.actor, r.agent, max(r.last_seq)
    from private.env_readers r
    cross join unnest(r.names) n(name)
    join public.variables v on v.vault_id = r.vault_id and v.name = n.name
    join public.variable_values vv on vv.variable_id = v.id and vv.environment = r.environment and r.last_at > vv.updated_at
   where r.vault_id = p_vault and p_vault in (select private.writable_vaults())
   group by 1, 2, 3, 4, 5
   order by 6 desc
$$;
revoke all on function public.variable_readers(uuid) from public, anon;
grant execute on function public.variable_readers(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The access log's primary key: (vault_id, seq)

alter table public.env_access_log drop constraint env_access_log_pkey;
alter table public.env_access_log add constraint env_access_log_pkey primary key (vault_id, seq);
drop index public.env_access_log_vault_id_seq_idx;
