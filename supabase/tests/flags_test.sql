-- Hostile tests for flags (20260928150000_flags): subscriptions, a
-- watermark per identity, and list_flags' three categories (standing
-- responsibility, working-set staleness for your own proposals,
-- subscriptions). Direct address (category 1) and staleness for files you
-- read aren't built, so nothing here is about them. Nothing calls these
-- over MCP yet: connections are simulated the way private.mcp_begin sets
-- claims (act.tok = the token id, act.name = its name).
--
-- Team: Ana owns, Ben edits, Cal views; canon/ needs two approvals, so a
-- proposal there stays open after one. Side: Ana alone. Dee's: Dee owns,
-- Cal views. Dee is an outsider to Team and Side.

-- ---------------------------------------------------------------------------
-- Setup

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
insert into t.ids select 'dees', t.run('dee', $q$select public.create_vault('Dee''s')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select test_support.add_member(t.id('dees'), t.id('cal'), 'viewer', t.id('dee'));
select t.run('ana', format($q$select public.set_policy(%L, 'canon/', 'canon', 2)$q$, t.id('team')));

select t.run('ana', format($q$select public.create_access_token('ana-agent', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_access_token('ana-agent2', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_access_token('ana-read', 30, array[%L]::uuid[], 'read')$q$, t.id('team')));
select t.run('ana', format($q$select public.create_access_token('side-only', 30, array[%L]::uuid[], 'write')$q$, t.id('side')));
select t.run('ben', format($q$select public.create_access_token('ben-agent', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
-- A CLI sign-in, in the shape the consent flow stores (kind cli, read,
-- env API resource): only require_person's refusal matters here.
insert into public.access_tokens (user_id, name, expires_at, all_vaults, vault_ids, access, kind, client_id, resource)
values (t.id('ana'), 'ana-cli', now() + interval '1 day', true, '{}', 'read', 'cli',
        'https://app.example/cli/oauth-client.json', 'https://app.example/api/env');

create function t.tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name $$;
-- As a connection, the way the MCP server sets claims.
create function t.run_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.tok(p_tok), 'name', p_tok, 'tok', t.tok(p_tok))), p_sql)
$$;
-- As the person in the web app (p_tok null), or as one of their connections.
create function t.as(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select case when p_tok is null then t.run(p_user, p_sql) else t.run_tok(p_user, p_tok, p_sql) end
$$;

create function t.sub_sql(p_vault text, p_target text, p_kind text default 'path') returns text language sql as $$
  select format($q$select public.create_subscription(%L, %L, %L)::text$q$, t.id(p_vault), p_kind, p_target)
$$;
create function t.list_sql(p_vault text, p_limit int default 50) returns text language sql as $$
  select format($q$select public.list_flags(%L, %s)::text$q$, t.id(p_vault), p_limit)
$$;
create function t.advance_sql(p_vault text, p_through text) returns text language sql as $$
  select format($q$select public.advance_flags(%L, %s)::text$q$, t.id(p_vault), p_through)
$$;
-- list_flags' answer, or its error as 'ERR <sqlstate>'.
create function t.flag_json(p_user text, p_vault text, p_tok text default null, p_limit int default 50) returns text
language sql as $$ select t.as(p_user, p_tok, t.list_sql(p_vault, p_limit)) $$;
-- The flags as "category reason event path; ..." in seq order, or 'none'.
create function t.flags(p_user text, p_vault text, p_tok text default null, p_limit int default 50) returns text
language plpgsql as $$
declare v text := t.flag_json(p_user, p_vault, p_tok, p_limit);
begin
  if v like 'ERR %' then return v; end if;
  return (select coalesce(string_agg(concat_ws(' ', f ->> 'category', f ->> 'reason', f ->> 'event', f ->> 'path'),
                                     '; ' order by (f ->> 'seq')::bigint), 'none')
            from jsonb_array_elements(v::jsonb -> 'flags') f);
end $$;
-- Shows the flags and marks them shown, as a caller would after a
-- delivered response.
create function t.catch_up(p_user text, p_vault text, p_tok text default null) returns text
language plpgsql as $$
declare v text := t.flag_json(p_user, p_vault, p_tok, 200);
begin
  if v like 'ERR %' then return v; end if;
  return t.as(p_user, p_tok, t.advance_sql(p_vault, v::jsonb ->> 'through'));
end $$;
create function t.head(p_vault text) returns bigint language sql as
$$ select coalesce(max(seq), 0) from public.log where vault_id = t.id(p_vault) $$;
create function t.mark(p_user text, p_vault text, p_tok text default null) returns text language sql as $$
  select coalesce((select last_seq::text from public.flag_watermarks
                    where user_id = t.id(p_user) and vault_id = t.id(p_vault)
                      and token_id is not distinct from t.tok(p_tok)), 'none')
$$;
create function t.subs(p_user text, p_vault text) returns text language sql as $$
  select count(*)::text from public.subscriptions where user_id = t.id(p_user) and vault_id = t.id(p_vault)
$$;
create function t.marks(p_user text, p_vault text) returns text language sql as $$
  select count(*)::text from public.flag_watermarks where user_id = t.id(p_user) and vault_id = t.id(p_vault)
$$;
-- Counted in a function of their own, so a count in the same statement as
-- the change it checks sees that change (a fresh snapshot per call).
create function t.sub_count(p_sub text) returns text language sql as
$$ select count(*)::text from public.subscriptions where id = t.id(p_sub) $$;
create table t.marks_before (id uuid, last_seq bigint);
create function t.marks_changed() returns text language sql as $$
  select count(*)::text from public.flag_watermarks w join t.marks_before b on b.id = w.id
   where w.last_seq is distinct from b.last_seq
$$;

-- ---------------------------------------------------------------------------
-- Subscribing: the person, in person; any member

create table t.log_before as select count(*) as n from public.log where vault_id = t.id('team');

select t.expect('subscribe: an outsider cannot watch a path in the vault',
  t.run('dee', t.sub_sql('team', 'notes/')), 'ERR P0002');
select t.expect('subscribe: anonymous cannot watch a path',
  t.run(null, t.sub_sql('team', 'notes/')), 'ERR 42501');
select t.expect('subscribe: a session without a person cannot watch a path',
  t.run_claims('{"role": "authenticated"}', t.sub_sql('team', 'notes/')), 'ERR 28000');
select t.expect('subscribe: the owner''s agent cannot watch a path for her',
  t.run('ana', t.sub_sql('team', 'notes/'), 'Claude Code'), 'ERR 42501');
select t.expect('subscribe: the owner''s connection cannot watch a path for her, read-write or read-only',
  t.run_tok('ana', 'ana-agent', t.sub_sql('team', 'notes/')) || ',' || t.run_tok('ana', 'ana-read', t.sub_sql('team', 'notes/')),
  'ERR 42501,ERR 42501');
select t.expect('subscribe: a CLI sign-in cannot watch a path',
  t.run_tok('ana', 'ana-cli', t.sub_sql('team', 'notes/')), 'ERR 42501');
select t.expect('subscribe: a tag is refused while files carry no tags',
  t.run('ana', t.sub_sql('team', 'client-x', 'tag')), 'ERR 22023');
select t.expect('subscribe: an unknown kind is refused',
  t.run('ana', t.sub_sql('team', 'notes/', 'folder')), 'ERR 22023');
select t.expect('subscribe: a malformed path is refused: empty, leading /, //, . or .., a control character, over 1024 characters',
  concat_ws(',', t.run('ana', t.sub_sql('team', '')), t.run('ana', t.sub_sql('team', '/notes/')),
    t.run('ana', t.sub_sql('team', 'notes//x.md')), t.run('ana', t.sub_sql('team', 'notes/../x.md')),
    t.run('ana', t.sub_sql('team', './notes/')), t.run('ana', t.sub_sql('team', E'notes/\tx.md')),
    t.run('ana', t.sub_sql('team', repeat('a', 1025)))),
  'ERR 22023,ERR 22023,ERR 22023,ERR 22023,ERR 22023,ERR 22023,ERR 22023');
select t.expect('subscribe: refused calls store nothing',
  (select count(*)::text from public.subscriptions), '0');

insert into t.ids select 'sub_ana', t.run('ana', t.sub_sql('team', 'notes/'))::uuid;
insert into t.ids select 'sub_ben', t.run('ben', t.sub_sql('team', 'canon/a.md'))::uuid;
insert into t.ids select 'sub_cal', t.run('cal', t.sub_sql('team', 'notes/'))::uuid;
insert into t.ids select 'sub_ana_side', t.run('ana', t.sub_sql('side', 'side-notes/'))::uuid;
select t.expect('subscribe: the owner, an editor and a viewer each watch a path of their own',
  (select string_agg(u.name || ' ' || s.target, ',' order by u.name)
     from public.subscriptions s join t.ids u on u.id = s.user_id where s.vault_id = t.id('team')),
  'ana notes/,ben canon/a.md,cal notes/');
select t.expect('subscribe: watching the same path again returns the same subscription and adds none',
  (t.run('ana', t.sub_sql('team', 'notes/')) = t.id('sub_ana')::text)::text || ' ' || t.subs('ana', 'team'),
  'true 1');
select t.expect('subscribe: nothing is logged in the vault''s Activity',
  ((select count(*) from public.log where vault_id = t.id('team')) - (select n from t.log_before))::text, '0');
select t.expect('subscribe: nobody inserts, updates or deletes a subscription directly',
  concat_ws(',',
    t.run('ana', format($q$insert into public.subscriptions (user_id, vault_id, kind, target) values (%L, %L, 'path', 'x/') returning 1$q$,
      t.id('ana'), t.id('team'))),
    t.run('ana', $q$update public.subscriptions set target = 'y/' returning 1$q$),
    t.run('ana', $q$delete from public.subscriptions returning 1$q$)),
  'ERR 42501,ERR 42501,ERR 42501');

-- The limit, in Dee's vault: 100 per person per vault.
select t.expect('subscribe: 100 paths per person per vault, then refused (54000)',
  t.run('dee', format($q$select count(public.create_subscription(%L, 'path', 'bulk/' || g || '/'))::text from generate_series(1, 100) g$q$,
    t.id('dees')))
  || ' ' || t.run('dee', t.sub_sql('dees', 'bulk/101/')),
  '100 ERR 54000');
select t.expect('subscribe: at the limit, watching a path already watched still returns it',
  (t.run('dee', t.sub_sql('dees', 'bulk/7/')) = (select id::text from public.subscriptions where user_id = t.id('dee') and target = 'bulk/7/'))::text,
  'true');
select t.expect('subscribe: the limit is one person''s in one vault: another member there still subscribes',
  (t.run('cal', t.sub_sql('dees', 'x/')) not like 'ERR %')::text || ' ' || t.subs('dee', 'dees'),
  'true 100');

-- ---------------------------------------------------------------------------
-- Listing: the person and their agents, their own, where the caller reaches

select t.expect('subscriptions read: the person lists their own, in every vault',
  t.run('ana', $q$select string_agg(target, ',' order by target) from public.subscriptions$q$), 'notes/,side-notes/');
select t.expect('subscriptions read: their agent lists them',
  t.run('ana', $q$select string_agg(target, ',' order by target) from public.subscriptions$q$, 'Claude Code'),
  'notes/,side-notes/');
select t.expect('subscriptions read: their connection lists those in its vaults, read-only ones too',
  t.run_tok('ana', 'ana-agent', $q$select string_agg(target, ',' order by target) from public.subscriptions$q$)
  || ' ' || t.run_tok('ana', 'ana-read', $q$select string_agg(target, ',' order by target) from public.subscriptions$q$)
  || ' ' || t.run_tok('ana', 'side-only', $q$select string_agg(target, ',' order by target) from public.subscriptions$q$),
  'notes/ notes/ side-notes/');
select t.expect('subscriptions read: another member sees none of yours',
  t.run('ben', format($q$select count(*)::text from public.subscriptions where user_id = %L$q$, t.id('ana'))), '0');
select t.expect('subscriptions read: an outsider sees none',
  t.run('dee', format($q$select count(*)::text from public.subscriptions where vault_id = %L$q$, t.id('team'))), '0');
select t.expect('subscriptions read: a CLI sign-in sees none',
  t.run_tok('ana', 'ana-cli', $q$select count(*)::text from public.subscriptions$q$), '0');
select t.expect('subscriptions read: anonymous can''t read them',
  t.run(null, $q$select count(*)::text from public.subscriptions$q$), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- Stopping: the person's own, in person

insert into t.ids select 'sub_drop', t.run('ana', t.sub_sql('team', 'drop/'))::uuid;
select t.expect('unsubscribe: another member cannot remove your subscription',
  t.run('ben', format($q$select 'ok' from public.delete_subscription(%L)$q$, t.id('sub_drop'))), 'ERR P0002');
select t.expect('unsubscribe: an outsider cannot remove it',
  t.run('dee', format($q$select 'ok' from public.delete_subscription(%L)$q$, t.id('sub_drop'))), 'ERR P0002');
select t.expect('unsubscribe: your agent cannot remove it',
  t.run('ana', format($q$select 'ok' from public.delete_subscription(%L)$q$, t.id('sub_drop')), 'Claude Code'), 'ERR 42501');
select t.expect('unsubscribe: your connection cannot remove it',
  t.run_tok('ana', 'ana-agent', format($q$select 'ok' from public.delete_subscription(%L)$q$, t.id('sub_drop'))), 'ERR 42501');
select t.expect('unsubscribe: refused calls remove nothing',
  t.sub_count('sub_drop'), '1');
select t.expect('unsubscribe: the person stops watching',
  t.run('ana', format($q$select 'ok' from public.delete_subscription(%L)$q$, t.id('sub_drop')))
  || ' ' || t.sub_count('sub_drop'),
  'ok 0');
select t.expect('unsubscribe: removing it again says there is no such subscription',
  t.run('ana', format($q$select 'ok' from public.delete_subscription(%L)$q$, t.id('sub_drop'))), 'ERR P0002');

-- ---------------------------------------------------------------------------
-- Flags. Each step acts, checks who is flagged, then catches up those
-- identities (reads, then advances to `through`), as a caller would.

-- 1. Ana proposes canon/a.md in person.
insert into t.ids select 'p1', t.run('ana', format($q$select public.propose(%L, 'canon/a.md', 'A one', 'first')$q$, t.id('team')))::uuid;

select t.expect('flags: a proposal waiting on an editor is flagged for them, once, even when they also watch its path',
  t.flags('ben', 'team'), 'responsibility review proposal.open canon/a.md');
select t.expect('flags: a viewer isn''t flagged as a reviewer',
  t.flags('cal', 'team'), 'none');
select t.expect('flags: what you did yourself isn''t flagged to you',
  t.flags('ana', 'team'), 'none');
select t.expect('flags: your agent is told what waits on you, even what you started in person',
  t.flags('ana', 'team', 'ana-agent'), 'responsibility review proposal.open canon/a.md');
select t.expect('flags: reading again without advancing shows the same flags',
  t.flags('ben', 'team'), 'responsibility review proposal.open canon/a.md');
select t.expect('watermark: none is stored until an identity advances; reading never stores one',
  (select count(*)::text from public.flag_watermarks), '0');
select t.expect('flags: each flag carries its seq, category, reason, event, path, proposal, who and when, and the answer its watermark, through and more',
  (select string_agg(k, ',' order by k) from jsonb_object_keys((t.flag_json('ben', 'team')::jsonb -> 'flags') -> 0) k)
  || ' / ' || (select string_agg(k, ',' order by k) from jsonb_object_keys(t.flag_json('ben', 'team')::jsonb) k)
  || ' / ' || ((t.flag_json('ben', 'team')::jsonb -> 'flags' -> 0 ->> 'proposal_id') = t.id('p1')::text)::text
  || ' ' || ((t.flag_json('ben', 'team')::jsonb -> 'flags' -> 0 ->> 'actor') = t.id('ana')::text)::text,
  'actor,agent,at,category,event,path,proposal_id,reason,seq,watching / flags,more,through,watermark / true true');
select t.catch_up('ben', 'team'), t.catch_up('ana', 'team'), t.catch_up('ana', 'team', 'ana-agent'), t.catch_up('cal', 'team');
select t.expect('flags: once advanced, what was shown isn''t shown again',
  t.flags('ben', 'team') || ' ' || t.flags('ana', 'team', 'ana-agent'), 'none none');

-- 2. Ben comments on it in person.
select t.run('ben', format($q$select public.comment_on_proposal(%L, 'Needs a source')::text$q$, t.id('p1')));
select t.expect('flags: a comment on a proposal waiting on you flags it again, one event one flag',
  t.flags('ana', 'team'), 'responsibility review proposal.comment canon/a.md');
select t.expect('flags: your own comment doesn''t flag you',
  t.flags('ben', 'team'), 'none');
select t.expect('flags: the person and each connection are flagged separately: advancing one leaves the others',
  t.flags('ben', 'team', 'ben-agent'),
  'subscription path proposal.open canon/a.md; responsibility review proposal.comment canon/a.md');
select t.catch_up('ana', 'team'), t.catch_up('ben', 'team'), t.catch_up('ben', 'team', 'ben-agent'), t.catch_up('ana', 'team', 'ana-agent');

-- 3. Ben requests changes in person.
select t.run('ben', format($q$select public.decide(%L, 'request_changes', 'Cite it')$q$, t.id('p1')));
select t.expect('flags: a decision on your own proposal is flagged to you and your agent',
  t.flags('ana', 'team') || ' | ' || t.flags('ana', 'team', 'ana-agent'),
  'working_set proposal proposal.request_changes canon/a.md | working_set proposal proposal.request_changes canon/a.md');
select t.expect('flags: a proposal sent back is no longer waiting on reviewers: its events show as the proposer''s, not as a review',
  t.flags('ana', 'team', 'ana-read'),
  'working_set proposal proposal.open canon/a.md; working_set proposal proposal.comment canon/a.md; '
  || 'working_set proposal proposal.request_changes canon/a.md');
select t.catch_up('ana', 'team'), t.catch_up('ana', 'team', 'ana-agent'), t.catch_up('ben', 'team'), t.catch_up('ben', 'team', 'ben-agent');

-- 4. Ana's agent revises it.
select t.run_tok('ana', 'ana-agent', format($q$select public.revise_proposal(%L, 'A two', 'with a source')::text$q$, t.id('p1')));
select t.expect('flags: an agent isn''t told what it did itself, but its person is',
  t.flags('ana', 'team', 'ana-agent') || ' | ' || t.flags('ana', 'team'),
  'none | responsibility review proposal.revise canon/a.md');
select t.expect('flags: a new revision flags it again for whoever decided the last one',
  t.flags('ben', 'team'), 'responsibility review proposal.revise canon/a.md');
select t.expect('flags: a second connection of the same person keeps its own watermark, and is told everything since it began',
  t.flags('ana', 'team', 'ana-agent2'),
  'working_set proposal proposal.open canon/a.md; working_set proposal proposal.comment canon/a.md; '
  || 'working_set proposal proposal.request_changes canon/a.md; responsibility review proposal.revise canon/a.md');
select t.expect('flags: a page at a time: at most the limit, more says there is another, and through is the last flag shown',
  t.flags('ana', 'team', 'ana-agent2', 2)
  || ' | ' || (t.flag_json('ana', 'team', 'ana-agent2', 2)::jsonb ->> 'more')
  || ' ' || ((t.flag_json('ana', 'team', 'ana-agent2', 2)::jsonb ->> 'through')::bigint
             = (select seq from public.log where proposal_id = t.id('p1') and event = 'proposal.comment'))::text,
  'working_set proposal proposal.open canon/a.md; working_set proposal proposal.comment canon/a.md | true true');
select t.as('ana', 'ana-agent2', t.advance_sql('team', t.flag_json('ana', 'team', 'ana-agent2', 2)::jsonb ->> 'through'));
select t.expect('flags: advancing through a page shows the next, and the last page runs through the vault''s latest entry',
  t.flags('ana', 'team', 'ana-agent2', 2)
  || ' | ' || (t.flag_json('ana', 'team', 'ana-agent2', 2)::jsonb ->> 'more')
  || ' ' || ((t.flag_json('ana', 'team', 'ana-agent2', 2)::jsonb ->> 'through')::bigint = t.head('team'))::text,
  'working_set proposal proposal.request_changes canon/a.md; responsibility review proposal.revise canon/a.md | false true');
select t.catch_up('ana', 'team'), t.catch_up('ana', 'team', 'ana-agent'), t.catch_up('ana', 'team', 'ana-agent2'),
       t.catch_up('ben', 'team'), t.catch_up('ben', 'team', 'ben-agent');

-- 5. Ben proposes two more; Ana approves one and snoozes the other.
insert into t.ids select 'p2', t.run('ben', format($q$select public.propose(%L, 'canon/b.md', 'B', 'b')$q$, t.id('team')))::uuid;
insert into t.ids select 'p3', t.run('ben', format($q$select public.propose(%L, 'canon/c.md', 'C', 'c')$q$, t.id('team')))::uuid;
select t.run('ana', format($q$select public.decide(%L, 'approve')$q$, t.id('p2')));
select t.run('ana', format($q$select 'ok' from public.snooze_proposal(%L)$q$, t.id('p3')));
select t.expect('flags: a proposal you decided on at this revision, or snoozed, isn''t flagged as waiting on you, nor to your agents',
  t.flags('ana', 'team') || ' | ' || t.flags('ana', 'team', 'ana-agent'), 'none | none');
select t.expect('flags: an approval on your own proposal is flagged to you',
  t.flags('ben', 'team'), 'working_set proposal proposal.approve canon/b.md');
select t.catch_up('ana', 'team'), t.catch_up('ana', 'team', 'ana-agent'), t.catch_up('ben', 'team'), t.catch_up('ben', 'team', 'ben-agent');
select t.run('ben', format($q$select public.comment_on_proposal(%L, 'Still needed?')::text$q$, t.id('p3')));
select t.expect('flags: a snooze ended by someone else''s comment flags the proposal again',
  t.flags('ana', 'team'), 'responsibility review proposal.comment canon/c.md');
select t.catch_up('ana', 'team'), t.catch_up('ana', 'team', 'ana-agent'), t.catch_up('ben', 'team'), t.catch_up('cal', 'team');

-- 6. Ana proposes a change to notes/x.md; Ben writes the file directly.
insert into t.ids select 'p4', t.run('ana', format($q$select public.propose(%L, 'notes/x.md', 'Ana''s', 'x')$q$, t.id('team')))::uuid;
select t.run('ben', format($q$select public.write_file(%L, 'notes/x.md', 'Ben''s')::text$q$, t.id('team')));
select t.expect('flags: a file your pending proposal would change, written by someone else, flags the proposal (not also as a watched path)',
  t.flags('ana', 'team')
  || ' ' || ((t.flag_json('ana', 'team')::jsonb -> 'flags' -> 0 ->> 'proposal_id') = t.id('p4')::text)::text,
  'working_set base_changed file.write notes/x.md true');
select t.expect('flags: an event under a watched folder is flagged, a viewer''s too, saying what they watch',
  t.flags('cal', 'team') || ' ' || (t.flag_json('cal', 'team')::jsonb -> 'flags' -> 0 ->> 'watching'),
  'subscription path proposal.open notes/x.md; subscription path file.write notes/x.md notes/');
select t.catch_up('ana', 'team'), t.catch_up('ana', 'team', 'ana-agent'), t.catch_up('ben', 'team'), t.catch_up('cal', 'team');

-- 7. What a subscription matches.
select t.run('cal', t.sub_sql('team', 'readme.md'));
select t.run('ana', format($q$select public.write_file(%L, 'readme.md.bak', 'old')::text$q$, t.id('team')));
select t.run('ana', format($q$select public.write_file(%L, 'notes-old/z.md', 'old')::text$q$, t.id('team')));
select t.run('ana', format($q$select public.write_file(%L, 'readme.md', 'Read me')::text$q$, t.id('team')));
select t.expect('flags: a watched file matches only itself, a watched folder only what is under it',
  t.flags('cal', 'team'), 'subscription path file.write readme.md');
-- Timestamps a statement apart; a 2 ms pause makes the order certain on any clock.
select pg_sleep(0.002);
select t.run('ben', t.sub_sql('team', 'readme.md'));
select t.expect('flags: a subscription flags nothing from before it was made',
  t.flags('ben', 'team'), 'none');
select pg_sleep(0.002);
select t.run('ana', format($q$select public.write_file(%L, 'readme.md', 'Read me, again')::text$q$, t.id('team')));
select t.expect('flags: ... and what comes after',
  t.flags('ben', 'team'), 'subscription path file.write readme.md');
select t.catch_up('ana', 'team'), t.catch_up('ana', 'team', 'ana-agent'), t.catch_up('ben', 'team'), t.catch_up('cal', 'team');
select t.run('ana', format($q$select public.write_file(%L, 'notes/y.md', 'Y')::text$q$, t.id('team')));
select t.expect('flags: your own change on a watched path isn''t flagged to you, but is to your agent',
  t.flags('ana', 'team') || ' | ' || t.flags('ana', 'team', 'ana-agent'),
  'none | subscription path file.write notes/y.md');
select t.catch_up('ana', 'team', 'ana-agent');

-- 8. A connection made now.
select pg_sleep(0.002);
select t.run('ana', format($q$select public.create_access_token('ana-late', 30, array[%L]::uuid[], 'write')$q$, t.id('team')));
select t.expect('flags: a new connection is told what waits on its person, not the history before it',
  t.flags('ana', 'team', 'ana-late'),
  'responsibility review proposal.revise canon/a.md; responsibility review proposal.comment canon/c.md; '
  || 'responsibility review proposal.open notes/x.md');
select t.run('ben', format($q$select public.decide(%L, 'request_changes', 'Mine is newer')$q$, t.id('p4')));
select t.expect('flags: ... and is told what happens after',
  t.flags('ana', 'team', 'ana-late'),
  'responsibility review proposal.revise canon/a.md; responsibility review proposal.comment canon/c.md; '
  || 'working_set proposal proposal.request_changes notes/x.md');

-- 9. Other vaults, and who may read flags at all.
select t.catch_up('ana', 'team', 'ana-agent'), t.catch_up('ana', 'side', 'side-only');
insert into t.ids select 'ps', t.run('ana', format($q$select public.propose(%L, 'notes/s.md', 'S', 's')$q$, t.id('side')))::uuid;
select t.run('dee', format($q$select public.write_file(%L, 'notes/dee.md', 'Dee')::text$q$, t.id('dees')));
select t.expect('flags: a vault''s flags never include another vault''s events, even on a path watched in this one',
  t.flags('ana', 'team', 'ana-agent') || ' | ' || t.flags('ana', 'side', 'side-only'),
  'none | responsibility review proposal.open notes/s.md');
select t.expect('flags: an outsider can''t read a vault''s flags',
  t.flags('dee', 'team') || ' ' || t.flags('ben', 'side'), 'ERR P0002 ERR P0002');
select t.expect('flags: a connection scoped to another vault can''t read this vault''s flags',
  t.flags('ana', 'team', 'side-only'), 'ERR P0002');
select t.expect('flags: anonymous can''t read flags; a session without a person is unauthorized',
  t.run(null, t.list_sql('team')) || ' ' || t.run_claims('{"role": "authenticated"}', t.list_sql('team')),
  'ERR 42501 ERR 28000');
select t.expect('flags: a CLI sign-in can''t read flags',
  t.flags('ana', 'team', 'ana-cli'), 'ERR 42501');
select t.expect('flags: an agent without a connection is refused, so it can''t read or move its person''s watermark',
  t.run('ana', t.list_sql('team'), 'Claude Code') || ' ' || t.run('ana', t.advance_sql('team', '1'), 'Claude Code'),
  'ERR 42501 ERR 42501');
select t.expect('flags: a read-only connection reads its person''s flags',
  (t.flag_json('ana', 'team', 'ana-read') not like 'ERR %')::text, 'true');
select t.run('ana', format($q$select 'ok' from public.revoke_access_token(%L)$q$, t.tok('ana-agent2')));
select t.expect('flags: a revoked connection can''t read flags or move its watermark',
  t.flags('ana', 'team', 'ana-agent2') || ' ' || t.as('ana', 'ana-agent2', t.advance_sql('team', '1')),
  'ERR P0002 ERR P0002');
select t.expect('flags: an agent told a proposal waits on its person still can''t approve it',
  t.run_tok('ana', 'ana-agent', format($q$select public.decide(%L, 'approve')$q$, t.id('p1'))), 'ERR 42501');

-- ---------------------------------------------------------------------------
-- Watermarks: each identity its own, moved only forward, only by itself

select t.expect('watermark: list_flags reports the caller''s own watermark, the person''s and each connection''s',
  ((t.flag_json('ana', 'team')::jsonb ->> 'watermark') = t.mark('ana', 'team'))::text
  || ' ' || ((t.flag_json('ana', 'team', 'ana-agent')::jsonb ->> 'watermark') = t.mark('ana', 'team', 'ana-agent'))::text
  || ' ' || (t.mark('ana', 'team') <> t.mark('ana', 'team', 'ana-agent'))::text,
  'true true true');
select t.expect('watermark: one row per identity and vault, however often it moves',
  (select count(*)::text from public.flag_watermarks
    where user_id = t.id('ana') and vault_id = t.id('team') and token_id is null), '1');
insert into t.marks_before select id, last_seq from public.flag_watermarks;
select t.expect('watermark: advancing never moves it back',
  t.run('ana', t.advance_sql('team', '1')), t.mark('ana', 'team'));
select t.expect('watermark: past the vault''s latest entry is refused',
  t.run('ana', t.advance_sql('team', (t.head('team') + 1)::text)), 'ERR 22023');
select t.expect('watermark: a missing or negative position is refused',
  t.run('ana', t.advance_sql('team', 'null')) || ' ' || t.run('ana', t.advance_sql('team', '-1')), 'ERR 22023 ERR 22023');
select t.expect('watermark: an outsider, a connection scoped elsewhere, a CLI sign-in and anonymous can''t move one',
  concat_ws(',', t.run('dee', t.advance_sql('team', '1')), t.run_tok('ana', 'side-only', t.advance_sql('team', '1')),
    t.run_tok('ana', 'ana-cli', t.advance_sql('team', '1')), t.run(null, t.advance_sql('team', '1'))),
  'ERR P0002,ERR P0002,ERR 42501,ERR 42501');
select t.expect('watermark: refused and backward calls change no watermark, and add none',
  t.marks_changed() || ' ' || (select count(*)::text from public.flag_watermarks w
                                where not exists (select 1 from t.marks_before b where b.id = w.id)),
  '0 0');
select t.expect('watermark: a read-only connection moves its own',
  t.run_tok('ana', 'ana-read', t.advance_sql('team', t.head('team')::text)) || ' ' || t.mark('ana', 'team', 'ana-read'),
  t.head('team') || ' ' || t.head('team'));
select t.expect('watermark: moving one identity''s leaves every other''s',
  t.run('ana', t.advance_sql('team', t.head('team')::text)) || ' ' || t.marks_changed()
  || ' ' || t.mark('ana', 'team'),
  t.head('team') || ' 1 ' || t.head('team'));
select t.expect('watermark: nobody reads or writes the table directly, the person, an agent or a connection',
  concat_ws(',',
    t.run('ana', $q$select count(*)::text from public.flag_watermarks$q$),
    t.run('ana', $q$select count(*)::text from public.flag_watermarks$q$, 'Claude Code'),
    t.run_tok('ana', 'ana-agent', $q$select count(*)::text from public.flag_watermarks$q$),
    t.run('ana', format($q$insert into public.flag_watermarks (user_id, vault_id, last_seq) values (%L, %L, 1) returning 1$q$,
      t.id('ana'), t.id('side'))),
    t.run('ana', $q$update public.flag_watermarks set last_seq = 0 returning 1$q$),
    t.run('ana', $q$delete from public.flag_watermarks returning 1$q$)),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501,ERR 42501');

-- ---------------------------------------------------------------------------
-- Membership: subscriptions and watermarks go with it

select t.expect('membership: before, Ben and Cal have subscriptions and watermarks in Team',
  t.subs('ben', 'team') || ' ' || t.marks('ben', 'team') || ' ' || t.subs('cal', 'team') || ' ' || t.marks('cal', 'team'),
  '2 2 2 1');
select t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, 'viewer')$q$, t.id('team'), t.id('ben')));
select t.expect('membership: a role change keeps them',
  t.subs('ben', 'team') || ' ' || t.marks('ben', 'team'), '2 2');
select t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, 'editor')$q$, t.id('team'), t.id('ben')));
create table t.ben_before as select t.mark('ben', 'team') as person, t.mark('ben', 'team', 'ben-agent') as agent;
delete from public.access_tokens where name = 'ben-agent';
select t.expect('membership: a deleted connection takes its watermark, and only its own',
  (select (agent <> 'none')::text || ' ' || person from t.ben_before)
  || ' / ' || t.marks('ben', 'team') || ' ' || t.mark('ben', 'team'),
  'true ' || (select person from t.ben_before) || ' / 1 ' || (select person from t.ben_before));
select t.run('cal', format($q$select 'ok' from public.leave_vault(%L)$q$, t.id('team')));
select t.expect('membership: leaving a vault takes your subscriptions and watermarks in it, not those elsewhere',
  t.subs('cal', 'team') || ' ' || t.marks('cal', 'team') || ' ' || t.subs('cal', 'dees'), '0 0 1');
select t.expect('membership: after leaving, flags and subscribing are refused as no such vault',
  t.flags('cal', 'team') || ' ' || t.run('cal', t.sub_sql('team', 'notes/')), 'ERR P0002 ERR P0002');
select t.run('ana', format($q$select 'ok' from public.set_member(%L, %L, null)$q$, t.id('team'), t.id('ben')));
select t.expect('membership: removed by an owner, the same',
  t.subs('ben', 'team') || ' ' || t.marks('ben', 'team'), '0 0');
select t.expect('membership: before, Ana has a subscription and watermarks in Side',
  t.subs('ana', 'side') || ' ' || t.marks('ana', 'side'), '1 1');
select t.run('ana', format($q$select public.delete_vault(%L, 'Side')::text$q$, t.id('side')));
select t.expect('membership: deleting a vault takes every subscription and watermark in it',
  (select count(*)::text from public.subscriptions where vault_id = t.id('side'))
  || ' ' || (select count(*)::text from public.flag_watermarks where vault_id = t.id('side')),
  '0 0');
