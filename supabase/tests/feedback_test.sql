-- Hostile tests for 20260926163000_feedback: sending feedback
-- (send_feedback), reading it (RLS on public.feedback), the operator's
-- controls (reliquary_ops) and the web app's notice claims. Ana owns Team
-- (Ben edits it); Dee owns Dee own. Eve has no vault.

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids values ('eve', '00000000-0000-0000-0000-0000000000e1');
insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'),
  (t.id('cal'), 'cal@example.test'), (t.id('dee'), 'dee@example.test'),
  (t.id('eve'), 'eve@example.test');

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'deev', t.run('dee', $q$select public.create_vault('Dee own')$q$)::uuid;
insert into t.ids select 'gone', t.run('ana', $q$select public.create_vault('Gone')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));

-- As t.run, but an error comes back as "<sqlstate> <message>".
create function t.msg(p_user text, p_sql text, p_agent text default null)
returns text language plpgsql as $$
declare
  v text;
  v_state text;
  v_msg text;
  claims jsonb := case when p_user is null then '{}'::jsonb
                       else jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated') end;
begin
  if p_agent is not null then
    claims := claims || jsonb_build_object('act', jsonb_build_object('sub', 'agent-1', 'name', p_agent));
  end if;
  perform set_config('request.jwt.claims', claims::text, true);
  perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return v;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  perform set_config('role', 'none', true);
  return v_state || ' ' || v_msg;
end $$;

-- Tokens, OAuth and CLI grants, used the way the MCP server and the env
-- API do (act.tok = the token's id).
create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;
-- As t.msg, through a token.
create function t.msg_tok(p_user text, p_tok text, p_sql text) returns text language plpgsql as $$
declare
  v text;
  v_state text;
  v_msg text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok)))::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql into v;
  perform set_config('role', 'none', true);
  return v;
exception when others then
  get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  perform set_config('role', 'none', true);
  return v_state || ' ' || v_msg;
end $$;
select t.run('ana', $q$select public.create_access_token('ana-all-rw', 30, null, 'write')$q$);
select t.run('ana', $q$select public.create_access_token('ana-all-ro', 30, null, 'read')$q$);
select t.run('ana', format($q$select public.create_access_token('ana-gone-only', 30, array[%L]::uuid[], 'write')$q$, t.id('gone')));
select t.run('ana', $q$select public.create_access_token('ana-revoked', 30)$q$);
update public.access_tokens set revoked_at = now() where name = 'ana-revoked';
update public.access_tokens set client_name = 'claude-code' where name = 'ana-all-ro';
insert into public.access_tokens (user_id, name, kind, client_id, resource, expires_at, access)
values (t.id('ana'), 'ana-oauth', 'oauth', 'https://client.example/meta.json', 'https://mcp.example/mcp', now() + interval '30 days', 'read'),
       (t.id('ana'), 'ana-cli', 'cli', 'https://app.example/cli/oauth-client.json', 'https://app.example/api/env', now() + interval '30 days', 'read');

create function t.send(p_kind text, p_message text, p_vault text default null, p_context text default null) returns text
language sql as $$
  select format('select public.send_feedback(%L, %L, %L, %L)::text', p_kind, p_message, t.id(p_vault), p_context)
$$;
create function t.expect(p_name text, p_got boolean, p_want boolean) returns void language sql as
$$ select t.expect(p_name, p_got::text, p_want::text) $$;
create function t.count_of(p_user text) returns text language sql as
$$ select count(*)::text from public.feedback where user_id = t.id(p_user) $$;

-- ---------------------------------------------------------------------------
-- Sending

insert into t.ids select 'f1', t.run('ana', t.send('bug', E'  The diff view\n\tloses a line.  \n', 'team', E'/v/x/file?path=a.md\n'))::uuid;
select t.expect('send: a person sends feedback; it is stored trimmed, from the web UI, as new, with its vault and context',
  (select concat_ws(' | ', kind, message, (vault_id = t.id('team'))::text, context, source, coalesce(agent, '-'), status, (user_id = t.id('ana'))::text)
     from public.feedback where id = t.id('f1')),
  E'bug | The diff view\n\tloses a line. | true | /v/x/file?path=a.md | web | - | new | true');
select t.expect('send: every kind is taken',
  (t.run('ana', t.send('idea', 'An idea.')) not like 'ERR%' and t.run('ana', t.send('question', 'A question?')) not like 'ERR%'
   and t.run('ana', t.send('other', 'Other.')) not like 'ERR%')::text,
  'true');
select t.expect('send: an unknown kind, an empty or blank message, one over 5000 characters and control characters are refused in words',
  t.msg('ana', t.send('rant', 'x')) || ' / ' || t.msg('ana', t.send('bug', '')) || ' / ' || t.msg('ana', t.send('bug', E' \n\t '))
  || ' / ' || t.msg('ana', t.send('bug', repeat('x', 5001))) || ' / ' || t.msg('ana', t.send('bug', 'bell' || chr(7))),
  '22023 choose what kind of feedback this is: bug, idea, question or other / '
  || '22023 write a message: feedback can''t be empty / 22023 write a message: feedback can''t be empty / '
  || '22023 feedback is at most 5000 characters (this is 5001): shorten it or summarise the log / '
  || '22023 feedback can''t contain control characters other than line breaks and tabs');
select t.expect('send: exactly 5000 characters is taken',
  t.run('ana', t.send('other', repeat('y', 5000))) not like 'ERR%', true);
insert into t.ids select 'c1', t.run('ben', t.send('idea', 'ctx', null, repeat('p', 600)))::uuid;
insert into t.ids select 'c2', t.run('ben', t.send('idea', 'ctx2', null, E'a\nb'))::uuid;
select t.expect('send: a long context is cut to 500 characters and its control characters become spaces',
  (select length(context)::text from public.feedback where id = t.id('c1'))
  || ' ' || (select context from public.feedback where id = t.id('c2')),
  '500 a b');

-- ---------------------------------------------------------------------------
-- Vaults

select t.expect('vault: an outsider''s vault, a made-up one, and one outside the token''s scope are refused, and nothing is stored',
  t.msg('ana', t.send('bug', 'about Dee', 'deev')) || ' / '
  || t.msg('ben', format($q$select public.send_feedback('bug', 'x', %L)::text$q$, gen_random_uuid())) || ' / '
  || t.run_tok('ana', 'ana-gone-only', t.send('bug', 'about team', 'team')) || ' / '
  || (select count(*)::text from public.feedback where message in ('about Dee', 'about team')),
  'P0002 no vault with that id is available to you: leave the vault out, or choose one you''re a member of / '
  || 'P0002 no vault with that id is available to you: leave the vault out, or choose one you''re a member of / ERR P0002 / 0');
select t.expect('vault: a member names their vault; the token in scope does too',
  (t.run('ben', t.send('bug', 'Ben about team', 'team')) not like 'ERR%')::text || ' '
  || (t.run_tok('ana', 'ana-gone-only', t.send('bug', 'about gone', 'gone')) not like 'ERR%')::text,
  'true true');

-- ---------------------------------------------------------------------------
-- Agents and connections

insert into t.ids select 'fa', t.run('ana', t.send('bug', 'sent by Claude', 'team'), 'Claude Code')::uuid;
insert into t.ids select 'fro', t.run_tok('ana', 'ana-all-ro', t.send('idea', 'sent read-only', 'team'))::uuid;
select t.expect('agents: an agent sends for its person, recorded as from an agent with its name; a read-only token too, with its client name',
  (select concat_ws(' ', source, agent, coalesce(client_name, '-'), (user_id = t.id('ana'))::text) from public.feedback where id = t.id('fa'))
  || ' / ' || (select concat_ws(' ', source, agent, client_name) from public.feedback where id = t.id('fro')),
  'agent Claude Code - true / agent ana-all-ro claude-code');
select t.expect('agents: an OAuth client sends too',
  t.run_tok('ana', 'ana-oauth', t.send('question', 'from oauth')) not like 'ERR%', true);
select t.expect('agents: a CLI grant, a revoked token, someone else''s token and anonymous are refused, and store nothing',
  t.run_tok('ana', 'ana-cli', t.send('bug', 'from cli')) || ' ' || t.run_tok('ana', 'ana-revoked', t.send('bug', 'from revoked'))
  || ' ' || t.run_tok('ben', 'ana-all-rw', t.send('bug', 'from stolen')) || ' ' || t.run(null, t.send('bug', 'anon'))
  || ' ' || (select count(*)::text from public.feedback where message in ('from cli', 'from revoked', 'from stolen', 'anon')),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 0');
select t.expect('agents: a revoked connection is told to reconnect',
  t.msg_tok('ana', 'ana-revoked', t.send('bug', 'from revoked'))
  || ' / ' || t.msg_tok('ana', 'ana-cli', t.send('bug', 'from cli')),
  '42501 this connection was revoked or has expired: reconnect, then send the feedback again / '
  || '42501 a CLI sign-in only reads environment variables');
select t.expect('agents: the app roles and the operator''s role can''t send',
  t.run_role('reliquary_web', t.send('bug', 'web role')) || ' ' || t.run_role('reliquary_mcp', t.send('bug', 'mcp role'))
  || ' ' || t.run_role('reliquary_ops', t.send('bug', 'ops role')),
  'ERR 42501 ERR 42501 ERR 42501');

-- ---------------------------------------------------------------------------
-- Reading

select t.expect('read: a person reads their own feedback, including what their agents sent',
  t.run('ana', format($q$select count(*)::text from public.feedback where id in (%L, %L, %L)$q$, t.id('f1'), t.id('fa'), t.id('fro'))),
  '3');
select t.expect('read: A can''t read B''s feedback, by id or at all',
  t.run('dee', format($q$select count(*)::text from public.feedback where id = %L$q$, t.id('f1')))
  || ' ' || t.run('dee', $q$select count(*)::text from public.feedback$q$)
  || ' ' || t.run('ben', format($q$select count(*)::text from public.feedback where user_id = %L$q$, t.id('ana'))),
  '0 0 0');
select t.expect('read: an agent reads its person''s feedback and nobody else''s',
  t.run('ana', $q$select count(*)::text from public.feedback where user_id <> private.uid()$q$, 'Claude Code')
  || ' ' || (t.run_tok('ana', 'ana-all-ro', $q$select count(*)::text from public.feedback$q$)::int = t.count_of('ana')::int)::text,
  '0 true');
select t.expect('read: a CLI grant, anonymous, and a session without a person read nothing',
  t.run_tok('ana', 'ana-cli', $q$select count(*)::text from public.feedback$q$)
  || ' ' || t.run(null, $q$select count(*)::text from public.feedback$q$)
  || ' ' || t.run_claims('{"role": "authenticated"}', $q$select count(*)::text from public.feedback$q$),
  '0 ERR 42501 0');
select t.expect('read: the web, MCP and operator roles can''t read the table directly',
  t.run_role('reliquary_web', $q$select count(*)::text from public.feedback$q$)
  || ' ' || t.run_role('reliquary_mcp', $q$select count(*)::text from public.feedback$q$)
  || ' ' || t.run_role('reliquary_ops', $q$select count(*)::text from public.feedback$q$),
  'ERR 42501 ERR 42501 ERR 42501');
select t.expect('read: the notice columns aren''t readable, even on your own feedback',
  t.run('ana', $q$select count(notified_at)::text from public.feedback$q$)
  || ' ' || t.run('ana', $q$select max(notify_attempts)::text from public.feedback$q$),
  'ERR 42501 ERR 42501');

-- ---------------------------------------------------------------------------
-- Writing directly, status and reply

select t.expect('status: nobody writes the table directly: not the sender, their agent, nor the app roles',
  t.run('ana', format($q$update public.feedback set status = 'fixed' where id = %L returning 1$q$, t.id('f1')))
  || ' ' || t.run('ana', format($q$update public.feedback set status = 'fixed' where id = %L returning 1$q$, t.id('fa')), 'Claude Code')
  || ' ' || t.run('ana', format($q$delete from public.feedback where id = %L returning 1$q$, t.id('f1')))
  || ' ' || t.run('ana', $q$insert into public.feedback (user_id, kind, message, source) values (private.uid(), 'bug', 'x', 'web') returning 1$q$)
  || ' ' || t.run_role('reliquary_web', format($q$update public.feedback set status = 'fixed' where id = %L returning 1$q$, t.id('f1'))),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501');
select t.expect('status: agents, people and the app roles can''t set a status or a reply',
  t.run('ana', format($q$select private.set_feedback_status(%L, 'fixed')$q$, t.id('f1')), 'Claude Code')
  || ' ' || t.run_tok('ana', 'ana-all-rw', format($q$select private.set_feedback_status(%L, 'fixed')$q$, t.id('f1')))
  || ' ' || t.run('ana', format($q$select private.set_feedback_reply(%L, 'done')$q$, t.id('f1')))
  || ' ' || t.run_role('reliquary_web', format($q$select private.set_feedback_status(%L, 'fixed')$q$, t.id('f1')))
  || ' ' || t.run_role('reliquary_mcp', format($q$select private.set_feedback_reply(%L, 'done')$q$, t.id('f1')))
  || ' ' || (select status || coalesce(reply, '-') from public.feedback where id = t.id('f1')),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501 new-');
select t.expect('status: the operator sets a status and a reply, and the sender sees both',
  t.run_role('reliquary_ops', format($q$select private.set_feedback_status(%L, 'wont_fix')$q$, t.id('f1')))
  || ' / ' || t.run_role('reliquary_ops', format($q$select private.set_feedback_reply(%L, '  Works as designed.  ')$q$, t.id('f1')))
  || ' / ' || t.run('ana', format($q$select status || ' ' || reply || ' ' || (status_at is not null and replied_at is not null) from public.feedback where id = %L$q$, t.id('f1'))),
  'new -> won''t fix / reply saved / wont_fix Works as designed. true');
select t.expect('status: an unknown status or id is refused in words; an empty reply clears it',
  t.run_role('reliquary_ops', format($q$select private.set_feedback_status(%L, 'done')$q$, t.id('f1'))) = 'ERR 22023'
  and t.run_role('reliquary_ops', format($q$select private.set_feedback_status(%L, 'seen')$q$, gen_random_uuid())) = 'ERR P0002'
  and t.run_role('reliquary_ops', format($q$select private.set_feedback_reply(%L, '')$q$, t.id('fa'))) = 'reply cleared',
  true);
select t.expect('status: the operator lists and shows feedback with the sender''s email; the app roles can''t',
  t.run_role('reliquary_ops', format($q$select sender || ' ' || via || ' ' || status from private.feedback_list('all', 500) where id = %L$q$, t.id('fa')))
  || ' / ' || t.run_role('reliquary_ops', format($q$select value from private.feedback_show(%L) where field = 'via'$q$, t.id('fro')))
  || ' / ' || t.run_role('reliquary_web', $q$select count(*)::text from private.feedback_list('all', 5)$q$)
  || ' ' || t.run('ana', format($q$select count(*)::text from private.feedback_show(%L)$q$, t.id('f1'))),
  'ana@example.test agent: Claude Code new / agent: ana-all-ro (client: claude-code) / ERR 42501 ERR 42501');

-- ---------------------------------------------------------------------------
-- Notices

select t.expect('notices: only the web app''s role claims them; people, agents, the MCP and operator roles can''t',
  t.run('ana', $q$select count(*)::text from private.claim_feedback_notices(5)$q$)
  || ' ' || t.run('ana', $q$select count(*)::text from private.claim_feedback_notices(5)$q$, 'Claude Code')
  || ' ' || t.run_role('reliquary_mcp', $q$select count(*)::text from private.claim_feedback_notices(5)$q$)
  || ' ' || t.run_role('reliquary_ops', $q$select count(*)::text from private.claim_feedback_notices(5)$q$)
  || ' ' || t.run('ana', format($q$select private.feedback_notified(%L)::text$q$, t.id('f1'))),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501');
create table t.claimed (id uuid, kind text, message text, more boolean, sender text, via text, vault text, context text);
insert into t.claimed select id, kind, message, more, sender, via, vault, context from private.claim_feedback_notices(20);
select t.expect('notices: a claim gives the oldest unsent ones with the sender''s email, the first 600 characters and how it came',
  (select concat_ws(' | ', kind, message, more::text, sender, via, vault, context) from t.claimed where id = t.id('f1'))
  || ' / ' || (select concat_ws(' | ', sender, via) from t.claimed where id = t.id('fro'))
  || ' / ' || (select length(message) || ' ' || more::text from t.claimed where message like 'yyy%'),
  E'bug | The diff view\n\tloses a line. | false | ana@example.test | the web UI | Team | /v/x/file?path=a.md'
  || ' / ana@example.test | an agent (ana-all-ro, claude-code) / 600 true');
select t.expect('notices: a claimed notice isn''t claimed again while its claim holds',
  (select count(*)::text from private.claim_feedback_notices(20) c join t.claimed x on x.id = c.id), '0');
select private.feedback_notified(t.id('f1'));
update public.feedback set notify_claimed_at = now() - interval '11 minutes' where id <> t.id('f1');
select t.expect('notices: once its claim lapses an unsent one comes back, and a sent one never does',
  (select count(*) filter (where c.id = t.id('f1'))::text || ' ' || (count(*) filter (where c.id = t.id('fa')))::text
     from private.claim_feedback_notices(20) c),
  '0 1');
update public.feedback set notify_claimed_at = now() - interval '11 minutes', notify_attempts = 5 where id = t.id('fa');
update public.feedback set notify_claimed_at = null, notify_attempts = 0, created_at = now() - interval '8 days' where id = t.id('fro');
select t.expect('notices: after 5 tries, or when older than 7 days, a notice isn''t claimed again',
  (select count(*)::text from private.claim_feedback_notices(20) c where c.id in (t.id('fa'), t.id('fro'))), '0');
select t.expect('notices: the operator''s list says which were emailed',
  t.run_role('reliquary_ops', format($q$select notice from private.feedback_list('all', 500) where id = %L$q$, t.id('f1')))
  || ' / ' || t.run_role('reliquary_ops', format($q$select notice from private.feedback_list('all', 500) where id = %L$q$, t.id('fa'))),
  'emailed / not emailed (5 tries)');

-- ---------------------------------------------------------------------------
-- The rate: 20 an hour per person, web and agents together

select t.run('eve', t.send('idea', format('eve %s', i)), case when i % 2 = 0 then 'Claude Code' end) from generate_series(1, 19) i;
insert into t.ids select 'e20', t.run('eve', t.send('idea', 'eve 20'))::uuid;
select t.expect('limits: the 21st in an hour is refused in words, from the web UI or an agent, and stores nothing',
  regexp_replace(t.msg('eve', t.send('idea', 'eve 21')), '[0-9]{2}:[0-9]{2} UTC', 'HH:MM UTC')
  || ' / ' || t.run('eve', t.send('idea', 'eve 21 agent'), 'Claude Code') || ' / ' || t.count_of('eve'),
  '54000 you have sent 20 feedback messages in the last hour, the most an hour takes: send this one after HH:MM UTC / ERR 54000 / 20');
select t.expect('limits: another person isn''t counted against it',
  t.run('dee', t.send('idea', 'dee 1')) not like 'ERR%', true);
update public.feedback set created_at = now() - interval '61 minutes' where id = t.id('e20');
select t.expect('limits: feedback older than an hour frees its place',
  t.run('eve', t.send('idea', 'eve again')) not like 'ERR%', true);

-- ---------------------------------------------------------------------------
-- Deleting a vault

select t.run('ana', format($q$select public.delete_vault(%L, 'Gone')::text$q$, t.id('gone')));
select t.expect('vault deleted: its feedback stays, without the vault',
  (select count(*)::text || ' ' || count(vault_id)::text from public.feedback where message = 'about gone'), '1 0');

-- ---------------------------------------------------------------------------
-- Deleting an account

create table t.account (step text, n text);
insert into t.account select 'before', count(*)::text from public.feedback where user_id = t.id('eve');
insert into t.account select 'deleted', t.run('eve', $q$select (public.delete_account('eve@example.test') is not null)::text$q$);
select t.expect('account deleted: their feedback goes with it, and nobody else''s',
  (select n from t.account where step = 'before') || ' / ' || (select n from t.account where step = 'deleted') || ' / '
  || (select count(*)::text from public.feedback where user_id = t.id('eve')) || ' / '
  || (select (count(*) > 0)::text from public.feedback where user_id = t.id('ana')),
  '21 / true / 0 / true');
select t.expect('account deleted: the trigger isn''t callable',
  t.run('ana', $q$select private.forget_feedback()::text$q$) || ' ' || t.run_role('reliquary_web', $q$select private.forget_feedback()::text$q$),
  'ERR 42501 ERR 42501');
