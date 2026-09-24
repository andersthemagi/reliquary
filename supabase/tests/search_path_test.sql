-- Every function in public and private pins its search_path, so no caller
-- can redirect an unqualified name (Supabase advisor 0011).

select t.expect('search_path: every public and private function pins it',
  (select coalesce(string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname), 'none')
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  'none');
