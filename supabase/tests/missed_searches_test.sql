-- Hostile tests for 20261017140000_missed_searches: searches that found
-- nothing are read and cleared only by the vault's owners in person, written
-- only through private.note_missed_search (and only for words that really
-- find nothing), never say who searched, and age out by the vault's period.
--
-- Ana owns Team (Ben edits, Cal views); Dee owns Other.

insert into t.ids select 'v1', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
select test_support.add_member(t.id('v1'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('v1'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.write_file(%L, 'notes/garden.md', 'Tomatoes need sun.')$q$, t.id('v1')));
insert into t.ids select 'v2', t.run('dee', $q$select public.create_vault('Other')$q$)::uuid;

create function t.note(p_user text, p_vault text, p_words text, p_agent text default null) returns text language sql as $$
  select t.run(p_user, format($q$select private.note_missed_search(%L, %L)::text$q$, t.id(p_vault), p_words), p_agent)
$$;
create function t.listed(p_user text, p_vault text, p_agent text default null) returns text language sql as $$
  select t.run(p_user, format($q$select coalesce(string_agg(words || ':' || by_agent, ',' order by id), '') from public.missed_searches where vault_id = %L$q$,
    t.id(p_vault)), p_agent)
$$;

-- ---------------------------------------------------------------------------
-- Recording

select t.expect('record: a member''s search that finds nothing is written, as a person''s or an agent''s',
  t.note('cal', 'v1', 'pricing') || ' ' || t.note('ben', 'v1', 'onboarding', 'Claude Code') || ' ' || t.listed('ana', 'v1'),
  'true true pricing:false,onboarding:true');
select t.expect('record: words that find a file are not written, even called directly',
  t.note('ben', 'v1', 'tomatoes') || ' ' || t.note('ben', 'v1', 'garden') || ' ' || t.listed('ana', 'v1'),
  'false false pricing:false,onboarding:true');
select t.expect('record: someone outside the vault writes nothing to it',
  t.note('dee', 'v1', 'planted') || ' ' || t.note(null, 'v1', 'planted') || ' ' || t.listed('ana', 'v1'),
  'false ERR 42501 pricing:false,onboarding:true');
select t.expect('record: the words are trimmed and cut at 200 characters; blank words write nothing',
  t.note('ana', 'v2', '  ') || ' ' || t.note('dee', 'v2', '  ' || repeat('q', 250))
  || ' ' || t.run('dee', format($q$select length(words)::text from public.missed_searches where vault_id = %L$q$, t.id('v2'))),
  'false true 200');
select t.expect('record: a row holds the words, the vault, person or agent, and when; no column says who',
  (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
    where table_schema = 'public' and table_name = 'missed_searches'),
  'id,vault_id,words,by_agent,searched_at');

-- ---------------------------------------------------------------------------
-- Reading and clearing

select t.expect('read: an editor, a viewer and someone outside the vault see none of it',
  t.listed('ben', 'v1') || '|' || t.listed('cal', 'v1') || '|' || t.listed('dee', 'v1'), '||');
select t.expect('read: an owner''s agent sees none of it',
  t.listed('ana', 'v1', 'Claude Code'), '');
select t.expect('read: an owner of another vault sees none of this one''s',
  t.run('dee', $q$select count(*)::text from public.missed_searches$q$), '1');
select t.expect('write: nobody inserts a row directly, not even an owner',
  t.run('ana', format($q$insert into public.missed_searches (vault_id, words, by_agent) values (%L, 'forged', false) returning words$q$, t.id('v1'))),
  'ERR 42501');
select t.expect('write: nobody changes a row, not even an owner',
  t.run('ana', $q$update public.missed_searches set words = 'changed' returning words$q$), 'ERR 42501');
select t.expect('clear: an editor, a viewer, an owner''s agent and an outsider delete nothing',
  t.run('ben', format($q$with d as (delete from public.missed_searches where vault_id = %L returning 1) select count(*)::text from d$q$, t.id('v1'))) || ' '
  || t.run('cal', format($q$with d as (delete from public.missed_searches where vault_id = %L returning 1) select count(*)::text from d$q$, t.id('v1'))) || ' '
  || t.run('ana', format($q$with d as (delete from public.missed_searches where vault_id = %L returning 1) select count(*)::text from d$q$, t.id('v1')), 'Claude Code') || ' '
  || t.run('dee', format($q$with d as (delete from public.missed_searches where vault_id = %L returning 1) select count(*)::text from d$q$, t.id('v1'))) || ' '
  || t.listed('ana', 'v1'),
  '0 0 0 0 pricing:false,onboarding:true');

-- ---------------------------------------------------------------------------
-- Retention

select t.expect('keep: a vault keeps searches 30 days unless an owner says otherwise',
  (select missed_search_days::text from public.vaults where id = t.id('v1')), '30');
select t.expect('keep: an editor, a viewer, an outsider and an owner''s agent can''t change the period',
  t.run('ben', format($q$select public.set_missed_search_days(%L, 7)::text$q$, t.id('v1'))) || ' '
  || t.run('cal', format($q$select public.set_missed_search_days(%L, 7)::text$q$, t.id('v1'))) || ' '
  || t.run('dee', format($q$select public.set_missed_search_days(%L, 7)::text$q$, t.id('v1'))) || ' '
  || t.run('ana', format($q$select public.set_missed_search_days(%L, 7)::text$q$, t.id('v1')), 'Claude Code') || ' '
  || (select missed_search_days::text from public.vaults where id = t.id('v1')),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 30');
select t.expect('keep: the period is 1 to 365 days',
  t.run('ana', format($q$select public.set_missed_search_days(%L, 0)::text$q$, t.id('v1'))) || ' '
  || t.run('ana', format($q$select public.set_missed_search_days(%L, 366)::text$q$, t.id('v1'))),
  'ERR 22023 ERR 22023');
update public.missed_searches set searched_at = now() - interval '10 days' where words = 'pricing';
select t.expect('keep: an owner shortening the period drops what is now too old at once',
  t.run('ana', format($q$select public.set_missed_search_days(%L, 7)::text$q$, t.id('v1'))) || ' ' || t.listed('ana', 'v1'),
  ' onboarding:true');
update public.missed_searches set searched_at = now() - interval '8 days' where words = 'onboarding';
select t.expect('keep: the next search that finds nothing drops rows older than the period',
  t.note('ben', 'v1', 'compost') || ' ' || t.listed('ana', 'v1'), 'true compost:false');

select t.expect('clear: an owner in person clears the list',
  t.run('ana', format($q$with d as (delete from public.missed_searches where vault_id = %L returning 1) select count(*)::text from d$q$, t.id('v1')))
  || ' ' || t.listed('ana', 'v1'),
  '1 ');

-- ---------------------------------------------------------------------------
-- The cap

insert into public.missed_searches (vault_id, words, by_agent)
  select t.id('v1'), 'junk ' || i, true from generate_series(1, 510) i;
select t.expect('cap: a vault keeps only its newest 500 searches that found nothing, however many are noted',
  t.note('ben', 'v1', 'compost heap') || ' '
  || t.run('ana', format($q$select count(*) || ' ' || bool_or(words = 'compost heap') || ' '
                             || bool_or(words = 'junk 12') || ' ' || bool_or(words = 'junk 11')
                             from public.missed_searches where vault_id = %L$q$, t.id('v1'))),
  'true 500 true true false');

-- ---------------------------------------------------------------------------
-- Deleting the vault

select t.run('dee', format($q$select public.delete_vault(%L, 'Other')::text$q$, t.id('v2')));
select t.expect('delete: deleting a vault takes its searches that found nothing with it',
  (select count(*)::text from public.missed_searches where vault_id = t.id('v2')), '0');
