-- Waiting on you, on a path with named owners (20261019130000_review_path_owners,
-- issue #196): a proposal on such a path is flagged, and counted in the
-- Inbox's review set, to its named owners only, whatever their role, and
-- not to the vault's owners and editors; a path with no named owners is as
-- before. The rest of list_flags is flags_test.sql's and the Inbox
-- shell_inbox_test.sql's.
--
-- Team: Ana owns, Ben edits, Cal views and is the named owner of owned/;
-- Dee owns a vault of her own, from which Ben proposes nothing.

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select t.run('ana', format($q$select public.set_policy(%L, 'owned/', 'canon', 1)$q$, t.id('team')));
select t.run('ana', format($q$select public.set_path_owner(%L, 'owned/', %L)$q$, t.id('team'), t.id('cal')));

create function t.flags(p_user text) returns text language plpgsql as $$
declare v text := t.run(p_user, format($q$select public.list_flags(%L, 50)::text$q$, t.id('team')));
begin
  if v like 'ERR %' then return v; end if;
  return (select coalesce(string_agg(concat_ws(' ', f ->> 'category', f ->> 'reason', f ->> 'path'), '; ' order by (f ->> 'seq')::bigint), 'none')
            from jsonb_array_elements(v::jsonb -> 'flags') f);
end $$;
create function t.review(p_user text) returns text language sql as
$$ select t.run(p_user, $q$select public.shell_summary(5) #>> '{counts,review}'$q$) $$;

insert into t.ids select 'p1', t.run('ben', format($q$select public.propose(%L, 'owned/a.md', 'A', 'a')$q$, t.id('team')))::uuid;

select t.expect('review by path owners: a proposal on an owned path is flagged to its named owner, a viewer',
  t.flags('cal'), 'responsibility review owned/a.md');
select t.expect('review by path owners: it is not flagged to the vault''s owner, whose approval doesn''t count there',
  t.flags('ana'), 'none');
select t.expect('review by path owners: the Inbox counts it for the named owner and not for the vault''s owner',
  t.review('cal') || ' ' || t.review('ana'), '1 0');

insert into t.ids select 'p2', t.run('ben', format($q$select public.propose(%L, 'canon/b.md', 'B', 'b')$q$, t.id('team')))::uuid;
select t.expect('review by path owners: a path with no named owners still waits on owners and editors, and not on the viewer',
  t.flags('ana') || ' | ' || t.flags('cal') || ' | ' || t.review('ana') || ' ' || t.review('cal'),
  'responsibility review canon/b.md | responsibility review owned/a.md | 1 1');

select t.run('ana', format($q$select public.remove_path_owner(%L, 'owned/', %L)$q$, t.id('team'), t.id('cal')));
select t.expect('review by path owners: once the last named owner is removed, the proposal waits on owners and editors again',
  t.flags('ana') || ' | ' || t.flags('cal') || ' | ' || t.review('ana') || ' ' || t.review('cal'),
  'responsibility review owned/a.md; responsibility review canon/b.md | none | 2 0');
