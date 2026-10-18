-- A link's credential can go in a header other than Authorization (issue
-- #441). Until now it was only ever sent as `Authorization: Bearer
-- <credential>`, so an upstream that takes its key in, say, `X-Api-Key`
-- couldn't be linked at all.
--
-- The header's name sits beside the url in public.links: it isn't secret,
-- every member and agent may read it, and the log keeps it. `Authorization`
-- (the default, matched without regard to case) sends `Bearer
-- <credential>`; any other name sends the credential as the header's whole
-- value.
--
-- The name must be an HTTP field name (a token, RFC 9110 section 5.1), and
-- can't be one Reliquary or the connection sets itself on every call to the
-- link's server (host, content-length, the MCP session headers and the
-- rest below), or a cookie: the credential would either be overwritten,
-- overwrite what the call needs, or go somewhere a server treats as
-- something other than a key. The table refuses such a name whoever writes
-- it (23514); create_link and update_link check through
-- private.check_link_auth_header first, which says which rule broke
-- (22023). web/src/discovery.ts's headerProblem holds the same rules for
-- the form and for every outbound call.
--
-- begin_link_call returns the name with the sealed credential, the way it
-- returns the url, so mcp/ can hand it to the web app's link proxy. mcp/
-- still never holds the credential itself.

alter table public.links add column auth_header text not null default 'Authorization'
  constraint links_auth_header_check check (
    auth_header ~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]{1,64}$'
    and lower(auth_header) not in ('host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade',
      'te', 'trailer', 'expect', 'content-type', 'accept', 'user-agent', 'mcp-session-id', 'mcp-protocol-version',
      'cookie', 'set-cookie'));

create function private.check_link_auth_header(p_header text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_header is null or p_header !~ '^[!#$%&''*+.^_`|~0-9A-Za-z-]+$' then
    raise exception 'a link''s header is a header name like Authorization or X-Api-Key: letters, digits and ! # $ %% & '' * + - . ^ _ ` | ~, with no spaces or colons'
      using errcode = '22023';
  elsif length(p_header) > 64 then
    raise exception 'a link''s header is at most 64 characters' using errcode = '22023';
  elsif lower(p_header) in ('cookie', 'set-cookie') then
    raise exception 'a link''s header can''t be a cookie (%): its credential goes in a header of its own', p_header
      using errcode = '22023';
  elsif lower(p_header) in ('host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade',
      'te', 'trailer', 'expect', 'content-type', 'accept', 'user-agent', 'mcp-session-id', 'mcp-protocol-version') then
    raise exception 'a link''s header can''t be %: Reliquary sets that header itself on every call to the link''s server', p_header
      using errcode = '22023';
  end if;
end $$;
revoke all on function private.check_link_auth_header(text) from public, anon, authenticated;

-- A new parameter, so dropped and created rather than replaced: two
-- overloads would make a six-argument call ambiguous. The new one is last
-- and defaulted, so every existing caller is unchanged. The header is
-- logged only when it isn't the default, so a link added the old way logs
-- exactly what it did.
drop function public.create_link(uuid, text, text, text, bytea, bytea);
create function public.create_link(p_vault uuid, p_name text, p_url text,
  p_key_id text, p_nonce bytea, p_ciphertext bytea, p_auth_header text default 'Authorization')
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
  perform private.check_link_url(p_url);
  perform private.check_link_auth_header(p_auth_header);
  if p_key_id is null or p_key_id !~ '^[A-Za-z0-9_-]{1,32}$' or p_nonce is null or length(p_nonce) <> 12
     or p_ciphertext is null or length(p_ciphertext) not between 16 and 65552 then
    raise exception 'that isn''t an encrypted credential (or it is over 64 KiB)' using errcode = '22023';
  end if;

  insert into public.links (vault_id, name, url, auth_header, created_by)
  values (p_vault, p_name, p_url, p_auth_header, private.uid())
  returning id into v_link;
  insert into private.link_secrets (link_id, key_id, nonce, ciphertext)
  values (v_link, p_key_id, p_nonce, p_ciphertext);
  perform private.log_link(p_vault, v_link, 'link.create', jsonb_build_object('name', p_name, 'url', p_url)
    || case when p_auth_header = 'Authorization' then '{}'::jsonb else jsonb_build_object('header', p_auth_header) end);
  return v_link;
end $$;

-- p_auth_header null keeps the link's header, so a caller that only renames
-- or re-urls a link doesn't reset it.
drop function public.update_link(uuid, text, text);
create function public.update_link(p_link uuid, p_name text, p_url text, p_auth_header text default null)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
  v_old_name text;
  v_old_url text;
  v_old_header text;
  v_header text;
begin
  perform private.require_human();
  select vault_id, name, url, auth_header into v_vault, v_old_name, v_old_url, v_old_header from public.links where id = p_link;
  if v_vault is null or private.role_in(v_vault) is distinct from 'owner' then
    raise exception 'only owners edit links' using errcode = '42501';
  end if;
  if p_name is null or p_name !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' then
    raise exception 'a link name is letters, digits and underscores, not starting with a digit, up to 64 characters'
      using errcode = '22023';
  end if;
  perform private.check_link_url(p_url);
  v_header := coalesce(p_auth_header, v_old_header);
  perform private.check_link_auth_header(v_header);
  if v_old_name = p_name and v_old_url = p_url and v_old_header = v_header then
    return;
  end if;
  update public.links set name = p_name, url = p_url, auth_header = v_header where id = p_link;
  perform private.log_link(v_vault, p_link, 'link.update',
    jsonb_build_object('name', p_name, 'url', p_url, 'previous_name', v_old_name, 'previous_url', v_old_url)
    || case when v_old_header = v_header then '{}'::jsonb
            else jsonb_build_object('header', v_header, 'previous_header', v_old_header) end);
end $$;

revoke all on function public.create_link(uuid, text, text, text, bytea, bytea, text),
  public.update_link(uuid, text, text, text) from public, anon;
grant execute on function public.create_link(uuid, text, text, text, bytea, bytea, text),
  public.update_link(uuid, text, text, text) to authenticated;

-- As in 20260928190000_link_proxy.sql, with the link's header returned
-- beside its url.
create or replace function public.begin_link_call(p_link uuid, p_tool_name text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
  v_url text;
  v_header text;
  v_role text;
  v_is_write boolean;
  v_enabled boolean;
  v_key_id text;
  v_nonce bytea;
  v_ciphertext bytea;
begin
  select l.vault_id, l.url, l.auth_header into v_vault, v_url, v_header from public.links l where l.id = p_link;
  if v_vault is null then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  v_role := private.role_in(v_vault);
  if v_role is null then
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

  return jsonb_build_object('ok', true, 'vault_id', v_vault, 'url', v_url, 'auth_header', v_header, 'key_id', v_key_id,
    'nonce', encode(v_nonce, 'base64'), 'ciphertext', encode(v_ciphertext, 'base64'));
end $$;
