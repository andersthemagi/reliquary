-- Hostile tests for path ownership (20260928130000_path_ownership).
-- Ana owns Gone (Ben edits, Cal views); Dee is an outsider. `canon/`
-- defaults to quorum 1. Two paths: canon/cal.md, owned solely by Cal (a
-- viewer, promoted for that path alone) to prove viewer promotion and
-- direct writes; canon/shared.md, also owned solely by Cal, to prove
-- quorum counts only her approval even though Ana (vault owner) and Ben
-- (editor) both have ordinary vault write access. A third path,
-- canon/plain.md, has no owner at all: every assertion there is a
-- regression check that nothing changed for it.

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids select 'gone', t.run('ana', $q$select public.create_vault('Gone')$q$)::uuid;
select test_support.add_member(t.id('gone'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('gone'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.create_access_token('all-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('gone')));

create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;

select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('gone')));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/cal.md', 'canon', 1)$q$, t.id('gone')));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/shared.md', 'canon', 1)$q$, t.id('gone')));

create function t.own_sql(p_path text, p_user text) returns text language sql as $$
  select format($q$select 'ok' from public.set_path_owner(%L, %L, %L)$q$, t.id('gone'), p_path, t.id(p_user))
$$;
create function t.log_count(p_event text) returns text language sql as
$$ select count(*)::text from public.log where vault_id = t.id('gone') and event = p_event $$;

-- ---------------------------------------------------------------------------
-- set_path_owner

select t.expect('set: an editor cannot name an owner',
  t.run('ben', t.own_sql('canon/cal.md', 'cal')), 'ERR 42501');
select t.expect('set: a viewer cannot name an owner',
  t.run('cal', t.own_sql('canon/cal.md', 'cal')), 'ERR 42501');
select t.expect('set: an outsider cannot name an owner',
  t.run('dee', t.own_sql('canon/cal.md', 'cal')), 'ERR 42501');
select t.expect('set: anonymous cannot name an owner',
  t.run(null, t.own_sql('canon/cal.md', 'cal')), 'ERR 42501');
select t.expect('set: the owner''s agent cannot name an owner',
  t.run('ana', t.own_sql('canon/cal.md', 'cal'), 'Claude Code'), 'ERR 42501');
select t.expect('set: the owner''s token cannot name an owner',
  t.run_tok('ana', 'all-rw', t.own_sql('canon/cal.md', 'cal')), 'ERR 42501');
select t.expect('set: refused calls name nobody and log nothing',
  t.run('ana', format($q$select count(*)::text from public.path_owners where vault_id = %L and path = 'canon/cal.md'$q$, t.id('gone')))
  || ' ' || t.log_count('path_owner.add'), '0 0');
select t.expect('set: a path with no policy row is refused',
  t.run('ana', t.own_sql('canon/never-ruled.md', 'cal')), 'ERR P0002');
select t.expect('set: an outsider can''t be named (not a member)',
  t.run('ana', t.own_sql('canon/cal.md', 'dee')), 'ERR P0002');
select t.expect('set: the owner names Cal, a viewer, owner of canon/cal.md',
  t.run('ana', t.own_sql('canon/cal.md', 'cal')), 'ok');
select t.expect('set: naming her again is harmless',
  t.run('ana', t.own_sql('canon/cal.md', 'cal')), 'ok');
select t.expect('set: still just one row, logged twice',
  (select count(*)::text from public.path_owners where vault_id = t.id('gone') and path = 'canon/cal.md')
  || ' ' || t.log_count('path_owner.add'), '1 2');
select t.run('ana', t.own_sql('canon/shared.md', 'cal'));

-- ---------------------------------------------------------------------------
-- Reading path_owners

select t.expect('read: the editor sees who owns the path',
  t.run('ben', format($q$select count(*)::text from public.path_owners where vault_id = %L and path = 'canon/cal.md'$q$, t.id('gone'))), '1');
select t.expect('read: an outsider sees nothing',
  t.run('dee', format($q$select count(*)::text from public.path_owners where vault_id = %L and path = 'canon/cal.md'$q$, t.id('gone'))), '0');

-- ---------------------------------------------------------------------------
-- write_file: a viewer named owner writes her path directly; a
-- non-owner, even the vault owner, still can't

select t.expect('write: Cal, a viewer, writes her owned canon path directly',
  t.run('cal', format($q$select 'ok' from public.write_file(%L, 'canon/cal.md', 'Cal wrote this')$q$, t.id('gone'))), 'ok');
select t.expect('write: the text landed',
  (select body from public.file_versions fv join public.files f on f.current_version_id = fv.id
    where f.vault_id = t.id('gone') and f.path = 'canon/cal.md'),
  'Cal wrote this');
select t.expect('write: Ben, an editor but not this path''s owner, still can''t',
  t.run('ben', format($q$select public.write_file(%L, 'canon/cal.md', 'Ben overwrites')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('write: Ana, the vault owner but not this path''s owner, still can''t either (no vault-wide override)',
  t.run('ana', format($q$select public.write_file(%L, 'canon/cal.md', 'Ana overwrites')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('write: on a path nobody owns, the vault owner still can''t write it directly (unchanged)',
  t.run('ana', format($q$select public.write_file(%L, 'canon/plain.md', 'x')::text$q$, t.id('gone'))), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- write_file via a scoped connection: a named owner's own access token
-- must be scoped the same way any editor's or owner's already is
-- (security(db) fix, 20260928170000_path_owner_connection_scope): a named
-- owner writing through role_in() bypassed token scope entirely before this.

insert into t.ids select 'else', t.run('ana', $q$select public.create_vault('Elsewhere')$q$)::uuid;
select test_support.add_member(t.id('else'), t.id('cal'), 'owner', t.id('ana'));
select t.run('cal', format($q$select public.create_access_token('cal-ro', 30, array[%L]::uuid[], 'read')$q$, t.id('gone')));
select t.run('cal', format($q$select public.create_access_token('cal-rw', 30, array[%L]::uuid[], 'write')$q$, t.id('gone')));
select t.run('cal', format($q$select public.create_access_token('cal-else', 30, array[%L]::uuid[], 'write')$q$, t.id('else')));

select t.expect('write: Cal''s read-only token can''t write her owned path',
  t.run_tok('cal', 'cal-ro', format($q$select public.write_file(%L, 'canon/cal.md', 'ro token')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('write: refused, so the text is unchanged',
  (select body from public.file_versions fv join public.files f on f.current_version_id = fv.id
    where f.vault_id = t.id('gone') and f.path = 'canon/cal.md'),
  'Cal wrote this');
select t.expect('write: a token of Cal''s scoped only to another vault can''t write it either, live and write-access or not',
  t.run_tok('cal', 'cal-else', format($q$select public.write_file(%L, 'canon/cal.md', 'wrong vault token')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('write: a token of Cal''s properly scoped to this vault, write access, still can',
  t.run_tok('cal', 'cal-rw', format($q$select 'ok' from public.write_file(%L, 'canon/cal.md', 'via a scoped token')$q$, t.id('gone'))), 'ok');
select t.expect('write: Cal''s own unrestricted session still can too (regression check)',
  t.run('cal', format($q$select 'ok' from public.write_file(%L, 'canon/cal.md', 'Cal again, no token')$q$, t.id('gone'))), 'ok');
select t.expect('write: policy_for agrees with can_write_path: her read-only token sees this path as still canon, not open',
  t.run_tok('cal', 'cal-ro', format($q$select policy from private.rule_for(%L, 'canon/cal.md')$q$, t.id('gone'))), 'canon');

-- ---------------------------------------------------------------------------
-- decide(): quorum counts only the named owner's approval

insert into t.ids select 'shared_p', t.run('ben',
  format($q$select public.propose(%L, 'canon/shared.md', 'Bens proposal', 'why')$q$, t.id('gone')))::uuid;
select t.expect('decide: Cal, a viewer but the path''s owner, may call decide at all, and her lone approval meets quorum 1',
  t.run('cal', format($q$select public.decide(%L, 'approve')$q$, t.id('shared_p'))), 'applied');
select t.expect('decide: the proposal record agrees',
  (select status from public.proposals where id = t.id('shared_p')), 'applied');

insert into t.ids select 'shared_p2', t.run('ben',
  format($q$select public.propose(%L, 'canon/shared.md', 'Bens second', 'why')$q$, t.id('gone')))::uuid;
select t.expect('decide: Ben''s own approval of his own proposal does not count (he is not the owner)',
  t.run('ben', format($q$select public.decide(%L, 'approve')$q$, t.id('shared_p2'))), 'open');
select t.expect('decide: Ana''s approval, the vault owner but not this path''s owner, does not count either',
  t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('shared_p2'))), 'open');
select t.expect('decide: still open after both, only Cal''s approval would count',
  (select status from public.proposals where id = t.id('shared_p2')), 'open');
select t.expect('decide: Cal approves and it applies',
  t.run('cal', format($q$select public.decide(%L, 'approve')$q$, t.id('shared_p2'))), 'applied');
select t.expect('decide: the proposal record agrees',
  (select status from public.proposals where id = t.id('shared_p2')), 'applied');

-- Regression: a plain canon path with no owner still needs any owner or
-- editor's approval, exactly as before this migration.
select t.run('ana', format($q$select public.set_policy(%L, 'canon/plain.md', 'canon', 1)$q$, t.id('gone')));
insert into t.ids select 'plain_p', t.run('ben',
  format($q$select public.propose(%L, 'canon/plain.md', 'plain body', 'why')$q$, t.id('gone')))::uuid;
select t.expect('decide: on an unowned path, the proposer''s own editor approval still counts (unchanged)',
  t.run('ben', format($q$select public.decide(%L, 'approve')$q$, t.id('plain_p'))), 'applied');

-- ---------------------------------------------------------------------------
-- remove_path_owner, and the cascade off set_policy(null)

select t.expect('remove: an editor cannot remove an owner',
  t.run('ben', format($q$select 'ok' from public.remove_path_owner(%L, 'canon/cal.md', %L)$q$, t.id('gone'), t.id('cal'))), 'ERR 42501');
select t.expect('remove: removing someone who isn''t an owner is refused',
  t.run('ana', format($q$select 'ok' from public.remove_path_owner(%L, 'canon/cal.md', %L)$q$, t.id('gone'), t.id('ben'))), 'ERR P0002');
select t.expect('remove: the owner removes Cal',
  t.run('ana', format($q$select 'ok' from public.remove_path_owner(%L, 'canon/cal.md', %L)$q$, t.id('gone'), t.id('cal'))), 'ok');
select t.expect('remove: she is gone from the owner list',
  (select count(*)::text from public.path_owners where vault_id = t.id('gone') and path = 'canon/cal.md'), '0');
select t.expect('remove: Cal can no longer write canon/cal.md directly',
  t.run('cal', format($q$select public.write_file(%L, 'canon/cal.md', 'no longer mine')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('remove: logged',
  t.log_count('path_owner.remove'), '1');

select t.expect('cascade: the owner clears the policy on canon/shared.md',
  t.run('ana', format($q$select 'ok' from public.set_policy(%L, 'canon/shared.md', null)$q$, t.id('gone'))), 'ok');
select t.expect('cascade: Cal''s ownership of it went with the rule',
  (select count(*)::text from public.path_owners where vault_id = t.id('gone') and path = 'canon/shared.md'), '0');

-- ---------------------------------------------------------------------------
-- Membership: a path's owner list goes with it (20260928160000). A named
-- owner who leaves, is removed, or deletes their account loses that row and
-- the write / decide access it granted; a role change alone leaves it
-- untouched. canon/removed.md (Ben alone, quorum 1) covers set_member(...,
-- null); canon/quorum2.md (Ben and Cal, quorum 2) covers leave_vault and
-- proves a removed owner's earlier approval stops counting toward quorum;
-- a fresh user, Eve, covers delete_account.

select t.run('ana', format($q$select public.set_policy(%L, 'canon/removed.md', 'canon', 1)$q$, t.id('gone')));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/quorum2.md', 'canon', 2)$q$, t.id('gone')));
select t.run('ana', t.own_sql('canon/removed.md', 'ben'));
select t.run('ana', t.own_sql('canon/quorum2.md', 'ben'));
select t.run('ana', t.own_sql('canon/quorum2.md', 'cal'));

select t.expect('membership: before, Cal owns canon/quorum2.md alongside Ben',
  (select count(*)::text from public.path_owners where vault_id = t.id('gone') and path = 'canon/quorum2.md'), '2');
select t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, 'editor')$q$, t.id('gone'), t.id('cal')));
select t.expect('membership: a role change keeps the row',
  (select count(*)::text from public.path_owners where vault_id = t.id('gone') and path = 'canon/quorum2.md' and user_id = t.id('cal')), '1');
select t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, 'viewer')$q$, t.id('gone'), t.id('cal')));

insert into t.ids select 'quorum2_p', t.run('ana',
  format($q$select public.propose(%L, 'canon/quorum2.md', 'first draft', 'why')$q$, t.id('gone')))::uuid;
select t.expect('membership: Cal, still a named owner, approves; one of two isn''t quorum yet',
  t.run('cal', format($q$select public.decide(%L, 'approve')$q$, t.id('quorum2_p'))), 'open');

select t.run('cal', format($q$select 'ok' from public.leave_vault(%L)$q$, t.id('gone')));
select t.expect('membership: leaving the vault takes her ownership of both paths she owned',
  (select count(*)::text from public.path_owners where vault_id = t.id('gone') and user_id = t.id('cal')), '0');
select t.expect('membership: Cal can no longer write the path she used to own, having left',
  t.run('cal', format($q$select public.write_file(%L, 'canon/quorum2.md', 'cal after leaving')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('membership: nor call decide() on it, even to re-approve the same proposal',
  t.run('cal', format($q$select public.decide(%L, 'approve')$q$, t.id('quorum2_p'))), 'ERR P0002');

select t.expect('membership: Ben approves too; only his approval counts now, not Cal''s stale one, so quorum 2 still isn''t met',
  t.run('ben', format($q$select public.decide(%L, 'approve')$q$, t.id('quorum2_p'))), 'open');
select t.expect('membership: the proposal record agrees: still open',
  (select status from public.proposals where id = t.id('quorum2_p')), 'open');

select t.expect('membership: before, Ben owns canon/removed.md',
  (select count(*)::text from public.path_owners where vault_id = t.id('gone') and path = 'canon/removed.md'), '1');
select t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, null)$q$, t.id('gone'), t.id('ben')));
select t.expect('membership: removed by the owner, Ben loses the row too',
  (select count(*)::text from public.path_owners where vault_id = t.id('gone') and path = 'canon/removed.md'), '0');
select t.expect('membership: Ben can no longer write it',
  t.run('ben', format($q$select public.write_file(%L, 'canon/removed.md', 'ben after removal')::text$q$, t.id('gone'))), 'ERR 42501');
select t.expect('membership: nor delete it',
  t.run('ben', format($q$select public.delete_file(%L, 'canon/removed.md')::text$q$, t.id('gone'))), 'ERR 42501');

insert into t.ids values ('eve', '00000000-0000-0000-0000-00000000000e');
insert into auth.users (id, email) values (t.id('eve'), 'eve@example.test');
select test_support.add_member(t.id('gone'), t.id('eve'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/eve.md', 'canon', 1)$q$, t.id('gone')));
select t.run('ana', t.own_sql('canon/eve.md', 'eve'));
select t.expect('membership: before, Eve owns canon/eve.md',
  (select count(*)::text from public.path_owners where vault_id = t.id('gone') and path = 'canon/eve.md'), '1');
select t.run('eve', $q$select public.delete_account('eve@example.test')::text$q$);
select t.expect('membership: deleting her account takes the row',
  (select count(*)::text from public.path_owners where vault_id = t.id('gone') and path = 'canon/eve.md'), '0');
select t.expect('membership: her write access to it is gone with the rest of her account',
  t.run('eve', format($q$select public.write_file(%L, 'canon/eve.md', 'eve after deletion')::text$q$, t.id('gone'))), 'ERR 42501');
