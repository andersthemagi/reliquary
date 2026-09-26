-- Sign out everywhere (web/src/settings.ts; hostile tests in
-- supabase/tests/sign_out_everywhere_test.sql).
--
-- A browser session is a Supabase Auth session: a refresh token, and an
-- access JWT the web app verifies on its own, without asking Auth, until it
-- expires (at most an hour). Supabase's global logout revokes every refresh
-- token of the account, so no browser can renew; this file ends the JWTs
-- already handed out, at once, instead of within the hour:
--
-- 1. private.session_cutoffs holds, per account, the moment the person
--    signed out everywhere. No API role reads or writes it.
-- 2. private.check_session(), which the web app runs at the start of every
--    transaction it opens as a person (web/src/db.ts, in the same round trip
--    as the claims), refuses a session whose JWT was issued (its `iat`, which
--    the web app now passes with `sub` and `role`) before that moment, with
--    SQLSTATE RLA01. The web app then clears the session's cookies and sends
--    the browser to sign in. A session without an `iat` (the local sign-in
--    stand-in, which keeps its sessions in memory and ends them itself) is
--    not checked here.
-- 3. public.end_my_sessions(p_revoke_connections) sets the moment, for the
--    person in person only: an agent, a token, an OAuth client or a CLI grant
--    is refused (it would sign its person out of their own browser, which is
--    account management, behind the ceiling like managing members). With
--    p_revoke_connections it also revokes every connection of the account
--    that is still live (personal tokens, connected apps and CLI sign-ins),
--    as Revoke on the Connections page does one at a time. Without it,
--    connections are untouched: they are not browser sessions.
--
-- Nothing is logged: the log is per vault and read by every member, and
-- signing out is the account's business, not a vault's.

create table private.session_cutoffs (
  user_id    uuid primary key,
  not_before timestamptz not null
);
alter table private.session_cutoffs enable row level security;
revoke all on private.session_cutoffs
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;

-- Refuses the transaction's session if it began before its person last
-- signed out everywhere. Called by the web app as `authenticated`.
create function private.check_session() returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_iat numeric;
begin
  if v_claims is null or v_claims ->> 'sub' is null then
    return;
  end if;
  if jsonb_typeof(v_claims -> 'iat') = 'number' then
    v_iat := (v_claims ->> 'iat')::numeric;
    if exists (select 1 from private.session_cutoffs c
                where c.user_id = (v_claims ->> 'sub')::uuid
                  and to_timestamp(v_iat) < c.not_before) then
      raise exception 'this session was signed out: you (or someone signed in as you) chose Sign out everywhere after it began. Sign in again'
        using errcode = 'RLA01';
    end if;
  end if;
end $$;

-- Ends every browser session of the caller's account that began before
-- now, and with p_revoke_connections revokes its live connections too.
-- Returns how many connections were revoked.
create function public.end_my_sessions(p_revoke_connections boolean default false)
returns int
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n int := 0;
begin
  perform private.require_human();
  if private.token_kind() is not null then
    raise exception 'only you, signed in to the web app, can sign out everywhere' using errcode = '42501';
  end if;
  insert into private.session_cutoffs (user_id, not_before) values (private.uid(), now())
  on conflict (user_id) do update set not_before = greatest(private.session_cutoffs.not_before, excluded.not_before);
  if coalesce(p_revoke_connections, false) then
    with gone as (
      update public.access_tokens set revoked_at = now()
       where user_id = private.uid() and revoked_at is null
         and (expires_at is null or expires_at > now())
      returning 1
    )
    select count(*) into v_n from gone;
  end if;
  return v_n;
end $$;

revoke all on function private.check_session(), public.end_my_sessions(boolean) from public, anon;
grant execute on function private.check_session(), public.end_my_sessions(boolean) to authenticated;
