-- Shared test harness. Included at the top of every *_test.sql.
-- Users: ana, ben, cal, dee (fixed synthetic UUIDs).

\set ON_ERROR_STOP on

drop schema if exists t cascade;
create schema t;
create table t.results (name text, ok boolean, detail text);
create table t.ids (name text primary key, id uuid);

-- Users: Ana owner, Ben editor, Cal viewer, Dee outsider.
insert into t.ids values
  ('ana', '00000000-0000-0000-0000-00000000000a'),
  ('ben', '00000000-0000-0000-0000-00000000000b'),
  ('cal', '00000000-0000-0000-0000-00000000000c'),
  ('dee', '00000000-0000-0000-0000-00000000000d');

create function t.id(p text) returns uuid language sql as
$$ select id from t.ids where name = p $$;

-- Run p_sql as the API role for p_user (or anonymous if NULL), optionally as
-- their agent. Returns the first column of the first row as text, or
-- 'ERR <sqlstate>' if it raised.
create function t.run(p_user text, p_sql text, p_agent text default null) returns text
language plpgsql as $$
declare
  v text;
  claims jsonb := '{}';
begin
  if p_user is not null then
    claims := jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated');
  end if;
  if p_agent is not null then
    claims := claims || jsonb_build_object('act', jsonb_build_object('sub', 'agent-1', 'name', p_agent));
  end if;
  perform set_config('request.jwt.claims', claims::text, true);
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
exception when others then
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return 'ERR ' || sqlstate;
end $$;

-- Same, with raw claims.
create function t.run_claims(p_claims jsonb, p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  perform set_config('request.jwt.claims', p_claims::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return v;
exception when others then
  perform set_config('role', 'none', true);
  return 'ERR ' || sqlstate;
end $$;

-- Run p_sql as a database role with no claims (e.g. the MCP server's role).
create function t.run_role(p_role text, p_sql text) returns text
language plpgsql as $$
declare v text;
begin
  perform set_config('role', p_role, true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return v;
exception when others then
  perform set_config('role', 'none', true);
  return 'ERR ' || sqlstate;
end $$;

-- Look up an access token's id by name.
create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;

-- Run p_sql acting through a token, the way the MCP server does.
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;

create function t.expect(p_name text, p_got text, p_want text) returns void
language sql as $$
  insert into t.results values (p_name, p_got is not distinct from p_want,
    format('got %s want %s', coalesce(p_got, 'NULL'), coalesce(p_want, 'NULL')))
$$;

create function t.expect_ok(p_name text, p_got text) returns void
language sql as $$
  insert into t.results values (p_name, p_got is not null and p_got not like 'ERR %',
    format('got %s', coalesce(p_got, 'NULL')))
$$;

create function t.expect_true(p_name text, p_ok boolean, p_detail text default '')
returns void language sql as $$
  insert into t.results values (p_name, coalesce(p_ok, false), p_detail)
$$;

-- Runs p_sql as the table owner and records ok if it raises.
create function t.owner_error(p_name text, p_sql text) returns void
language plpgsql as $$
begin
  execute p_sql;
  insert into t.results values (p_name, false, 'no error raised');
exception when others then
  insert into t.results values (p_name, true, sqlerrm);
end $$;

-- SHA-256 hex, for hashing tokens and other values the same way the server
-- stores them.
create function t.sha(p text) returns text language sql as
$$ select encode(extensions.digest(p, 'sha256'), 'hex') $$;

-- PKCE's S256 code challenge from a verifier (base64url, no padding).
create function t.s256(p text) returns text language sql as
$$ select translate(rtrim(encode(extensions.digest(p, 'sha256'), 'base64'), '='), '+/', '-_') $$;

