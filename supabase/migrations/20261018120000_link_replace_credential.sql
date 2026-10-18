-- Replace a link's credential, or rediscover its tools, without deleting the
-- link (issue #439). Until now the only way to rotate a key, or to pick up
-- tools an upstream added, was delete and re-add: that wiped every grant and
-- split the link's call history across two ids. This answers design.md's
-- last open question about links ("does a compromised upstream credential
-- need same-day replacement without deleting and re-adding the link?"): yes.
--
-- Both are an owner's, in person (require_human), the same ceiling as every
-- other link management function (20260928120000_links.sql): no agent, no
-- token, no editor or viewer.
--
-- - replace_link_credential takes an already-sealed credential, exactly as
--   create_link does; Postgres never sees a plaintext one. The link keeps
--   its id, name, url, tools and grants. Logged as link.credential with the
--   link's name only, never the ciphertext, its key id or its nonce.
-- - link_credential_for_discovery hands the web app the stored credential,
--   still sealed, with its vault and url, so "Refresh tools" can open it
--   server-side and run discovery again. The same sealed shape
--   begin_link_call (20260928190000_link_proxy.sql) already returns to any
--   member granted a tool; this one is narrower (owners, in person). The
--   rediscovered tools go through set_link_tools as before, which already
--   keeps an owner's grant choices, seeds defaults for new tools only and
--   removes tools the upstream no longer lists.

create function public.replace_link_credential(p_link uuid, p_key_id text, p_nonce bytea, p_ciphertext bytea)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
  v_name text;
begin
  perform private.require_human();
  select vault_id, name into v_vault, v_name from public.links where id = p_link;
  if v_vault is null or private.role_in(v_vault) is distinct from 'owner' then
    raise exception 'only owners replace a link''s credential' using errcode = '42501';
  end if;
  if p_key_id is null or p_key_id !~ '^[A-Za-z0-9_-]{1,32}$' or p_nonce is null or length(p_nonce) <> 12
     or p_ciphertext is null or length(p_ciphertext) not between 16 and 65552 then
    raise exception 'that isn''t an encrypted credential (or it is over 64 KiB)' using errcode = '22023';
  end if;
  insert into private.link_secrets (link_id, key_id, nonce, ciphertext)
  values (p_link, p_key_id, p_nonce, p_ciphertext)
  on conflict (link_id) do update
    set key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext;
  perform private.log_link(v_vault, p_link, 'link.credential', jsonb_build_object('name', v_name));
end $$;

create function public.link_credential_for_discovery(p_link uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_vault uuid;
  v_url text;
  v_key_id text;
  v_nonce bytea;
  v_ciphertext bytea;
begin
  perform private.require_human();
  select vault_id, url into v_vault, v_url from public.links where id = p_link;
  if v_vault is null or private.role_in(v_vault) is distinct from 'owner' then
    raise exception 'only owners refresh a link''s tools' using errcode = '42501';
  end if;
  select s.key_id, s.nonce, s.ciphertext into v_key_id, v_nonce, v_ciphertext
    from private.link_secrets s where s.link_id = p_link;
  if v_key_id is null then
    raise exception 'this link has no stored credential; replace it first' using errcode = 'P0002';
  end if;
  return jsonb_build_object('vault_id', v_vault, 'url', v_url, 'key_id', v_key_id,
    'nonce', encode(v_nonce, 'base64'), 'ciphertext', encode(v_ciphertext, 'base64'));
end $$;

revoke all on function public.replace_link_credential(uuid, text, bytea, bytea),
  public.link_credential_for_discovery(uuid) from public, anon;
grant execute on function public.replace_link_credential(uuid, text, bytea, bytea),
  public.link_credential_for_discovery(uuid) to authenticated;
