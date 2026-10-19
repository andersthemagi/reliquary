-- Hostile tests for 20261019140000_thread_emails: who is queued an email
-- about a thread, who may claim the queue, how a batch is cut, and the
-- person's own choice to turn these emails off. Who is told about a thread
-- at all is thread_flags_test.sql's rule; this mirrors it for email.
--
-- Team: Ana owns, Ben edits (with an agent connection), Cal views. Dee owns
-- a vault of her own and is an outsider to Team.

insert into auth.users (id, email) values (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'), (t.id('cal'), 'cal@example.test');
insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ben', format($q$select public.create_access_token('ben-agent', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('ana', $q$select public.set_display_name('Ana R.')$q$);
select t.run('ben', $q$select public.set_display_name('Ben')$q$);

-- Who is queued for a thread, unsent, by name, in order.
create function t.queued(p_thread text) returns text language sql as $$
  select coalesce(string_agg(i.name || ':' || e.message_id, ' ' order by e.message_id, i.name), 'none')
    from private.thread_emails e join t.ids i on i.id = e.user_id
   where e.thread_id = t.id(p_thread) and e.sent_at is null
$$;
-- The web app's claim, as "name vault/title opened messages writers through".
create function t.claim() returns text language sql as $$
  select coalesce(string_agg(concat_ws(' ', i.name, c.vault || '/' || c.title, case when c.opened then 'opened' else 'more' end, c.messages, coalesce(c.writers, '-'), c.through), ' / ' order by c.through, i.name), 'none')
    from private.claim_thread_emails(20) c join t.ids i on i.id = c.user_id
$$;
create function t.backdate() returns void language sql as $$
  update private.thread_emails set queued_at = now() - interval '3 minutes', claimed_at = null
$$;

insert into t.ids select 'vault-wide', t.run('ana', format($q$select public.open_thread(%L, 'Pick your roles', 'Who takes what?')$q$, t.id('team')))::uuid;

select t.expect('thread emails: a thread for the whole vault queues every other member, viewers included, and not its opener',
  t.queued('vault-wide'), 'ben:1 cal:1');

select t.expect('thread emails: only the web app''s role claims them; people, agents, the MCP and operator roles can''t',
  concat_ws(' ',
    t.run('ana', 'select count(*)::text from private.claim_thread_emails(5)'),
    t.run('ben', 'select count(*)::text from private.claim_thread_emails(5)', 'ben-agent'),
    t.run_role('reliquary_mcp', 'select count(*)::text from private.claim_thread_emails(5)'),
    t.run_role('reliquary_ops', 'select count(*)::text from private.claim_thread_emails(5)'),
    t.run('ana', format('select private.thread_emails_sent(%L, %L, 1)::text', t.id('ben'), t.id('vault-wide'))),
    t.run_role('reliquary_web', 'select count(*)::text from private.claim_thread_emails(5)')),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501 0');

select t.expect('thread emails: nothing is claimed until the thread has been quiet two minutes',
  t.claim(), 'none');

select t.run('ben', format($q$select public.post_message(%L, 'I take the backend.')$q$, t.id('vault-wide')), 'ben-agent');
select t.backdate();
select t.expect('thread emails: a batch is one claim per member and thread, saying it opened the thread, how many messages and who wrote; the agent''s person is not emailed about their agent''s post',
  t.claim(),
  'ben Team/Pick your roles opened 1 Ana R. 1 / ana Team/Pick your roles more 1 Ben 2 / cal Team/Pick your roles opened 2 Ana R., Ben 2');
select t.expect('thread emails: a claimed batch is not claimed again while its claim holds',
  t.claim(), 'none');

select t.run_role('reliquary_web', format('select private.thread_emails_sent(%L, %L, 2)::text', t.id('cal'), t.id('vault-wide')));
select t.run('ana', format($q$select public.post_message(%L, 'And I the slides.')$q$, t.id('vault-wide')));
select t.backdate();
select t.expect('thread emails: once sent, only what came after is queued again; the unsent ones come back when their claim lapses',
  t.queued('vault-wide') || ' | ' || t.claim(),
  'ben:1 ana:2 ben:3 cal:3 | ana Team/Pick your roles more 1 Ben 2 / ben Team/Pick your roles opened 2 Ana R. 3 / cal Team/Pick your roles more 1 Ana R. 3');

select t.run_role('reliquary_web', format('select private.thread_emails_sent(%L, %L, 3)::text', t.id('ben'), t.id('vault-wide')));
select t.run_role('reliquary_web', format('select private.thread_emails_sent(%L, %L, 3)::text', t.id('cal'), t.id('vault-wide')));
select t.run_role('reliquary_web', format('select private.thread_emails_sent(%L, %L, 2)::text', t.id('ana'), t.id('vault-wide')));

insert into t.ids select 'side', t.run('ana', format($q$select public.open_thread(%L, 'Just us', 'Ben, a word?', array[%L]::uuid[])$q$, t.id('team'), t.id('ben')))::uuid;
select t.run('ben', format($q$select public.post_message(%L, 'Sure.')$q$, t.id('side')));
select t.expect('thread emails: a side thread queues its addressees when it opens, and its participants after that, never the viewer',
  t.queued('side'), 'ben:4 ana:5');

select t.run('ben', $q$select public.set_thread_emails(false)$q$);
select t.backdate();
select t.expect('thread emails: a member who turned them off is not claimed; others are',
  t.claim(), 'ana Team/Just us more 1 Ben 5');
select t.run_role('reliquary_web', format('select private.thread_emails_sent(%L, %L, 5)::text', t.id('ana'), t.id('side')));

select t.expect('thread emails: the choice is the person''s own, in person: an agent can''t make it, nor read it',
  concat_ws(' ',
    t.run('ben', 'select public.set_thread_emails(true)::text', 'ben-agent'),
    t.run('ben', 'select count(*)::text from public.notification_preferences', 'ben-agent'),
    t.run('ana', 'select count(*)::text from public.notification_preferences'),
    t.run('ben', 'select thread_emails::text from public.notification_preferences')),
  'ERR 42501 0 0 false');

select t.run('ben', $q$select public.set_thread_emails(true)$q$);
select t.run('ana', format($q$select public.resolve_thread(%L)$q$, t.id('side')));
select t.run('ana', format($q$select public.post_message(%L, 'Hello?')$q$, t.id('vault-wide')));
select t.backdate();
select t.expect('thread emails: a resolved thread is not claimed, and turning emails back on brings a member''s queued ones back',
  t.claim(), 'ben Team/Pick your roles more 1 Ana R. 6 / cal Team/Pick your roles more 1 Ana R. 6');

select t.run('cal', format($q$select public.leave_vault(%L)$q$, t.id('team')));
select t.expect('thread emails: a member who leaves the vault takes their queue with them',
  (select count(*)::text from private.thread_emails where user_id = t.id('cal')), '0');
