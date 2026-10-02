-- Hostile tests for the MCP proxy's credential-egress chokepoint
-- (20260928190000_link_proxy.sql): begin_link_call and record_link_call,
-- plus set_link_tools' new input_schema. Unlike every other link
-- function, these two aren't require_human -- an agent and a properly
-- scoped token are exactly who's expected to reach them, so most of this
-- file's actor ladder runs the other direction: proving who DOES reach a
-- granted tool, not just who's refused. Reach is owned by Ana (Ben edits,
-- Cal views); Dee is an outsider. Elsewhere is a second vault, used only
-- for a token scoped away from Reach.

insert into t.ids select 'reach', t.run('ana', $q$select public.create_vault('Reach')$q$)::uuid;
insert into t.ids select 'elsewhere', t.run('ana', $q$select public.create_vault('Elsewhere')$q$)::uuid;
select test_support.add_member(t.id('reach'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('reach'), t.id('cal'), 'viewer', t.id('ana'));

-- The three token shapes 20260928170000_path_owner_connection_scope.sql's
-- own tests use for private.connection_write_capable(): write-scoped to
-- this vault, read-scoped to this vault, and write-scoped to a different
-- vault entirely.
select t.run('ana', format($q$select public.create_access_token('reach-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('reach')));
select t.run('ana', format($q$select public.create_access_token('reach-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('reach')));
select t.run('ana', format($q$select public.create_access_token('other-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('elsewhere')));

-- A fake sealed credential, the same marker convention links_test.sql uses:
-- a "ciphertext" that is hex of 'CIPHERTEXT-MARKER-' || tag, so a test can
-- prove exactly what comes back through begin_link_call.
create function t.lk(p_tag text) returns text language sql as
$$ select encode(convert_to('CIPHERTEXT-MARKER-' || p_tag, 'utf8'), 'hex') $$;
create function t.create_link_sql(p_vault text, p_name text, p_url text, p_tag text default 'x') returns text language sql as $$
  select format($q$select public.create_link(%L, %L, %L, 'k1', decode(%L, 'hex'), decode(%L, 'hex'))$q$,
    t.id(p_vault), p_name, p_url, repeat('00', 12), t.lk(p_tag))
$$;

-- begin_link_call's result, one call, both fields at once (calling it
-- twice to read 'ok' then 'error' separately would double-count a
-- refusal's own log row).
create function t.begin(p_user text, p_link text, p_tool text, p_agent text default null) returns text language sql as $$
  select t.run(p_user, format(
    $q$select coalesce(r->>'ok','?') || ' ' || coalesce(r->>'error','-') from (select public.begin_link_call(%L, %L) as r) x$q$,
    t.id(p_link), p_tool), p_agent)
$$;
create function t.begin_tok(p_user text, p_tok text, p_link text, p_tool text) returns text language sql as $$
  select t.run_tok(p_user, p_tok, format(
    $q$select coalesce(r->>'ok','?') || ' ' || coalesce(r->>'error','-') from (select public.begin_link_call(%L, %L) as r) x$q$,
    t.id(p_link), p_tool))
$$;
create function t.call_count(p_link text, p_outcome text default null) returns text language sql as $$
  select count(*)::text from public.link_calls
   where link_id = t.id(p_link) and (p_outcome is null or outcome = p_outcome)
$$;
create function t.tool_count(p_link text) returns text language sql as
$$ select count(*)::text from public.link_tools where link_id = t.id(p_link) $$;

insert into t.ids select 'gh', t.run('ana', t.create_link_sql('reach', 'gh', 'https://api.github.com'))::uuid;
select t.run('ana', format($q$select 'ok' from public.set_link_tools(%L,
  '[{"name": "list_issues", "is_write": false}, {"name": "create_issue", "is_write": true}]'::jsonb)$q$, t.id('gh')));

-- ---------------------------------------------------------------------------
-- begin_link_call: who reaches a granted tool, who doesn't

select t.expect('begin: an outsider is refused', t.begin('dee', 'gh', 'list_issues'), 'false forbidden');
-- Anonymous never reaches the function body at all: begin_link_call is
-- granted to authenticated only, so this is a plain permission-denied
-- (also 42501) at the grant, the same mechanism links_test.sql's own
-- "anonymous cannot add a link" hits on create_link -- not a row this
-- function's own logic ever sees to log.
select t.expect('begin: anonymous is refused at the grant, before it ever runs',
  t.begin(null, 'gh', 'list_issues'), 'ERR 42501');
select t.expect('begin: a viewer has no seeded grant for the read tool either (viewers don''t call links directly)',
  t.begin('cal', 'gh', 'list_issues'), 'false forbidden');
select t.expect('begin: refusals this function''s own logic saw are logged, one row per attempt (not anonymous''s, above)',
  t.call_count('gh', 'refused'), '2');

select t.expect('begin: an editor reaches the granted read tool', t.begin('ben', 'gh', 'list_issues'), 'true -');
select t.expect('begin: an editor is refused the ungranted write tool', t.begin('ben', 'gh', 'create_issue'), 'false forbidden');
select t.expect('begin: the owner reaches the granted read tool', t.begin('ana', 'gh', 'list_issues'), 'true -');
select t.expect('begin: the owner is refused the ungranted write tool', t.begin('ana', 'gh', 'create_issue'), 'false forbidden');
select t.expect('begin: a tool that was never discovered is not_found', t.begin('ana', 'gh', 'delete_repo'), 'false not_found');
select t.expect('begin: a link that doesn''t exist is not_found',
  t.run('ana', $q$select coalesce(r->>'ok','?') || ' ' || coalesce(r->>'error','-')
    from (select public.begin_link_call('00000000-0000-0000-0000-0000000000ff', 'x') as r) x$q$),
  'false not_found');
select t.expect('begin: a nonexistent link logs nothing (no vault to attribute it to)', t.call_count('gh'), '5');

select t.expect('begin: the owner''s agent reaches a granted tool -- unlike every other link function, agents aren''t refused here',
  t.begin('ana', 'gh', 'list_issues', 'Claude Code'), 'true -');
select t.expect('begin: a granted read tool returns the sealed credential, never plaintext',
  t.run('ana', format($q$select (r->>'key_id') || ' ' || encode(decode(r->>'ciphertext', 'base64'), 'hex')
    from (select public.begin_link_call(%L, 'list_issues') as r) x$q$, t.id('gh'))),
  'k1 ' || t.lk('x'));

-- The owner enables the write tool for owner and (later) viewer, to
-- exercise private.connection_write_capable() as its own gate, distinct
-- from role_in()'s collapse of a read-only token's role to 'viewer' --
-- the same structure 20260928170000's F425 fix tests for path ownership.
select t.run('ana', format($q$select 'ok' from public.set_link_grant(%L, 'owner', 'create_issue', true)$q$, t.id('gh')));
select t.expect('begin: the owner reaches create_issue once granted, from their own unrestricted session',
  t.begin('ana', 'gh', 'create_issue'), 'true -');
select t.expect('begin: the owner''s write-scoped token reaches it too (real role, write-capable)',
  t.begin_tok('ana', 'reach-rw', 'gh', 'create_issue'), 'true -');
select t.expect('begin: the owner''s read-only-scoped token is refused it -- role_in() alone would collapse to viewer and stop here anyway',
  t.begin_tok('ana', 'reach-ro', 'gh', 'create_issue'), 'false forbidden');
select t.expect('begin: a token scoped to a different vault can''t reach this link at all',
  t.begin_tok('ana', 'other-rw', 'gh', 'list_issues'), 'false forbidden');

select t.run('ana', format($q$select 'ok' from public.set_link_grant(%L, 'viewer', 'create_issue', true)$q$, t.id('gh')));
select t.expect('begin: a genuine viewer''s own unrestricted session reaches a write tool once their role is granted it',
  t.begin('cal', 'gh', 'create_issue'), 'true -');
select t.expect('begin: the owner''s read-only-scoped token STILL can''t reach it, though it now collapses to a role that IS granted -- connection_write_capable is the gate that matters here',
  t.begin_tok('ana', 'reach-ro', 'gh', 'create_issue'), 'false forbidden');

-- ---------------------------------------------------------------------------
-- record_link_call: the one, final row -- re-authorized, not just membership

select t.expect('record: an invalid outcome is refused, nothing stored',
  t.run('ana', format($q$select 'ok' from public.record_link_call(%L, 'list_issues', 'refused', 'ah', 'rh')$q$, t.id('gh'))), 'ERR 22023');
select t.expect('record: an outsider is refused, nothing stored',
  t.run('dee', format($q$select 'ok' from public.record_link_call(%L, 'list_issues', 'ok', 'ah', 'rh')$q$, t.id('gh'))), 'ERR 42501');
select t.expect('record: an editor can''t fabricate an outcome for a tool their role isn''t granted',
  t.run('ben', format($q$select 'ok' from public.record_link_call(%L, 'create_issue', 'ok', 'ah', 'rh')$q$, t.id('gh'))), 'ERR 42501');
select t.expect('record: the owner''s read-only-scoped token can''t record a write tool''s outcome either',
  t.run_tok('ana', 'reach-ro', format($q$select 'ok' from public.record_link_call(%L, 'create_issue', 'ok', 'ah', 'rh')$q$, t.id('gh'))), 'ERR 42501');
select t.expect('record: refused calls above stored nothing', t.call_count('gh', 'ok') || ' ' || t.call_count('gh', 'error'), '0 0');

select t.expect('record: the owner records a real outcome for a granted tool',
  t.run('ana', format($q$select 'ok' from public.record_link_call(%L, 'list_issues', 'ok', 'arghash', 'reshash')$q$, t.id('gh'))), 'ok');
-- count() || max(...) rather than a bare scalar subquery: an aggregate
-- always returns exactly one row, so a regression that inserts more than
-- the one expected row fails this assertion cleanly instead of a raw
-- "more than one row" error aborting the rest of the file.
select t.expect('record: it''s the one row, with the right shape',
  (select count(*)::text || ':' || max(tool_name || ' ' || outcome || ' ' || arg_hash || ' ' || result_hash || ' ' || actor::text)
     from public.link_calls where link_id = t.id('gh') and outcome = 'ok'),
  format('1:list_issues ok arghash reshash %s', t.id('ana')));
select t.expect('record: an error outcome is fine too',
  t.run('ben', format($q$select 'ok' from public.record_link_call(%L, 'list_issues', 'error', 'ah2', null)$q$, t.id('gh'))), 'ok');
select t.expect('record: both rows are there now', t.call_count('gh', 'ok') || ' ' || t.call_count('gh', 'error'), '1 1');

-- ---------------------------------------------------------------------------
-- set_link_tools' input_schema (this migration's other change)

insert into t.ids select 'stripe', t.run('ana', t.create_link_sql('reach', 'stripe', 'https://api.stripe.com', 'y'))::uuid;

select t.expect('tools: a non-object input_schema is refused',
  t.run('ana', format($q$select 'ok' from public.set_link_tools(%L, '[{"name": "x", "input_schema": "nope"}]'::jsonb)$q$, t.id('stripe'))),
  'ERR 22023');
select t.expect('tools: refused calls store nothing', t.tool_count('stripe'), '0');

select t.expect('tools: the owner records a tool with an input_schema',
  t.run('ana', format($q$select 'ok' from public.set_link_tools(%L,
    '[{"name": "create_invoice", "is_write": true, "input_schema": {"type": "object", "properties": {"amount": {"type": "number"}}}},
      {"name": "list_invoices", "is_write": false}]'::jsonb)$q$, t.id('stripe'))),
  'ok');
select t.expect('tools: its input_schema is stored exactly (jsonb equality, not text -- key order isn''t the point)',
  t.run('ana', format($q$select (input_schema = '{"type": "object", "properties": {"amount": {"type": "number"}}}'::jsonb)::text
    from public.link_tools where link_id = %L and tool_name = 'create_invoice'$q$, t.id('stripe'))),
  'true');
select t.expect('tools: a tool with no input_schema given stores null',
  t.run('ana', format($q$select coalesce(input_schema::text, 'null') from public.link_tools where link_id = %L and tool_name = 'list_invoices'$q$, t.id('stripe'))),
  'null');

select t.expect('tools: a second discovery run refreshes input_schema, like description',
  t.run('ana', format($q$select 'ok' from public.set_link_tools(%L,
    '[{"name": "create_invoice", "is_write": true, "input_schema": {"type": "object", "properties": {"amount": {"type": "number"}, "currency": {"type": "string"}}}},
      {"name": "list_invoices", "is_write": false}]'::jsonb)$q$, t.id('stripe'))),
  'ok');
select t.expect('tools: the refreshed input_schema is the new one',
  t.run('ana', format($q$select (input_schema = '{"type": "object", "properties": {"amount": {"type": "number"}, "currency": {"type": "string"}}}'::jsonb)::text
    from public.link_tools where link_id = %L and tool_name = 'create_invoice'$q$, t.id('stripe'))),
  'true');

-- ---------------------------------------------------------------------------
-- list_callable_link_tools: what mcp/'s tools/list actually offers, which
-- must agree exactly with what begin_link_call would allow. By this point
-- in the file: gh has list_issues granted to owner+editor (default) and
-- create_issue granted to owner and viewer (set above); stripe has
-- list_invoices granted to owner+editor (default) and create_invoice
-- granted to nobody (default, write tool, never turned on).

create function t.callable(p_user text) returns text language sql as $$
  select t.run(p_user,
    $q$select coalesce(string_agg(link_name || '.' || tool_name, ', ' order by link_name, tool_name), '(none)') from private.list_callable_link_tools()$q$)
$$;
create function t.callable_tok(p_user text, p_tok text) returns text language sql as $$
  select t.run_tok(p_user, p_tok,
    $q$select coalesce(string_agg(link_name || '.' || tool_name, ', ' order by link_name, tool_name), '(none)') from private.list_callable_link_tools()$q$)
$$;

select t.expect('callable: the owner sees every tool their role is granted, write tools included (their own session is always write-capable)',
  t.callable('ana'), 'gh.create_issue, gh.list_issues, stripe.list_invoices');
select t.expect('callable: an editor sees only what editors are granted -- create_issue never was',
  t.callable('ben'), 'gh.list_issues, stripe.list_invoices');
select t.expect('callable: a viewer sees only create_issue -- the one tool granted to viewers, from their own unrestricted (always write-capable) session',
  t.callable('cal'), 'gh.create_issue');
select t.expect('callable: an outsider sees nothing', t.callable('dee'), '(none)');
select t.expect('callable: the owner''s write-scoped token sees the same as the owner directly (real role, write-capable)',
  t.callable_tok('ana', 'reach-rw'), 'gh.create_issue, gh.list_issues, stripe.list_invoices');
select t.expect('callable: the owner''s read-only-scoped token sees nothing -- role collapses to viewer, and viewer''s one grant is a write tool a read-only token can never reach',
  t.callable_tok('ana', 'reach-ro'), '(none)');
select t.expect('callable: a token scoped to a different vault sees nothing here either',
  t.callable_tok('ana', 'other-rw'), '(none)');
