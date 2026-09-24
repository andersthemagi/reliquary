-- The apps' login roles carry a statement timeout
-- (20260924210000_role_timeouts), so a runaway query can't hold a pooled
-- connection. The MCP suite checks the value a real login session gets.

select t.expect_true('timeout: reliquary_web has a 10s statement_timeout',
  exists (select 1 from pg_db_role_setting
           where setrole = 'reliquary_web'::regrole and setdatabase = 0
             and 'statement_timeout=10s' = any (setconfig)));
select t.expect_true('timeout: reliquary_mcp has a 10s statement_timeout',
  exists (select 1 from pg_db_role_setting
           where setrole = 'reliquary_mcp'::regrole and setdatabase = 0
             and 'statement_timeout=10s' = any (setconfig)));
