-- Hostile tests for thread flags (20261005100000_thread_flags): who is told
-- about a new thread or message, and what the flag says. list_flags'
-- other categories, and who may read flags at all, are flags_test.sql's;
-- threads themselves are vault_threads_test.sql's. Connections are
-- simulated the way private.mcp_begin sets claims (act.tok = the token id,
-- act.name = its name).
--
-- Team: Ana owns, Ben edits, Cal views. Dee's: Dee owns, Ana edits. Dee is
-- an outsider to Team.

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'dees', t.run('dee', $q$select public.create_vault('Dee''s')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select test_support.add_member(t.id('dees'), t.id('ana'), 'editor', t.id('dee'));

select t.run('ana', format($q$select public.create_access_token('ana-agent', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_access_token('ana-read', 30, array[%L]::uuid[], 'read')$q$, t.id('team')));
select t.run('ben', format($q$select public.create_access_token('ben-agent', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('cal', format($q$select public.create_access_token('cal-agent', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));

-- `or replace`: the same as harness.sql's once that file defines them.
create or replace function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;
create or replace function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;
-- As the person in the web app (p_tok null), or as one of their connections.
create function t.as(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select case when p_tok is null then t.run(p_user, p_sql) else t.run_tok(p_user, p_tok, p_sql) end
$$;

create function t.flag_json(p_user text, p_vault text, p_tok text default null, p_limit int default 50) returns text
language sql as $$
  select t.as(p_user, p_tok, format($q$select public.list_flags(%L, %s)::text$q$, t.id(p_vault), p_limit))
$$;
-- The flags as "category reason event thread" in seq order (the thread by
-- its name in t.ids, else the path), or 'none'.
create function t.flags(p_user text, p_vault text, p_tok text default null, p_limit int default 50) returns text
language plpgsql as $$
declare v text := t.flag_json(p_user, p_vault, p_tok, p_limit);
begin
  if v like 'ERR %' then return v; end if;
  return (select coalesce(string_agg(concat_ws(' ', f ->> 'category', f ->> 'reason', f ->> 'event',
                                       coalesce((select i.name from t.ids i where i.id::text = f ->> 'thread_id'), f ->> 'path')),
                                     '; ' order by (f ->> 'seq')::bigint), 'none')
            from jsonb_array_elements(v::jsonb -> 'flags') f);
end $$;
create function t.advance(p_user text, p_vault text, p_tok text, p_through text) returns text language sql as $$
  select t.as(p_user, p_tok, format($q$select public.advance_flags(%L, %s)::text$q$, t.id(p_vault), p_through))
$$;
-- Shows the flags and marks them shown, as a caller would after a
-- delivered response.
create function t.catch_up(p_user text, p_vault text, p_tok text default null) returns text
language plpgsql as $$
declare v text := t.flag_json(p_user, p_vault, p_tok, 200);
begin
  if v like 'ERR %' then return v; end if;
  return t.advance(p_user, p_vault, p_tok, v::jsonb ->> 'through');
end $$;
create function t.catch_up_all() returns void language sql as $$
  select t.catch_up('ana', 'team'), t.catch_up('ana', 'team', 'ana-agent'), t.catch_up('ana', 'team', 'ana-read'),
         t.catch_up('ben', 'team'), t.catch_up('ben', 'team', 'ben-agent'),
         t.catch_up('cal', 'team'), t.catch_up('cal', 'team', 'cal-agent'),
         t.catch_up('dee', 'dees'), t.catch_up('ana', 'dees')
$$;
create function t.open_sql(p_vault text, p_title text, p_body text, p_to text[] default null) returns text language sql as $$
  select format($q$select public.open_thread(%L, %L, %L, %L::uuid[])::text$q$, t.id(p_vault), p_title, p_body,
    (select array_agg(t.id(u)) from unnest(p_to) u))
$$;
create function t.post_sql(p_thread text, p_body text) returns text language sql as $$
  select format($q$select public.post_message(%L, %L)::text$q$, t.id(p_thread), p_body)
$$;
create function t.last_message(p_thread text) returns text language sql as $$
  select max(id)::text from public.thread_messages where thread_id = t.id(p_thread)
$$;
create function t.head(p_vault text) returns bigint language sql as
$$ select coalesce(max(seq), 0) from public.log where vault_id = t.id(p_vault) $$;

-- ---------------------------------------------------------------------------
-- A thread for the whole vault

insert into t.ids select 'launch', t.run('ana', t.open_sql('team', 'Launch plan', 'Who takes the copy?'))::uuid;

select t.expect('thread flags: a thread for the whole vault is flagged to every other member',
  t.flags('ben', 'team') || ' | ' || t.flags('ben', 'team', 'ben-agent'),
  'thread vault thread.open launch | thread vault thread.open launch');
select t.expect('thread flags: a viewer is flagged too, though they can''t post, and so is a viewer''s connection',
  t.flags('cal', 'team') || ' | ' || t.flags('cal', 'team', 'cal-agent'),
  'thread vault thread.open launch | thread vault thread.open launch');
select t.expect('thread flags: the poster isn''t flagged for their own thread',
  t.flags('ana', 'team'), 'none');
select t.expect('thread flags: what the person did in the web app is flagged to their agents, a read-only connection too',
  t.flags('ana', 'team', 'ana-agent') || ' | ' || t.flags('ana', 'team', 'ana-read'),
  'thread vault thread.open launch | thread vault thread.open launch');
select t.expect('thread flags: a member of another vault isn''t flagged, there or in their own',
  t.flags('dee', 'team') || ' | ' || t.flags('dee', 'dees') || ' | ' || t.flags('ana', 'dees'),
  'ERR P0002 | none | none');
select t.expect('thread flags: a flag names its thread and message, and carries no other key than the other categories do',
  (select (f ->> 'thread_id' = t.id('launch')::text)::text || ' ' || (f ->> 'message_id' = t.last_message('launch'))::text
          || ' ' || (f ->> 'path' is null)::text || ' ' || (f ->> 'proposal_id' is null)::text
          || ' ' || (select string_agg(k, ',' order by k) from jsonb_object_keys(f) k)
     from jsonb_array_elements(t.flag_json('ben', 'team')::jsonb -> 'flags') f),
  'true true true true actor,agent,at,category,event,message_id,path,proposal_id,reason,seq,thread_id,watching');
select t.expect('thread flags: a flag holds neither the thread''s title nor the message''s text',
  (position('Launch plan' in t.flag_json('ben', 'team')) = 0 and position('Who takes the copy' in t.flag_json('ben', 'team')) = 0)::text,
  'true');
select t.expect('thread flags: reading them again without advancing shows the same flags',
  t.flags('ben', 'team') || ' | ' || t.flags('cal', 'team'),
  'thread vault thread.open launch | thread vault thread.open launch');
select t.catch_up_all();

select t.run_tok('ben', 'ben-agent', t.post_sql('launch', 'I can take it'));
select t.expect('thread flags: a message in an open thread is flagged, naming that message',
  t.flags('cal', 'team') || ' ' || ((t.flag_json('cal', 'team')::jsonb -> 'flags' -> 0 ->> 'message_id') = t.last_message('launch'))::text,
  'thread vault thread.post launch true');
select t.expect('thread flags: an agent isn''t flagged for its own message, but its person is',
  t.flags('ben', 'team', 'ben-agent') || ' | ' || t.flags('ben', 'team'),
  'none | thread vault thread.post launch');
select t.expect('thread flags: the person and each connection are told separately: advancing one leaves the others',
  t.catch_up('ana', 'team') || ' ' || t.flags('ana', 'team') || ' | ' || t.flags('ana', 'team', 'ana-agent'),
  t.head('team') || ' none | thread vault thread.post launch');
select t.catch_up_all();

-- ---------------------------------------------------------------------------
-- Side threads

insert into t.ids select 'forben', t.run('ana', t.open_sql('team', 'For Ben', 'The invoice is late', array['ben']))::uuid;
select t.expect('thread flags: a side thread is flagged to its addressee and their connections',
  t.flags('ben', 'team') || ' | ' || t.flags('ben', 'team', 'ben-agent'),
  'thread side thread.open forben | thread side thread.open forben');
select t.expect('thread flags: a member a side thread isn''t addressed to isn''t flagged about it, nor their connection',
  t.flags('cal', 'team') || ' | ' || t.flags('cal', 'team', 'cal-agent'), 'none | none');
select t.expect('thread flags: nor is its opener''s agent, when the opener didn''t address their own person',
  t.flags('ana', 'team', 'ana-agent'), 'none');
select t.catch_up_all();

select t.run('ben', t.post_sql('forben', 'Paid it this morning'));
select t.expect('thread flags: a reply in a side thread is flagged to its addressees only',
  t.flags('ben', 'team', 'ben-agent') || ' | ' || t.flags('cal', 'team') || ' | ' || t.flags('ana', 'team')
  || ' | ' || t.flags('ana', 'team', 'ana-agent'),
  'thread side thread.post forben | none | none | none');
select t.catch_up_all();

insert into t.ids select 'forcal', t.run('ben', t.open_sql('team', 'Read this', 'The brief changed', array['cal', 'ana']))::uuid;
select t.expect('thread flags: a side thread addressed to a viewer flags the viewer, and each addressee',
  t.flags('cal', 'team') || ' | ' || t.flags('ana', 'team') || ' | ' || t.flags('ben', 'team', 'ben-agent'),
  'thread side thread.open forcal | thread side thread.open forcal | none');
select t.catch_up_all();

-- ---------------------------------------------------------------------------
-- Resolved threads, redaction

select t.run('ana', t.post_sql('launch', 'Copy is due Friday'));
select t.run('ben', format($q$select 'ok' from public.resolve_thread(%L)$q$, t.id('launch')));
select t.expect('thread flags: nothing flags for a resolved thread, a message posted before it was resolved included',
  t.flags('cal', 'team') || ' | ' || t.flags('ben', 'team', 'ben-agent'), 'none | none');
select t.expect('thread flags: resolving a thread flags no one',
  t.flags('ana', 'team') || ' | ' || t.flags('ana', 'team', 'ana-agent'), 'none | none');
select t.run('ben', format($q$select 'ok' from public.reopen_thread(%L)$q$, t.id('launch')));
select t.expect('thread flags: reopening flags no one, and a message not yet shown is flagged once the thread is open again',
  t.flags('cal', 'team') || ' | ' || t.flags('ana', 'team'), 'thread vault thread.post launch | none');
select t.catch_up_all();

select t.run('ana', format($q$select 'ok' from public.redact_message(%L)$q$, t.last_message('forben')));
select t.expect('thread flags: a redaction flags no one',
  concat_ws(' | ', t.flags('ben', 'team'), t.flags('ben', 'team', 'ben-agent'), t.flags('cal', 'team'),
    t.flags('ana', 'team', 'ana-agent')),
  'none | none | none | none');

-- ---------------------------------------------------------------------------
-- Pages, and advancing only through what was shown

select t.run('ben', t.post_sql('launch', 'First'));
select t.run('ben', t.post_sql('launch', 'Second'));
select t.expect('thread flags: a page at a time: through is the last flag shown, not the vault''s latest entry',
  t.flags('cal', 'team', null, 1) || ' | ' || (t.flag_json('cal', 'team', null, 1)::jsonb ->> 'more')
  || ' ' || ((t.flag_json('cal', 'team', null, 1)::jsonb ->> 'through')::bigint < t.head('team'))::text,
  'thread vault thread.post launch | true true');
select t.advance('cal', 'team', null, t.flag_json('cal', 'team', null, 1)::jsonb ->> 'through');
select t.expect('thread flags: advancing through the shown page leaves the next message flagged',
  t.flags('cal', 'team') || ' ' || ((t.flag_json('cal', 'team')::jsonb -> 'flags' -> 0 ->> 'message_id') = t.last_message('launch'))::text,
  'thread vault thread.post launch true');
select t.catch_up_all();

-- ---------------------------------------------------------------------------
-- A connection made now

select pg_sleep(0.002);
select t.run('ana', format($q$select public.create_access_token('ana-late', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.expect('thread flags: a new connection isn''t told about threads and messages from before it was made',
  t.flags('ana', 'team', 'ana-late'), 'none');
select pg_sleep(0.002);
select t.run('ben', t.post_sql('launch', 'After'));
select t.expect('thread flags: ... and is told what is posted after',
  t.flags('ana', 'team', 'ana-late'), 'thread vault thread.post launch');

-- ---------------------------------------------------------------------------
-- Another vault's threads

select t.catch_up_all();
insert into t.ids select 'deesown', t.run('dee', t.open_sql('dees', 'Elsewhere', 'Not for Team'))::uuid;
select t.expect('thread flags: a thread is flagged only in its own vault',
  t.flags('ana', 'dees') || ' | ' || t.flags('ana', 'team') || ' | ' || t.flags('ben', 'team'),
  'thread vault thread.open deesown | none | none');
