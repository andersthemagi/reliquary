-- Two foreign keys the Supabase performance advisor flagged as unindexed
-- (`account_plans.plan_id`, `vault_tier_overrides.tier_id`,
-- 20260925230000_plans.sql): the hostile test for this
-- (20260925110000_hardening.sql, "indexes:") only ever checked `public`, so
-- `private` tables never had to keep the invariant true. Both reference
-- tiny, operator-managed lookup tables (`plans`, `vault_tiers`) that are
-- effectively never deleted from, so this isn't a hot path; it's closing a
-- real gap in "every foreign key has an index" cheaply, while it's cheap.
-- supabase/tests/hardening_test.sql now checks `private` too, so a future
-- table can't reopen the gap.

create index if not exists account_plans_plan_id_idx on private.account_plans (plan_id);
create index if not exists vault_tier_overrides_tier_id_idx on private.vault_tier_overrides (tier_id);
