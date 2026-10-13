-- A column that could hold a secret is ciphertext or a hash (#236). The rule
-- otherwise lives in each table's own tests, which a table that doesn't exist
-- yet doesn't have: this reads the catalog, so a new column fails here first.

-- Shapes allowed on any table: a hash, or the one sealing scheme
-- (private.variable_secrets: key_id, nonce, ciphertext; checked below). The
-- rest are named one by one, each with why it holds no secret.
create temp table allowed (col text primary key, why text not null);
insert into allowed values
  ('private.oauth_codes.code_challenge', 'PKCE S256 challenge: a hash of the verifier'),
  ('private.rate_limits.key',            'keyed hash of an address, 64 hex characters'),
  ('private.env_readers.names_key',      'the variable names read, joined; names are not values'),
  ('public.work_plan_steps.key',         'a step''s slug in its plan'),
  ('public.env_access_log.token_id',     'id of an access_tokens row, not the token'),
  ('public.env_imports.token_id',        'id of an access_tokens row, not the token'),
  ('public.flag_watermarks.token_id',    'id of an access_tokens row, not the token'),
  ('public.path_claims.holder_token',    'id of an access_tokens row, not the token'),
  ('public.work_plan_steps.holder_token','id of an access_tokens row, not the token');

create temp view secret_named as
  select c.table_schema || '.' || c.table_name || '.' || c.column_name as col,
         c.table_schema, c.table_name, c.column_name, c.data_type
    from information_schema.columns c
    join information_schema.tables t using (table_schema, table_name)
   where c.table_schema in ('public', 'private') and t.table_type = 'BASE TABLE'
     and c.column_name ~* '(token|secret|key|password|credential|code|api)';

select t.expect('secret columns: every column named like a secret is a hash, sealed, or listed with why',
  (select coalesce(string_agg(col || ' ' || data_type, ', ' order by col), 'none')
     from secret_named s
    where not (s.column_name ~ '_hash$' and s.data_type = 'text')
      and not (s.column_name = 'key_id' and s.data_type = 'text'
               and exists (select 1 from information_schema.columns n
                            where (n.table_schema, n.table_name) = (s.table_schema, s.table_name)
                              and n.column_name = 'ciphertext'))
      and s.col not in (select col from allowed)),
  'none');

select t.expect('secret columns: no allowed column is gone or renamed, so the list stays true',
  (select coalesce(string_agg(col, ', ' order by col), 'none')
     from allowed where col not in (select col from secret_named)),
  'none');

-- Every sealed table carries variable_secrets' exact columns and checks, lives
-- in private, and is named by each function the rekey path
-- (web/src/rekey.ts) goes through, so rotating a key reseals it too.
create temp view sealed as
  select (c.table_schema || '.' || c.table_name)::regclass as tbl, c.table_schema, c.table_name
    from information_schema.columns c
   where c.table_schema in ('public', 'private') and c.column_name = 'ciphertext';

create function pg_temp.scheme(p regclass) returns text language sql as $$
  select (select string_agg(attname || ' ' || format_type(atttypid, atttypmod) || ' ' || attnotnull, ', ' order by attname)
            from pg_attribute where attrelid = p and attname in ('key_id', 'nonce', 'ciphertext') and not attisdropped)
      || ' | ' ||
         (select string_agg(pg_get_constraintdef(oid), ', ' order by pg_get_constraintdef(oid))
            from pg_constraint where conrelid = p and contype = 'c'
             and pg_get_constraintdef(oid) ~ '\m(key_id|nonce|ciphertext)\M')
$$;

select t.expect('secret columns: every ciphertext column is in private, sealed like variable_secrets',
  (select coalesce(string_agg(tbl::text, ', ' order by tbl::text), 'none')
     from sealed
    where table_schema <> 'private'
       or pg_temp.scheme(tbl) is distinct from pg_temp.scheme('private.variable_secrets')),
  'none');

select t.expect('secret columns: the rekey functions cover every sealed table',
  (select coalesce(string_agg(s.table_name || ' not in ' || f, ', ' order by s.table_name, f), 'none')
     from sealed s
     cross join unnest(array['sealed_rows', 'reseal', 'rekey_vaults', 'variable_key_ids']) f
    where not exists (select 1 from pg_proc p
                       where p.pronamespace = 'private'::regnamespace and p.proname = f
                         and p.prosrc ~ ('\mprivate\.' || s.table_name || '\M'))),
  'none');
