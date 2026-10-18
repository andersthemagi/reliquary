-- A proxied call's size (issue #440; docs/design.md, "Links": "every
-- proxied call is logged: who, which agent, which tool, the outcome and
-- size"). 20260928120000_links.sql's link_calls had the hashes but no
-- size, so a link's Calls page had nothing to show for it.
--
-- result_bytes is the length in bytes of what the upstream answered (the
-- JSON of its content, the same value result_hash is taken over), never the
-- answer itself. Null for a call with no answer: a refusal, a network
-- failure, and every row written before this migration.
--
-- record_link_call and log_link_call gain a trailing, defaulted parameter,
-- so their existing callers (mcp/ with five arguments, begin_link_call with
-- four) resolve to the new functions unchanged. Dropped and created rather
-- than replaced, since create or replace can't add a parameter; the
-- bodies are 20260928190000_link_proxy.sql's, plus the size.

alter table public.link_calls add column result_bytes integer check (result_bytes >= 0);

drop function private.log_link_call(uuid, uuid, text, text, text, text);
create function private.log_link_call(p_vault uuid, p_link uuid, p_tool_name text, p_outcome text,
  p_arg_hash text default null, p_result_hash text default null, p_result_bytes integer default null)
returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.link_calls (link_id, vault_id, actor, agent, tool_name, outcome, arg_hash, result_hash, result_bytes)
  values (p_link, p_vault, private.uid(), private.agent(), p_tool_name, p_outcome, p_arg_hash, p_result_hash, p_result_bytes)
$$;
revoke all on function private.log_link_call(uuid, uuid, text, text, text, text, integer) from public, anon, authenticated;

drop function public.record_link_call(uuid, text, text, text, text);
create function public.record_link_call(p_link uuid, p_tool_name text, p_outcome text,
  p_arg_hash text default null, p_result_hash text default null, p_result_bytes integer default null)
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
  if p_result_bytes < 0 then
    raise exception 'a recorded call''s size is a number of bytes, 0 or more' using errcode = '22023';
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
  perform private.log_link_call(v_vault, p_link, p_tool_name, p_outcome, p_arg_hash, p_result_hash, p_result_bytes);
end $$;
revoke all on function public.record_link_call(uuid, text, text, text, text, integer) from public, anon;
grant execute on function public.record_link_call(uuid, text, text, text, text, integer) to authenticated;
