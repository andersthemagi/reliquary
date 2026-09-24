-- Latency of the gate at a realistic-ish size. Run after schema.sql on an
-- empty database. Synthetic data only.
--
-- 500 spaces, 5,000 members (each in 3 spaces, ~30 per space), 200,000
-- entries (a quarter with an audience of 2-8 people), 400 group chats of
-- 5-40 people, a DM per member.

\set ON_ERROR_STOP on
\timing off

select setseed(0.42);

insert into app.spaces (name, is_public)
select 'space-' || g, g <= 5 from generate_series(1, 500) g;

insert into app.members (display_name)
select 'member-' || g from generate_series(1, 5000) g;

insert into app.space_members (space_id, member_id, role)
select distinct on (s.id, m.id) s.id, m.id, 'collaborator'
from app.members m
cross join lateral (
  select id from app.spaces where not is_public and m.id is not null
  order by random() limit 3
) s;

insert into app.identities (channel, external_id, member_id)
select 'telegram', 'tg:' || id, id from app.members;

insert into app.agent_tokens (id, name)
values ('00000000-0000-0000-0000-0000000000f1', 'bench-bot');
insert into app.agent_token_spaces (token_id, space_id)
select '00000000-0000-0000-0000-0000000000f1', id from app.spaces;

-- Entries: words drawn from a small vocabulary so full-text search hits.
with vocab as (
  select array['roadmap','schedule','budget','hiring','launch','offsite',
               'client','invoice','design','release','venue','speaker',
               'deadline','contract','keynote','dinner'] as w
), sp as (
  select array_agg(id) as ids from app.spaces
), sm as (
  select space_id, array_agg(member_id) as mids
  from app.space_members group by space_id
), picked as (
  select g, sp.ids[1 + floor(random() * cardinality(sp.ids))::int] as space_id
  from generate_series(1, 200000) g cross join sp
)
insert into app.entries (space_id, title, body, audience)
select p.space_id,
       'entry-' || p.g,
       v.w[1 + floor(random() * 16)::int] || ' ' || v.w[1 + floor(random() * 16)::int]
         || ' ' || v.w[1 + floor(random() * 16)::int] || ' notes ' || p.g,
       case when random() < 0.25 and sm.mids is not null then
         (select array_agg(x) from (
            select x from unnest(sm.mids) x order by random()
            limit 2 + floor(random() * 7)::int) q)
       end
from picked p
cross join vocab v
left join sm on sm.space_id = p.space_id;

-- Group chats bound to a space, participants drawn from its members.
with picked as (
  select g, (select id from app.spaces where not is_public
             order by random() + g * 0 limit 1) as space_id
  from generate_series(1, 400) g
), ins as (
  insert into app.chats (channel, external_chat_id, kind, space_id)
  select 'telegram', 'g-' || g, 'group', space_id from picked
  returning id, space_id
)
insert into app.chat_participants (chat_id, external_id)
select ins.id, 'tg:' || p.member_id
from ins
cross join lateral (
  select member_id from app.space_members sm
  where sm.space_id = ins.space_id
  order by random() limit 5 + (random() * 35)::int
) p;

with ins as (
  insert into app.chats (channel, external_chat_id, kind)
  select 'telegram', 'dm-' || id, 'dm' from app.members
  returning id, external_chat_id
)
insert into app.chat_participants (chat_id, external_id)
select id, 'tg:' || substr(external_chat_id, 4) from ins;

analyze;

-- ---------------------------------------------------------------------------

create or replace function pg_temp.bench(p_label text, p_kind text, p_n int, p_sql text)
returns table (label text, n int, p50_ms numeric, p95_ms numeric, max_ms numeric, avg_rows numeric)
language plpgsql as $$
declare
  c record;
  t0 timestamptz;
  times numeric[] := '{}';
  rows_seen int[] := '{}';
  k int;
begin
  for c in
    select ch.id as chat, (select external_id from app.chat_participants p
                           where p.chat_id = ch.id order by random() limit 1) as asker
    from app.chats ch where ch.kind = p_kind order by random() limit p_n
  loop
    perform set_config('request.jwt.claims', jsonb_build_object(
      'token', '00000000-0000-0000-0000-0000000000f1',
      'chat', c.chat, 'asker', c.asker)::text, true);
    perform set_config('role', 'reliquary_agent', true);
    t0 := clock_timestamp();
    execute p_sql into k;
    times := times || extract(epoch from clock_timestamp() - t0) * 1000;
    perform set_config('role', 'none', true);
    rows_seen := rows_seen || k;
  end loop;
  return query select p_label, p_n,
    round((select percentile_cont(0.5) within group (order by x) from unnest(times) x)::numeric, 2),
    round((select percentile_cont(0.95) within group (order by x) from unnest(times) x)::numeric, 2),
    round((select max(x) from unnest(times) x), 2),
    round((select avg(x) from unnest(rows_seen) x), 1);
end $$;

\echo
\echo 'Gate latency (ms), 200k entries:'
select * from pg_temp.bench('search, DM', 'dm', 300,
  $q$select count(*) from (select id from app.entries
     where tsv @@ to_tsquery('simple', 'budget & launch')
     order by ts_rank(tsv, to_tsquery('simple', 'budget & launch')) desc limit 20) s$q$)
union all
select * from pg_temp.bench('search, group', 'group', 300,
  $q$select count(*) from (select id from app.entries
     where tsv @@ to_tsquery('simple', 'budget & launch')
     order by ts_rank(tsv, to_tsquery('simple', 'budget & launch')) desc limit 20) s$q$)
union all
select * from pg_temp.bench('count all visible, DM', 'dm', 300,
  'select count(*) from app.entries')
union all
select * from pg_temp.bench('count all visible, group', 'group', 300,
  'select count(*) from app.entries');

\echo
\echo 'Plan for one group search (helpers should appear once, as InitPlans):'
do $$
declare c record; line text;
begin
  select ch.id as chat, p.external_id as asker into c
  from app.chats ch join app.chat_participants p on p.chat_id = ch.id
  where ch.kind = 'group' limit 1;
  perform set_config('request.jwt.claims', jsonb_build_object(
    'token', '00000000-0000-0000-0000-0000000000f1',
    'chat', c.chat, 'asker', c.asker)::text, true);
  perform set_config('role', 'reliquary_agent', true);
  for line in execute $q$explain (analyze, costs off, timing on, summary on)
    select id from app.entries where tsv @@ to_tsquery('simple', 'budget & launch')
    order by ts_rank(tsv, to_tsquery('simple', 'budget & launch')) desc limit 20$q$
  loop
    raise notice '%', line;
  end loop;
  perform set_config('role', 'none', true);
end $$;
