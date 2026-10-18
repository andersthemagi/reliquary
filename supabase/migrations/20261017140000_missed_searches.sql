-- Searches that found nothing (#407): diagnostic data for a vault's owners.
-- A row is the words, the vault, whether a person or an agent searched, and
-- when; never who (no user id, no agent or connection name), by the owner's
-- decision of 2026-10-17. Rows age out after the vault's retention (30 days
-- by default, 1 to 365), pruned when the next one is written, so no server
-- or cron job has to stay on.

alter table public.vaults
  add column missed_search_days smallint not null default 30
  check (missed_search_days between 1 and 365);

create table public.missed_searches (
  id          bigint generated always as identity primary key,
  vault_id    uuid not null references public.vaults on delete cascade,
  words       text not null check (length(words) between 1 and 200),
  by_agent    boolean not null,
  searched_at timestamptz not null default now()
);
create index on public.missed_searches (vault_id, searched_at desc);
alter table public.missed_searches enable row level security;

-- Owners in person read and clear the list. An owner's agent doesn't: the
-- words are other members' questions, and diagnostics are for people.
create policy owner_read on public.missed_searches for select to authenticated
  using (private.role_in(vault_id) = 'owner' and private.agent() is null);
create policy owner_clear on public.missed_searches for delete to authenticated
  using (private.role_in(vault_id) = 'owner' and private.agent() is null);
-- No insert or update grant: rows come only from private.note_missed_search.
revoke all on public.missed_searches from anon, authenticated;
grant select, delete on public.missed_searches to authenticated;

-- Called by the MCP `search` tool and the web app's searches after
-- public.search returned nothing. It checks that for itself, so a caller
-- can't plant words that do find something: as the function's owner the
-- search sees the whole vault, which only makes it stricter (words that
-- find a file the caller may not read are not a gap in the vault). The
-- second search runs only on a miss; public.search itself is unchanged.
-- Returns whether a row was written. A non-member writes nothing.
create function private.note_missed_search(p_vault uuid, p_words text)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_words text := left(trim(coalesce(p_words, '')), 200);
  v_days smallint;
  -- Any member or agent can call this in a loop with made-up words, so a
  -- vault keeps only its newest rows: more than an owner reads, and a bound
  -- on what one member can make the list (and the database) hold.
  c_keep constant int := 500;
begin
  if v_words = '' or private.role_in(p_vault) is null then
    return false;
  end if;
  if exists (select 1 from public.search(p_vault, v_words, 1)) then
    return false;
  end if;
  select missed_search_days into v_days from public.vaults where id = p_vault;
  delete from public.missed_searches
   where vault_id = p_vault and searched_at < now() - make_interval(days => v_days);
  insert into public.missed_searches (vault_id, words, by_agent)
  values (p_vault, v_words, private.agent() is not null);
  delete from public.missed_searches
   where vault_id = p_vault
     and id <= (select id from public.missed_searches where vault_id = p_vault
                 order by id desc offset c_keep limit 1);
  return true;
end $$;

-- An owner, in person, sets how long the list keeps a search. Shortening it
-- drops what is now too old at once.
create function public.set_missed_search_days(p_vault uuid, p_days int)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_human();
  if private.role_in(p_vault) is distinct from 'owner' then
    raise exception 'only owners set how long searches that found nothing are kept' using errcode = '42501';
  end if;
  if p_days is null or p_days not between 1 and 365 then
    raise exception 'searches that found nothing are kept 1 to 365 days' using errcode = '22023';
  end if;
  update public.vaults set missed_search_days = p_days where id = p_vault;
  delete from public.missed_searches
   where vault_id = p_vault and searched_at < now() - make_interval(days => p_days);
end $$;

revoke all on function private.note_missed_search(uuid, text), public.set_missed_search_days(uuid, int)
  from public, anon;
grant execute on function private.note_missed_search(uuid, text), public.set_missed_search_days(uuid, int)
  to authenticated;
