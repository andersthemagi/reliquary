-- Hostile tests for claim rules (20260930220000_claim_rules): the
-- resolution a rule gives claim_path/renew_claim (no rule falls back to
-- the fixed defaults; a prefix rule overrides them; the specificity order
-- is path_policies' own; a request over the rule's maximum is clamped, a
-- shorter one honoured; the hold limit and caps come from the rule too),
-- set_claim_rule's own access rule (person, owner, same ceiling as
-- set_policy), and that changing a rule never touches an already-granted
-- claim's expiry. Path validity itself (set_claim_rule reuses private.
-- rule_path_problem) is exhaustively covered by rule_paths_test.sql; this
-- file spot-checks that it's actually called, not the validator's own
-- cases again. Each resolution check claims and releases its own fresh
-- path, so one connection's caps never interact across sections.

insert into t.ids select 'cr', t.run('ana', $q$select public.create_vault('Claim rules')$q$)::uuid;
select test_support.add_member(t.id('cr'), t.id('ben'), 'editor', t.id('ana'));
select test_support.add_member(t.id('cr'), t.id('cal'), 'viewer', t.id('ana'));

-- The error message p_sql raises as p_user (NULL if it doesn't raise), an
-- agent too when named (same shape as rule_paths_test.sql's t.rp_err).
create function t.cr_err(p_user text, p_sql text, p_agent text default null) returns text
language plpgsql as $$
declare claims jsonb := jsonb_build_object('sub', t.id(p_user), 'role', 'authenticated');
begin
  if p_agent is not null then claims := claims || jsonb_build_object('act', jsonb_build_object('sub', 'agent-1', 'name', p_agent)); end if;
  perform set_config('request.jwt.claims', claims::text, true);
  perform set_config('role', 'authenticated', true);
  execute p_sql;
  perform set_config('role', 'none', true);
  return null;
exception when others then
  perform set_config('role', 'none', true);
  return sqlstate || ' ' || sqlerrm;
end $$;

create function t.set_rule(p_path text, p_lease int, p_hold int, p_max int default null, p_conn int default 1, p_person int default 5)
returns text language sql as $$
  select t.cr_err('ana', format('select public.set_claim_rule(%L, %L, %L, %L, %L, %L, %L)',
    t.id('cr'), p_path, p_lease, p_hold, p_max, p_conn, p_person))
$$;
create function t.rule_row(p_path text) returns public.claim_rules language sql as $$
  select * from public.claim_rules where vault_id = t.id('cr') and path = p_path
$$;
create function t.seed(p_path text) returns void language sql as $$
  select t.run('ben', format($q$select public.write_file(%L, %L, 'x')$q$, t.id('cr'), p_path))
$$;
create function t.claim_sql(p_path text, p_ttl int default null) returns text language sql as $$
  select format($q$select o_secret from public.claim_path(%L, %L, null, %L)$q$, t.id('cr'), p_path, p_ttl)
$$;
create function t.renew_sql(p_path text, p_fence int, p_secret text, p_ttl int default null) returns text language sql as $$
  select format($q$select public.renew_claim(%L, %L, %L, %L, %L)::text$q$, t.id('cr'), p_path, p_fence, p_secret, p_ttl)
$$;
create function t.row(p_path text) returns public.path_claims language sql as $$
  select * from public.path_claims where vault_id = t.id('cr') and path = p_path
$$;
create table t.vals (name text primary key, val text);
create function t.save(p_name text, p_val text) returns text language sql as $$
  insert into t.vals values (p_name, p_val) on conflict (name) do update set val = excluded.val returning val
$$;
create function t.val(p_name text) returns text language sql as $$ select val from t.vals where name = p_name $$;

-- Claims p_path as Ben (seeding it first), returns how many minutes from
-- now its expires_at is, and releases it, so the next check starts clean.
create function t.claim_minutes(p_path text, p_ttl int default null) returns numeric
language plpgsql as $$
declare v_vault uuid := t.id('cr'); v_ben uuid := t.id('ben');
        v_secret text; v_fence int; v_expires timestamptz; v_before timestamptz;
begin
  perform t.seed(p_path);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', v_ben, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  v_before := clock_timestamp();
  select o_secret, o_fence, o_expires into v_secret, v_fence, v_expires
    from public.claim_path(v_vault, p_path, null, p_ttl);
  perform public.release_claim(v_vault, p_path, v_fence, v_secret);
  perform set_config('role', 'none', true);
  return extract(epoch from (v_expires - v_before)) / 60;
end $$;

-- ---------------------------------------------------------------------------
-- set_claim_rule: who may, and that the path check actually runs

select t.expect('set rule: an agent is refused',
  t.run('ana', format($q$select public.set_claim_rule(%L, 'a/', 30, 120)$q$, t.id('cr')), 'Claude Code'), 'ERR 42501');
select t.expect('set rule: an editor is refused',
  left(t.cr_err('ben', format($q$select public.set_claim_rule(%L, 'a/', 30, 120)$q$, t.id('cr'))), 5), '42501');
select t.expect('set rule: a viewer is refused',
  left(t.cr_err('cal', format($q$select public.set_claim_rule(%L, 'a/', 30, 120)$q$, t.id('cr'))), 5), '42501');
select t.expect_true('set rule: none of the refused attempts stored a rule', (t.rule_row('a/')) is null);
select t.expect_true('set rule: a bad path is refused by the same validator set_policy uses',
  t.set_rule('../x', 30, 120) like '22023 The rule on "../x" has a .. segment%', t.set_rule('../x', 30, 120));
select t.expect_true('set rule: nothing refused was stored', (t.rule_row('../x')) is null);

-- ---------------------------------------------------------------------------
-- resolution: no rule, a prefix rule, specificity, clamping

select t.expect_true('resolve: no rule falls back to the fixed default, 48 hours',
  abs(t.claim_minutes('d/no-rule.md') - 48 * 60) < 1);

select t.expect('set rule: an owner sets a folder rule', t.set_rule('a/', 30, 120, 30, 2, 3), null);
select t.expect_true('set rule: stored as given',
  (t.rule_row('a/')).lease_minutes = 30 and (t.rule_row('a/')).hold_limit_minutes = 120
  and (t.rule_row('a/')).max_lease_minutes = 30 and (t.rule_row('a/')).connection_cap = 2 and (t.rule_row('a/')).person_cap = 3);
select t.expect_true('resolve: a prefix rule overrides the default', abs(t.claim_minutes('a/x.md') - 30) < 1);

select t.expect('set rule: a more specific rule on one exact file', t.set_rule('a/x.md', 10, 60, 10), null);
select t.expect_true('resolve: the exact path wins over its folder''s rule', abs(t.claim_minutes('a/x.md') - 10) < 1);
select t.expect_true('resolve: the folder rule still applies to a sibling', abs(t.claim_minutes('a/y.md') - 30) < 1);

select t.expect_true('resolve: a request over the rule''s maximum is clamped', abs(t.claim_minutes('a/x.md', 500) - 10) < 1);
select t.expect_true('resolve: a shorter request is honoured', abs(t.claim_minutes('a/x.md', 3) - 3) < 1);

-- ---------------------------------------------------------------------------
-- a lease under one minute, and a hold limit shorter than the lease

select t.expect_true('set rule: a lease under one minute is refused',
  t.set_rule('b/', 0, 60) like '23514%', t.set_rule('b/', 0, 60));
select t.expect_true('set rule: a hold limit shorter than the lease is refused',
  t.set_rule('b/', 30, 10) like '23514%', t.set_rule('b/', 30, 10));
select t.expect_true('set rule: neither was stored', (t.rule_row('b/')) is null);

-- ---------------------------------------------------------------------------
-- caps: the rule's own connection and person caps, not the fixed default

select t.seed('e/1.md');
select t.seed('e/2.md');
select t.seed('e/3.md');
select t.expect_true('caps: a first claim succeeds under the default cap',
  t.run('ben', t.claim_sql('e/1.md')) ~ '^[0-9a-f]{64}$');
select t.expect('caps: the default connection cap (1) refuses a second claim',
  t.run('ben', t.claim_sql('e/2.md')), 'ERR RLC03');
select t.expect('set rule: e/ allows 2 claims per connection', t.set_rule('e/', 60, 300, 60, 2, 5), null);
select t.expect_true('caps: the rule''s higher connection cap allows a second claim under it',
  t.run('ben', t.claim_sql('e/2.md')) ~ '^[0-9a-f]{64}$');
select t.expect('caps: a third is refused by the rule''s own cap of 2',
  t.run('ben', t.claim_sql('e/3.md')), 'ERR RLC03');
-- Frees Ben's connection for the sections below (secrets were never
-- captured; expiring directly is path_claims_test.sql's own technique).
update public.path_claims set expires_at = now() - interval '1 second' where vault_id = t.id('cr') and path in ('e/1.md', 'e/2.md');

-- ---------------------------------------------------------------------------
-- hold limit: from the rule, not the fixed 7 days

select t.seed('f/z.md');
select t.expect('set rule: f/ has a 60 minute lease and a 90 minute hold limit', t.set_rule('f/', 60, 90, 60), null);
select t.save('f', t.run('ben', t.claim_sql('f/z.md')));
update public.path_claims set granted_at = now() - interval '85 minutes' where vault_id = t.id('cr') and path = 'f/z.md';
select t.save('f-granted', (t.row('f/z.md')).granted_at::text);
select t.run('ben', t.renew_sql('f/z.md', (t.row('f/z.md')).fence, t.val('f'), 60));
select t.expect_true('hold limit: a renewal is capped at the rule''s own hold limit from the original grant, not the full request',
  abs(extract(epoch from ((t.row('f/z.md')).expires_at - (t.val('f-granted')::timestamptz + interval '90 minutes')))) < 1);

update public.path_claims set granted_at = now() - interval '91 minutes' where vault_id = t.id('cr') and path = 'f/z.md';
select t.expect('hold limit: past the rule''s own hold limit, a renewal is refused outright',
  t.run('ben', t.renew_sql('f/z.md', (t.row('f/z.md')).fence, t.val('f'), 60)), 'ERR RLC04');
update public.path_claims set expires_at = now() - interval '1 second' where vault_id = t.id('cr') and path = 'f/z.md';

-- ---------------------------------------------------------------------------
-- changing a rule: affects new claims and check-ins, never an
-- already-granted claim's own expiry

select t.seed('g/z.md');
select t.expect('set rule: g/ starts at a 60 minute lease', t.set_rule('g/', 60, 300, 60), null);
select t.save('g', t.run('ben', t.claim_sql('g/z.md')));
select t.save('g-expires', (t.row('g/z.md')).expires_at::text);
select t.expect('set rule: g/ changes to a 10 minute lease', t.set_rule('g/', 10, 300, 10), null);
select t.expect_true('rule change: the already-granted claim''s own expiry is untouched',
  (t.row('g/z.md')).expires_at::text = t.val('g-expires'));
select t.run('ben', t.renew_sql('g/z.md', (t.row('g/z.md')).fence, t.val('g')));
select t.expect_true('rule change: a check-in (renew) now uses the new rule',
  abs(extract(epoch from ((t.row('g/z.md')).expires_at - clock_timestamp())) / 60 - 10) < 1);
update public.path_claims set expires_at = now() - interval '1 second' where vault_id = t.id('cr') and path = 'g/z.md';

-- ---------------------------------------------------------------------------
-- removing a rule: falls back to the next-longest match, or the default

select t.expect('set rule: remove a/x.md''s own rule', t.set_rule('a/x.md', null, null), null);
select t.expect_true('resolve: falls back to the folder rule once the exact-path rule is gone',
  abs(t.claim_minutes('a/x.md') - 30) < 1);
select t.expect('set rule: remove a/ too', t.set_rule('a/', null, null), null);
select t.expect_true('resolve: falls back to the fixed default once no rule matches at all',
  abs(t.claim_minutes('a/x.md') - 48 * 60) < 1);

-- ---------------------------------------------------------------------------
-- escaping % and _ in a folder's name: a literal character, never a wildcard

select t.seed('h%/x.md');
select t.seed('h0/x.md'); -- would match a LIKE 'h%/%' pattern if % were not escaped
select t.expect('set rule: a folder named with a literal %', t.set_rule('h%/', 20, 120, 20), null);
select t.expect_true('resolve: the % rule applies to its own folder', abs(t.claim_minutes('h%/x.md') - 20) < 1);
select t.expect_true('resolve: the % rule does not leak onto an unrelated folder', abs(t.claim_minutes('h0/x.md') - 48 * 60) < 1);

select t.seed('i_/x.md');
select t.seed('iz/x.md'); -- would match a LIKE 'i_/%' pattern if _ were not escaped
select t.expect('set rule: a folder named with a literal _', t.set_rule('i_/', 20, 120, 20), null);
select t.expect_true('resolve: the _ rule applies to its own folder', abs(t.claim_minutes('i_/x.md') - 20) < 1);
select t.expect_true('resolve: the _ rule does not leak onto an unrelated folder', abs(t.claim_minutes('iz/x.md') - 48 * 60) < 1);

-- ---------------------------------------------------------------------------
-- the table itself: closed to direct writes, invisible outside the vault

select t.expect('tables: no direct insert into claim_rules',
  t.run('ben', format($q$insert into public.claim_rules (vault_id, path, lease_minutes, max_lease_minutes, hold_limit_minutes,
    place_in_line_minutes, check_again_minutes, min_gap_seconds, cooldown_cap_minutes, set_by)
    values (%L, 'direct/', 10, 10, 10, 10, 10, 10, 10, %L) returning 'x'$q$, t.id('cr'), t.id('ben'))),
  'ERR 42501');
select t.expect('rls: an outsider sees no claim rules in a vault they are not in',
  t.run('dee', format($q$select count(*)::text from public.claim_rules where vault_id = %L$q$, t.id('cr'))), '0');
select t.expect_true('rls: a member reads the rules set here', t.run('ben', format($q$select count(*)::text from public.claim_rules where vault_id = %L$q$, t.id('cr')))::int > 0);
