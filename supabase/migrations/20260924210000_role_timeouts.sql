-- Statement timeouts for the two login roles the apps connect as.
--
-- Hosted, both apps reach Postgres through Supavisor in transaction mode with
-- small pools (docs/research/hosting.md, section 2). A runaway query would
-- hold one of a handful of pooled connections, so each role gets a ceiling.
-- A role setting applies when that role logs in; `set local role
-- authenticated` inside a transaction keeps the session's value.
--
-- Passwords are not set here: the owner sets them in the SQL editor.

alter role reliquary_web set statement_timeout = '10s';
alter role reliquary_mcp set statement_timeout = '10s';
