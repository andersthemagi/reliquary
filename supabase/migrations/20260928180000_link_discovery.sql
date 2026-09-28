-- Discovery for links (milestone 3, docs/design.md's "Links" implementation
-- plan): public.set_link_tools replaces a link's discovered tools with what
-- the web app's discovery call (web/src/discovery.ts) just found, called in
-- the same request as create_link, right after it succeeds. Owners, in
-- person, same ceiling as every other link management function
-- (20260928120000_links.sql) -- discovery itself never runs as an agent or
-- through a token, so this only ever runs alongside a person's own add-link
-- submission.
--
-- Read tools default enabled for owner and editor at discovery time
-- (design.md: "Read tools default enabled for editor and owner ... Write
-- tools default disabled until an owner enables them, per role"); viewers
-- get no seeded grant, matching "viewers don't call links directly" in the
-- access table. A grant an owner has already set for a tool that's
-- discovered again is left alone (only a newly-seen tool gets a seeded
-- default) -- an owner's own choice outlives a later discovery.
--
-- A tool no longer discovered is removed from link_tools; its grants, if
-- any, are left in place rather than deleted (inert, the same way a grant
-- for a tool not yet discovered already sits inert per the original
-- migration's comment -- if the tool reappears later, the owner's earlier
-- choice for it still applies rather than resetting to a default).
--
-- There is no rediscovery yet (web/src/discovery.ts's own header), so in
-- practice this runs exactly once per link today; it is still written to
-- be safe to call again once that changes -- add/update/remove, not
-- replace-and-hope, and a call that finds no change logs nothing, matching
-- update_link's "the same name and url again logs nothing".

create function public.set_link_tools(p_link uuid, p_tools jsonb)
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
  ) then
    raise exception 'a discovered tool needs a name (1 to 200 characters) and, if given, a boolean is_write' using errcode = '22023';
  end if;

  -- Gone from the latest discovery: remove from link_tools; grants for it
  -- stay (see above).
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
  -- link_tools as it stands before the upsert below touches it, an
  -- ordinary anti-join rather than sniffing INSERT vs. UPDATE off the
  -- upsert's own system columns (xmax is 0 for both paths' returned row
  -- version within one command, so it can't tell them apart here).
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

  -- Add or refresh. On conflict, only the description is refreshed: is_write
  -- is discovery's first guess only, an owner's later flip (not built yet,
  -- but the schema already allows it: 20260928120000_links.sql) is never
  -- overwritten by a later discovery run.
  with incoming as (
    select t->>'name' as tool_name,
           coalesce((t->>'is_write')::boolean, true) as is_write,
           nullif(left(t->>'description', 1000), '') as description
      from jsonb_array_elements(p_tools) t
  )
  insert into public.link_tools (link_id, vault_id, tool_name, is_write, description)
  select p_link, v_vault, tool_name, is_write, description from incoming
  on conflict (link_id, tool_name) do update
    set description = excluded.description;

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

revoke all on function public.set_link_tools(uuid, jsonb) from public, anon;
grant execute on function public.set_link_tools(uuid, jsonb) to authenticated;
