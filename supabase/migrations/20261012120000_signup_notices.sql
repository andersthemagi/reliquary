-- Signup notices: the operator is emailed once when an account confirms
-- its address (web/src/signups.ts; supabase/tests/signup_notices_test.sql).
--
-- The same shape as feedback notices (20260926163000_feedback.sql, 4): the
-- web app claims accounts not yet notified, emails the operator, and marks
-- them notified. A claim lapses after 10 minutes, at most 5 tries, and only
-- for addresses confirmed in the last 7 days. Only the web app's role may
-- claim. A row exists per account from its first claim on; accounts that
-- existed when this shipped are recorded as notified, so nobody already in
-- is emailed. Deleting an account (public.delete_account deletes its
-- auth.users row) deletes its row.

create table private.signup_notices (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  notified_at timestamptz,
  claimed_at  timestamptz,
  attempts    int not null default 0 check (attempts between 0 and 5)
);
alter table private.signup_notices enable row level security;
revoke all on private.signup_notices
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;

insert into private.signup_notices (user_id, notified_at) select id, now() from auth.users;

-- Up to p_limit accounts to email the operator about, claimed for 10
-- minutes, with where each stands: its admission (via), else its place in
-- line, how many wait and the pace, and whether invite-only is on.
create function private.claim_signup_notices(p_limit int)
returns table (user_id uuid, email text, confirmed_at timestamptz, via text, place bigint, waiting bigint,
               open_per_day int, invite_only boolean)
language plpgsql volatile security definer set search_path = '' as $$
#variable_conflict use_column
begin
  insert into private.signup_notices (user_id)
  select u.id from auth.users u
   where u.email_confirmed_at > now() - interval '7 days'
  on conflict do nothing;
  return query
    with c as (
      select n.user_id from private.signup_notices n join auth.users u on u.id = n.user_id
       where n.notified_at is null and n.attempts < 5
         and u.email_confirmed_at > now() - interval '7 days'
         and (n.claimed_at is null or n.claimed_at < now() - interval '10 minutes')
       order by u.email_confirmed_at
       limit greatest(1, least(coalesce(p_limit, 5), 20))
       for update of n skip locked
    ), up as (
      update private.signup_notices n set claimed_at = now(), attempts = n.attempts + 1
        from c where n.user_id = c.user_id
      returning n.user_id
    )
    select u.id, u.email::text, u.email_confirmed_at, a.via, l.place,
           (select count(*) from private.line()), s.open_per_day, s.invite_only
      from up join auth.users u on u.id = up.user_id
      left join private.admissions a on a.user_id = u.id
      left join private.line() l on l.user_id = u.id
      cross join private.settings s
     order by u.email_confirmed_at;
end $$;

create function private.signup_notified(p_user uuid) returns void
language sql volatile security definer set search_path = '' as $$
  update private.signup_notices set notified_at = now() where user_id = p_user and notified_at is null
$$;

revoke all on function private.claim_signup_notices(int), private.signup_notified(uuid)
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
grant execute on function private.claim_signup_notices(int), private.signup_notified(uuid) to reliquary_web;
