# Owner checklist

What's left needs the owner (accounts, money, decisions). Everything a model
could build or harden is done as of 2026-09-25; the loop stopped here.

## Do next

1. **Three hosts** (`docs/ops/runbook.md`, "Hosts"):
   - DNS in Squarespace (redmage.cc): CNAME `reliquary`, `app.reliquary` and
     `mcp.reliquary` to `cname.vercel-dns.com`.
   - Vercel: `reliquary.redmage.cc` and `app.reliquary.redmage.cc` on
     `reliquary-web`, `mcp.reliquary.redmage.cc` on `reliquary-mcp`.
   - Environment: `scripts/vercel-env.sh web https://app.reliquary.redmage.cc
     https://mcp.reliquary.redmage.cc https://reliquary.redmage.cc` and
     `scripts/vercel-env.sh mcp https://app.reliquary.redmage.cc
     https://mcp.reliquary.redmage.cc`, pasted into each project (`PUBLIC_URL`,
     `SITE_URL`, `MCP_PUBLIC_URL`, `MCP_RESOURCE`, `AUTH_ISSUER`), then a
     redeploy of the live release.
   - Supabase Auth, URL Configuration: Site URL
     `https://app.reliquary.redmage.cc`, redirect URL
     `https://app.reliquary.redmage.cc/**`.
   - GitHub repository variables `WEB_URL=https://app.reliquary.redmage.cc`
     and `MCP_URL=https://mcp.reliquary.redmage.cc` (uptime and deploy
     checks).
   - Connectors (Claude Code, Claude.ai, ChatGPT) and the CLI sign in again
     once. The CLI's default server is now `https://app.reliquary.redmage.cc`;
     a `.reliquary.json` naming `https://reliquary.redmage.cc` must change to
     it. Until the switch, the CLI needs
     `--server https://reliquary-context.vercel.app`.
2. **Releases** (only a published release deploys; `docs/ops/runbook.md`,
   "Deploy"):
   - GitHub, Settings > Actions > General > Workflow permissions: turn on
     "Allow GitHub Actions to create and approve pull requests", or
     release-please can't open the release pull request.
   - Secret `VERCEL_TOKEN` (deferred during pre-alpha by the owner's decision; releases are deployed by hand, then verified with the deploy workflow's tag input): a Vercel access token (Account Settings >
     Tokens) scoped to the team that owns `reliquary-web` and
     `reliquary-mcp`, so a release deploys exactly its tagged commit. If the
     projects are under a team, also the variable `VERCEL_TEAM_ID`
     (`team_...`; not secret); if they were renamed, `VERCEL_PROJECT_WEB`
     and `VERCEL_PROJECT_MCP`. Until it's set, the deploy falls back to the
     Deploy Hook secrets `VERCEL_DEPLOY_HOOK_WEB` / `_MCP` (if they exist),
     which build `main`, not the tag.
   - Optional, recommended: secret `RELEASE_PLEASE_TOKEN`, a fine-grained
     token (or GitHub App token) with Contents and Pull requests read and
     write on this repository only. With it, the release pull request gets
     its `test` checks and releases trigger `deploy` and `publish-cli`
     directly; without it the `release` workflow starts them itself.
   - Cut v0.1.0 once, by hand (runbook, "The first release").
3. **Email templates**: paste Reliquary's 13 templates into Supabase
   (Authentication > Emails: the Templates tab and Security notifications,
   turning those on). `scripts/email-templates.sh` lists them and copies
   each; steps in `docs/ops/runbook.md`, "Email templates".
4. **`reliquary login` again**, ticking "also let it send .env files", so
   `reliquary env push` works.

## Decide

5. **CLI licence** (`cli/package.json` says `UNLICENSED`, which makes a
   public package unusable), then publish: create the `@reliquary-ai` npm
   scope, add the `NPM_TOKEN` secret, then Actions > publish-cli > Run
   workflow from tag `cli-v0.1.0` (cut with v0.1.0). Later CLI versions
   publish when their "Release cli vX.Y.Z" pull request is merged. If the repo
   stays private, drop provenance (see `cli/README.md`).
6. **Pricing**: keep "free for 1 to 10 people" or adopt
   `docs/research/positioning.md` section 5. The landing page reads its
   numbers from `PRICING` in `web/src/site.ts`.
7. **Sign-ups**: on (anyone can make an account; invites work by link) or
   off (add each invitee in Supabase first). Either way the "Confirm sign
   up" template is one of the pasted ones (Do next, 3).
8. **Email sender** on a subdomain (e.g. `notify.redmage.cc`; an EU sender
   keeps data in the EU), then SMTP in Supabase Auth and `deliverInvite()`
   in `web/src/invites.ts`; add it to `/subprocessors`.
9. **Legal placeholders** in `OPERATOR` in `web/src/site.ts`, and a legal
   review before the "Draft" labels come off.
10. **Milestone 3 (shared connections)**: starts after milestone 2's week of
   real use (no local `.env` files; `reliquary run` instead), per
   `AGENTS.md`.

## Before the next key rotation

- `scripts/set-role-passwords.sh ops`, then follow `docs/ops/runbook.md`.

## Keep an eye on

- The open "Release vX.Y.Z" pull request: merging it is what ships.
  Versions stay 0.x (pre-alpha) until you decide on 1.0.

- The `uptime` workflow's "Production is down" issue.
- Backups: `scripts/backup.sh` then `scripts/restore-test.sh`, weekly.
- The pooler client count during real use (`docs/research/server-load.md`).
