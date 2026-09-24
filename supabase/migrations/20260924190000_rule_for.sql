-- private.policy_for() answered for any vault id, so a signed-in person (or a
-- token scoped elsewhere) could read the rules of a vault they can't see.
-- Clients now call private.rule_for(), which answers only for vaults the
-- caller can read (so token scope applies too). policy_for stays for the
-- security-definer API, which checks access before asking.

create or replace function private.rule_for(p_vault uuid, p_path text,
  out policy text, out quorum int)
language sql stable security definer set search_path = '' as $$
  select r.policy, r.quorum
  from private.policy_for(p_vault, p_path) r
  where coalesce(private.is_member(p_vault), false)
$$;

revoke all on function private.policy_for(uuid, text) from public, anon, authenticated;
revoke all on function private.rule_for(uuid, text) from public, anon;
grant execute on function private.rule_for(uuid, text) to authenticated;

-- search() runs as the caller, so it moves to rule_for as well.
create or replace function public.search(p_vault uuid, p_query text, p_limit int default 20)
returns table (path text, policy text, body text, updated_at timestamptz,
               author uuid, agent text, rank real)
language sql stable security invoker set search_path = '' as $$
  select f.path, (private.rule_for(f.vault_id, f.path)).policy, v.body, f.updated_at,
         v.author, v.agent,
         ts_rank(to_tsvector('simple', coalesce(v.body, '')),
                 websearch_to_tsquery('simple', p_query))
  from public.files f
  join public.file_versions v on v.id = f.current_version_id
  where f.vault_id = p_vault
    and f.deleted_at is null
    and v.body is not null
    and (to_tsvector('simple', coalesce(v.body, '')) @@ websearch_to_tsquery('simple', p_query)
         -- literal substring, no pattern syntax; an empty query matches nothing
         or (length(trim(coalesce(p_query, ''))) > 0
             and strpos(lower(f.path), lower(trim(p_query))) > 0))
  order by 7 desc, f.updated_at desc
  limit least(greatest(coalesce(p_limit, 20), 1), 100)
$$;
