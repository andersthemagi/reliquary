-- Hostile tests for vault administration (20260925120000_vault_admin):
-- rename, default policy, export and delete. All of it is an owner's, in
-- person. Ana owns Gone (Ben edits, Cal views) and Keep; Dee is an outsider.

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids select 'gone', t.run('ana', $q$select public.create_vault('Gone')$q$)::uuid;
insert into t.ids select 'keep', t.run('ana', $q$select public.create_vault('Keep')$q$)::uuid;
select test_support.add_member(t.id('gone'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('gone'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 2)$q$, t.id('gone')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/a.md', 'Alpha one')$q$, t.id('gone')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/a.md', 'Alpha two')$q$, t.id('gone')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/b.md', 'Bravo')$q$, t.id('gone')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/deleted.md', 'Deleted text')$q$, t.id('gone')));
select t.run('ana', format($q$select public.delete_file(%L, 'notes/deleted.md')$q$, t.id('gone')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/erased.md', 'Erased text')$q$, t.id('gone')));
select t.run('ana', format($q$select public.erase_file(%L, 'notes/erased.md')$q$, t.id('gone')));
select t.run('ana', format($q$select public.write_file(%L, 'notes/z.md', 'Zulu')$q$, t.id('gone')));
select t.run('ana', format($q$select public.write_file(%L, 'kept.md', 'Kept text')$q$, t.id('keep')));
insert into t.ids select 'p1', t.run('ben',
  format($q$select public.propose(%L, 'canon/c.md', 'Canon text', 'seed')$q$, t.id('gone')), 'Hermes')::uuid;
select t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p1')));
select t.run('ben', format($q$select public.decide(%L, 'approve')$q$, t.id('p1')));
select t.run('ana', format($q$select public.comment_on_proposal(%L, 'A comment')$q$, t.id('p1')));

-- A variable in each vault: a fixed marker as its "ciphertext", so a test
-- can prove the export never carries it, and that deletion destroys it.
create function t.setv(p_user text, p_vault text, p_name text, p_env text) returns text language sql as $$
  select t.run(p_user, format($q$select public.set_variable(%L, %L, %L, 'k1', decode(%L, 'hex'), decode(%L, 'hex'))$q$,
    t.id(p_vault), p_name, p_env, repeat('00', 12), encode(convert_to('CIPHERTEXT-MARKER-' || p_name, 'utf8'), 'hex')))
$$;
select t.setv('ana', 'gone', 'API_KEY', 'development');
select t.setv('ana', 'gone', 'API_KEY', 'production');
select t.setv('ana', 'gone', 'DB_URL', 'preview');
select t.setv('ana', 'keep', 'KEEP_KEY', 'development');
select t.run('ana', format($q$select public.reveal_variable(%L, 'API_KEY', 'development')::text$q$, t.id('gone')));
insert into t.ids select 'gone_var', id from public.variables where vault_id = t.id('gone') and name = 'API_KEY';

select t.run('ana', format($q$select public.create_access_token('only-gone', 30, array[%L]::uuid[], 'write')$q$, t.id('gone')));
select t.run('ana', format($q$select public.create_access_token('both', 30, array[%L, %L]::uuid[], 'write')$q$,
  t.id('gone'), t.id('keep')));
select t.run('ana', $q$select public.create_access_token('all-rw', 30)$q$);
select t.run('ben', format($q$select public.create_access_token('ben-gone', 30, array[%L]::uuid[], 'write')$q$, t.id('gone')));

create function t.log_count(p_vault text, p_event text) returns text language sql as
$$ select count(*)::text from public.log where vault_id = t.id(p_vault) and event = p_event $$;
create function t.name_of(p_vault text) returns text language sql as
$$ select name from public.vaults where id = t.id(p_vault) $$;
create function t.default_of(p_vault text) returns text language sql as
$$ select default_policy from public.vaults where id = t.id(p_vault) $$;

-- ---------------------------------------------------------------------------
-- Rename

select t.expect('rename: an editor cannot rename',
  t.run('ben', format($q$select 'ok' from public.rename_vault(%L, 'Ben''s')$q$, t.id('gone'))), 'ERR 42501');
select t.expect('rename: a viewer cannot rename',
  t.run('cal', format($q$select 'ok' from public.rename_vault(%L, 'Cal''s')$q$, t.id('gone'))), 'ERR 42501');
select t.expect('rename: an outsider cannot rename',
  t.run('dee', format($q$select 'ok' from public.rename_vault(%L, 'Dee''s')$q$, t.id('gone'))), 'ERR 42501');
select t.expect('rename: anonymous cannot rename',
  t.run(null, format($q$select 'ok' from public.rename_vault(%L, 'Anon')$q$, t.id('gone'))), 'ERR 42501');
select t.expect('rename: the owner''s agent cannot rename',
  t.run('ana', format($q$select 'ok' from public.rename_vault(%L, 'Agent''s')$q$, t.id('gone')), 'Claude Code'), 'ERR 42501');
select t.expect('rename: the owner''s all-vaults read-write token cannot rename',
  t.run_tok('ana', 'all-rw', format($q$select 'ok' from public.rename_vault(%L, 'Token''s')$q$, t.id('gone'))), 'ERR 42501');
select t.expect('rename: refused calls change nothing and log nothing',
  t.name_of('gone') || ' ' || t.log_count('gone', 'vault.rename'), 'Gone 0');
select t.expect('rename: a blank name is refused',
  t.run('ana', format($q$select 'ok' from public.rename_vault(%L, '   ')$q$, t.id('gone'))), 'ERR 22023');
select t.expect('rename: a name over 100 characters is refused',
  t.run('ana', format($q$select 'ok' from public.rename_vault(%L, %L)$q$, t.id('gone'), repeat('x', 101))), 'ERR 22023');
select t.expect('rename: the owner renames, trimmed',
  t.run('ana', format($q$select 'ok' from public.rename_vault(%L, '  Gone soon  ')$q$, t.id('gone')))
  || ' ' || t.name_of('gone'), 'ok Gone soon');
select t.expect('rename: logged with the new and previous names, as the person',
  (select string_agg(detail::text || ' ' || actor::text || ' ' || coalesce(agent, 'no agent'), '; ') from public.log
    where vault_id = t.id('gone') and event = 'vault.rename'),
  '{"name": "Gone soon", "previous": "Gone"} ' || t.id('ana')::text || ' no agent');
select t.expect('rename: the same name again logs nothing',
  t.run('ana', format($q$select 'ok' from public.rename_vault(%L, 'Gone soon')$q$, t.id('gone')))
  || ' ' || t.log_count('gone', 'vault.rename'), 'ok 1');

-- ---------------------------------------------------------------------------
-- Default policy

select t.expect('default policy: an editor cannot change it',
  t.run('ben', format($q$select 'ok' from public.set_default_policy(%L, 'canon')$q$, t.id('gone'))), 'ERR 42501');
select t.expect('default policy: an outsider cannot change it',
  t.run('dee', format($q$select 'ok' from public.set_default_policy(%L, 'canon')$q$, t.id('gone'))), 'ERR 42501');
select t.expect('default policy: the owner''s agent cannot change it',
  t.run('ana', format($q$select 'ok' from public.set_default_policy(%L, 'canon')$q$, t.id('gone')), 'Claude Code'), 'ERR 42501');
select t.expect('default policy: the owner''s token cannot change it',
  t.run_tok('ana', 'all-rw', format($q$select 'ok' from public.set_default_policy(%L, 'canon')$q$, t.id('gone'))), 'ERR 42501');
select t.expect('default policy: only canon or open',
  t.run('ana', format($q$select 'ok' from public.set_default_policy(%L, 'closed')$q$, t.id('gone'))), 'ERR 22023');
select t.expect('default policy: refused calls change nothing',
  (select default_policy from public.vaults where id = t.id('gone')) || ' ' || t.log_count('gone', 'vault.default_policy'), 'open 0');
select t.expect('default policy: the owner makes the vault canon by default',
  t.run('ana', format($q$select 'ok' from public.set_default_policy(%L, 'canon')$q$, t.id('gone')))
  || ' ' || t.default_of('gone'), 'ok canon');
select t.expect('default policy: a path with no rule is canon now, so direct writes are refused',
  t.run('ana', format($q$select public.write_file(%L, 'loose.md', 'x')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('default policy: logged with the previous default',
  (select string_agg(detail::text, '; ') from public.log where vault_id = t.id('gone') and event = 'vault.default_policy'),
  '{"previous": "open", "default_policy": "canon"}');
select t.run('ana', format($q$select public.set_default_policy(%L, 'open')$q$, t.id('gone')));

-- ---------------------------------------------------------------------------
-- Export

select t.expect('export: an editor cannot export',
  t.run('ben', format($q$select public.export_vault(%L)::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('export: a viewer cannot export',
  t.run('cal', format($q$select public.export_vault(%L)::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('export: an outsider cannot export',
  t.run('dee', format($q$select public.export_vault(%L)::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('export: anonymous cannot export',
  t.run(null, format($q$select public.export_vault(%L)::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('export: the owner''s agent cannot export',
  t.run('ana', format($q$select public.export_vault(%L)::text$q$, t.id('gone')), 'Claude Code'), 'ERR 42501');
select t.expect('export: the owner''s all-vaults read-write token cannot export',
  t.run_tok('ana', 'all-rw', format($q$select public.export_vault(%L)::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('export: nobody but the owner in person gets file pages either',
  t.run('ben', format($q$select count(*)::text from public.export_files(%L)$q$, t.id('gone')))
  || ' ' || t.run('ana', format($q$select count(*)::text from public.export_files(%L)$q$, t.id('gone')), 'Claude Code')
  || ' ' || t.run_tok('ana', 'all-rw', format($q$select count(*)::text from public.export_files(%L)$q$, t.id('gone')))
  || ' ' || t.run('dee', format($q$select count(*)::text from public.export_files(%L)$q$, t.id('gone'))),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('export: refused calls log nothing',
  t.log_count('gone', 'vault.export'), '0');

create table t.manifest (m jsonb);
insert into t.manifest select case when r like 'ERR %' then null else r::jsonb end
  from (select t.run('ana', format($q$select public.export_vault(%L)::text$q$, t.id('gone'))) r) x;
select t.expect('export: the owner starts one, logged as vault.export with counts',
  t.log_count('gone', 'vault.export') || ' ' ||
  (select string_agg(detail::text, '; ') from public.log where vault_id = t.id('gone') and event = 'vault.export'),
  '1 {"bytes": 28, "files": 4}');
select t.expect('export: the header names the vault, its default and its rules',
  (select m -> 'vault' ->> 'name' || ' ' || (m -> 'vault' ->> 'default_policy') || ' ' || (m -> 'rules')::text
     from t.manifest),
  'Gone soon open [{"path": "canon/", "policy": "canon", "quorum": 2}]');
select t.expect('export: variables are names and environments only',
  (select (m -> 'variables')::text from t.manifest),
  '[{"name": "API_KEY", "environments": ["development", "production"]}, {"name": "DB_URL", "environments": ["preview"]}]');
select t.expect('export: no ciphertext, nonce or value anywhere in the header',
  (select position('CIPHERTEXT' in m::text)::text || position(encode(convert_to('CIPHERTEXT', 'utf8'), 'hex') in m::text)::text
     || position('nonce' in m::text)::text from t.manifest), '000');
select t.expect('export: files are the current text of live files, in path order; deleted and erased ones are left out',
  t.run('ana', format($q$select string_agg(path || '=' || body, ', ' order by path) from public.export_files(%L)$q$, t.id('gone'))),
  'canon/c.md=Canon text, notes/a.md=Alpha two, notes/b.md=Bravo, notes/z.md=Zulu');
select t.expect('export: files page after a path, with a limit',
  t.run('ana', format($q$select string_agg(path, ', ' order by path) from public.export_files(%L, 'notes/a.md', 1)$q$, t.id('gone'))),
  'notes/b.md');
select t.expect('export: another vault''s files never appear',
  t.run('ana', format($q$select count(*)::text from public.export_files(%L) where body = 'Kept text'$q$, t.id('gone'))), '0');

-- The size cap, lowered for this test only (as the table owner).
create or replace function private.export_cap() returns bigint
language sql immutable set search_path = '' as $$ select 10::bigint $$;
select t.expect('export: a vault over the size cap is refused, and nothing is logged',
  t.run('ana', format($q$select public.export_vault(%L)::text$q$, t.id('gone'))) || ' ' || t.log_count('gone', 'vault.export'),
  'ERR 54000 1');
create or replace function private.export_cap() returns bigint
language sql immutable set search_path = '' as $$ select 104857600::bigint $$;

-- ---------------------------------------------------------------------------
-- Delete: refusals

create function t.alive(p_vault text) returns text language sql as
$$ select count(*)::text from public.vaults where id = t.id(p_vault) $$;

select t.expect('delete: an editor cannot delete the vault',
  t.run('ben', format($q$select public.delete_vault(%L, 'Gone soon')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('delete: a viewer cannot delete the vault',
  t.run('cal', format($q$select public.delete_vault(%L, 'Gone soon')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('delete: an outsider cannot delete the vault',
  t.run('dee', format($q$select public.delete_vault(%L, 'Gone soon')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('delete: anonymous cannot delete the vault',
  t.run(null, format($q$select public.delete_vault(%L, 'Gone soon')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('delete: the owner''s agent cannot delete the vault',
  t.run('ana', format($q$select public.delete_vault(%L, 'Gone soon')::text$q$, t.id('gone')), 'Claude Code'), 'ERR 42501');
select t.expect('delete: the owner''s all-vaults read-write token cannot delete the vault',
  t.run_tok('ana', 'all-rw', format($q$select public.delete_vault(%L, 'Gone soon')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('delete: a token scoped to the vault cannot delete it',
  t.run_tok('ana', 'only-gone', format($q$select public.delete_vault(%L, 'Gone soon')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('delete: the owner must type the name exactly',
  t.run('ana', format($q$select public.delete_vault(%L, 'gone soon')::text$q$, t.id('gone')))
  || ' ' || t.run('ana', format($q$select public.delete_vault(%L, null)::text$q$, t.id('gone'))), 'ERR 22023 ERR 22023');
select t.expect('delete: refused calls leave the vault and its tokens alone',
  t.alive('gone') || ' ' || (select count(*)::text from public.access_tokens where revoked_at is not null)
  || ' ' || (select count(*)::text from private.vault_deletions), '1 0 0');

-- Nobody forges the marker the append-only triggers trust.
select t.expect('delete: signed-in users cannot write the deletion record',
  t.run('ana', format($q$insert into private.vault_deletions (vault_id, deleted_by, txid) values (%L, %L, txid_current()) returning 'ok'$q$,
    t.id('gone'), t.id('ana'))), 'ERR 42501');
select t.expect('delete: signed-in users cannot call the purge check',
  t.run('ana', format($q$select private.purging(%L)::text$q$, t.id('gone'))), 'ERR 42501');
-- A marker from another transaction opens nothing (the table owner plants one).
insert into private.vault_deletions (vault_id, deleted_by, txid) values (t.id('keep'), t.id('ana'), 1);
select t.owner_error('delete: a marker from another transaction does not unlock the log',
  format('delete from public.log where vault_id = %L', t.id('keep')));
select t.owner_error('delete: nor file versions',
  format('delete from public.file_versions where vault_id = %L', t.id('keep')));
select t.owner_error('delete: nor the variables access log',
  format('delete from public.env_access_log where vault_id = %L', t.id('keep')));
select t.owner_error('delete: truncate is refused even so', 'truncate public.log');

-- ---------------------------------------------------------------------------
-- Delete: the owner, in person

create table t.before (what text primary key, n int);
insert into t.before select 'keep_log', count(*) from public.log where vault_id = t.id('keep');
insert into t.before select 'keep_env_log', count(*) from public.env_access_log where vault_id = t.id('keep');
insert into t.before select 'gone_secrets', count(*) from private.variable_secrets where variable_id = t.id('gone_var');

select t.expect('delete: setup has ciphertexts to destroy',
  (select n::text from t.before where what = 'gone_secrets'), '2');

select t.expect('delete: the owner deletes the vault with its name typed, and gets counts back',
  (select case when r like 'ERR %' then r else r::jsonb ->> 'files' end
     from (select t.run('ana', format($q$select public.delete_vault(%L, '  Gone soon ')::text$q$, t.id('gone'))) r) x), '6');
select t.expect('delete: the vault is gone', t.alive('gone'), '0');
select t.expect('delete: every file, version, proposal, approval, note and rule is gone',
  (select count(*) from public.files where vault_id = t.id('gone'))
  || ' ' || (select count(*) from public.file_versions where vault_id = t.id('gone'))
  || ' ' || (select count(*) from public.proposals where vault_id = t.id('gone'))
  || ' ' || (select count(*) from public.approvals where proposal_id = t.id('p1'))
  || ' ' || (select count(*) from public.proposal_notes where vault_id = t.id('gone'))
  || ' ' || (select count(*) from public.path_policies where vault_id = t.id('gone'))
  || ' ' || (select count(*) from public.vault_members where vault_id = t.id('gone')),
  '0 0 0 0 0 0 0');
select t.expect('delete: the log and the variables access log for it are gone',
  (select count(*) from public.log where vault_id = t.id('gone'))
  || ' ' || (select count(*) from public.env_access_log where vault_id = t.id('gone')), '0 0');
select t.expect('delete: variables, their values and their ciphertexts are destroyed',
  (select count(*) from public.variables where vault_id = t.id('gone'))
  || ' ' || (select count(*) from public.variable_values where vault_id = t.id('gone'))
  || ' ' || (select count(*) from private.variable_secrets where variable_id = t.id('gone_var'))
  || ' ' || (select count(*) from public.environments where vault_id = t.id('gone')), '0 0 0 0');
select t.expect('delete: the only record kept is who deleted it, when, and counts: no name',
  (select deleted_by::text || ' ' || (counts ->> 'variables') || ' ' || position('Gone' in to_jsonb(d)::text)
     from private.vault_deletions d where vault_id = t.id('gone')),
  t.id('ana')::text || ' 2 0');
select t.expect('delete: the other vault is untouched, log and all',
  t.alive('keep') || ' '
  || ((select count(*) from public.log where vault_id = t.id('keep')) = (select n from t.before where what = 'keep_log'))::text || ' '
  || ((select count(*) from public.env_access_log where vault_id = t.id('keep')) = (select n from t.before where what = 'keep_env_log'))::text || ' '
  || t.run('ana', format($q$select body from public.search(%L, 'Kept')$q$, t.id('keep'))),
  '1 true true Kept text');

-- Tokens

select t.expect('delete: tokens whose only vault it was are revoked, anyone''s',
  (select string_agg(name, ', ' order by name) from public.access_tokens where revoked_at is not null),
  'ben-gone, only-gone');
select t.expect('delete: a token scoped to it and another vault keeps the other',
  t.run_tok('ana', 'both', format($q$select body from public.search(%L, 'Kept')$q$, t.id('keep'))), 'Kept text');
select t.expect('delete: a token scoped to it sees nothing of it afterwards',
  t.run_tok('ana', 'both', format($q$select count(*)::text from public.files where vault_id = %L$q$, t.id('gone')))
  || ' ' || t.run_tok('ana', 'both', format($q$select count(*)::text from public.log where vault_id = %L$q$, t.id('gone')))
  || ' ' || t.run_tok('ana', 'both', format($q$select count(*)::text from public.changes_since(%L)$q$, t.id('gone'))),
  '0 0 0');
select t.expect('delete: a token scoped to it writes nothing there afterwards',
  t.run_tok('ana', 'both', format($q$select public.write_file(%L, 'notes/back.md', 'x')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('delete: the revoked token reaches nothing at all',
  t.run_tok('ana', 'only-gone', format($q$select count(*)::text from public.vaults$q$)), '0');
select t.expect('delete: deleting it again finds nothing to delete',
  t.run('ana', format($q$select public.delete_vault(%L, 'Gone soon')::text$q$, t.id('gone'))), 'ERR 42501');

-- Append-only still holds after a deletion

select t.owner_error('delete: the log is still append-only afterwards',
  format('delete from public.log where vault_id = %L', t.id('keep')));
select t.owner_error('delete: the deletion record cannot be changed', 'update private.vault_deletions set counts = ''{}''');
select t.owner_error('delete: the deletion record cannot be removed', 'delete from private.vault_deletions');
