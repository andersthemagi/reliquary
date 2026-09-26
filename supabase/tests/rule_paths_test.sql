-- Hostile tests for 20260926120000_rule_paths: a rule's path is a path
-- inside the vault, checked like a file's path; each refusal names the path
-- and why; a rule saved before the check can still be removed.

insert into t.ids select 'rp', t.run('ana', $q$select public.create_vault('Rule paths')$q$)::uuid;
select test_support.add_member(t.id('rp'), t.id('ben'), 'editor', t.id('ana'));

-- The error message p_sql raises as p_user (NULL if it doesn't raise).
create function t.rp_err(p_user text, p_sql text) returns text
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

create function t.rp_set(p_path text, p_policy text default 'canon') returns text
language sql as $$
  select t.rp_err('ana', format('select public.set_policy(%L, %L, %L, 1)', t.id('rp'), p_path, p_policy))
$$;

create function t.rp_rules() returns bigint language sql as $$
  select count(*) from public.path_policies where vault_id = t.id('rp')
$$;

-- ---------------------------------------------------------------------------
-- Refused, with the path and the reason

select t.expect_true('rule paths: .. is refused as outside the vault',
  t.rp_set('../x') = '22023 The rule on "../x" has a .. segment, which points outside the vault: name the folder or file inside the vault, like clients/',
  t.rp_set('../x'));
select t.expect_true('rule paths: .. inside a path is refused',
  t.rp_set('clients/../x/') like '22023 The rule on "clients/../x/" has a .. segment%', t.rp_set('clients/../x/'));
select t.expect_true('rule paths: a folder rule that is .. is refused',
  t.rp_set('../') like '22023 The rule on "../" has a .. segment%', t.rp_set('../'));
select t.expect_true('rule paths: a trailing .. is refused',
  t.rp_set('clients/..') like '22023 %has a .. segment%', t.rp_set('clients/..'));
select t.expect_true('rule paths: an absolute path is refused',
  t.rp_set('/x') = '22023 The rule on "/x" starts with /: paths in a vault are relative, so write clients/ rather than /clients/',
  t.rp_set('/x'));
select t.expect_true('rule paths: / alone is refused',
  t.rp_set('/') like '22023 The rule on "/" starts with /%', t.rp_set('/'));
select t.expect_true('rule paths: an empty segment is refused',
  t.rp_set('a//b.md') like '22023 The rule on "a//b.md" has an empty folder name%', t.rp_set('a//b.md'));
select t.expect_true('rule paths: a folder rule ending in // is refused',
  t.rp_set('clients//') like '22023 %has an empty folder name%', t.rp_set('clients//'));
select t.expect_true('rule paths: a . segment is refused',
  t.rp_set('./clients/') like '22023 The rule on "./clients/" has a . segment%', t.rp_set('./clients/'));
select t.expect_true('rule paths: an empty path is refused',
  t.rp_set('') like '22023 A rule needs a path%', t.rp_set(''));
select t.expect_true('rule paths: a null path is refused',
  t.rp_set(null) like '22023 A rule needs a path%', t.rp_set(null));
select t.expect_true('rule paths: a control character is refused without quoting the path',
  t.rp_set(E'notes/\nforged') like '22023 A rule''s path can''t contain control characters%'
  and t.rp_set(E'notes/\nforged') not like '%forged%', t.rp_set(E'notes/\nforged'));
select t.expect_true('rule paths: a tab is refused',
  t.rp_set(E'a\tb/') like '22023 %control characters%', t.rp_set(E'a\tb/'));
select t.expect_true('rule paths: a path over 1024 characters is refused',
  t.rp_set(repeat('a', 1025)) like '22023 A rule''s path can be at most 1024 characters; this one has 1025', left(t.rp_set(repeat('a', 1025)), 120));
select t.expect_true('rule paths: removing a rule on a bad path that doesn''t exist is refused too',
  t.rp_set('../x', null) like '22023 %has a .. segment%', t.rp_set('../x', null));
select t.expect('rule paths: nothing refused was stored', t.rp_rules()::text, '0');
select t.expect('rule paths: nothing refused was logged',
  (select count(*) from public.log where vault_id = t.id('rp') and event = 'policy.set')::text, '0');

-- ---------------------------------------------------------------------------
-- Accepted: the paths a file can have, and folders of them

select t.expect('rule paths: a folder rule is accepted', t.rp_set('clients/'), null);
select t.expect('rule paths: a nested file rule is accepted', t.rp_set('clients/acme/brief.md'), null);
select t.expect('rule paths: dots inside names are accepted', t.rp_set('.github/..notes.md'), null);
select t.expect('rule paths: a backslash is accepted, as in a file path', t.rp_set('win\dows/'), null);
select t.expect('rule paths: 1024 characters are accepted', t.rp_set(repeat('a', 1024)), null);
select t.expect('rule paths: the accepted rules are stored', t.rp_rules()::text, '5');

-- The same rule as a file path: for each sample, a file path is valid
-- exactly when a rule on it (and on it as a folder) is accepted.
-- valid_path raises rather than returning false.
create function t.file_ok(p text) returns boolean language plpgsql as $$
begin perform private.valid_path(p); return true; exception when others then return false; end $$;
select t.expect_true('rule paths: rules and file paths agree, sample by sample',
  not exists (
    select 1 from unnest(array['a.md', 'x/y.md', '../x', 'a/../b', './a', 'a/./b', '/abs', 'a//b',
                               E'a\nb', E'a\u0001b', 'a\b', '...', '..a', 'a..', '.hidden', repeat('b', 1025)]) p
    where t.file_ok(p) is distinct from
          (private.rule_path_problem(p) is null and private.rule_path_problem(p || '/') is null)
  ));

-- ---------------------------------------------------------------------------
-- Who: the path check doesn't open anything up

select t.expect('rule paths: an editor is still refused before the path is looked at',
  left(t.rp_err('ben', format($q$select public.set_policy(%L, '../x', 'canon', 1)$q$, t.id('rp'))), 5), '42501');
select t.expect('rule paths: an agent is still refused',
  t.run('ana', format($q$select public.set_policy(%L, 'ok/', 'canon', 1)$q$, t.id('rp')), 'Claude Code'), 'ERR 42501');
select t.expect('rule paths: an outsider is still refused',
  left(t.rp_err('dee', format($q$select public.set_policy(%L, 'ok/', 'canon', 1)$q$, t.id('rp'))), 5), '42501');
select t.expect('rule paths: nobody signed in can call the checker',
  t.run('ana', $q$select private.rule_path_problem('x')$q$), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- Rules saved before the check: left alone, removable, not changeable

-- An old row, as production may have: put in with the constraint off.
alter table public.path_policies drop constraint path_policies_path_inside;
insert into public.path_policies (vault_id, path, policy, quorum) values (t.id('rp'), '../old', 'canon', 1);
alter table public.path_policies add constraint path_policies_path_inside
  check (path <> '' and path !~ '^/' and path !~ '//' and path !~ '(^|/)\.\.?(/|$)') not valid;

select t.expect_true('rule paths: an old bad rule can''t be changed',
  t.rp_set('../old', 'open') like '22023 %has a .. segment%', t.rp_set('../old', 'open'));
select t.expect('rule paths: an old bad rule can be removed', t.rp_set('../old', null), null);
select t.expect('rule paths: and is gone',
  (select count(*) from public.path_policies where vault_id = t.id('rp') and path = '../old')::text, '0');
select t.owner_error('rule paths: the table refuses a .. path from any writer',
  format($q$insert into public.path_policies (vault_id, path, policy) values (%L, 'a/../b/', 'canon')$q$, t.id('rp')));
select t.owner_error('rule paths: the table refuses a . segment from any writer',
  format($q$insert into public.path_policies (vault_id, path, policy) values (%L, './b/', 'canon')$q$, t.id('rp')));
