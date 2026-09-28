-- The MCP proxy's credential-egress chokepoint (milestone 3's exit item,
-- docs/design.md's "Links" implementation plan). mcp/ calls these two
-- functions from a <link>.<tool> handler; there is no MCP tool for either,
-- so an agent never calls them directly.
--
-- Split in two, unlike reveal_variable/read_variables's single function
-- (20260925090000_variables.sql): a link call's outcome depends on an HTTP
-- round trip to the upstream server that Postgres can't make, so the
-- "sensitive read" and the "outcome" aren't the same statement the way a
-- variable's are.
--
-- - begin_link_call authorizes (membership, the tool's grant for this
--   role, and -- for a write tool -- private.connection_write_capable(),
--   the same check 20260928170000_path_owner_connection_scope.sql built
--   for path ownership's F425 fix, so a read-only or wrong-vault-scoped
--   token can't reach a write tool's credential even when its role's
--   grant is on) and, on success, hands back the sealed credential
--   (still encrypted) and its vault id. mcp/ never decrypts this itself
--   -- server.ts refuses to start with VARIABLES_KEY(S) set, so the key
--   stays web-app-only, same as every environment variable -- it sends
--   the sealed value on to the web app's own internal endpoint
--   (web/src/linkproxy.ts), which opens it and makes the call. Nothing
--   is logged on success yet -- the call hasn't happened. A refusal is
--   logged right here, though, and returned as {ok: false, ...} without
--   raising, the same reveal_variable/read_variables reasoning: so the
--   refusal's own row still commits regardless of what the caller does
--   with the answer.
-- - record_link_call is the one, final row: mcp/ calls it once the
--   upstream call has resolved, one way or another, from a try/finally
--   around the outbound request so every path -- success, an upstream
--   error, a timeout, an SSRF re-check failing at call time -- reaches it
--   before the MCP response returns. This is what "logged in the same
--   request as the call" (design.md) means here: not a shared SQL
--   transaction (impossible across a network round trip), a guarantee
--   that every path through that one request logs before responding.
--
-- A third function, private.list_callable_link_tools(), is what mcp/'s
-- tools/list calls to build each identity's <link>.<tool> entries: the
-- same criteria as begin_link_call, so a tool is only ever listed if
-- calling it would actually succeed.
--
-- Also: link_tools grows input_schema (jsonb), and set_link_tools stores
-- it when discovery provides one. Discovery already fetches a tool's full
-- schema from the upstream's tools/list and was simply discarding it;
-- mcp/'s proxy needs it to register <link>.<tool> with a real schema
-- rather than a passthrough one. Purely additive: every existing caller
-- of set_link_tools that omits input_schema gets null, as before.

alter table public.link_tools add column input_schema jsonb;

create or replace function public.set_link_tools(p_link uuid, p_tools jsonb)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
  v_added text[];
  v_removed text[];
  v_tool_count int;
begin
  perform private.require_human();
  select vault_id into v_vault from public.links where id = p_link;
  if v_vault is null or private.role_in(v_vault) is distinct from 'owner' then
    raise exception 'only owners record a link''s discovered tools' using errcode = '42501';
  end if;
  if jsonb_typeof(p_tools) is distinct from 'array' then
    raise exception 'discovered tools must be a list' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(p_tools)) > 500 then
    raise exception 'a link can have at most 500 discovered tools' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_tools) t
     where jsonb_typeof(t) is distinct from 'object'
        or jsonb_typeof(t->'name') is distinct from 'string'
        or length(t->>'name') = 0 or length(t->>'name') > 200
        or (t ? 'is_write' and jsonb_typeof(t->'is_write') is distinct from 'boolean')
        or (t ? 'input_schema' and jsonb_typeof(t->'input_schema') not in ('object', 'null'))
  ) then
    raise exception 'a discovered tool needs a name (1 to 200 characters), a boolean is_write and an object input_schema, if given' using errcode = '22023';
  end if;

  -- Gone from the latest discovery: remove from link_tools; grants for it
  -- stay (see the original migration's comment).
  with names as (
    select distinct t->>'name' as tool_name from jsonb_array_elements(p_tools) t
  ),
  deleted as (
    delete from public.link_tools
     where link_id = p_link and tool_name not in (select tool_name from names)
    returning tool_name
  )
  select coalesce(array_agg(tool_name order by tool_name), '{}') into v_removed from deleted;

  -- Which of the incoming names are genuinely new -- checked against
  -- link_tools as it stands before the upsert below touches it.
  with incoming as (
    select t->>'name' as tool_name,
           coalesce((t->>'is_write')::boolean, true) as is_write,
           nullif(left(t->>'description', 1000), '') as description
      from jsonb_array_elements(p_tools) t
  ),
  new_ones as (
    select i.tool_name from incoming i
     where not exists (select 1 from public.link_tools lt where lt.link_id = p_link and lt.tool_name = i.tool_name)
  )
  select coalesce(array_agg(tool_name order by tool_name), '{}') into v_added from new_ones;

  -- Add or refresh. description and input_schema are refreshed every run
  -- (nothing an owner hand-edits); is_write is discovery's first guess
  -- only, an owner's later flip never overwritten by a later run.
  with incoming as (
    select t->>'name' as tool_name,
           coalesce((t->>'is_write')::boolean, true) as is_write,
           nullif(left(t->>'description', 1000), '') as description,
           case when jsonb_typeof(t->'input_schema') = 'object' then t->'input_schema' end as input_schema
      from jsonb_array_elements(p_tools) t
  )
  insert into public.link_tools (link_id, vault_id, tool_name, is_write, description, input_schema)
  select p_link, v_vault, tool_name, is_write, description, input_schema from incoming
  on conflict (link_id, tool_name) do update
    set description = excluded.description, input_schema = excluded.input_schema;

  if array_length(v_added, 1) > 0 then
    insert into public.link_grants (link_id, vault_id, role, tool_name, enabled)
    select p_link, v_vault, r.role, lt.tool_name, not lt.is_write
      from public.link_tools lt
      cross join (values ('owner'), ('editor')) as r(role)
     where lt.link_id = p_link and lt.tool_name = any(v_added)
    on conflict (link_id, role, tool_name) do nothing;
  end if;

  if array_length(v_added, 1) > 0 or array_length(v_removed, 1) > 0 then
    select count(*) into v_tool_count from public.link_tools where link_id = p_link;
    perform private.log_link(v_vault, p_link, 'link.discover',
      jsonb_build_object('added', to_jsonb(v_added), 'removed', to_jsonb(v_removed), 'tool_count', v_tool_count));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- The chokepoint

create function private.log_link_call(p_vault uuid, p_link uuid, p_tool_name text, p_outcome text,
  p_arg_hash text default null, p_result_hash text default null)
returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.link_calls (link_id, vault_id, actor, agent, tool_name, outcome, arg_hash, result_hash)
  values (p_link, p_vault, private.uid(), private.agent(), p_tool_name, p_outcome, p_arg_hash, p_result_hash)
$$;

-- Authorizes a <link>.<tool> call and, on success, hands back the sealed
-- credential and its vault id (never plaintext -- mcp/ forwards this,
-- still sealed, to the web app's internal endpoint to open and use; mcp/
-- never holds VARIABLES_KEYS). Not require_human: this runs on an
-- agent's behalf, same as any other proxied tool call.
create function public.begin_link_call(p_link uuid, p_tool_name text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
  v_url text;
  v_role text;
  v_is_write boolean;
  v_enabled boolean;
  v_key_id text;
  v_nonce bytea;
  v_ciphertext bytea;
begin
  select l.vault_id, l.url into v_vault, v_url from public.links l where l.id = p_link;
  if v_vault is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  v_role := private.role_in(v_vault);
  if v_role is null then
    -- Not a member, or a token that doesn't reach this vault at all: there
    -- is no identity to log this refusal against beyond the vault itself.
    perform private.log_link_call(v_vault, p_link, p_tool_name, 'refused');
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select lt.is_write into v_is_write from public.link_tools lt
   where lt.link_id = p_link and lt.tool_name = p_tool_name;
  if v_is_write is null then
    perform private.log_link_call(v_vault, p_link, p_tool_name, 'refused');
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  select lg.enabled into v_enabled from public.link_grants lg
   where lg.link_id = p_link and lg.role = v_role and lg.tool_name = p_tool_name;
  if coalesce(v_enabled, false) is not true then
    perform private.log_link_call(v_vault, p_link, p_tool_name, 'refused');
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  if v_is_write and not private.connection_write_capable(v_vault) then
    perform private.log_link_call(v_vault, p_link, p_tool_name, 'refused');
    return jsonb_build_object('ok', false, 'error', 'forbidden');
  end if;

  select s.key_id, s.nonce, s.ciphertext into v_key_id, v_nonce, v_ciphertext
    from private.link_secrets s where s.link_id = p_link;
  if v_key_id is null then
    perform private.log_link_call(v_vault, p_link, p_tool_name, 'refused');
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  return jsonb_build_object('ok', true, 'vault_id', v_vault, 'url', v_url, 'key_id', v_key_id,
    'nonce', encode(v_nonce, 'base64'), 'ciphertext', encode(v_ciphertext, 'base64'));
end $$;

-- The one, final append-only row for a call begin_link_call authorized.
-- Re-checks the exact same authorization (not just membership), so a bug
-- in mcp/'s own code -- the only caller, never an agent directly -- can
-- never write a row into the append-only log for a tool this identity
-- isn't (or no longer is) actually granted. Raises rather than silently
-- doing nothing, the ordinary shape for an access refusal in this
-- codebase, since a mismatch here means mcp/'s proxy called this for the
-- wrong tool or after something changed mid-flight: worth surfacing, not
-- swallowing. mcp/ catches this and logs server-side rather than failing
-- the tool call the agent is waiting on -- the upstream call itself
-- already happened by the time this runs.
create function public.record_link_call(p_link uuid, p_tool_name text, p_outcome text,
  p_arg_hash text default null, p_result_hash text default null)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
  v_role text;
  v_is_write boolean;
  v_enabled boolean;
begin
  if p_outcome not in ('ok', 'error') then
    raise exception 'a recorded call''s outcome is ok or error' using errcode = '22023';
  end if;
  select vault_id into v_vault from public.links where id = p_link;
  if v_vault is null then
    raise exception 'this identity may not record a call for that link''s tool' using errcode = '42501';
  end if;
  v_role := private.role_in(v_vault);
  select lt.is_write into v_is_write from public.link_tools lt
   where lt.link_id = p_link and lt.tool_name = p_tool_name;
  select lg.enabled into v_enabled from public.link_grants lg
   where lg.link_id = p_link and lg.role = v_role and lg.tool_name = p_tool_name;
  if v_role is null or v_is_write is null or coalesce(v_enabled, false) is not true
     or (v_is_write and not private.connection_write_capable(v_vault)) then
    raise exception 'this identity may not record a call for that link''s tool' using errcode = '42501';
  end if;
  perform private.log_link_call(v_vault, p_link, p_tool_name, p_outcome, p_arg_hash, p_result_hash);
end $$;

-- Every (link, tool) this identity may call right now, across every vault
-- they reach: the exact criteria begin_link_call itself checks (the
-- role's grant enabled; a write tool also needs
-- connection_write_capable()), so mcp/'s tools/list only ever offers a
-- <link>.<tool> that would actually succeed. security definer so it may
-- call connection_write_capable(), deliberately not granted to
-- authenticated directly (20260928170000_path_owner_connection_scope.sql)
-- -- this is the one place outside policy_for()/can_write_path() allowed
-- to, rather than loosening that grant for everything.
create function private.list_callable_link_tools()
returns table (vault_id uuid, link_id uuid, link_name text, tool_name text, is_write boolean, description text, input_schema jsonb)
language sql stable security definer set search_path = '' as $$
  select l.vault_id, l.id, l.name, lt.tool_name, lt.is_write, lt.description, lt.input_schema
    from public.links l
    join public.link_tools lt on lt.link_id = l.id
    join public.link_grants lg on lg.link_id = l.id and lg.tool_name = lt.tool_name
   where l.vault_id in (select private.readable_vaults())
     and lg.role = private.role_in(l.vault_id)
     and lg.enabled
     and (not lt.is_write or private.connection_write_capable(l.vault_id))
   order by l.name, lt.tool_name
$$;

revoke all on function private.log_link_call(uuid, uuid, text, text, text, text) from public, anon, authenticated;

revoke all on function public.begin_link_call(uuid, text), public.record_link_call(uuid, text, text, text, text)
  from public, anon;
grant execute on function public.begin_link_call(uuid, text), public.record_link_call(uuid, text, text, text, text)
  to authenticated;

revoke all on function private.list_callable_link_tools() from public, anon;
grant execute on function private.list_callable_link_tools() to authenticated;
