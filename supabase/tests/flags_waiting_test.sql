-- Tests for public.flags_waiting (20261009100000_flags_waiting.sql), the
-- count behind the MCP server's flags hint. It is list_flags' answer
-- measured, so who is flagged is supabase/tests/flags_test.sql's job; this
-- file proves the count matches it, stops at 21, moves no watermark, keeps
-- to the vault asked about, and refuses whoever list_flags refuses.
-- Connections are simulated the way private.mcp_begin sets claims.
--
-- Team: Ana owns, Ben edits, Cal views; canon/ needs one approval. Side:
-- Ana alone, watching side-notes/. Dee's: Dee alone.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
insert into t.ids select 'dees', t.run('dee', $q$select public.create_vault('Dee''s')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('team')));
select t.run('ana', format($q$select public.create_subscription(%L, 'path', 'side-notes/')::text$q$, t.id('side')));

select t.run('ana', format($q$select public.create_access_token('ana-agent', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_access_token('ana-agent2', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_access_token('ana-read', 30, array[%L]::uuid[], 'read')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_access_token('side-only', 30, array[%L]::uuid[], 'write')$q$, t.id('side')));
insert into public.access_tokens (user_id, name, expires_at, all_vaults, vault_ids, access, kind, client_id, resource)
values (t.id('ana'), 'ana-cli', now() + interval '1 day', true, '{}', 'read', 'cli',
        'https://app.example/cli/oauth-client.json', 'https://app.example/api/env');

-- As the person in the web app (p_tok null), or as one of their connections.
create function t.as(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select case when p_tok is null then t.run(p_user, p_sql)
    else t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
      'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql) end
$$;
create function t.waiting(p_user text, p_vault text, p_tok text default null) returns text language sql as $$
  select t.as(p_user, p_tok, format($q$select public.flags_waiting(%L)::text$q$, t.id(p_vault)))
$$;
-- list_flags' own answer, as text, and how many flags it holds.
create function t.list(p_user text, p_vault text, p_tok text default null) returns text language sql as $$
  select t.as(p_user, p_tok, format($q$select public.list_flags(%L, 200)::text$q$, t.id(p_vault)))
$$;
create function t.listed(p_user text, p_vault text, p_tok text default null) returns text language sql as $$
  select jsonb_array_length(t.list(p_user, p_vault, p_tok)::jsonb -> 'flags')::text
$$;
create function t.catch_up(p_user text, p_vault text, p_tok text default null) returns text language sql as $$
  select t.as(p_user, p_tok, format($q$select public.advance_flags(%L, %s)::text$q$,
    t.id(p_vault), t.list(p_user, p_vault, p_tok)::jsonb ->> 'through'))
$$;
create function t.propose_many(p_n int, p_from int default 1) returns text language sql as $$
  select t.run('ben', format($q$select count(public.propose(%L, 'canon/p' || g || '.md', 'text', 'why'))::text
                              from generate_series(%s, %s) g$q$, t.id('team'), p_from, p_from + p_n - 1))
$$;

-- ---------------------------------------------------------------------------

select t.expect('flags waiting: zero when nothing waits',
  t.waiting('ana', 'team', 'ana-agent'), '0');

-- Ben proposes three: each waits on Ana, her agents told about it.
select t.propose_many(3);

select t.expect('flags waiting: counts exactly what list_flags returns for the caller, connection or person',
  concat_ws(' ', t.waiting('ana', 'team', 'ana-agent'), t.listed('ana', 'team', 'ana-agent'),
    t.waiting('ana', 'team'), t.listed('ana', 'team')),
  '3 3 3 3');
select t.expect('flags waiting: a member nothing waits on counts zero, as list_flags lists none',
  t.waiting('cal', 'team') || ' ' || t.listed('cal', 'team'), '0 0');
select t.expect('flags waiting: a read-only connection counts too',
  t.waiting('ana', 'team', 'ana-read'), '3');

create table t.before as select t.list('ana', 'team', 'ana-agent') as listed;
select t.waiting('ana', 'team', 'ana-agent'), t.waiting('ana', 'team');
select t.expect('flags waiting: counting moves no watermark: none is stored, and list_flags answers as before',
  (select count(*)::text from public.flag_watermarks)
  || ' ' || (t.list('ana', 'team', 'ana-agent') = (select listed from t.before))::text,
  '0 true');
select t.catch_up('ana', 'team', 'ana-agent');
create table t.mark as select last_seq from public.flag_watermarks where token_id = t.tok('ana-agent');
select t.waiting('ana', 'team', 'ana-agent');
select t.expect('flags waiting: ... nor moves one already stored',
  (select (w.last_seq = m.last_seq)::text from public.flag_watermarks w, t.mark m where w.token_id = t.tok('ana-agent')),
  'true');

select t.expect('flags waiting: each connection counts from its own watermark, and the person from theirs',
  concat_ws(' ', t.waiting('ana', 'team', 'ana-agent'), t.waiting('ana', 'team', 'ana-agent2'), t.waiting('ana', 'team')),
  '0 3 3');

-- Ana's Side connection writes a watched path: flagged to Ana in Side only.
select t.as('ana', 'side-only', format($q$select public.write_file(%L, 'side-notes/a.md', 'a')::text$q$, t.id('side')));
select t.expect('flags waiting: only the vault asked about counts, never another of the caller''s vaults',
  t.waiting('ana', 'side') || ' ' || t.waiting('ana', 'team'), '1 3');

select t.propose_many(22, 4);
select t.expect('flags waiting: stops at 21, so 21 means more than 20; list_flags still lists them all',
  t.waiting('ana', 'team', 'ana-agent2') || ' ' || t.listed('ana', 'team', 'ana-agent2'), '21 25');

select t.expect('flags waiting: refused as list_flags refuses: an outsider and a connection scoped elsewhere (P0002), a CLI sign-in (42501), a session without a person (28000)',
  concat_ws(',', t.waiting('dee', 'team'), t.waiting('ana', 'team', 'side-only'), t.waiting('ana', 'team', 'ana-cli'),
    t.run_claims('{"role": "authenticated"}', format($q$select public.flags_waiting(%L)::text$q$, t.id('team')))),
  'ERR P0002,ERR P0002,ERR 42501,ERR 28000');
select t.expect('flags waiting: anonymous callers can''t execute it',
  has_function_privilege('anon', 'public.flags_waiting(uuid)', 'execute')::text || ' ' || t.waiting(null, 'team'),
  'false ERR 42501');
