-- Emails are compared in Unicode NFC, lower-cased: an address typed in
-- one form (é as one character) and stored by Auth in another (e and a
-- combining accent) is the same address, for invites, members and the
-- operator's lookups
-- (supabase/tests/admission_test.sql, "emails:").

-- An address as Reliquary compares it: trimmed, Unicode NFC, lower-cased.
create function private.email_key(p_email text) returns text
language sql immutable set search_path = '' as $$
  select lower(normalize(trim(p_email), nfc))
$$;

create or replace function private.email_of(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select private.email_key(u.email::text) from auth.users u where u.id = p_user
$$;

create or replace function private.user_by_email(p_email text) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare
  v uuid[];
begin
  select array_agg(u.id) into v from auth.users u
   where private.email_key(u.email::text) = private.email_key(coalesce(p_email, ''));
  if v is null then
    raise exception 'no account with that email' using errcode = 'P0002';
  end if;
  if cardinality(v) > 1 then
    raise exception 'more than one account has that email; use its id' using errcode = '21000';
  end if;
  return v[1];
end $$;

-- Invites already made keep matching: their address in the same form.
update private.vault_invites set email = private.email_key(email)
 where email is distinct from private.email_key(email);

-- As in 20260925230000_plans, with the address in one form.
create or replace function public.create_invite(p_vault uuid, p_email text, p_role text)
returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_token text := 'rli_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_email text := private.email_key(coalesce(p_email, ''));
  v_id uuid;
  v_old uuid;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners invite people' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('owner', 'editor', 'viewer') then
    raise exception 'a role is owner, editor or viewer' using errcode = '22023';
  end if;
  if length(v_email) > 254
     or v_email !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$' then
    raise exception 'enter an email address, like name@example.com' using errcode = '22023';
  end if;
  perform 1 from public.vaults where id = p_vault for update;
  -- One person's invites, counted one call at a time, whichever vault.
  perform pg_advisory_xact_lock(hashtextextended('reliquary.invite_rate:' || private.uid()::text, 0));
  if (select count(*) from private.vault_invites
       where created_by = private.uid() and created_at > now() - interval '1 hour') >= private.invite_rate() then
    raise exception 'you have created % invites in the last hour: try again later', private.invite_rate()
      using errcode = '54000';
  end if;
  if exists (select 1 from public.vault_members m
              where m.vault_id = p_vault and private.email_of(m.user_id) = v_email) then
    raise exception 'that address already belongs to a member of this vault' using errcode = '23505';
  end if;
  for v_old in
    update private.vault_invites set revoked_at = now(), revoked_by = private.uid()
     where vault_id = p_vault and email = v_email
       and private.invite_state(accepted_at, revoked_at, expires_at) = 'pending'
    returning id
  loop
    perform private.log_event(p_vault, 'invite.revoke', null, null, null,
      jsonb_build_object('invite', v_old, 'replaced', true));
  end loop;
  if (select count(*) from private.vault_invites
       where vault_id = p_vault and private.invite_state(accepted_at, revoked_at, expires_at) = 'pending')
     >= private.invite_cap() then
    raise exception 'this vault has % invites waiting: revoke some first', private.invite_cap() using errcode = '54000';
  end if;
  perform private.require_people_room(p_vault, true);
  insert into private.vault_invites (vault_id, email, role, token_hash, created_by, expires_at)
  values (p_vault, v_email, p_role, private.token_hash(v_token), private.uid(), now() + interval '7 days')
  returning id into v_id;
  perform private.log_event(p_vault, 'invite.create', null, null, null,
    jsonb_build_object('invite', v_id, 'role', p_role));
  return v_token;
end $$;

revoke all on function private.email_key(text)
  from public, anon, authenticated, reliquary_web, reliquary_mcp, reliquary_ops;
