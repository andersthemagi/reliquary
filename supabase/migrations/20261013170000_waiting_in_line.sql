-- Waiting in line, the tables (CL-3.9, issue #74; tracking issue #52;
-- docs/design.md "Claims and work plans" items 8, 11 and 12). Ported from
-- spikes/claims/guard.sql's `tickets` and `claim_strikes`, onto this
-- schema: a place belongs to a person and a registered plan, and a strike
-- to a person in a vault.
--
-- work_plan_places: one place per person per plan (item 12e: the person is
-- the unit of fairness, so two connections of one person share a place).
-- created_at is the place's order in line and never changes while the
-- place lives; expires_at, next_allowed_at and the last answer change on
-- every full evaluation, and are not indexed, so refreshing a place is an
-- in-place (HOT) update that never grows an index (item 12g), with spare
-- room on each page for it (fillfactor). next_allowed_at and the last
-- answer are what a caller asking again too soon is told, from one read
-- and with no write (item 12d).
--
-- private.work_plan_strikes: claims a person let lapse unfinished, per
-- vault, and the cooldown they earned. Private: no API role reads or
-- writes it; only request_work and complete_step do.
--
-- Nothing here is writable by an API role: places and strikes change only
-- through request_work, leave_queue and complete_step (item 12a, "one way
-- in"). Places are readable, like steps, by whoever can read the vault, so
-- a person can be shown who is waiting.
--
-- Deletion: both go with their vault, and with a member who leaves, by
-- cascade. delete_vault doesn't lock them first the way it locks steps
-- (20261013110000_work_plans_lock_order.sql): request_work inserts places,
-- and an insert has no row a deletion could lock ahead of it, so
-- request_work and leave_queue take the vault's row first instead, the
-- order post_message already uses (20261004110000_thread_writes.sql). A
-- place locked ahead of the vault's row would then deadlock with them.

create table public.work_plan_places (
  id              bigint generated always as identity primary key,
  plan_id         uuid not null references public.work_plans on delete cascade,
  vault_id        uuid not null references public.vaults on delete cascade,
  holder          uuid not null,
  label           text check (label is null or length(label) <= 200),
  agent           text,
  created_at      timestamptz not null default clock_timestamp(),
  expires_at      timestamptz not null,
  next_allowed_at timestamptz not null,
  last_place      int not null,
  last_ready      int not null,
  unique (plan_id, holder),
  foreign key (vault_id, holder) references public.vault_members (vault_id, user_id) on delete cascade
) with (fillfactor = 70);
create index work_plan_places_line on public.work_plan_places (plan_id, created_at, id);
create index work_plan_places_holder on public.work_plan_places (vault_id, holder);

alter table public.work_plan_places enable row level security;
create policy member_read on public.work_plan_places for select to authenticated
  using (vault_id in (select private.readable_vaults()));
revoke all on public.work_plan_places from public, anon, authenticated;
grant select (id, plan_id, vault_id, holder, label, agent, created_at, expires_at) on public.work_plan_places to authenticated;

create table private.work_plan_strikes (
  vault_id       uuid not null references public.vaults on delete cascade,
  person         uuid not null,
  strikes        int not null check (strikes >= 1),
  cooldown_until timestamptz,
  last_at        timestamptz not null,
  primary key (vault_id, person),
  foreign key (vault_id, person) references public.vault_members (vault_id, user_id) on delete cascade
);
revoke all on private.work_plan_strikes from public, anon, authenticated;

-- "Is any step open or claimed": plan_complete's one probe.
create index work_plan_steps_unfinished on public.work_plan_steps (plan_id) where status in ('open', 'claimed');
