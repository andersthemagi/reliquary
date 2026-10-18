-- Terms acceptances: which version of the Terms and Privacy Policy each
-- account accepted, and when (#450; supabase/tests/terms_acceptances_test.sql).
--
-- The hosted sign-in form won't send a code without its agreement box
-- ticked (web/src/signin.ts), so a completed sign-in there is an
-- acceptance; the web app records it after verifying the new session's
-- token, the same way it records signup notices
-- (20261012120000_signup_notices.sql): only its role may, with the account
-- id it verified. A version is the terms' last-updated date; each account
-- keeps the first time it accepted each one. An id with no account (one
-- deleted since its token was issued) records nothing instead of failing
-- the sign-in. Deleting an account
-- (public.delete_account deletes its auth.users row) deletes its rows.

create table private.terms_acceptances (
  user_id     uuid not null references auth.users (id) on delete cascade,
  terms_date  date not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, terms_date)
);
alter table private.terms_acceptances enable row level security;
revoke all on private.terms_acceptances
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;

create function private.record_terms_acceptance(p_user uuid, p_terms date) returns void
language sql volatile security definer set search_path = '' as $$
  insert into private.terms_acceptances (user_id, terms_date)
  select p_user, p_terms where exists (select 1 from auth.users where id = p_user)
  on conflict do nothing
$$;

revoke all on function private.record_terms_acceptance(uuid, date)
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
grant execute on function private.record_terms_acceptance(uuid, date) to reliquary_web;
