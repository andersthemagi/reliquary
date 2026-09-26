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
