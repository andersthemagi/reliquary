-- A link's url is https://, a host and an optional path: no
-- user:password@, no ?query, no #fragment (docs/public/concepts/links.md).
--
-- The check was a prefix test ('^https://[^/?#]+' with no end anchor, in the
-- table and in create_link and update_link), so
-- https://user:TOKEN@host/mcp?key=SECRET passed. But a link's url is plain
-- text that every member and every agent reads (public.links' member_read
-- policy, list_links), and create_link and update_link copy it, and the one
-- it replaced, into the append-only log that changes_since hands to agents
-- and nothing may redact. A credential belongs in the link's sealed
-- credential (private.link_secrets), which is sent as a bearer token.
--
-- The table check is replaced NOT VALID: a link saved before this keeps its
-- url and keeps working (rewriting the url could break its calls, and the
-- log already holds it anyway); saving it again needs a url that passes.
-- create_link and update_link (as in 20260928120000_links, their only
-- definitions) check through private.check_link_url, which says which rule
-- a url broke.

create function private.check_link_url(p_url text) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_url is null or p_url !~ '^https://' then
    raise exception 'a link''s url must start with https://' using errcode = '22023';
  elsif length(p_url) > 2048 then
    raise exception 'a link''s url is at most 2048 characters' using errcode = '22023';
  elsif p_url ~ '^https://[^/?#]*@' then
    raise exception 'a link''s url can''t hold a user name or password (user:password@): every member and agent can read it, and it is logged. Put the key or token in the link''s credential'
      using errcode = '22023';
  elsif p_url ~ '[?#]' then
    raise exception 'a link''s url can''t have a query string (?) or a fragment (#): every member and agent can read it, and it is logged. Put a key or token in the link''s credential, and leave the rest out'
      using errcode = '22023';
  elsif p_url !~ '^https://[^/?#@]+(/[^?#]*)?$' then
    raise exception 'a link''s url is https://, a host and an optional path' using errcode = '22023';
  end if;
end $$;
revoke all on function private.check_link_url(text) from public, anon, authenticated;

alter table public.links drop constraint links_url_check;
alter table public.links add constraint links_url_check
  check (url ~ '^https://[^/?#@]+(/[^?#]*)?$' and length(url) <= 2048) not valid;

create or replace function public.create_link(p_vault uuid, p_name text, p_url text,
  p_key_id text, p_nonce bytea, p_ciphertext bytea)
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_link uuid;
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners add links' using errcode = '42501';
  end if;
  if p_name is null or p_name !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' then
    raise exception 'a link name is letters, digits and underscores, not starting with a digit, up to 64 characters'
      using errcode = '22023';
  end if;
  perform private.check_link_url(p_url);
  if p_key_id is null or p_key_id !~ '^[A-Za-z0-9_-]{1,32}$' or p_nonce is null or length(p_nonce) <> 12
     or p_ciphertext is null or length(p_ciphertext) not between 16 and 65552 then
    raise exception 'that isn''t an encrypted credential (or it is over 64 KiB)' using errcode = '22023';
  end if;

  insert into public.links (vault_id, name, url, created_by)
  values (p_vault, p_name, p_url, private.uid())
  returning id into v_link;
  insert into private.link_secrets (link_id, key_id, nonce, ciphertext)
  values (v_link, p_key_id, p_nonce, p_ciphertext);
  perform private.log_link(p_vault, v_link, 'link.create', jsonb_build_object('name', p_name, 'url', p_url));
  return v_link;
end $$;

create or replace function public.update_link(p_link uuid, p_name text, p_url text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_vault uuid;
  v_old_name text;
  v_old_url text;
begin
  perform private.require_human();
  select vault_id, name, url into v_vault, v_old_name, v_old_url from public.links where id = p_link;
  if v_vault is null or private.role_in(v_vault) is distinct from 'owner' then
    raise exception 'only owners edit links' using errcode = '42501';
  end if;
  if p_name is null or p_name !~ '^[A-Za-z_][A-Za-z0-9_]{0,63}$' then
    raise exception 'a link name is letters, digits and underscores, not starting with a digit, up to 64 characters'
      using errcode = '22023';
  end if;
  perform private.check_link_url(p_url);
  if v_old_name = p_name and v_old_url = p_url then
    return;
  end if;
  update public.links set name = p_name, url = p_url where id = p_link;
  perform private.log_link(v_vault, p_link, 'link.update',
    jsonb_build_object('name', p_name, 'url', p_url, 'previous_name', v_old_name, 'previous_url', v_old_url));
end $$;
