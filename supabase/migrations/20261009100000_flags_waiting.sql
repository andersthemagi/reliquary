-- How many flags wait for the caller in a vault, for the MCP server's flags
-- hint (docs/design.md, "Notifications": flags don't ride in every
-- response, a one-line hint does). MCP has no push, so an agent that never
-- calls list_flags never learns a proposal waits on its person; the server
-- now counts after each successful tool call that names a vault and, when
-- the count isn't zero, adds one fixed line telling the agent to call
-- list_flags.
--
-- The count is list_flags' own answer, measured: who is flagged, from which
-- watermark, and who may ask are decided there and only there. A second
-- copy of those rules here would drift from it, and a change to
-- list_flags (a new category, say) would silently miss the hint; calling
-- it means the hint follows whatever list_flags becomes.
--
-- 21 is one past what the hint shows exactly: 21 means "more than 20".
-- Like list_flags, it moves no watermark: reading the hint uses nothing up.
-- Who may call it is list_flags' rule (the same refusals: an outsider and a
-- connection scoped elsewhere get P0002, a CLI sign-in 42501); anonymous
-- callers can't execute it at all.

create function public.flags_waiting(p_vault uuid)
returns int
language sql stable set search_path = '' as $$
  select jsonb_array_length(public.list_flags(p_vault, 21) -> 'flags')
$$;

revoke all on function public.flags_waiting(uuid) from public, anon;
grant execute on function public.flags_waiting(uuid) to authenticated;
