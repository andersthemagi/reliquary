# Owner checklist

What's left needs the owner (accounts, money, decisions). Everything a model
could build or harden is done as of 2026-09-25; the loop stopped here.

## Do next

1. **DNS in Squarespace** (redmage.cc): CNAME `reliquary` and
   `mcp.reliquary` to `cname.vercel-dns.com`. Both domains are already on the
   Vercel projects. Then ask for the switch: `PUBLIC_URL`, `MCP_RESOURCE`,
   `AUTH_ISSUER`, the Supabase Site URL and redirect URLs move to
   `reliquary.redmage.cc`; connectors (Claude Code, Claude.ai, ChatGPT) and
   the CLI sign in again once. Until then the CLI needs
   `--server https://reliquary-context.vercel.app`.
2. **Vercel deploy hooks**: in each project, Settings, Git, Deploy Hooks
   (branch `main`); save as GitHub secrets `VERCEL_DEPLOY_HOOK_WEB` and
   `VERCEL_DEPLOY_HOOK_MCP`. Then every green push deploys itself.
3. **`reliquary login` again**, ticking "also let it send .env files", so
   `reliquary env push` works.

## Decide

4. **CLI licence** (`cli/package.json` says `UNLICENSED`, which makes a
   public package unusable), then publish: create the `@reliquary-ai` npm
   scope, add the `NPM_TOKEN` secret, push tag `cli-v0.1.0`. If the repo
   stays private, drop provenance (see `cli/README.md`).
5. **Pricing**: keep "free for 1 to 10 people" or adopt
   `docs/research/positioning.md` section 5. The landing page reads its
   numbers from `PRICING` in `web/src/site.ts`.
6. **Sign-ups**: on (anyone can make an account; invites work by link) or
   off (add each invitee in Supabase first). If on, edit the "Confirm
   signup" email template like the magic link one (`web/README.md`).
7. **Email sender** on a subdomain (e.g. `notify.redmage.cc`; an EU sender
   keeps data in the EU), then SMTP in Supabase Auth and `deliverInvite()`
   in `web/src/invites.ts`; add it to `/subprocessors`.
8. **Legal placeholders** in `OPERATOR` in `web/src/site.ts`, and a legal
   review before the "Draft" labels come off.
9. **Milestone 3 (shared connections)**: starts after milestone 2's week of
   real use (no local `.env` files; `reliquary run` instead), per
   `AGENTS.md`.

## Before the next key rotation

- `scripts/set-role-passwords.sh ops`, then follow `docs/ops/runbook.md`.

## Keep an eye on

- The `uptime` workflow's "Production is down" issue.
- Backups: `scripts/backup.sh` then `scripts/restore-test.sh`, weekly.
- The pooler client count during real use (`docs/research/server-load.md`).
