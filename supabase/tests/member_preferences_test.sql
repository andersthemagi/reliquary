-- Hostile tests for 20261014160000_member_preferences: a member's
-- per-vault choices are theirs alone and outlive their membership. Ana
-- owns Team (Ben edits, Cal views), which requires emails; Dee owns Club,
-- where Ben and Cal are members too, so Cal still shares a vault with Ben
-- after Ben leaves Team. Ben hides his email.

insert into auth.users (id, email) values
  (t.id('ana'), 'ana@example.test'), (t.id('ben'), 'ben@example.test'),
  (t.id('cal'), 'cal@example.test'), (t.id('dee'), 'dee@example.test');

insert into t.ids select 'team', t.run('ana', $q$select public.create_vault('Team')$q$)::uuid;
insert into t.ids select 'club', t.run('dee', $q$select public.create_vault('Club')$q$)::uuid;
select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('team'), t.id('cal'), 'viewer', t.id('ana'));
select test_support.add_member(t.id('club'), t.id('ben'), 'editor', t.id('dee'));
select test_support.add_member(t.id('club'), t.id('cal'), 'editor', t.id('dee'));
select t.run('ana', format($q$select public.set_require_emails(%L, true)$q$, t.id('team')));
select t.run('ben', $q$select public.set_email_shown(false)$q$);
select t.run('ben', $q$select public.create_access_token('ben-all', 30)$q$);

-- Ben's stored show_email for a vault, or 'none'.
create function t.pref(p_vault text) returns text language sql as $$
  select coalesce((select value::text from public.member_preferences
                    where user_id = t.id('ben') and vault_id = t.id(p_vault) and preference = 'show_email'), 'none')
$$;
-- How Cal sees Ben's email.
create function t.cal_sees_ben() returns text language sql as $$
  select coalesce(t.run('cal', format($q$select coalesce(email, 'no email') from public.co_member_people(array[%L]::uuid[])$q$, t.id('ben'))), 'nobody')
$$;
create function t.set(p_user text, p_value boolean, p_agent text default null) returns text language sql as $$
  select t.run(p_user, format($q$select public.set_member_preference(%L, 'show_email', %L)$q$, t.id('team'), p_value), p_agent) || 'ok'
$$;

-- ---------------------------------------------------------------------------
-- Theirs alone

select t.expect('preferences: a member sets their own, either way',
  t.set('ben', false) || ' ' || t.pref('team') || ' ' || t.set('ben', true) || ' ' || t.pref('team') || ' ' || t.cal_sees_ben(),
  'ok false ok true ben@example.test');
select t.expect('preferences: nobody else writes the table: not an owner, a co-member, the web, MCP or ops roles',
  t.run('ana', format($q$insert into public.member_preferences (user_id, vault_id, preference, value) values (%L, %L, 'show_email', false) returning 'ok'$q$, t.id('ben'), t.id('club'))) || ' '
  || t.run('ana', format($q$update public.member_preferences set value = false where user_id = %L returning 'changed'$q$, t.id('ben'))) || ' '
  || t.run('cal', format($q$delete from public.member_preferences where user_id = %L returning 'deleted'$q$, t.id('ben'))) || ' '
  || t.run_role('reliquary_web', $q$update public.member_preferences set value = false returning 'changed'$q$) || ' '
  || t.run_role('reliquary_mcp', $q$delete from public.member_preferences returning 'deleted'$q$) || ' '
  || t.run_role('reliquary_ops', $q$update public.member_preferences set value = false returning 'changed'$q$) || ' '
  || t.pref('team') || ' ' || t.pref('club'),
  'ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501 ERR 42501 true none');
select t.expect('preferences: nor the person''s own agent, token or anonymous, and nobody reads the table',
  t.set('ben', false, 'Claude Code') || ' '
  || t.run_tok('ben', 'ben-all', format($q$select public.set_member_preference(%L, 'show_email', false)$q$, t.id('team'))) || ' '
  || t.set(null, false) || ' '
  || t.run('ben', $q$select count(*)::text from public.member_preferences$q$) || ' '
  || t.pref('team'),
  'ERR 42501ok ERR 42501 ERR 42501ok ERR 42501 true');
select t.expect('preferences: an unknown preference, or a vault you aren''t in, is refused',
  t.run('ben', format($q$select public.set_member_preference(%L, 'show_phone', true)$q$, t.id('team'))) || ' '
  || t.run('dee', format($q$select public.set_member_preference(%L, 'show_email', true)$q$, t.id('team'))),
  'ERR 22023 ERR P0002');

-- ---------------------------------------------------------------------------
-- Outliving the membership

select t.expect('preferences: turning the requirement off keeps the row and hides the email meanwhile',
  (t.run('ana', format($q$select public.set_require_emails(%L, false)$q$, t.id('team'))) || 'ok') || ' '
  || t.pref('team') || ' ' || t.cal_sees_ben(),
  'ok true no email');
select t.expect('preferences: turning it back on applies the stored choice, with no new prompt',
  (t.run('ana', format($q$select public.set_require_emails(%L, true)$q$, t.id('team'))) || 'ok') || ' '
  || t.run('ben', format($q$select public.email_consent_needed(%L)::text$q$, t.id('team'))) || ' ' || t.cal_sees_ben(),
  'ok false ben@example.test');

select t.run('ben', format($q$select public.leave_vault(%L)$q$, t.id('team')));
select t.expect('preferences: the row survives leaving',
  t.pref('team'), 'true');
select t.expect('preferences: a former member''s stored choice reveals nothing, even to someone who shares another vault with them',
  t.cal_sees_ben(), 'no email');

select test_support.add_member(t.id('team'), t.id('ben'), 'editor', t.id('ana'));
select t.expect('preferences: rejoining applies it again, with no new prompt',
  t.run('ben', format($q$select public.email_consent_needed(%L)::text$q$, t.id('team'))) || ' ' || t.cal_sees_ben(),
  'false ben@example.test');

select t.run('ana', format($q$select public.set_member(%L, %L, null)$q$, t.id('team'), t.id('ben')));
select t.expect('preferences: the row survives removal too, and reveals nothing meanwhile',
  t.pref('team') || ' ' || t.cal_sees_ben(), 'true no email');

-- ---------------------------------------------------------------------------
-- Only the vault's deletion removes them

select t.run('ben', format($q$select public.set_member_preference(%L, 'show_email', true)$q$, t.id('club')));
select t.run('ana', format($q$select public.delete_vault(%L, 'Team')$q$, t.id('team')));
select t.expect('preferences: deleting the vault removes its rows, and only its rows',
  (select count(*)::text from public.vaults where id = t.id('team')) || ' ' || t.pref('team') || ' ' || t.pref('club'),
  '0 none true');
