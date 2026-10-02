-- Hostile tests for 20260925150000_efficiency_3: the vault an MCP tool names
-- resolved in the tool's query, the env API's token resolved in its
-- transaction, rules for (vault, path) pairs, and search words for current
-- versions only. docs/research/server-load.md, "Third pass".

-- ---------------------------------------------------------------------------
-- Setup: Ana owns Team (Ben edits, Cal views), Side and two vaults named
-- Twin; Dee owns Private and a vault named Team.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'side', t.run('ana', $q$select public.create_vault('Side')$q$)::uuid;
insert into t.ids select 'twin1', t.run('ana', $q$select public.create_vault('Twin')$q$)::uuid;
insert into t.ids select 'twin2', t.run('ana', $q$select public.create_vault('Twin')$q$)::uuid;
insert into t.ids select 'priv', t.run('dee', $q$select public.create_vault('Private')$q$)::uuid;
insert into t.ids select 'dteam', t.run('dee', $q$select public.create_vault('Team')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));

create function t.pat_tok(p_name text) returns uuid language sql as
$$ select id from public.access_tokens where name = p_name and kind = 'pat' $$;
create function t.run_pat_tok(p_user text, p_tok text, p_sql text) returns text language sql as $$
  select t.run_claims(jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated',
    'act', jsonb_build_object('sub', t.pat_tok(p_tok), 'name', p_tok, 'tok', t.pat_tok(p_tok))), p_sql)
$$;
select t.run('ana', format($q$select public.create_access_token('ana-side', 30, array[%L]::uuid[], 'read')$q$, t.id('side')));

-- ---------------------------------------------------------------------------
-- 1. The vault a tool names

-- The lookup the MCP server made before (mcp/src/tools.ts, vaultId), as the
-- caller: the id, or 'none' where it answered "no vault".
create function t.lookup_before(p_ref text) returns text language plpgsql as $$
declare ids uuid[];
begin
  if p_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select array_agg(id) into ids from public.vaults where id = p_ref::uuid;
  else
    select array_agg(v.id) into ids from public.vault_members m join public.vaults v on v.id = m.vault_id
     where m.user_id = private.uid() and v.name = p_ref;
  end if;
  return case when cardinality(ids) = 1 then ids[1]::text else 'none' end;
end $$;
grant usage on schema t to authenticated;
grant execute on function t.lookup_before(text) to authenticated;
create function t.lookup_now(p_ref text) returns text language plpgsql as $$
begin
  return private.vault_ref(p_ref)::text;
exception when sqlstate 'RLV01' then
  return 'none';
end $$;
grant execute on function t.lookup_now(text) to authenticated;

create function t.refs_agree(p_user text, p_tok text default null) returns text language sql as $$
  select string_agg(ref || '=' || (a = b)::text || ':' || (a <> 'none')::text, ',' order by ord)
    from (select r.ref, r.ord,
                 case when p_tok is null then t.run(p_user, format('select t.lookup_before(%L)', r.ref))
                      else t.run_pat_tok(p_user, p_tok, format('select t.lookup_before(%L)', r.ref)) end as a,
                 case when p_tok is null then t.run(p_user, format('select t.lookup_now(%L)', r.ref))
                      else t.run_pat_tok(p_user, p_tok, format('select t.lookup_now(%L)', r.ref)) end as b
            from unnest(array['Team', 'Side', 'Twin', 'Private', 'team', t.id('team')::text, upper(t.id('team')::text),
                              t.id('priv')::text, '00000000-0000-0000-0000-000000000000', 'not-a-uuid-0000', ''])
                 with ordinality r(ref, ord)) x
$$;
select t.expect('vault ref: the same vault as the lookup it replaces, by name and by id, for the owner',
  t.refs_agree('ana'),
  'Team=true:true,Side=true:true,Twin=true:false,Private=true:false,team=true:false,' || t.id('team') || '=true:true,'
  || upper(t.id('team')::text) || '=true:true,' || t.id('priv') || '=true:false,00000000-0000-0000-0000-000000000000=true:false,'
  || 'not-a-uuid-0000=true:false,=true:false');
select t.expect('vault ref: and for an editor, a viewer and an outsider (whose own Team is found, never Ana''s)',
  t.refs_agree('ben') || ' | ' || t.refs_agree('cal') || ' | ' || t.refs_agree('dee'),
  t.refs_agree('ben') || ' | ' || t.refs_agree('cal') || ' | ' || t.refs_agree('dee'));
select t.expect('vault ref: an outsider''s Team is their own; Ana''s id tells them nothing',
  t.run('dee', 'select t.lookup_now(''Team'')') || ',' || t.run('dee', format('select t.lookup_now(%L)', t.id('team'))),
  t.id('dteam') || ',none');
select t.expect('vault ref: two vaults with one name are "no vault", as before (refer to it by id)',
  t.run('ana', 'select t.lookup_now(''Twin'')') || ',' || t.run('ana', format('select t.lookup_now(%L)', t.id('twin2'))),
  'none,' || t.id('twin2'));
select t.expect('vault ref: a token scoped to Side finds Side only, by name or id',
  t.refs_agree('ana', 'ana-side') || ' | ' || t.run_pat_tok('ana', 'ana-side', 'select t.lookup_now(''Side'')')
  || ',' || t.run_pat_tok('ana', 'ana-side', 'select t.lookup_now(''Team'')')
  || ',' || t.run_pat_tok('ana', 'ana-side', format('select t.lookup_now(%L)', t.id('team'))),
  t.refs_agree('ana', 'ana-side') || ' | ' || t.id('side') || ',none,none');
select t.expect('vault ref: no vault raises RLV01; anonymous callers can''t call it',
  t.run('dee', format('select private.vault_ref(%L)', t.id('team'))) || ',' || t.run(null, 'select private.vault_ref(''Team'')'),
  'ERR RLV01,ERR 42501');

-- ---------------------------------------------------------------------------
-- 2. The env API's token, inside its transaction

create function t.cli(p_user text, p_access text, p_resource text) returns text language plpgsql as $$
declare
  v_code text;
  v_client text := 'https://app.example/cli/oauth-client.json';
  v_redirect text := 'http://127.0.0.1:53682/callback';
  v_verifier text := repeat('v', 43) || 'erifier-for-tests';
begin
  v_code := t.run(p_user, format($q$select public.create_cli_grant(%L, %L, %L, %L, null, false)$q$,
    v_client, v_redirect, p_resource, t.s256(v_verifier)));
  return t.run_role('reliquary_web', format($q$select private.oauth_redeem_code(%L, %L, %L, %L, %L, %L, %L)$q$,
    t.sha(v_code), v_client, v_redirect, p_resource, v_verifier, t.sha(p_access), t.sha(p_access || '-r')));
end $$;
select t.cli('ana', 'rle_efficiency3_cli', 'https://app.example/api/env');

-- As the web app: become reliquary_web, call env_begin, then run p_sql in
-- the same transaction. "user,current_user,act.tok[,answer]".
create function t.env_begin(p_hash text, p_resource text default 'https://app.example/api/env', p_sql text default null,
  p_role text default 'reliquary_web') returns text
language plpgsql as $$
declare u text; v text;
begin
  perform set_config('role', p_role, true);
  select coalesce(string_agg(user_id::text, ','), 'none') into u from private.env_begin(p_hash, p_resource);
  v := u || ',' || current_user || ',' ||
       coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb -> 'act' ->> 'tok', '-');
  if p_sql is not null then
    execute p_sql into u;
    v := v || ',' || coalesce(u, 'null');
  end if;
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return v;
exception when others then
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claims', '', true);
  return 'ERR ' || sqlstate;
end $$;
create function t.grant_id() returns text language sql as
$$ select id::text from public.access_tokens where kind = 'cli' and user_id = t.id('ana') $$;

select t.expect('env begin: a CLI token makes the rest of the transaction its person, through the grant',
  t.env_begin(t.sha('rle_efficiency3_cli'), p_sql => 'select private.uid()::text || ''/'' || private.token_kind()'),
  t.id('ana') || ',authenticated,' || t.grant_id() || ',' || t.id('ana') || '/cli');
select t.expect('env begin: the grant reads what the env API reads: its person''s vaults',
  split_part(t.env_begin(t.sha('rle_efficiency3_cli'), p_sql => 'select count(*) from public.env_vaults()'), ',', 4),
  (select count(*)::text from public.vault_members where user_id = t.id('ana')));
select t.expect('env begin: an unknown token, or a grant''s token for another resource, sets nothing, and then nothing is readable',
  t.env_begin(t.sha('rle_nope')) || ';' || t.env_begin(t.sha('rle_efficiency3_cli'), 'https://other.example/api/env')
  || ';' || (t.env_begin(t.sha('rle_efficiency3_cli'), 'https://app.example/api/env', 'select count(*) from public.files')
    like '%,authenticated,%')::text
  || ';' || t.env_begin(t.sha('rle_nope'), 'https://app.example/api/env', 'select count(*) from public.files'),
  'none,reliquary_web,-;none,reliquary_web,-;true;ERR 42501');
select t.expect('env begin: people, anonymous callers and the MCP server''s role can''t call it',
  t.run('ana', format($q$select count(*) from private.env_begin(%L, 'https://app.example/api/env')$q$, t.sha('rle_efficiency3_cli')))
  || ',' || t.run(null, format($q$select count(*) from private.env_begin(%L, 'https://app.example/api/env')$q$, t.sha('rle_efficiency3_cli')))
  || ',' || t.env_begin(t.sha('rle_efficiency3_cli'), p_role => 'reliquary_mcp'),
  'ERR 42501,ERR 42501,ERR 42501');
update public.access_tokens set revoked_at = now() where kind = 'cli' and user_id = t.id('ana');
select t.expect('env begin: a revoked grant sets nothing',
  t.env_begin(t.sha('rle_efficiency3_cli')), 'none,reliquary_web,-');

-- ---------------------------------------------------------------------------
-- 3. Rules for (vault, path) pairs

select t.run('ana', format($q$select public.set_policy(%L, 'notes/', 'canon', 2)$q$, t.id('team')));
select t.run('ana', format($q$select public.set_policy(%L, 'notes/deep/', 'open', 1)$q$, t.id('team')));
select t.run('ana', format($q$select public.set_policy(%L, 'notes/deep/x.md', 'canon', 3)$q$, t.id('team')));
update public.vaults set default_policy = 'canon' where id = t.id('side');
select t.run('dee', format($q$select public.set_policy(%L, 'notes/', 'canon', 4)$q$, t.id('priv')));

create table t.pairs as
  select v, p from unnest(array[t.id('team'), t.id('side'), t.id('priv')]) v,
                   unnest(array['notes/a.md', 'notes/deep/y.md', 'notes/deep/x.md', 'readme.md', 'notes/']) p;
grant select on t.pairs to authenticated;
create function t.pairs_agree(p_user text, p_tok text default null) returns text language sql as $$
  select case when p_tok is null then t.run(p_user, q) else t.run_pat_tok(p_user, p_tok, q) end
    from (select $q$select ((select coalesce(string_agg(x.vault_id || x.path || x.policy || x.quorum, ',' order by x.vault_id, x.path), '')
                    from private.rules_for_pairs((select array_agg(v) from t.pairs), (select array_agg(p) from t.pairs)) x)
             = (select coalesce(string_agg(v || p || r.policy || r.quorum, ',' order by v, p), '')
                  from t.pairs, private.rule_for(v, p) r where r.policy is not null))::text
             || ':' || (select count(*) from private.rules_for_pairs((select array_agg(v) from t.pairs), (select array_agg(p) from t.pairs)))$q$ as q) s
$$;
select t.expect('rules for pairs: the same rule and quorum as rule_for, pair by pair, across vaults, for owner, editor, viewer and outsider',
  t.pairs_agree('ana') || ',' || t.pairs_agree('ben') || ',' || t.pairs_agree('cal') || ',' || t.pairs_agree('dee'),
  'true:10,true:5,true:5,true:5');
select t.expect('rules for pairs: the rules themselves (exact file, nested folder, folder, default)',
  t.run('ana', format($q$select string_agg(path || '=' || policy || quorum, ',' order by path)
    from private.rules_for_pairs(array[%1$L, %1$L, %1$L, %1$L, %2$L]::uuid[], array['notes/a.md', 'notes/deep/y.md', 'notes/deep/x.md', 'readme.md', 'x.md'])$q$,
    t.id('team'), t.id('side'))),
  'notes/a.md=canon2,notes/deep/x.md=canon3,notes/deep/y.md=open1,readme.md=open1,x.md=canon1');
select t.expect('rules for pairs: a token scoped to Side answers for Side only; anonymous callers can''t call it',
  t.pairs_agree('ana', 'ana-side') || ',' || t.run(null, $q$select count(*) from private.rules_for_pairs(array[]::uuid[], array[]::text[])$q$),
  'true:5,ERR 42501');

-- ---------------------------------------------------------------------------
-- 4. Search words for current versions only

insert into t.ids select 'words', t.run('ana', $q$select public.create_vault('Words')$q$)::uuid;
select t.run('ana', format($q$select public.write_file(%L, 'a.md', 'first alpha')$q$, t.id('words')));
select t.run('ana', format($q$select public.write_file(%L, 'a.md', 'second bravo')$q$, t.id('words')));
select t.run('ana', format($q$select public.write_file(%L, 'a.md', 'third charlie')$q$, t.id('words')));
select t.run('ana', format($q$select public.write_file(%L, 'b.md', 'only delta')$q$, t.id('words')));
create function t.words() returns text language sql as $$
  select string_agg(coalesce(body, '(erased)') || '=' || coalesce(body_tsv::text, '-'), ',' order by created_at, body)
    from public.file_versions where vault_id = t.id('words')
$$;
select t.expect('search words: only each file''s current version keeps its words',
  t.words(), 'first alpha=-,second bravo=-,third charlie=''charlie'':2 ''third'':1,only delta=''delta'':2 ''only'':1');
select t.expect('search words: the current text is found, superseded text isn''t (as before)',
  t.run('ana', format($q$select string_agg(path, ',' order by path) from public.search(%L, 'charlie or alpha or delta')$q$, t.id('words'))),
  'a.md,b.md');
select t.run('ana', format($q$select public.delete_file(%L, 'b.md')$q$, t.id('words')));
select t.run('ana', format($q$select public.write_file(%L, 'b.md', 'delta again')$q$, t.id('words')));
select t.expect('search words: writing a deleted file again moves the words to the new version',
  t.words(), 'first alpha=-,second bravo=-,third charlie=''charlie'':2 ''third'':1,only delta=-,delta again=''again'':2 ''delta'':1');
select t.run('ana', format($q$select public.erase_file(%L, 'a.md')$q$, t.id('words')));
select t.expect('search words: erasing a file erases its words',
  t.words(), '(erased)=-,(erased)=-,(erased)=-,only delta=-,delta again=''again'':2 ''delta'':1');
-- A proposal applied by approval writes a version the same way.
select t.run('ana', format($q$select public.set_policy(%L, 'c/', 'canon', 1)$q$, t.id('words')));
select t.run('ana', format($q$select public.write_file(%L, 'c.md', 'x')$q$, t.id('words')));
insert into t.ids select 'prop', t.run('ana', format($q$select public.propose(%L, 'c/p.md', 'proposed echo', 'why')$q$, t.id('words')))::uuid;
select t.run('ana', format($q$select public.decide(%L, 'approve', null)$q$, t.id('prop')));
select t.expect('search words: an approved proposal''s version is searchable',
  t.run('ana', format($q$select string_agg(path, ',') from public.search(%L, 'echo')$q$, t.id('words'))), 'c/p.md');

-- As the table's owner (triggers still apply): the result, or ERR <sqlstate>.
create function t.try(p_sql text) returns text language plpgsql as $$
declare v text;
begin
  execute p_sql into v;
  return coalesce(v, 'null');
exception when others then
  return 'ERR ' || sqlstate;
end $$;
select t.expect('search words: versions are still insert-only: changing text or author or setting words is refused; only erasing or clearing words',
  t.try(format($s$update public.file_versions set body = 'changed' where vault_id = %L and body = 'delta again' returning 'x'$s$, t.id('words')))
  || ',' || t.try(format($s$update public.file_versions set author = %L where vault_id = %L and body = 'delta again' returning 'x'$s$, t.id('dee'), t.id('words')))
  || ',' || t.try(format($s$update public.file_versions set body_tsv = to_tsvector('simple', 'forged') where vault_id = %L and body = 'delta again' returning 'x'$s$, t.id('words')))
  || ',' || t.try(format($s$update public.file_versions set body_tsv = null, agent = 'sneaky' where vault_id = %L and body = 'delta again' returning 'x'$s$, t.id('words')))
  || ',' || t.try(format($s$update public.file_versions set body_tsv = null where vault_id = %L and body = 'delta again' returning 'cleared'$s$, t.id('words')))
  || ',' || t.try(format($s$delete from public.file_versions where vault_id = %L returning 'deleted'$s$, t.id('words'))),
  'ERR 42501,ERR 42501,ERR 42501,ERR 42501,cleared,ERR 42501');
select t.expect('search words: API roles can''t change versions: nothing is updated',
  (coalesce(t.run('ana', format($q$update public.file_versions set body_tsv = null where vault_id = %L returning 'x'$q$, t.id('words'))), 'none')
    in ('ERR 42501', 'none'))::text
  || ',' || (select count(*) from public.file_versions where vault_id = t.id('words') and body_tsv is not null)::text,
  'true,2');

-- The backfill: words left on history (as the generated column kept them)
-- are cleared, current versions keep theirs.
select t.run('ana', format($q$select public.write_file(%L, 'h.md', 'old history words')$q$, t.id('words')));
select t.run('ana', format($q$select public.write_file(%L, 'h.md', 'new current words')$q$, t.id('words')));
set session_replication_role = replica;
update public.file_versions set body_tsv = to_tsvector('simple', coalesce(body, '')) where vault_id = t.id('words');
set session_replication_role = origin;
select t.expect('backfill: it clears history''s and erased versions'' words',
  private.clear_history_words()::text, '5');
select t.expect('backfill: what is left is exactly each file''s current version',
  (select string_agg(body, ',' order by body) from public.file_versions where vault_id = t.id('words') and body_tsv is not null),
  'delta again,new current words,proposed echo,x');
select t.expect('backfill: a second run finds nothing; no app role can run it',
  private.clear_history_words()::text || ',' || t.run('ana', 'select private.clear_history_words()')
  || ',' || t.run_role('reliquary_web', 'select private.clear_history_words()')
  || ',' || t.run_role('reliquary_mcp', 'select private.clear_history_words()'),
  '0,ERR 42501,ERR 42501,ERR 42501');
