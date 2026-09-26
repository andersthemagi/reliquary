# Operations runbook

How the hosted Reliquary is run. Plan and reasons: `docs/research/hosting.md`.
Where things live: Supabase project `reliquary` (ref `bigonndpibguxuwtysnx`,
Frankfurt, Pro); Vercel projects `reliquary-web` and `reliquary-mcp` (functions
in `fra1`); GitHub Actions for tests, deploys and uptime.

## Hosts

Three hostnames, two Vercel projects:

| Host | Project | Serves |
|---|---|---|
| `reliquary.redmage.cc` | `reliquary-web` | the public site: landing, `/docs` (and `.md`, `/llms.txt`, `/llms-full.txt`), `/roadmap`, the legal and trust pages, `robots.txt`, `sitemap.xml`, `/.well-known/security.txt`, static files |
| `app.reliquary.redmage.cc` | `reliquary-web` | the app: sign-in, Home and every signed-in page, the OAuth authorization server (issuer), the env API, `/cli/oauth-client.json`, `/version`, `/healthz`, static files |
| `mcp.reliquary.redmage.cc` | `reliquary-mcp` | the MCP endpoint `/mcp` |

The web project serves both of its hosts from one deployment, told apart by
the Host header (`web/src/hosts.ts`), with `PUBLIC_URL` the app origin and
`SITE_URL` the site origin. On the site host any app path is a 308 to the
same path and query on the app host, and no cookie is ever set; on the app
host the public pages are a 308 to the site host (`/` stays: Home or sign-in)
and every answer carries `X-Robots-Tag: noindex`. A redirect only ever goes
to one of those two origins. Without `SITE_URL` one host serves both, as in
local development and most tests.

Production values (`scripts/vercel-env.sh web https://app.reliquary.redmage.cc https://mcp.reliquary.redmage.cc https://reliquary.redmage.cc`):

| Where | Variable | Value |
|---|---|---|
| `reliquary-web` | `PUBLIC_URL` | `https://app.reliquary.redmage.cc` |
| `reliquary-web` | `SITE_URL` | `https://reliquary.redmage.cc` |
| `reliquary-web` | `MCP_PUBLIC_URL` | `https://mcp.reliquary.redmage.cc/mcp` |
| `reliquary-web` | `MCP_RESOURCE` | `https://mcp.reliquary.redmage.cc/mcp` |
| `reliquary-mcp` | `MCP_RESOURCE` | `https://mcp.reliquary.redmage.cc/mcp` |
| `reliquary-mcp` | `AUTH_ISSUER` | `https://app.reliquary.redmage.cc` |
| Supabase Auth, URL Configuration | Site URL | `https://app.reliquary.redmage.cc` |
| Supabase Auth, URL Configuration | Redirect URLs | `https://app.reliquary.redmage.cc/**` |
| GitHub, repository variables | `WEB_URL` / `MCP_URL` | `https://app.reliquary.redmage.cc` / `https://mcp.reliquary.redmage.cc` |

Both web hostnames are domains of `reliquary-web` in Vercel; DNS for all
three is a CNAME to `cname.vercel-dns.com`. Changing `PUBLIC_URL` changes the
OAuth issuer: every connector and the CLI signs in again once. Changing only
`SITE_URL` signs nobody out. After changing any of them, redeploy (below).

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

Production is always a release: a tag `vX.Y.Z` with a GitHub Release. What
is live answers `GET /version` on both apps (`{"version","commit"}`), and the
web footer shows it. 0.x is **pre-alpha**: any release may change or remove
anything, including MCP tools and CLI commands, and its GitHub Release is
marked a prerelease. 1.0 is a deliberate decision by the owner, not a number
the tooling reaches on its own (with `bump-minor-pre-major`, even a breaking
change only bumps the minor while below 1.0).

### How a release goes live

1. **Push to `main`** (or merge a pull request). The `test` workflow runs
   all four suites. Nothing deploys.
2. **The release pull request.** The `release` workflow (release-please)
   keeps a pull request "Release vX.Y.Z" open and updates it on every push:
   `CHANGELOG.md` from the conventional commits since the last release,
   `version.txt`, the web and MCP package versions. `feat` bumps the minor,
   `fix`/`perf`/`security` the patch; `chore`, `test`, `ci`, `docs` and
   `refactor` don't release on their own. Commits touching `cli/` go to a
   separate "Release cli vX.Y.Z" pull request instead.
3. **Cut the release: merge that pull request** when you want what it lists
   live. release-please tags the merge `vX.Y.Z` and publishes the GitHub
   Release; the `release` workflow adds the pre-alpha line, the database
   migrations in this release, roadmap items for this version
   (`docs/public/roadmap.yml`) and a deploy note to it.
4. **The deploy** (`deploy` workflow, for that tag): migrations (dry run,
   then `supabase db push` to the session pooler), then a production
   deployment of exactly the tagged commit in both Vercel projects through
   the API (`VERCEL_TOKEN`; `scripts/vercel-deploy.sh` waits for both
   builds), then smoke checks (`scripts/deploy-check.sh`) including that both
   apps' `/version` answers the release and its commit. A failing check fails
   the run: read it, then fix forward or roll back.

Without `RELEASE_PLEASE_TOKEN`, the release pull request shows no `test`
checks (GitHub doesn't run workflows for what `GITHUB_TOKEN` creates): close
and reopen it just before merging to run them. The `release` workflow then
starts the deploy itself.

The CLI: merging "Release cli vX.Y.Z" tags `cli-vX.Y.Z` and runs
`publish-cli` (skipped until `NPM_TOKEN` exists). It deploys nothing.

### The first release (v0.1.0, once)

The `release` workflow skips until a `v*` tag exists, so release-please
doesn't propose a version for the whole history. After the versioning
change is on `main`, cut v0.1.0 by hand at that commit:

```bash
git switch main && git pull --ff-only
sha=$(git rev-parse HEAD); git show -s --oneline "$sha"   # the versioning commit
git tag -a v0.1.0 -m v0.1.0 "$sha"
git tag -a cli-v0.1.0 -m cli-v0.1.0 "$sha"
git push origin v0.1.0 cli-v0.1.0
section() { awk '/^## 0\.1\.0/{p=1;next} /^## /{p=0} p' "$1"; }
gh release create v0.1.0 --verify-tag --prerelease --title v0.1.0 --notes "$(section CHANGELOG.md)"
scripts/release-notes.sh --apply v0.1.0    # pre-alpha line, migrations, deploy note
gh release create cli-v0.1.0 --verify-tag --prerelease --title cli-v0.1.0 --notes "$(section cli/CHANGELOG.md)"
gh workflow run release.yml --ref main
```

Publishing v0.1.0 (by you, so it triggers workflows) runs `deploy` for it;
pushing `cli-v0.1.0` runs `publish-cli`, which skips until `NPM_TOKEN` is
set (then re-run it: Actions > publish-cli > Run workflow from tag
`cli-v0.1.0`). The last line lets release-please start the next release
pull request.

### Redeploy or roll back

Actions > deploy > Run workflow, on `main`, with the tag (`vX.Y.Z`).

- **The newest release**: a redeploy (migrations are a no-op if applied).
  This is the "redeploy" after changing a Vercel environment variable (key
  rotation, secrets): it rebuilds the live release with the new values.
- **An older release**: a rollback. Migrations are forward-only, so the
  workflow skips them and deploys only that tag's app code, on today's
  schema. That is safe only if the older code works with the newer schema
  (additive migrations are; a dropped or renamed column isn't): read the
  "Database migrations in this release" lists of the releases you step back
  over. If it isn't safe, fix forward instead.
- Instant alternative for app code only: promote the previous production
  deployment in Vercel. The next release deploys over it as usual.

### Hotfix

There are no release branches: fix forward on `main`.

1. Land the fix on `main` as `fix(...): ...` (with its test).
2. The release pull request now lists it (and anything else merged since the
   last release). If something unready is also in it, revert that on `main`
   first (`revert: ...`), or roll back while you fix.
3. Merge the release pull request: a patch release (`vX.Y.Z+1`) deploys.

### By hand

`scripts/db-push.sh` (dry run), then `scripts/db-push.sh --apply`.
Migrations must be applied in timestamp order; never edit one that shipped.
Deploy only releases: never deploy `main` from the Vercel dashboard, or live
stops matching a release (the next deploy's `/version` check says so).

## Checks

- **Uptime:** the `uptime` workflow runs hourly: web sign-in, web database
  (the env API with a fake token must say 401), OAuth metadata, MCP database,
  MCP resource metadata. Two failures in a row open the issue "Production is
  down" (GitHub emails you); recovery closes it.
- **By hand:**

  ```bash
  curl -s https://rq-mcp.vercel.app/healthz?db=1
  curl -s https://rq-mcp.vercel.app/version     # which release is live
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

## Plans and testers

There are no payments: the operator puts people on plans and vaults on
tiers by hand, with `scripts/plan.sh` (psql as postgres, with
`supabase/.db-password`, never printed; it prints plans, emails, vault
names and counts only). The model and the numbers are in
`supabase/migrations/20260925230000_plans.sql`; what people see is
`docs/public/concepts/plans-and-limits.md`.

| Do | Command |
|---|---|
| See the plans and tiers | `scripts/plan.sh plans` |
| See someone's plan and their vaults | `scripts/plan.sh show <email>` |
| Make someone an alpha tester (25 vaults, 25 people and 1 GB each) | `scripts/plan.sh user <email> alpha_tester` |
| Put them back on Free | `scripts/plan.sh user <email> free` |
| Upgrade one vault (50 people, 5 GB) | `scripts/plan.sh vault <vault-id> pro` |
| Take it back to its account's plan | `scripts/plan.sh vault <vault-id> standard` |
| Usage, largest first (everyone, one person's vaults, or one vault) | `scripts/plan.sh usage [<email>\|<vault-id>]` |
| Let an account create vaults while invite-only | `scripts/plan.sh admit <email>` |
| Take that back (they keep their vaults and memberships) | `scripts/plan.sh revoke-admission <email>` |
| Open sign-ups to everyone after the alpha, or close them again | `scripts/plan.sh invite-only off` / `on` |
| Storage counters that drifted, and members whose account is gone from Auth | `scripts/plan.sh check` |
| Set one vault's storage counter to a full scan | `scripts/plan.sh recount <vault-id>` |

- The person needs an account first: they sign in once, then `user` finds
  them by email. A vault's id is in its URL (`/v/<id>`).
- A change applies to the next request; nobody needs to sign in again.
- Smaller never deletes: a person over their vault count keeps every vault
  and can't create another; a vault over its people or storage keeps
  everything, and takes nothing that adds until it is under (the `limit`
  column says `over`). Tell them before you downgrade.
- The numbers live in `private.plans` and `private.vault_tiers`; changing
  them is an `update` as postgres (for example in the Supabase SQL editor),
  no release needed. A new plan or tier is an `insert` there. Record why
  in the commit or ticket that asked for it.
- Only postgres and `reliquary_ops` can change plans: no person, agent or
  app role can (hostile tests in `supabase/tests/plans_test.sql`).
- **Invite-only** (`supabase/migrations/20260925240000_admission.sql`):
  Supabase sign-ups stay on so invitees can make accounts, so anyone can
  get an account; while invite-only is on (the default) an account creates
  vaults only once admitted, and is refused with SQLSTATE `RLP02`
  otherwise. Accepting any invite admits it, and so does `user` (a plan);
  `admit` is for a tester who has no invite. `show` says whether someone is
  admitted. Admission is kept per account id: an account deleted in
  Supabase and made again starts un-admitted. Only postgres and
  `reliquary_ops` admit (hostile tests in
  `supabase/tests/admission_test.sql`).
- **Drift**: the storage counters are kept by triggers, and pg_cron runs
  `private.log_storage_drift()` Mondays 04:00 UTC, recording any vault whose
  counter differs from a full scan in `private.storage_drift_log` (and a
  warning in the Postgres log). Nothing fixes a counter by itself: read
  `check`, find the cause, then `recount <vault-id>` on purpose. Without
  pg_cron, run `check` by hand now and then.
- Try the script against a local database first: set
  `PLAN_DB_CONTAINER=<a local postgres container with the migrations>`
  (and `PLAN_DB_NAME`).

## Feedback

People send bugs, ideas and questions from the web app's **Feedback**
button (`/feedback`) and their agents with `send_feedback` over MCP
(`supabase/migrations/20260926163000_feedback.sql`, `web/src/feedback.ts`;
what people see: `docs/public/how-to/send-feedback.md`). The operator reads
and answers with `scripts/feedback.sh` (psql as postgres, like
`scripts/plan.sh`; `PLAN_DB_CONTAINER` for a local or self-hosted database):

| Do | Command |
|---|---|
| What's new, newest first | `scripts/feedback.sh list` |
| Everything, or one status | `scripts/feedback.sh list all`, `scripts/feedback.sh list planned` |
| One in full (sender's email, agent and client, vault, page, message, reply, notice) | `scripts/feedback.sh show <id>` |
| Set its status (the sender sees it) | `scripts/feedback.sh status <id> seen` (`new`, `seen`, `planned`, `fixed`, `wont_fix`) |
| Reply (the sender and their agents see it; `""` clears it) | `scripts/feedback.sh reply <id> "Fixed in 0.5.0, thanks."` |

- **Notices.** Each new item is emailed to the operator through Resend,
  from the web app (the MCP server has no mailer): to `FEEDBACK_EMAIL` if
  set, else, on the hosted service only (`VERCEL` and not `SELF_HOSTED`),
  to `OPERATOR.contactEmail` in `web/src/site.ts`. The web app claims
  unsent items (`private.claim_feedback_notices`) after every feedback
  form, on a signed-in page load at most once a minute per instance, and
  every minute where the server runs continuously (self-hosted, local); so
  an agent's feedback is emailed when someone next uses the web app. A
  claim lapses after 10 minutes, an item is tried at most 5 times and only
  within 7 days; a failed send is logged with a ref (`kind=feedback`).
  Nothing about the feedback itself depends on the email: `list` shows
  every item, with `notice` saying whether it was emailed.
- **What you see is private.** The list and `show` print senders' emails
  and their words; don't paste them anywhere public. Never quote a
  secret, token or variable value in a reply, even one the sender pasted:
  replies reach the sender's agents.
- **Limits.** 20 an hour per person, web and agents together (`54000`,
  with when they can send again). Messages up to 5000 characters.
- **Access.** A person reads only their own feedback and their agents'
  (RLS); only postgres and `reliquary_ops` list, show, set a status or
  reply; only the web app's role claims notices (hostile tests in
  `supabase/tests/feedback_test.sql`).
- **Deleted accounts.** Deleting an account deletes its feedback (a
  trigger on `private.deleted_accounts`); notices already emailed stay in
  the operator's mailbox, so delete those by hand when asked to erase.
- **Self-hosted instances** send nothing to Red Mage: their feedback stays
  in their database, and notices go to their own `FEEDBACK_EMAIL` or
  nowhere.

## Email sender

All email goes out through Resend (resend.com) from one subdomain,
`mail.reliquary.redmage.cc`: Supabase Auth's (sign-in codes and links, account
notices) over Resend's SMTP, and the web app's vault invites over Resend's
HTTP API (`web/src/mailer.ts`). Until this is done, Supabase's built-in
sender reaches only the project team (2 an hour) and owners copy invite
links by hand. Values checked against the docs on 2026-09-26 (sources at the
end of this section).

1. **Account**: sign up at resend.com with the owner's address; turn on
   two-factor sign-in (Settings).
2. **Domain**: Domains > Add domain, `mail.reliquary.redmage.cc`, region **Ireland
   (eu-west-1)**. The region only sets where mail is sent from: Resend
   stores account data, email metadata and logs in the US whatever the
   region, which `/subprocessors` and `/privacy` say. Use a subdomain, not
   `redmage.cc`, so its sending reputation is its own.
3. **DNS, in Squarespace** (Domains > redmage.cc > DNS > Custom records):
   add exactly the records Resend's domain page lists, copied from there
   (values are per domain, so they aren't written here). They are:
   - **DKIM**: a TXT record at `resend._domainkey.mail.reliquary` (the public key);
   - **SPF**: a TXT record at the return-path subdomain (`send.mail.reliquary` by
     default) allowing Amazon SES, and an **MX** record there for bounces
     (`feedback-smtp.<region>.amazonses.com`, priority 10);
   - **DMARC** (recommended, Resend shows it after verifying): a TXT record
     at `_dmarc.mail.reliquary` starting `v=DMARC1; p=none;`. Tighten to
     `p=quarantine` once reports look clean. A `_dmarc.redmage.cc` record, if
     there is one, covers the subdomain unless its `sp=` says otherwise.
   Squarespace's Host field takes the name without `.redmage.cc` (e.g.
   `resend._domainkey.mail.reliquary`). Then **Verify DNS Records** in Resend: usually
   within 15 minutes, up to 72 hours. Leave open and click tracking off (the
   default): tracking rewrites links, which breaks sign-in and invite links.
4. **API keys**: API Keys > Create API key, twice, each with permission
   **Sending access** and domain `mail.reliquary.redmage.cc` only: `supabase-smtp`
   and `reliquary-web`. Two keys so either can be revoked alone. Resend shows
   a key once: paste it straight into its place below (and a password
   manager), never into a chat, a file in the repo or a terminal.
5. **Supabase SMTP** (project `bigonndpibguxuwtysnx`): Authentication >
   Emails > **SMTP Settings**, turn on **Enable custom SMTP**:
   - Sender email `no-reply@mail.reliquary.redmage.cc`, sender name `Reliquary`
     (together `Reliquary <no-reply@mail.reliquary.redmage.cc>`);
   - Host `smtp.resend.com`, port `465` (implicit TLS; `587` with STARTTLS
     also works);
   - Username `resend`, password the `supabase-smtp` key;
   - Minimum interval per user: leave at 60 seconds. **Save changes**.
6. **Supabase email rate limit**: saving custom SMTP sets it to 30 emails an
   hour. Authentication > **Rate Limits** > "Rate limit for sending emails":
   raise it to what the Resend plan covers. Resend's free plan is 100 emails
   a day and 3,000 a month, and a sign-in is one email; start at 100 an hour
   on a paid plan, or leave 30 on the free one. Reliquary's own limits
   (`docs/public/reference/limits.md`) sit in front of it.
7. **Templates**: paste them, per "Email templates" below
   (`scripts/email-templates.sh`), if not done yet.
8. **Invites from the web app**: in Vercel, `reliquary-web` > Settings >
   Environment Variables (Production), add `RESEND_API_KEY` = the
   `reliquary-web` key (Sensitive) and `EMAIL_FROM` =
   `Reliquary <no-reply@mail.reliquary.redmage.cc>`. `scripts/vercel-env.sh web ...`
   lists both (the key as a placeholder). Never in `reliquary-mcp`. Then
   redeploy the live release (see "Redeploy or roll back").
9. **Check**: sign out and sign in with a code (the email comes from
   `no-reply@mail.reliquary.redmage.cc`, and Resend > Emails lists it). Then invite
   an address you own to a test vault: **Members** says "We emailed them the
   link", and the email's link opens the invite. If it says it couldn't email
   it, the reason and a ref are on the page; find the ref in the logs ("Finding
   an error by its ref"): `where` is `email sender (Resend)` and `code` is
   Resend's error name (`validation_error` for an unverified domain or a bad
   sender, `restricted_api_key` for a key without sending access,
   `daily_quota_exceeded`). The invite is kept either way; the owner can send
   the shown link.

Rotating a key: create the new one, put it in its place (Supabase or Vercel,
then redeploy), check as in 9, then delete the old one in Resend.

Sources: Resend, [SMTP](https://resend.com/docs/send-with-smtp),
[send email API](https://resend.com/docs/api-reference/emails/send-email)
(`Idempotency-Key`, up to 256 characters, kept 24 hours),
[errors](https://resend.com/docs/api-reference/errors),
[domains](https://resend.com/docs/dashboard/domains/introduction),
[add a domain](https://resend.com/docs/add-a-domain),
[regions](https://resend.com/docs/dashboard/domains/regions),
[API keys](https://resend.com/docs/api-reference/api-keys/create-api-key),
[quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits);
Supabase, [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

## Email templates

Every email Supabase Auth sends uses Reliquary's templates, `web/emails/*.html`
(the source is `web/emails/build.mjs`; public list: `docs/public/reference/emails.md`).
Self-hosted instances serve them to their Auth server on their own
(`deploy/compose`). The hosted project needs them pasted into the dashboard,
once, and again whenever `web/emails/` changes (a release note or the diff
says so).

**The quick way:** put all 13 in at once through Supabase's Management API.
Make a personal access token (supabase.com, Account > Access Tokens), paste
it into `supabase/.access-token` (gitignored; `chmod 600`), then run
`scripts/email-templates.sh apply`. It sets every template and subject and
turns the security notifications on. `scripts/email-templates.sh check`
says, per template, whether the project matches the files. Delete the token
afterwards if you won't need it again. The token is read from the file and
never printed. (`SUPABASE_API_URL` points the script elsewhere, for testing
only.)

**By hand, in the dashboard:**

1. `scripts/email-templates.sh` lists all 13: dashboard place, subject, file.
2. Supabase dashboard, project `bigonndpibguxuwtysnx`: **Authentication >
   Emails**.
3. **Templates** tab, for each of Confirm sign up, Invite user, Magic link or
   OTP, Change email address, Reset password, Reauthentication:
   - `scripts/email-templates.sh <id>` (e.g. `sign-in`): prints the subject
     and copies the HTML to the clipboard (or prints it; `--print` forces that);
   - open the template, set **Subject**, switch the body to **Source**, select
     all, paste, **Save changes**.
4. **Security notifications** (same page), for each of Password changed, Email
   address changed, Phone number changed, Sign-in method linked, Sign-in
   method removed, Verification method added, Verification method removed:
   turn it on, then subject and body as above.
5. Check: **Authentication > Sign In / Providers**, Email OTP expiration is
   600 seconds (the emails say "within 10 minutes"). Then sign in to the app
   once: the email has the big code, a **Sign in** button, and the link
   written out, all to `https://app.reliquary.redmage.cc/auth/confirm`.

A link to anything but the app's `/auth/confirm` (Supabase's
`{{ .ConfirmationURL }}`, the default) breaks sign-in by link: it returns the
tokens in a URL fragment the server never sees.

## Rotating secrets

| Secret | Where it lives | How to rotate | Effect |
|---|---|---|---|
| `reliquary_web` / `reliquary_mcp` DB passwords | `supabase/.web-db-password`, `.mcp-db-password`; Vercel `DATABASE_URL` | delete the file, run `scripts/set-role-passwords.sh`, run `scripts/vercel-env.sh <app> ...`, paste the new `DATABASE_URL` into that Vercel project, redeploy | that app can't reach the database until redeployed |
| `reliquary_ops` DB password (the operator's role, key rotation only) | `supabase/.ops-db-password`; nowhere else (not Vercel) | `scripts/set-role-passwords.sh ops-off` (nologin, file removed), then `scripts/set-role-passwords.sh ops` when next needed | only `rotate-variables-key.sh` uses it; nologin between rotations is fine |
| `SESSION_SECRET` (web) | `supabase/.web-session-secret`; Vercel | delete the file, run `vercel-env.sh web ...`, update Vercel, redeploy | everyone is signed out of the web UI once; CLI and connectors unaffected |
| `VARIABLES_KEYS` (web; formerly `VARIABLES_KEY`) | `supabase/.variables-keys-secret` (one `id:key` per line, current first; an older `.variables-secret` is taken over as `k1`); Vercel; password manager | [Rotating VARIABLES_KEY](#rotating-variables_key), below: add a key, deploy, re-encrypt, drop the old key, deploy | no downtime; losing a key before its values are re-encrypted loses them |
| `postgres` password | `supabase/.db-password`; GitHub secret `SUPABASE_DB_PASSWORD` | reset in the dashboard, rewrite the file, `tr -d '[:space:]' < supabase/.db-password \| gh secret set SUPABASE_DB_PASSWORD` | migrations and backups need the new one |
| A person's agent token or connection | database | Tokens page, Revoke | stops within one request |

### Rotating VARIABLES_KEY

Values stay readable throughout: the web app holds the old and the new key
while every ciphertext moves (docs/variables.md, "Key rotation"). Every
script here prints key ids and counts, never a key, so they are safe to run
from a chat; still, never open the key files in one. Do it at a quiet time,
from a checkout of the deployed commit (the migrations
`20260925170000_variables_keys.sql` and `20260925190000_final_sweep.sql`
must be applied).

0. **The operator's role.** Re-encryption runs as `reliquary_ops`, which the
   web app's role is not (it may not read stored ciphertext). Once, or after
   `ops-off`: `scripts/set-role-passwords.sh ops` gives it a password in
   `supabase/.ops-db-password` (mode 600, gitignored, never printed) and
   checks it can log in through the pooler.
1. **Add a key.** `scripts/vercel-env.sh new-variables-key` adds `k2` (the
   next id) to `supabase/.variables-keys-secret` as the current key. Copy
   it from that file into your password manager, yourself.
2. **Deploy both keys.** `scripts/vercel-env.sh web <web-origin>
   <mcp-origin>`, then in the web Vercel project set `VARIABLES_KEYS` from
   `supabase/.vercel-web.env` (Sensitive) and delete `VARIABLES_KEY` if it
   is still there (the first time only). Redeploy, and check the site is up.
   New values are now sealed with `k2`; old ones open with `k1`.
3. **Re-encrypt.** `scripts/rotate-variables-key.sh`. It uses the database
   and keys in `supabase/.vercel-web.env`, logs in as `reliquary_ops` with
   `supabase/.ops-db-password` (it stops with exit 2 and says so if that file
   is missing: step 0), moves every value and pending
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
5. **Optionally, close the operator's role again:**
   `scripts/set-role-passwords.sh ops-off`.

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

## Finding an error by its ref

Every failure a person or agent sees carries a reference, `ref 7f3a2c9e`
(the public page: docs/public/reference/errors.md). The same request wrote
one log line that starts with it:

```text
failure ref=7f3a2c9e {"status":504,"what":"POST /v/:id/file <vault id> action=write","where":"database (function public.search)","why":"57014 statement timeout: ...","sqlstate":"57014","message":"canceling statement due to statement timeout","functions":"public.search line 12 < ...","routine":"ProcessInterrupts","stack":"..."}
```

1. Vercel, the project the person was using (web app for pages, the env
   API, OAuth and the CLI; MCP for tool calls), **Logs**, set the time range
   around when it happened, and search for the ref (`7f3a2c9e`). With the
   CLI: `vercel logs <deployment url> | grep 7f3a2c9e` (logs are kept for a
   limited time, so look soon).
2. Read the JSON: `status`, `what` (the route's shape and ids, never a path
   or name someone typed), `where`, `why`, and for database errors
   `sqlstate`, `constraint`, `table`, `column`, `functions` (innermost
   first, with line numbers), `detail` (values redacted to `(…)`) and
   `hint`. A 5xx has `stack` (frames only). 5xx lines are at error level,
   the rest at info.
3. Next to it, the request's own line (`POST /v/... 504 ref=7f3a2c9e`, or
   the env API's and OAuth's route line with `server_error ref=...`).
4. A `57014` or `55P03` is a slow query or a held lock: find the function
   in `functions`, and check Supabase's query performance for it. An `08xxx`
   or `53300` is the database connection: check Supabase's status and the
   pooler. A `sign-in (Supabase Auth)` failure names the call and its status
   or network error.

Logs never hold a value, a token, a file's text, an email address or a
failing row's values; if one ever does, that is a bug to fix before
anything else.

## If something is wrong

1. Check the uptime issue and the last `deploy` run.
2. Read the runtime logs for the failing app.
3. A bad release: roll back (Actions > deploy with the previous tag, or
   promote the previous deployment in Vercel; [Redeploy or roll
   back](#redeploy-or-roll-back)). Migrations are forward-only: fix forward
   with a new migration.
4. A leaked secret: rotate it (table above), then check the access logs
   (`env_access_log` via the Variables page's log, tokens' last use).
