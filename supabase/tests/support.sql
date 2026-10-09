-- Test-only helpers. Not a migration: every test runner loads this after the
-- migrations, and nothing else does, so production never has it.
--
-- test_support.add_member puts someone in a vault directly, as the database
-- owner, for seeds and test setup. In production a new member joins only by
-- accepting an invite (20260925160000_membership_polish.sql); set_member no
-- longer adds anyone. It writes the member.set log row set_member used to,
-- attributed to p_by, so tests that count log rows see what they did before.
-- No API role can reach this schema.

create schema if not exists test_support;
revoke all on schema test_support from public, anon, authenticated;

create or replace function test_support.add_member(p_vault uuid, p_user uuid, p_role text, p_by uuid)
returns void
language plpgsql set search_path = '' as $$
begin
  insert into public.vault_members (vault_id, user_id, role) values (p_vault, p_user, p_role)
  on conflict (vault_id, user_id) do update set role = excluded.role;
  insert into public.log (vault_id, actor, agent, event, detail)
  values (p_vault, p_by, null, 'member.set', jsonb_build_object('user', p_user, 'role', p_role));
end $$;
revoke all on function test_support.add_member(uuid, uuid, text, uuid) from public, anon, authenticated;

-- test_support.roomy_free gives the Free plan room for a whole suite
-- (20260925230000_plans): web/test.sh and cli/test.sh run many test files
-- as the same few people in one database, well past Free's 5 vaults. Plans
-- themselves are tested with plans of their own (supabase/tests/plans_test.sql,
-- web/test/plans.test.mjs), never through this.
create or replace function test_support.roomy_free()
returns void
language sql set search_path = '' as $$
  update private.plans set max_vaults = 1000, max_members = 1000, max_storage_bytes = 1000000000000
   where id = 'free'
$$;
revoke all on function test_support.roomy_free() from public, anon, authenticated;

-- Admission (20260925240000_admission): the suites predate it and
-- create vaults as people nobody admitted (most with no account in
-- auth.users at all), so every test database starts open (invite-only off,
-- as after the alpha). Admission is tested with it on, by the tests that
-- turn it on themselves: supabase/tests/admission_test.sql (a database of
-- its own), web/test/admission.test.mjs and mcp/test/admission.test.mjs
-- (their suites run one file at a time; each turns it on in before() and
-- off again in after()). With no daily quota on open admission
-- (20261009200000_open_admission), since they make many accounts a day;
-- admission_test.sql sets one.
update private.settings set invite_only = false, open_per_day = null;
