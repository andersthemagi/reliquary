-- The parts of a Supabase database that Reliquary's migrations and Supabase
-- Auth rely on, for a self-hosted plain Postgres (17). Supabase's own image
-- provides these; here deploy/bin/db-init.sh applies this file before Auth
-- starts, on every start (it is idempotent).
--
-- The same ideas as supabase/tests/stub.sql, but for real:
--  - the API roles (anon, authenticated, service_role), never able to log
--    in: the web app and the MCP server log in as reliquary_web and
--    reliquary_mcp (created by the migrations) and become `authenticated`
--    per transaction;
--  - supabase_auth_admin, the role Supabase Auth logs in as, owning the
--    `auth` schema, where Auth creates its own tables (auth.users) when it
--    starts. Its password is set by db-init.sh from AUTH_DB_PASSWORD;
--  - pgcrypto in `extensions`, and Supabase's default privileges on
--    `public`, which the migrations were written (and are tested) against:
--    they revoke whatever they don't mean to expose.
-- No password or secret is in this file.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit createrole;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;
create extension if not exists pgcrypto with schema extensions;

alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- Supabase Auth's schema: its own, created here so it can run its
-- migrations without being a superuser.
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to postgres;
alter role supabase_auth_admin set search_path = auth;
alter role supabase_auth_admin set idle_in_transaction_session_timeout = '60s';
revoke all on schema auth from public;
