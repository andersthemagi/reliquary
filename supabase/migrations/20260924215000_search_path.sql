-- Pin search_path on the helpers that didn't set one (Supabase security
-- advisor 0011). None is security definer and all qualify their references,
-- so this changes no behaviour; it stops a caller's search_path from ever
-- mattering.

alter function private.uid() set search_path = '';
alter function private.agent() set search_path = '';
alter function private.token_id() set search_path = '';
alter function private.require_person() set search_path = '';
alter function private.require_human() set search_path = '';
alter function private.valid_path(text) set search_path = '';
alter function private.forbid_change() set search_path = '';
alter function private.versions_erase_only() set search_path = '';
alter function private.notes_erase_only() set search_path = '';
