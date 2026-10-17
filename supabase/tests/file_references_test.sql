-- References between files (20261017100000_file_references.sql, issue #393):
-- what a saved file's text refers to is kept per file, and only readers of
-- the vault see it, in either direction.
--
-- Ana owns Refs (canon/ is canon; Ben edits, Cal views) and Side; Dee owns
-- Other, where secret.md lives.

insert into t.ids select 'refs', t.run('ana', $q$select public.create_vault('Refs')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
insert into t.ids select 'other', t.run('dee', $q$select public.create_vault('Other')$q$)::uuid;
select test_support.add_member(t.id('refs'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('refs'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('refs')));
select t.run('ana', format($q$select public.create_access_token('ana-side', 30, array[%L]::uuid[], 'read')$q$, t.id('side')));

create function t.write(p_user text, p_vault text, p_path text, p_body text) returns text language sql as $$
  select t.run(p_user, format('select public.write_file(%L, %L, %L)::text', t.id(p_vault), p_path, p_body))
$$;
-- A file's references as the table owner sees them, comma separated.
create function t.refs_of(p_vault text, p_path text) returns text language sql as $$
  select coalesce(string_agg(target_path, ',' order by target_path), '')
    from public.file_references where vault_id = t.id(p_vault) and source_path = p_path
$$;
-- related_files as p_user (through p_tok when given), one "direction path policy [missing]" per row.
create function t.related(p_user text, p_vault text, p_path text, p_tok text default null) returns text language sql as $$
  select case when p_tok is null then t.run(p_user, q) else t.run_tok(p_user, p_tok, q) end
    from (select format($q$select coalesce(string_agg(direction || ' ' || path || ' ' || policy || case when missing then ' missing' else '' end, '; '), '')
                             from public.related_files(%L, %L)$q$, t.id(p_vault), p_path) as q) x
$$;

select t.run('ana', format($q$select public.decide(public.propose(%L, 'canon/pricing.md', 'Prices.', 'first'), 'approve')::text$q$, t.id('refs')));
select t.write('ben', 'refs', 'notes/a.md', $b$
See [[canon/pricing]] and [[people/ben.md|Ben]], [the brief](brief.md), [up](../index.md)
and [rooted](/canon/pricing.md#tiers).
$b$);

select t.expect('references: saving a file records its wiki and Markdown references as vault paths, each once',
  t.refs_of('refs', 'notes/a.md'), 'canon/pricing.md,index.md,notes/brief.md,people/ben.md');

select t.write('ben', 'refs', 'notes/noise.md', $b$
[web](https://example.com/x.md) [mail](mailto:a@example.com) [anchor](#top) [[#top]]
![diagram](pic.md) ![[photo.png]] [image](chart.png) [too far](../../out.md) [self](noise.md)
$b$);
select t.expect('references: URLs, anchors alone, images, non-.md links, paths above the root and the file itself are not references',
  t.refs_of('refs', 'notes/noise.md'), '');

select t.write('ben', 'refs', 'notes/a.md', 'Now only [[notes/brief]].');
select t.expect('references: editing a file replaces its references',
  t.refs_of('refs', 'notes/a.md'), 'notes/brief.md');

select t.expect('references: a reference to a path that doesn''t exist yet is kept and shows as missing',
  t.related('ben', 'refs', 'notes/a.md'), 'references notes/brief.md open missing');
select t.write('ben', 'refs', 'notes/brief.md', 'The brief. Back to [[notes/a]].');
select t.expect('references: once the target is written it is no longer missing, and it lists what refers to it',
  t.related('ben', 'refs', 'notes/brief.md'), 'references notes/a.md open; referenced_by notes/a.md open');

select t.write('ben', 'refs', 'notes/c.md', 'On [[canon/pricing]].');
select t.expect('references: a viewer sees both directions with each end''s policy, canon included',
  t.related('cal', 'refs', 'notes/c.md') || ' | ' || t.related('cal', 'refs', 'canon/pricing.md'),
  'references canon/pricing.md canon | referenced_by notes/c.md open');

select t.run('ben', format($q$select public.delete_file(%L, 'notes/brief.md')::text$q$, t.id('refs')));
select t.expect('references: deleting a file removes its outgoing references; those pointing at it stay, shown missing',
  t.refs_of('refs', 'notes/brief.md') || ' | ' || t.related('ben', 'refs', 'notes/a.md'),
  ' | references notes/brief.md open missing');
select t.write('ben', 'refs', 'notes/brief.md', 'Restored, citing [[canon/pricing]].');
select t.expect('references: writing a deleted file again records its new references',
  t.refs_of('refs', 'notes/brief.md'), 'canon/pricing.md');

select t.run('ben', format($q$select public.propose(%L, 'canon/terms.md', 'See [pricing](pricing.md).', 'terms')::text$q$, t.id('refs')));
select t.run('ana', format($q$select public.decide(id, 'approve')::text from public.proposals where vault_id = %L and path = 'canon/terms.md'$q$, t.id('refs')));
select t.expect('references: an approved proposal''s text records its references, as a direct write does',
  t.refs_of('refs', 'canon/terms.md'), 'canon/pricing.md');

-- ---------------------------------------------------------------------------
-- Hostile: a reference never shows a reader a file they can't read.

select t.write('dee', 'other', 'secret.md', 'Dee''s secret, citing [[plans]].');
select t.write('ana', 'refs', 'notes/guess.md', 'Guessing at [[secret]].');

select t.expect('references hostile: an outsider sees none of a vault''s references, in either direction',
  t.run('dee', format('select count(*)::text from public.file_references where vault_id = %L', t.id('refs')))
  || ',' || t.related('dee', 'refs', 'notes/c.md') || ',' || t.related('dee', 'refs', 'canon/pricing.md'),
  '0,,');
select t.expect('references hostile: a member''s token scoped to another vault sees none, in either direction',
  t.run_tok('ana', 'ana-side', format('select count(*)::text from public.file_references where vault_id = %L', t.id('refs')))
  || ',' || t.related('ana', 'refs', 'notes/c.md', 'ana-side') || ',' || t.related('ana', 'refs', 'canon/pricing.md', 'ana-side'),
  '0,,');
select t.expect('references hostile: anonymous callers read nothing',
  t.run(null, 'select count(*)::text from public.file_references') || ',' || t.run(null, format($q$select count(*)::text from public.related_files(%L, 'notes/c.md')$q$, t.id('refs'))),
  'ERR 42501,ERR 42501');
select t.expect('references hostile: text naming another vault''s file learns nothing about it; that file shows nothing referring to it',
  t.related('ana', 'refs', 'notes/guess.md') || ' | ' || t.related('dee', 'other', 'secret.md'),
  'references secret.md open missing | references plans.md open missing');
select t.expect('references hostile: nobody writes references directly, not even the owner, and the helpers aren''t callable',
  t.run('ana', format($q$insert into public.file_references values (%L, 'x.md', 'y.md') returning 'x'$q$, t.id('refs')))
  || ',' || t.run('ana', format($q$update public.file_references set target_path = 'z.md' where vault_id = %L returning 'x'$q$, t.id('refs')))
  || ',' || t.run('ana', format($q$delete from public.file_references where vault_id = %L returning 'x'$q$, t.id('refs')))
  || ',' || t.run('ana', $q$select count(*)::text from private.references_in('a.md', '[[b]]')$q$),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501');
