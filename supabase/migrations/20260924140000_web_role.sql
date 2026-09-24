-- The web UI server's database role.
--
-- The web UI is where human-present actions happen (approving, policies), so
-- it runs calls as the signed-in person with NO `act` claim. Like the MCP
-- server, it logs in as its own role and becomes `authenticated` per request.
--
-- Until Supabase Auth is wired in, the local web server only ever acts as the
-- single local person configured at startup. When hosted, it will verify a
-- Supabase Auth session and take `sub` from it; this role stays the same.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'reliquary_web') then
    create role reliquary_web nologin noinherit;
  end if;
end $$;
grant authenticated to reliquary_web;
