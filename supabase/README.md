# Database

Migrations are timestamped SQL files in `migrations/`, applied in order.
Never edit one after it ships; fix forward with a new file.

Name a new one `<UTC timestamp>_<what it does>.sql`, taking the stamp from
`date -u +%Y%m%d%H%M%S` after you rebase on main. It has to sort after every
migration already on main: they are applied in that order, and where two
files redefine a function the later one wins. CI runs
`scripts/check-migrations.sh`, which fails a pull request that edits,
deletes or renames a migration already on main, or adds one that sorts before
the newest there, and says which file and what to do.

```bash
./tests/run.sh    # fresh Postgres, stubbed Supabase roles, every migration, hostile tests
```

Every access rule in `docs/design.md` is enforced here by RLS or a
security-definer function, and every rule has an attack in `tests/`.
