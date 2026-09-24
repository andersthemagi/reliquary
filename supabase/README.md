# Database

Migrations are timestamped SQL files in `migrations/`, applied in order.
Never edit one after it ships; fix forward with a new file.

```bash
./tests/run.sh    # fresh Postgres, stubbed Supabase roles, every migration, hostile tests
```

Every access rule in `docs/design.md` is enforced here by RLS or a
security-definer function, and every rule has an attack in `tests/`.
