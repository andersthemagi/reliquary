-- Hostile tests for links to upstream MCP servers (20260928120000_links):
-- schema and owner-only management only. Discovery and the MCP proxy
-- aren't built, so there is nothing here about tool calls, grants taking
-- effect at call time, or a credential leaving private.link_secrets
-- through a function -- that's a later migration's tests. Ana owns Gone
-- (Ben edits, Cal views) and Keep; Dee is an outsider.

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids select 'gone', t.run('ana', $q$select public.create_vault('Gone')$q$)::uuid;
insert into t.ids select 'keep', t.run('ana', $q$select public.create_vault('Keep')$q$)::uuid;
select test_support.add_member(t.id('gone'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('gone'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.create_access_token('all-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('gone')));

-- Tokens, used the way the MCP server does (act.tok = the token id).
create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;

-- A fake sealed credential: 12-byte nonce, and a "ciphertext" that is a
-- marker (hex of 'CIPHERTEXT-MARKER-' || p_tag), so a test can prove it
-- never leaves through anything but a table grant that doesn't exist.
create function t.lk(p_tag text) returns text language sql as
$$ select encode(convert_to('CIPHERTEXT-MARKER-' || p_tag, 'utf8'), 'hex') $$;
create function t.create_link_sql(p_vault text, p_name text, p_url text, p_tag text default 'x') returns text language sql as $$
  select format($q$select public.create_link(%L, %L, %L, 'k1', decode(%L, 'hex'), decode(%L, 'hex'))$q$,
    t.id(p_vault), p_name, p_url, repeat('00', 12), t.lk(p_tag))
$$;
create function t.create_link(p_user text, p_vault text, p_name text, p_url text, p_tag text default 'x',
                               p_agent text default null) returns text language sql as $$
  select t.run(p_user, t.create_link_sql(p_vault, p_name, p_url, p_tag), p_agent)
$$;
create function t.log_count(p_vault text, p_event text) returns text language sql as
$$ select count(*)::text from public.log where vault_id = t.id(p_vault) and event = p_event $$;
create function t.link_count(p_vault text) returns text language sql as
$$ select count(*)::text from public.links where vault_id = t.id(p_vault) $$;
create function t.link_name(p_link text) returns text language sql as
$$ select name from public.links where id = t.id(p_link) $$;

-- ---------------------------------------------------------------------------
-- create_link

select t.expect('create: an editor cannot add a link',
  t.create_link('ben', 'gone', 'linear', 'https://api.linear.app'), 'ERR 42501');
select t.expect('create: a viewer cannot add a link',
  t.create_link('cal', 'gone', 'linear', 'https://api.linear.app'), 'ERR 42501');
select t.expect('create: an outsider cannot add a link',
  t.create_link('dee', 'gone', 'linear', 'https://api.linear.app'), 'ERR 42501');
select t.expect('create: anonymous cannot add a link',
  t.create_link(null, 'gone', 'linear', 'https://api.linear.app'), 'ERR 42501');
select t.expect('create: the owner''s agent cannot add a link',
  t.create_link('ana', 'gone', 'linear', 'https://api.linear.app', 'x', 'Claude Code'), 'ERR 42501');
select t.expect('create: the owner''s all-vaults read-write token cannot add a link',
  t.run_tok('ana', 'all-rw', t.create_link_sql('gone', 'linear', 'https://api.linear.app')), 'ERR 42501');
select t.expect('create: refused calls add nothing and log nothing',
  t.link_count('gone') || ' ' || t.log_count('gone', 'link.create'), '0 0');
select t.expect('create: a name starting with a digit is refused',
  t.create_link('ana', 'gone', '1linear', 'https://api.linear.app'), 'ERR 22023');
select t.expect('create: a non-https url is refused',
  t.create_link('ana', 'gone', 'linear', 'http://api.linear.app'), 'ERR 22023');
select t.expect('create: a bare scheme with no host is refused',
  t.create_link('ana', 'gone', 'linear', 'https://'), 'ERR 22023');
select t.expect('create: a short nonce is refused',
  t.run('ana', format($q$select public.create_link(%L, 'badnonce', 'https://x.example', 'k1', decode('00', 'hex'), decode(%L, 'hex'))$q$,
    t.id('gone'), t.lk('bad'))), 'ERR 22023');

insert into t.ids select 'lk1', t.run('ana', t.create_link_sql('gone', 'linear', 'https://api.linear.app'))::uuid;
select t.expect('create: the owner adds a link', t.link_count('gone'), '1');
select t.expect('create: logged with its name and url, as the person',
  (select string_agg(detail::text || ' ' || actor::text || ' ' || coalesce(agent, 'no agent'), '; ') from public.log
    where vault_id = t.id('gone') and event = 'link.create'),
  format('{"url": "https://api.linear.app", "link": "%s", "name": "linear"} %s no agent', t.id('lk1'), t.id('ana')));
select t.expect('create: a duplicate name in the same vault is refused',
  t.create_link('ana', 'gone', 'linear', 'https://other.example'), 'ERR 23505');
select t.expect_true('create: the same name in a different vault is fine',
  t.create_link('ana', 'keep', 'linear', 'https://api.linear.app') is not null);

-- ---------------------------------------------------------------------------
-- Secret storage

select t.expect('secret: the owner cannot select link_secrets directly',
  t.run('ana', $q$select count(*) from private.link_secrets$q$), 'ERR 42501');
select t.expect('secret: an outsider cannot select link_secrets directly',
  t.run('dee', $q$select count(*) from private.link_secrets$q$), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- Reading

select t.expect('read: the owner sees the link',
  t.run('ana', format($q$select count(*)::text from public.links where id = %L$q$, t.id('lk1'))), '1');
select t.expect('read: the editor sees the link',
  t.run('ben', format($q$select count(*)::text from public.links where id = %L$q$, t.id('lk1'))), '1');
select t.expect('read: the viewer sees the link',
  t.run('cal', format($q$select count(*)::text from public.links where id = %L$q$, t.id('lk1'))), '1');
select t.expect('read: an outsider sees nothing',
  t.run('dee', format($q$select count(*)::text from public.links where id = %L$q$, t.id('lk1'))), '0');

-- ---------------------------------------------------------------------------
-- update_link

select t.expect('update: an editor cannot rename a link',
  t.run('ben', format($q$select 'ok' from public.update_link(%L, 'renamed', 'https://api.linear.app')$q$, t.id('lk1'))), 'ERR 42501');
select t.expect('update: a viewer cannot rename a link',
  t.run('cal', format($q$select 'ok' from public.update_link(%L, 'renamed', 'https://api.linear.app')$q$, t.id('lk1'))), 'ERR 42501');
select t.expect('update: an outsider cannot rename a link',
  t.run('dee', format($q$select 'ok' from public.update_link(%L, 'renamed', 'https://api.linear.app')$q$, t.id('lk1'))), 'ERR 42501');
select t.expect('update: the owner''s agent cannot rename a link',
  t.run('ana', format($q$select 'ok' from public.update_link(%L, 'renamed', 'https://api.linear.app')$q$, t.id('lk1')), 'Claude Code'), 'ERR 42501');
select t.expect('update: the owner''s token cannot rename a link',
  t.run_tok('ana', 'all-rw', format($q$select 'ok' from public.update_link(%L, 'renamed', 'https://api.linear.app')$q$, t.id('lk1'))), 'ERR 42501');
select t.expect('update: refused calls change nothing and log nothing',
  t.link_name('lk1') || ' ' || t.log_count('gone', 'link.update'), 'linear 0');
select t.expect('update: the same name and url again logs nothing',
  t.run('ana', format($q$select 'ok' from public.update_link(%L, 'linear', 'https://api.linear.app')$q$, t.id('lk1')))
  || ' ' || t.log_count('gone', 'link.update'), 'ok 0');
select t.expect('update: the owner renames and re-urls it',
  t.run('ana', format($q$select 'ok' from public.update_link(%L, 'linear2', 'https://api2.linear.app')$q$, t.id('lk1')))
  || ' ' || t.link_name('lk1'), 'ok linear2');
select t.expect('update: logged with the new and previous values',
  (select detail from public.log where vault_id = t.id('gone') and event = 'link.update')::text,
  format('{"url": "https://api2.linear.app", "link": "%s", "name": "linear2", "previous_url": "https://api.linear.app", "previous_name": "linear"}', t.id('lk1')));

-- ---------------------------------------------------------------------------
-- set_link_grant

select t.expect('grant: an editor cannot set a grant',
  t.run('ben', format($q$select 'ok' from public.set_link_grant(%L, 'editor', 'list_issues', true)$q$, t.id('lk1'))), 'ERR 42501');
select t.expect('grant: a viewer cannot set a grant',
  t.run('cal', format($q$select 'ok' from public.set_link_grant(%L, 'editor', 'list_issues', true)$q$, t.id('lk1'))), 'ERR 42501');
select t.expect('grant: an outsider cannot set a grant',
  t.run('dee', format($q$select 'ok' from public.set_link_grant(%L, 'editor', 'list_issues', true)$q$, t.id('lk1'))), 'ERR 42501');
select t.expect('grant: the owner''s agent cannot set a grant',
  t.run('ana', format($q$select 'ok' from public.set_link_grant(%L, 'editor', 'list_issues', true)$q$, t.id('lk1')), 'Claude Code'), 'ERR 42501');
select t.expect('grant: an invalid role is refused',
  t.run('ana', format($q$select 'ok' from public.set_link_grant(%L, 'admin', 'list_issues', true)$q$, t.id('lk1'))), 'ERR 22023');
select t.expect('grant: an empty tool name is refused',
  t.run('ana', format($q$select 'ok' from public.set_link_grant(%L, 'editor', '', true)$q$, t.id('lk1'))), 'ERR 22023');
select t.expect('grant: the owner enables a tool for editors',
  t.run('ana', format($q$select 'ok' from public.set_link_grant(%L, 'editor', 'list_issues', true)$q$, t.id('lk1')))
  || ' ' || t.run('ben', format($q$select enabled::text from public.link_grants where link_id = %L and role = 'editor' and tool_name = 'list_issues'$q$, t.id('lk1'))),
  'ok true');
select t.expect('grant: the owner flips it off again (upsert, not a new row)',
  t.run('ana', format($q$select 'ok' from public.set_link_grant(%L, 'editor', 'list_issues', false)$q$, t.id('lk1')))
  || ' ' || t.run('ana', format($q$select count(*)::text from public.link_grants where link_id = %L and role = 'editor' and tool_name = 'list_issues'$q$, t.id('lk1'))),
  'ok 1');

-- ---------------------------------------------------------------------------
-- link_calls: append-only, and read only for owners and editors

insert into public.link_calls (link_id, vault_id, actor, tool_name, outcome, arg_hash, result_hash)
values (t.id('lk1'), t.id('gone'), t.id('ana'), 'list_issues', 'ok', 'argh', 'resh');

select t.expect('calls: the owner reads it',
  t.run('ana', format($q$select count(*)::text from public.link_calls where link_id = %L$q$, t.id('lk1'))), '1');
select t.expect('calls: the editor reads it',
  t.run('ben', format($q$select count(*)::text from public.link_calls where link_id = %L$q$, t.id('lk1'))), '1');
select t.expect('calls: the viewer reads nothing',
  t.run('cal', format($q$select count(*)::text from public.link_calls where link_id = %L$q$, t.id('lk1'))), '0');
select t.expect('calls: an outsider reads nothing',
  t.run('dee', format($q$select count(*)::text from public.link_calls where link_id = %L$q$, t.id('lk1'))), '0');
select t.expect('calls: nobody in authenticated may insert one directly',
  t.run('ana', format($q$insert into public.link_calls (link_id, vault_id, tool_name, outcome) values (%L, %L, 'x', 'ok') returning 1$q$,
    t.id('lk1'), t.id('gone'))), 'ERR 42501');
select t.owner_error('calls: link_calls rows cannot be updated, even by the table owner',
  $q$update public.link_calls set outcome = 'error'$q$);
select t.owner_error('calls: link_calls rows cannot be deleted, even by the table owner',
  $q$delete from public.link_calls$q$);
select t.owner_error('calls: link_calls cannot be truncated, even by the table owner',
  $q$truncate public.link_calls$q$);

-- ---------------------------------------------------------------------------
-- delete_link

select t.expect('delete: an editor cannot delete a link',
  t.run('ben', format($q$select 'ok' from public.delete_link(%L)$q$, t.id('lk1'))), 'ERR 42501');
select t.expect('delete: a viewer cannot delete a link',
  t.run('cal', format($q$select 'ok' from public.delete_link(%L)$q$, t.id('lk1'))), 'ERR 42501');
select t.expect('delete: an outsider cannot delete a link',
  t.run('dee', format($q$select 'ok' from public.delete_link(%L)$q$, t.id('lk1'))), 'ERR 42501');
select t.expect('delete: the owner''s agent cannot delete a link',
  t.run('ana', format($q$select 'ok' from public.delete_link(%L)$q$, t.id('lk1')), 'Claude Code'), 'ERR 42501');
select t.expect('delete: the owner''s token cannot delete a link',
  t.run_tok('ana', 'all-rw', format($q$select 'ok' from public.delete_link(%L)$q$, t.id('lk1'))), 'ERR 42501');
select t.expect('delete: refused calls change nothing',
  t.link_count('gone'), '1');
select t.expect('delete: the owner deletes it, and its grant goes with it',
  t.run('ana', format($q$select 'ok' from public.delete_link(%L)$q$, t.id('lk1')))
  || ' ' || t.link_count('gone')
  || ' ' || t.run('ana', format($q$select count(*)::text from public.link_grants where link_id = %L$q$, t.id('lk1'))),
  'ok 0 0');
select t.expect('delete: logged with its name',
  (select detail from public.log where vault_id = t.id('gone') and event = 'link.delete')::text,
  format('{"link": "%s", "name": "linear2"}', t.id('lk1')));
