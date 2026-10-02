-- Hostile tests for path claims (20260930200000_path_claims): the SQL
-- layer's own Accept criteria (a path already claimed is refused, naming
-- the holder; a stale fence or secret is refused; renew after expiry is
-- refused; no check-in extends a claim past the hold limit; expiry frees
-- the path) plus the access rules the migration introduces (who may
-- claim or break one, and the connection/person caps). The concurrent
-- "exactly one of N wins" property is proved with real parallel
-- connections in web/test/races.test.mjs, not here.

insert into t.ids select 'claims', t.run('ana', $q$select public.create_vault('Claims')$q$)::uuid;
select test_support.add_member(t.id('claims'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('claims'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.create_access_token('claims-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('claims')));
select t.run('ben', format($q$select public.create_access_token('ben-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('claims')));

-- The error message p_sql raises as p_user (NULL if it doesn't raise); for
-- checking a refusal names something t.expect's SQLSTATE-only result can't.
create function t.err(p_user text, p_sql text) returns text
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql;
  perform set_config('role', 'none', true);
  return null;
exception when others then
  perform set_config('role', 'none', true);
  return sqlstate || ' ' || sqlerrm;
end $$;

-- Small text store, the way t.ids stores uuids, for a claim's secret
-- (claim_path's other columns -- fence, expires_at -- are read back from
-- public.path_claims directly instead of round-tripping through text).
create table t.vals (name text primary key, val text);
create function t.save(p_name text, p_val text) returns text language sql as $$
  insert into t.vals values (p_name, p_val) on conflict (name) do update set val = excluded.val returning val
$$;
create function t.val(p_name text) returns text language sql as $$ select val from t.vals where name = p_name $$;

create function t.claim_sql(p_path text, p_label text default null, p_ttl int default null) returns text language sql as $$
  select format($q$select o_secret from public.claim_path(%L, %L, %L, %L)$q$, t.id('claims'), p_path, p_label, p_ttl)
$$;
create function t.row(p_path text) returns public.path_claims language sql as $$
  select * from public.path_claims where vault_id = t.id('claims') and path = p_path
$$;
create function t.renew_sql(p_path text, p_fence int, p_secret text, p_ttl int default null) returns text language sql as $$
  select format($q$select public.renew_claim(%L, %L, %L, %L, %L)::text$q$, t.id('claims'), p_path, p_fence, p_secret, p_ttl)
$$;
create function t.release_sql(p_path text, p_fence int, p_secret text) returns text language sql as $$
  select format($q$select public.release_claim(%L, %L, %L, %L)::text$q$, t.id('claims'), p_path, p_fence, p_secret)
$$;
create function t.break_sql(p_path text) returns text language sql as $$
  select format($q$select public.break_claim(%L, %L)::text$q$, t.id('claims'), p_path)
$$;
create function t.seed(p_path text) returns void language sql as $$
  select t.run('ben', format($q$select public.write_file(%L, %L, 'x')$q$, t.id('claims'), p_path))
$$;

-- ---------------------------------------------------------------------------
-- claim_path

select t.seed('notes/a.md');
select t.save('a', t.run('ben', t.claim_sql('notes/a.md', 'Ben''s agent')));
select t.expect_true('claim: an editor claims a free path, fence 1', t.val('a') ~ '^[0-9a-f]{64}$' and (t.row('notes/a.md')).fence = 1);
select t.expect_true('claim: the label is recorded', (t.row('notes/a.md')).holder_label = 'Ben''s agent');

select t.expect('claim: the same path is refused while held',
  t.run('ana', t.claim_sql('notes/a.md')), 'ERR RLC01');
select t.expect_true('claim: the refusal names the current holder''s label',
  t.err('ana', t.claim_sql('notes/a.md')) like '%RLC01%Ben''s agent%');

select t.expect('claim: a read-only connection is refused',
  t.run_tok('ana', 'claims-ro', t.claim_sql('notes/free.md')), 'ERR 42501');
select t.expect('claim: a viewer is refused',
  t.run('cal', t.claim_sql('notes/free.md')), 'ERR 42501');
select t.expect('claim: an outsider is refused',
  t.run('dee', t.claim_sql('notes/free.md')), 'ERR 42501');
select t.expect_true('claim: none of the refused attempts created a row',
  (t.row('notes/free.md')) is null);

-- Frees Ben's connection (cap 1) for the sections below.
select t.run('ben', t.release_sql('notes/a.md', (t.row('notes/a.md')).fence, t.val('a')));

-- ---------------------------------------------------------------------------
-- renew_claim

select t.seed('notes/b.md');
select t.save('b', t.run('ben', t.claim_sql('notes/b.md')));

select t.expect('renew: a stale fence is refused',
  t.run('ben', t.renew_sql('notes/b.md', 999, t.val('b'))), 'ERR RLC02');
select t.expect('renew: a stale secret is refused',
  t.run('ben', t.renew_sql('notes/b.md', (t.row('notes/b.md')).fence, 'wrong-secret')), 'ERR RLC02');
select t.expect('renew: a different connection (even the same person) is refused',
  t.run_tok('ben', 'ben-rw', t.renew_sql('notes/b.md', (t.row('notes/b.md')).fence, t.val('b'))), 'ERR RLC02');

select t.save('b-expires-before', (t.row('notes/b.md')).expires_at::text);
-- No ttl given (same default, 48h, as the original claim): a shorter one
-- would legitimately pull expires_at earlier, which isn't what this checks.
select t.run('ben', t.renew_sql('notes/b.md', (t.row('notes/b.md')).fence, t.val('b')));
select t.expect_true('renew: the right fence and secret extends the lease',
  (t.row('notes/b.md')).expires_at > t.val('b-expires-before')::timestamptz);

update public.path_claims set expires_at = now() - interval '1 second' where vault_id = t.id('claims') and path = 'notes/b.md';
select t.expect('renew: after expiry is refused',
  t.run('ben', t.renew_sql('notes/b.md', (t.row('notes/b.md')).fence, t.val('b'))), 'ERR RLC02');

-- ---------------------------------------------------------------------------
-- expiry frees the path (not release: nobody released this one)

select t.expect_true('expiry: a different caller claims the expired path, and the fence keeps counting up, not resetting',
  (select t.run('ana', t.claim_sql('notes/b.md'))) ~ '^[0-9a-f]{64}$' and (t.row('notes/b.md')).fence = 2);
-- Frees Ana's connection (cap 1) for the sections below.
select t.run('ana', t.break_sql('notes/b.md'));

-- ---------------------------------------------------------------------------
-- the hold limit: no amount of checking in extends a claim past it

select t.seed('notes/c.md');
select t.save('c', t.run('ben', t.claim_sql('notes/c.md')));
update public.path_claims set granted_at = now() - interval '6 days 23 hours' where vault_id = t.id('claims') and path = 'notes/c.md';
select t.save('c-granted', (t.row('notes/c.md')).granted_at::text);
select t.run('ben', t.renew_sql('notes/c.md', (t.row('notes/c.md')).fence, t.val('c'), 120));
select t.expect_true('hold limit: a renewal is capped at the original grant plus 7 days, not the full request',
  abs(extract(epoch from ((t.row('notes/c.md')).expires_at - (t.val('c-granted')::timestamptz + interval '7 days')))) < 1);

update public.path_claims set granted_at = now() - interval '8 days' where vault_id = t.id('claims') and path = 'notes/c.md';
select t.expect('hold limit: past it, a renewal is refused outright',
  t.run('ben', t.renew_sql('notes/c.md', (t.row('notes/c.md')).fence, t.val('c'), 120)), 'ERR RLC04');

-- notes/c.md's own lease hasn't naturally run out yet (only its hold
-- limit has); expire it directly so it stops counting against Ben's
-- connection cap for the sections below.
update public.path_claims set expires_at = now() - interval '1 second' where vault_id = t.id('claims') and path = 'notes/c.md';

-- ---------------------------------------------------------------------------
-- release_claim

select t.seed('notes/d.md');
select t.save('d', t.run('ben', t.claim_sql('notes/d.md')));
select t.expect('release: a stale fence is refused',
  t.run('ben', t.release_sql('notes/d.md', 999, t.val('d'))), 'ERR RLC02');
select t.expect('release: the right fence and secret frees it',
  t.run('ben', t.release_sql('notes/d.md', (t.row('notes/d.md')).fence, t.val('d'))), '');
select t.expect_true('release: the path is immediately claimable again, fence keeps counting up',
  (select t.run('ana', t.claim_sql('notes/d.md'))) ~ '^[0-9a-f]{64}$' and (t.row('notes/d.md')).fence = 2);
-- Frees Ana's connection (cap 1) for the section below.
select t.run('ana', t.break_sql('notes/d.md'));

-- ---------------------------------------------------------------------------
-- break_claim: a person only, whoever can write the path

select t.seed('notes/e.md');
select t.save('e', t.run('ben', t.claim_sql('notes/e.md')));
select t.expect('break: no active claim is refused',
  t.run('ana', t.break_sql('notes/free2.md')), 'ERR P0002');
select t.expect('break: an agent cannot break a claim',
  t.run('ana', t.break_sql('notes/e.md'), 'Claude Code'), 'ERR 42501');
select t.expect('break: a viewer cannot break a claim',
  t.run('cal', t.break_sql('notes/e.md')), 'ERR 42501');
select t.expect('break: an owner, in person, breaks it',
  t.run('ana', t.break_sql('notes/e.md')), '');
select t.expect_true('break: the path is immediately claimable again',
  (select t.run('ana', t.claim_sql('notes/e.md'))) ~ '^[0-9a-f]{64}$');

-- ---------------------------------------------------------------------------
-- connection and person caps, on a vault of their own so earlier claims
-- above never count toward them

insert into t.ids select 'caps', t.run('ana', $q$select public.create_vault('Claim caps')$q$)::uuid;
select test_support.add_member(t.id('caps'), t.id('ben'), 'editor', t.id('ana'));
create function t.caps_claim_sql(p_path text) returns text language sql as $$
  select format($q$select o_secret from public.claim_path(%L, %L)$q$, t.id('caps'), p_path)
$$;
select t.run('ben', format($q$select public.write_file(%L, %L, 'x')$q$, t.id('caps'), p))
  from unnest(array['notes/1.md', 'notes/2.md', 'notes/3.md', 'notes/4.md', 'notes/5.md', 'notes/6.md']) p;

select t.expect_true('caps: a connection''s first claim succeeds',
  (select t.run('ben', t.caps_claim_sql('notes/1.md'))) ~ '^[0-9a-f]{64}$');
select t.expect('caps: the same connection is refused a second claim',
  t.run('ben', t.caps_claim_sql('notes/2.md')), 'ERR RLC03');

select t.run('ben', format($q$select public.create_access_token(%L, 30, array[%L]::uuid[], 'write')$q$, tok, t.id('caps')))
  from (values ('caps-2'), ('caps-3'), ('caps-4'), ('caps-5')) as v(tok);
select t.expect_true('caps: four more connections of the same person reach the person cap of 5',
  (select bool_and(t.run_tok('ben', tok, t.caps_claim_sql(path)) ~ '^[0-9a-f]{64}$')
     from (values ('caps-2', 'notes/2.md'), ('caps-3', 'notes/3.md'), ('caps-4', 'notes/4.md'), ('caps-5', 'notes/5.md')) as v(tok, path)));

select t.run('ben', format($q$select public.create_access_token('caps-6', 30, array[%L]::uuid[], 'write')$q$, t.id('caps')));
select t.expect('caps: a sixth connection of the same person is refused by the person cap, not the connection cap',
  t.run_tok('ben', 'caps-6', t.caps_claim_sql('notes/6.md')), 'ERR RLC03');

-- ---------------------------------------------------------------------------
-- release_claim: the same identity check renew_claim already has, untested
-- until now (a different connection of the same person must not release)

select t.seed('notes/g.md');
select t.save('g', t.run('ben', t.claim_sql('notes/g.md')));
select t.expect('release: a different connection (even the same person) is refused',
  t.run_tok('ben', 'ben-rw', t.release_sql('notes/g.md', (t.row('notes/g.md')).fence, t.val('g'))), 'ERR RLC02');
select t.run('ben', t.release_sql('notes/g.md', (t.row('notes/g.md')).fence, t.val('g')));

-- ---------------------------------------------------------------------------
-- label limits: length-capped, and left no row behind when refused

select t.seed('notes/h.md');
select t.expect('claim: a label over 200 characters is refused',
  t.run('ben', t.claim_sql('notes/h.md', repeat('x', 201))), 'ERR 22023');
select t.expect_true('claim: the refused label left no row behind',
  (t.row('notes/h.md')) is null);
select t.expect_true('claim: exactly 200 characters is accepted',
  (t.run('ben', t.claim_sql('notes/h.md', repeat('x', 200)))) ~ '^[0-9a-f]{64}$');

-- A NUL byte can't be tested through claim_path's own validation: Postgres
-- refuses to hold one in any text value at all (SQLSTATE 22021, "invalid
-- byte sequence"), before the function body ever runs -- the same reason
-- the MCP layer, not SQL, is where feedback's message and context fields
-- check for one (mcp/src/flags-tools.ts). This pins that guarantee against
-- the column claim labels actually live in (as the table owner, bypassing
-- the grants above, so the privilege check doesn't hide it), rather than
-- against a string Postgres would never let us construct in the first place.
select t.owner_error('claim: a label can never hold a NUL byte, independent of any check here',
  $q$insert into public.path_claims (vault_id, path, holder_label)
    values ('00000000-0000-0000-0000-000000000000', 'nul-test.md', convert_from('\x610062'::bytea, 'UTF8'))$q$);

-- ---------------------------------------------------------------------------
-- the table itself: closed to direct writes, two columns never selectable,
-- and invisible outside the vault (RLS, not app-level filtering)

select t.expect('tables: no direct insert into path_claims',
  t.run('ben', format($q$insert into public.path_claims (vault_id, path, holder) values (%L, 'direct.md', %L) returning 'x'$q$,
    t.id('claims'), t.id('ben'))), 'ERR 42501');
select t.expect('tables: no direct insert into path_claims, even for an agent',
  t.run('ben', format($q$insert into public.path_claims (vault_id, path, holder) values (%L, 'direct2.md', %L) returning 'x'$q$,
    t.id('claims'), t.id('ben')), 'Claude Code'), 'ERR 42501');
select t.expect('tables: no direct update of a claim',
  t.run('ben', format($q$update public.path_claims set expires_at = now() + interval '1 day' where vault_id = %L and path = 'notes/e.md' returning 'x'$q$,
    t.id('claims'))), 'ERR 42501');
select t.expect('tables: no direct delete of a claim',
  t.run('ben', format($q$delete from public.path_claims where vault_id = %L and path = 'notes/e.md' returning 'x'$q$,
    t.id('claims'))), 'ERR 42501');
select t.expect('tables: the secret hash is not a selectable column, even to the holder',
  t.run('ben', format($q$select secret_hash from public.path_claims where vault_id = %L and path = 'notes/e.md'$q$, t.id('claims'))),
  'ERR 42501');
select t.expect('tables: the holder token is not a selectable column, even to the holder',
  t.run('ben', format($q$select holder_token::text from public.path_claims where vault_id = %L and path = 'notes/e.md'$q$, t.id('claims'))),
  'ERR 42501');

select t.expect('rls: an outsider sees no claims in a vault they are not in',
  t.run('dee', format($q$select count(*)::text from public.path_claims where vault_id = %L$q$, t.id('claims'))), '0');
select t.expect('rls: a connection scoped to another vault sees no claims here either',
  t.run_tok('ben', 'caps-6', format($q$select count(*)::text from public.path_claims where vault_id = %L$q$, t.id('claims'))), '0');
