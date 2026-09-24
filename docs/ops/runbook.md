# Operations runbook

How the hosted Reliquary is run. Plan and reasons: `docs/research/hosting.md`.
Where things live: Supabase project `reliquary` (ref `bigonndpibguxuwtysnx`,
Frankfurt, Pro); Vercel projects `reliquary-web` and `reliquary-mcp` (functions
in `fra1`); GitHub Actions for tests, deploys and uptime.

## Rules that came from incidents

- **Secrets never pass through a model.** Scripts that handle secrets write
  mode-600 gitignored files and print names only (`vercel-env.sh`,
  `set-role-passwords.sh`, `backup.sh`, `variables-keys.sh`,
  `rotate-variables-key.sh`). Don't `cat` those files, don't paste
  them into a chat, and don't ask an agent to read the terminal while one is
  on screen. On 2026-09-24 a database password and the session secret reached
  a model this way; both were rotated.
- **Run `reliquary run` from your own terminal** when the process might print
  a value. An agent can read what its commands print.

## Deploy

1. Push to `main`. The `test` workflow runs all four suites.
2. On green, the `deploy` workflow applies migrations (`supabase db push` to
   the session pooler, dry run first), triggers the Vercel deploy hooks (once
   `VERCEL_DEPLOY_HOOK_WEB` and `VERCEL_DEPLOY_HOOK_MCP` exist), then smoke
   checks both apps.
3. Until the hooks exist, deploy from the Vercel dashboard or the Vercel
   connector, after the migrations have run.

By hand: `scripts/db-push.sh` (dry run), then `scripts/db-push.sh --apply`.
Migrations must be applied in timestamp order; never edit one that shipped.

## Checks

- **Uptime:** the `uptime` workflow runs hourly: web sign-in, web database
  (the env API with a fake token must say 401), OAuth metadata, MCP database,
  MCP resource metadata. Two failures in a row open the issue "Production is
  down" (GitHub emails you); recovery closes it.
- **By hand:**

  ```bash
  curl -s https://rq-mcp.vercel.app/healthz?db=1
  ```

- **Logs:** Vercel project, Logs; or the Vercel connector's runtime logs.
  Server logs never contain tokens, values or file text (tests enforce it).
- **Database advisors:** Supabase dashboard, Advisors. Expected: "RLS enabled,
  no policy" on the private tables (deny-all by design).

## Backups and restore

- **Supabase:** daily backups, 7 days on Pro (dashboard, Database, Backups).
- **Off-site:** `scripts/backup.sh` writes `~/reliquary-backups/*.dump`
  (mode 600, keeps 14). Variable values are ciphertext only; the key is in
  Vercel and your password manager.
- **Test a restore** after each backup, or at least monthly:
  `scripts/restore-test.sh` restores the newest dump into a throwaway local
  Postgres and prints row counts.
- **Real restore:** prefer Supabase's restore (dashboard). From an off-site
  dump, restore into a new project with `pg_restore --no-owner
  --no-privileges`, apply any newer migrations with `db push`, set the app
  role passwords (`set-role-passwords.sh`), then point both Vercel projects'
  `DATABASE_URL` at it.

## Rotating secrets

| Secret | Where it lives | How to rotate | Effect |
|---|---|---|---|
| `reliquary_web` / `reliquary_mcp` DB passwords | `supabase/.web-db-password`, `.mcp-db-password`; Vercel `DATABASE_URL` | delete the file, run `scripts/set-role-passwords.sh`, run `scripts/vercel-env.sh <app> ...`, paste the new `DATABASE_URL` into that Vercel project, redeploy | that app can't reach the database until redeployed |
| `SESSION_SECRET` (web) | `supabase/.web-session-secret`; Vercel | delete the file, run `vercel-env.sh web ...`, update Vercel, redeploy | everyone is signed out of the web UI once; CLI and connectors unaffected |
| `VARIABLES_KEYS` (web; formerly `VARIABLES_KEY`) | `supabase/.variables-keys-secret` (one `id:key` per line, current first; an older `.variables-secret` is taken over as `k1`); Vercel; password manager | [Rotating VARIABLES_KEY](#rotating-variables_key), below: add a key, deploy, re-encrypt, drop the old key, deploy | no downtime; losing a key before its values are re-encrypted loses them |
| `postgres` password | `supabase/.db-password`; GitHub secret `SUPABASE_DB_PASSWORD` | reset in the dashboard, rewrite the file, `tr -d '[:space:]' < supabase/.db-password \| gh secret set SUPABASE_DB_PASSWORD` | migrations and backups need the new one |
| A person's agent token or connection | database | Tokens page, Revoke | stops within one request |

### Rotating VARIABLES_KEY

Values stay readable throughout: the web app holds the old and the new key
while every ciphertext moves (docs/variables.md, "Key rotation"). Every
script here prints key ids and counts, never a key, so they are safe to run
from a chat; still, never open the key files in one. Do it at a quiet time,
from a checkout of the deployed commit (the migration
`20260925170000_variables_keys.sql` must be applied).

1. **Add a key.** `scripts/vercel-env.sh new-variables-key` adds `k2` (the
   next id) to `supabase/.variables-keys-secret` as the current key. Copy
   it from that file into your password manager, yourself.
2. **Deploy both keys.** `scripts/vercel-env.sh web <web-origin>
   <mcp-origin>`, then in the web Vercel project set `VARIABLES_KEYS` from
   `supabase/.vercel-web.env` (Sensitive) and delete `VARIABLES_KEY` if it
   is still there (the first time only). Redeploy, and check the site is up.
   New values are now sealed with `k2`; old ones open with `k1`.
3. **Re-encrypt.** `scripts/rotate-variables-key.sh`. It uses the database
   and keys in `supabase/.vercel-web.env`, moves every value and pending
   import value to `k2`, and prints counts. Exit 0 ("Everything is on k2")
   means done. Exit 1: run it again (a deployment still writing `k1` during
   step 2's rollout); if it still says values can't be decrypted, those
   values were already unreadable: set them again in the web UI, or delete
   them, then run it again. Owners and editors see one "Re-encrypted (key
   rotation)" row per vault in its access log.
4. **Drop the old key.** Only after step 3 exits 0:
   `scripts/vercel-env.sh drop-variables-key k1`, then `scripts/vercel-env.sh
   web ...`, set `VARIABLES_KEYS` in Vercel again, redeploy.
   `scripts/rotate-variables-key.sh --check` should still exit 0.

If a deployment ever lacks a key that stored values name, the web app
refuses to start and its log says which id: put that key back in
`VARIABLES_KEYS` and redeploy. Once step 2 is live, don't roll the web app
back (Vercel instant rollback) to a deployment from before it: that one
holds only the old key and can't open values sealed with the new one. Keep old keys in the password manager until
backups taken before the rotation have aged out (7 days on Supabase, 14 for
`backup.sh`): restoring one needs the key it was sealed with. After a
suspected leak of a key, rotate it and rotate the values too (at their
providers): re-encryption protects stored ciphertext, not a value someone
already decrypted.

## If something is wrong

1. Check the uptime issue and the last `deploy` run.
2. Read the runtime logs for the failing app.
3. A bad deploy: promote the previous deployment in Vercel (instant
   rollback). Migrations are forward-only: fix forward with a new migration.
4. A leaked secret: rotate it (table above), then check the access logs
   (`env_access_log` via the Variables page's log, tokens' last use).
