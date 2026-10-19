-- The parts of a Supabase database the migrations rely on, for running tests
-- on plain Postgres. Not a migration. Supabase provides these for real.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase installs extensions in their own schema.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
-- pgvector is not a trusted extension: hosted Supabase installs it for the
-- postgres role (supautils), so the stub does the same (its migration's
-- "if not exists" then skips it, as there).
create extension if not exists vector with schema extensions;
-- As in Supabase, the API roles may use what is in it (pgvector's type and
-- operators, for search: 20261017110000_semantic_search.sql).
grant usage on schema extensions to anon, authenticated, service_role;

-- Supabase grants the API roles everything on new objects in public by
-- default. Migrations must revoke what they don't intend to expose; these
-- defaults make the tests prove it.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- Supabase Auth's users table, as much of it as the migrations read (the
-- email, for members and invites). API roles get nothing on it, as in
-- Supabase. Tests insert the rows they need.
create schema if not exists auth;
create table if not exists auth.users (
  id    uuid primary key,
  email varchar(255)
);
-- When Auth confirmed the address (joining from the Inbox needs it,
-- 20260926140000_inbox_join.sql). Tests' accounts are confirmed unless a
-- test clears it; Supabase's own column has no default.
alter table auth.users add column if not exists email_confirmed_at timestamptz default now();
revoke all on schema auth from public;
revoke all on auth.users from public, anon, authenticated;

-- The migrations run as supabase_postgres, shaped like hosted Supabase's
-- postgres role: the database's owner, with createrole, createdb and
-- bypassrls, a member of the API roles, able to read and reference
-- auth.users, and not a superuser. v0.27.0's and v0.27.1's deploys failed
-- on statements only a superuser may run (a cast between built-in types; an
-- extension's setting in a function before the extension was loaded) that
-- had passed every suite as the container's superuser (#477). Extensions a
-- superuser must install are created above, as Supabase does for postgres.
-- schema.sh switches to this role for the migrations and back for the rest.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'supabase_postgres') then
    create role supabase_postgres nologin nosuperuser createdb createrole bypassrls;
  end if;
  execute format('alter database %I owner to supabase_postgres', current_database());
end $$;
grant anon, authenticated, service_role to supabase_postgres with admin option;
grant usage on schema auth to supabase_postgres;
grant all on auth.users to supabase_postgres;
grant usage, create on schema extensions to supabase_postgres;
alter default privileges for role supabase_postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role supabase_postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role supabase_postgres in schema public grant all on functions to anon, authenticated, service_role;
