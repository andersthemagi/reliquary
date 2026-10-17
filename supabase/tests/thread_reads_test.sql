-- Hostile tests for 20261017150000_thread_reads: what a person has read of
-- a thread is theirs alone, in person only. Ana owner, Ben editor, Cal
-- viewer, Dee outsider.

insert into t.ids select 'v1', t.run('ana', $q$select public.create_vault('Reads')$q$)::uuid;
select test_support.add_member(t.id('v1'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('v1'), t.id('cal'), 'viewer', t.id('ana'));
insert into t.ids select 'th', t.run('ana', format($q$select public.open_thread(%L, 'A thread', 'First.')$q$, t.id('v1')))::uuid;
select t.run('ben', format($q$select public.post_message(%L, 'Second.')$q$, t.id('th')));

create function t.mark(p_user text, p_as text, p_through bigint, p_agent text default null) returns text language sql as $$
  select coalesce(t.run(p_user, format($q$insert into public.thread_reads (user_id, vault_id, thread_id, last_message_id)
    values (%L, %L, %L, %s) on conflict (user_id, vault_id, thread_id) do update
    set last_message_id = greatest(public.thread_reads.last_message_id, excluded.last_message_id) returning last_message_id::text$q$,
    t.id(p_as), t.id('v1'), t.id('th'), p_through), p_agent), 'nothing') $$;
create function t.seen(p_user text, p_agent text default null) returns text language sql as $$
  select t.run(p_user, format($q$select coalesce(string_agg(user_id::text || ':' || last_message_id, ',' order by user_id), 'none')
    from public.thread_reads where thread_id = %L$q$, t.id('th')), p_agent) $$;
create function t.rows_of(p_user text) returns text language sql as
$$ select coalesce((select last_message_id::text from public.thread_reads where user_id = t.id(p_user) and thread_id = t.id('th')), 'none') $$;

select t.expect('thread reads: a member records their own read, in person, and it only moves forward',
  t.mark('ana', 'ana', 2) || ' ' || t.mark('ana', 'ana', 1) || ' ' || t.mark('ana', 'ana', 3) || ' ' || t.seen('ana') || ' ' || t.rows_of('ana'),
  '2 2 3 ' || t.id('ana') || ':3 3');

select t.expect('thread reads: a viewer records one too, and reads only their own',
  t.mark('cal', 'cal', 1) || ' ' || t.seen('cal'),
  '1 ' || t.id('cal') || ':1');

select t.expect('thread reads: another member of the same vault reads none of it',
  t.seen('ben'), 'none');

select t.expect('thread reads: another member can''t write or change it for them',
  t.mark('ben', 'ana', 9) || ' '
  || coalesce(t.run('ben', format($q$update public.thread_reads set last_message_id = 9 where user_id = %L returning 'changed'$q$, t.id('ana'))), 'nothing') || ' '
  || t.rows_of('ana'),
  'ERR 42501 nothing 3');

select t.expect('thread reads: the person''s agent reads none of it',
  t.seen('ana', 'Claude Code'), 'none');

select t.expect('thread reads: the person''s agent can''t write or change it either',
  t.mark('ana', 'ana', 9, 'Claude Code') || ' '
  || coalesce(t.run('ana', $q$update public.thread_reads set last_message_id = 9 returning 'changed'$q$, 'Claude Code'), 'nothing') || ' '
  || t.rows_of('ana'),
  'ERR 42501 nothing 3');

select t.expect('thread reads: nobody deletes one, the person included',
  coalesce(t.run('ana', $q$delete from public.thread_reads returning 'deleted'$q$), 'nothing') || ' ' || t.rows_of('ana'),
  'ERR 42501 3');

select t.expect('thread reads: an outsider can''t record one, and learns nothing',
  t.mark('dee', 'dee', 1) || ' ' || t.seen('dee') || ' ' || t.rows_of('dee'),
  'ERR 23503 none none');

select t.expect('thread reads: nothing an agent lists or reads says what its person has read',
  (t.run('ana', format($q$select public.read_thread(%L) -> 'thread' ? 'last_message_id'$q$, t.id('th')), 'Claude Code')) || ' '
  || (t.run('ana', format($q$select (to_jsonb(s) ?| array['unread', 'last_read', 'read']) from public.thread_summaries s where s.id = %L$q$, t.id('th')), 'Claude Code')),
  'true false');

select t.run('cal', format($q$select public.leave_vault(%L)$q$, t.id('v1')));
select t.expect('thread reads: the row goes with the membership',
  t.rows_of('cal'), 'none');
