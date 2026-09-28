-- Hostile tests for 20260926130000_portable_paths: a new file path can't
-- hold what Windows reads otherwise (a backslash, a colon, * ? " < > |, a
-- name ending in a dot or space, a device name), whoever writes it and
-- however; each refusal says why without quoting the path; a path already
-- in the vault keeps working.

insert into t.ids select 'pp', t.run('ana', $q$select public.create_vault('Portable paths')$q$)::uuid;
select test_support.add_member(t.id('pp'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('pp'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 1)$q$, t.id('pp')));

-- The error p_sql raises as p_user (and their agent, if given): SQLSTATE
-- and message, or NULL if it doesn't raise.
create function t.pp_err(p_user text, p_sql text, p_agent text default null) returns text
language plpgsql as $$
declare
  claims jsonb := jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated');
begin
  if p_agent is not null then
    claims := claims || jsonb_build_object('act', jsonb_build_object('sub', 'agent-1', 'name', p_agent));
  end if;
  perform set_config('request.jwt.claims', claims::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql;
  perform set_config('role', 'none', true);
  return null;
exception when others then
  perform set_config('role', 'none', true);
  return sqlstate || ' ' || sqlerrm;
end $$;

-- The error p_sql raises as the table owner, or NULL.
create function t.pp_owner(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;

create function t.pp_write(p_path text, p_agent text default null) returns text language sql as $$
  select t.pp_err('ben', format('select public.write_file(%L, %L, %L)', t.id('pp'), p_path, 'text'), p_agent)
$$;
create function t.pp_propose(p_path text, p_agent text default null, p_delete boolean default false) returns text
language sql as $$
  select t.pp_err('ben', format('select public.propose(%L, %L, %L, %L, %L)', t.id('pp'), p_path, 'text', 'why', p_delete), p_agent)
$$;

-- ---------------------------------------------------------------------------
-- Refused, with the reason

select t.expect_true('portable paths: ..\x is refused as a backslash',
  t.pp_write('..\x.md') = '22023 A file path can''t contain a backslash (\): Windows reads it as a folder separator, so an exported copy could land outside its folder. Use / between folders, like clients/acme/brief.md',
  t.pp_write('..\x.md'));
select t.expect_true('portable paths: a\..\..\x is refused',
  t.pp_write('a\..\..\x.md') like '22023 %backslash%', t.pp_write('a\..\..\x.md'));
select t.expect_true('portable paths: a backslash in a proposal is refused',
  t.pp_propose('canon\..\..\x.md') like '22023 %backslash%', t.pp_propose('canon\..\..\x.md'));
select t.expect_true('portable paths: an agent''s backslash is refused over write_file',
  t.pp_write('notes\x.md', 'Claude Code') like '22023 %backslash%', t.pp_write('notes\x.md', 'Claude Code'));
select t.expect_true('portable paths: an agent''s backslash is refused over propose',
  t.pp_propose('canon\x.md', 'Claude Code') like '22023 %backslash%', t.pp_propose('canon\x.md', 'Claude Code'));
select t.expect_true('portable paths: a drive letter is refused',
  t.pp_write('C:evil.md') = '22023 A file path can''t contain any of : * ? " < > | (this one has :): Windows can''t hold them in a name, and a colon can name a drive. Use a dash instead, like "Meeting - notes.md"',
  t.pp_write('C:evil.md'));
select t.expect_true('portable paths: a stream name is refused',
  t.pp_write('notes/a:b.md') like '22023 %(this one has :)%', t.pp_write('notes/a:b.md'));
select t.expect_true('portable paths: the refusal lists each reserved character once',
  t.pp_write('notes/why?*?.md') like '22023 %(this one has * ?)%', t.pp_write('notes/why?*?.md'));
select t.expect_true('portable paths: < > | and " are refused',
  t.pp_write('a<b>|"c".md') like '22023 %(this one has " < > |)%', t.pp_write('a<b>|"c".md'));
select t.expect_true('portable paths: a name ending in a dot is refused',
  t.pp_write('notes/plan.') like '22023 A file or folder name can''t end in a dot or a space%', t.pp_write('notes/plan.'));
select t.expect_true('portable paths: ... is refused',
  t.pp_write('notes/.../x.md') like '22023 %end in a dot or a space%', t.pp_write('notes/.../x.md'));
select t.expect_true('portable paths: ".. " is refused',
  t.pp_write('notes/.. /x.md') like '22023 %end in a dot or a space%', t.pp_write('notes/.. /x.md'));
select t.expect_true('portable paths: a folder ending in a space is refused',
  t.pp_write('notes /x.md') like '22023 %end in a dot or a space%', t.pp_write('notes /x.md'));
select t.expect_true('portable paths: CON is refused with and without an extension',
  t.pp_write('notes/con.md') = '22023 A file or folder can''t be named CON, with or without an extension: Windows reserves the name for a device. Add a word, like con-notes.md'
  and t.pp_write('CON') like '22023 %named CON,%', t.pp_write('notes/con.md'));
select t.expect_true('portable paths: device names as folders are refused',
  t.pp_write('nul/x.md') like '22023 %named NUL,%' and t.pp_write('Lpt1.tar.gz') like '22023 %named LPT1,%'
  and t.pp_write('com9 .md') like '22023 %named COM9,%' and t.pp_write('aux') like '22023 %named AUX,%'
  and t.pp_write('prn.txt') like '22023 %named PRN,%' and t.pp_write('conin$') like '22023 %named CONIN$,%',
  t.pp_write('com9 .md'));
select t.expect_true('portable paths: a refusal never quotes the path back',
  t.pp_write('ECHOMARKER\x.md') not like '%ECHOMARKER%' and t.pp_write('ECHOMARKER:x.md') not like '%ECHOMARKER%'
  and t.pp_write('ECHOMARKER/con') not like '%ECHOMARKER%', t.pp_write('ECHOMARKER\x.md'));
select t.expect('portable paths: nothing refused was stored',
  (select count(*) from public.files where vault_id = t.id('pp'))::text
    || '/' || (select count(*) from public.proposals where vault_id = t.id('pp'))::text, '0/0');
select t.expect('portable paths: nothing refused was logged',
  (select count(*) from public.log where vault_id = t.id('pp') and event in ('file.write', 'proposal.open'))::text, '0');

-- Any writer, not only the functions: the table owner is refused too.
select t.expect_true('portable paths: a backslash inserted into files by any writer is refused',
  t.pp_owner(format($q$insert into public.files (vault_id, path) values (%L, 'a\..\x.md')$q$, t.id('pp')))
    like '22023 %backslash%');
select t.expect_true('portable paths: a device name inserted into proposals by any writer is refused',
  t.pp_owner(format($q$insert into public.proposals (vault_id, kind, path, body, proposed_by) values (%L, 'write', 'aux.md', 'x', %L)$q$,
                    t.id('pp'), t.id('ana'))) like '22023 %named AUX,%');

-- ---------------------------------------------------------------------------
-- Accepted: ordinary names, including ones that only look close

select t.expect('portable paths: a nested path is accepted', t.pp_write('notes/2026-09-26 kickoff.md'), null);
select t.expect('portable paths: a name that starts with a device name is accepted', t.pp_write('notes/console.md'), null);
select t.expect('portable paths: con-notes is accepted', t.pp_write('con-notes.md'), null);
select t.expect('portable paths: dots inside and at the start of names are accepted', t.pp_write('.github/..notes.v2.md'), null);
select t.expect('portable paths: unicode is accepted', t.pp_write('café/résumé ¿qué.md'), null);
select t.expect('portable paths: a proposal on an ordinary path is accepted', t.pp_propose('canon/plan.md'), null);

-- ---------------------------------------------------------------------------
-- Paths saved before the check: still written, proposed and deleted

-- Old rows, as production may have: put in with the trigger off.
alter table public.files disable trigger files_portable_path;
insert into public.files (vault_id, path) values (t.id('pp'), 'old\notes.md'), (t.id('pp'), 'canon/old:plan.md');
alter table public.files enable trigger files_portable_path;

select t.expect('portable paths: an existing backslash path can still be written', t.pp_write('old\notes.md'), null);
select t.expect('portable paths: an agent can still write it', t.pp_write('old\notes.md', 'Claude Code'), null);
select t.expect('portable paths: an existing canon path can still be proposed', t.pp_propose('canon/old:plan.md'), null);
select t.expect('portable paths: an existing path can be proposed for deletion',
  t.pp_propose('canon/old:plan.md', null, true), null);
select t.expect('portable paths: an existing path can be deleted',
  t.pp_err('ben', format($q$select public.delete_file(%L, 'old\notes.md')$q$, t.id('pp'))), null);
select t.expect('portable paths: a deleted old path can be written again', t.pp_write('old\notes.md'), null);
select t.expect_true('portable paths: an old path in one vault opens nothing in another',
  t.pp_err('ana', format($q$select public.write_file(%L, 'old\notes.md', 'x')$q$,
    t.run('ana', $q$select public.create_vault('Portable paths 2')$q$))) like '22023 %backslash%');
select t.expect_true('portable paths: an existing file can''t be moved to a backslash path',
  t.pp_owner(format($q$update public.files set path = 'moved\x.md' where vault_id = %L and path = 'notes/console.md'$q$, t.id('pp')))
    like '22023 %backslash%');

-- ---------------------------------------------------------------------------
-- Who: the check opens nothing up, and nobody signed in can call it

select t.expect('portable paths: a viewer is still refused',
  left(t.pp_err('cal', format($q$select public.write_file(%L, 'ok.md', 'x')$q$, t.id('pp'))), 5), '42501');
select t.expect('portable paths: an outsider is still refused',
  left(t.pp_err('dee', format($q$select public.write_file(%L, 'ok.md', 'x')$q$, t.id('pp'))), 5), '42501');
select t.expect('portable paths: nobody signed in can call the checker',
  t.run('ana', $q$select private.portable_path_problem('x')$q$), 'ERR 42501');
