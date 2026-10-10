# Owner checklist

What's left needs the owner (accounts, money, decisions). Items are removed
when the repo shows them done; the rest are the owner's to confirm.

## Do next

1. **Three hosts** (`docs/ops/runbook.md`, "Hosts"):
   - Netlify (`docs/research/hosting.md`, section 11, has the whole move from
     Vercel in order): a team on the Pro plan (the Frankfurt functions region
     needs it), two sites made without a repository (`netlify sites:create
     --name reliquary-web`, then `reliquary-mcp`, or Add new site > Deploy
     manually): never connect them to the repository, or Netlify builds
     every push. Domains: `reliquary.redmage.cc` and
     `app.reliquary.redmage.cc` on `reliquary-web`, `mcp.reliquary.redmage.cc`
     on `reliquary-mcp`. In each site's environment variables,
     `AWS_LAMBDA_JS_RUNTIME=nodejs22.x`.
   - DNS in Squarespace (redmage.cc): CNAME `reliquary`, `app.reliquary` and
     `mcp.reliquary` to the owning site's `<name>.netlify.app` address, as
     Netlify shows when the domain is added (today they point at Vercel's
     `cname.vercel-dns.com`; moving them is the cutover).
   - Environment: `scripts/netlify-env.sh web https://app.reliquary.redmage.cc
     https://mcp.reliquary.redmage.cc https://reliquary.redmage.cc` and
     `scripts/netlify-env.sh mcp https://app.reliquary.redmage.cc
     https://mcp.reliquary.redmage.cc`, each file imported into its site
     (Site configuration > Environment variables > Import from a .env file,
     "Contains secret values" on; or `netlify env:import`), then a redeploy
     of the live release.
   - Supabase Auth, URL Configuration: Site URL
     `https://app.reliquary.redmage.cc`, redirect URL
     `https://app.reliquary.redmage.cc/**`.
   - GitHub repository variables `WEB_URL=https://app.reliquary.redmage.cc`
     and `MCP_URL=https://mcp.reliquary.redmage.cc` (uptime and deploy
     checks).
   - Connectors (Claude Code, Claude.ai, ChatGPT) and the CLI sign in again
     once. The CLI's default server is now `https://app.reliquary.redmage.cc`;
     a `.reliquary.json` naming `https://reliquary.redmage.cc` must change to
     it.
2. **Releases** (only a published release deploys; `docs/ops/runbook.md`,
   "Deploy"):
   - GitHub, Settings > Actions > General > Workflow permissions: turn on
     "Allow GitHub Actions to create and approve pull requests", or
     release-please can't open the release pull request.
   - Secret `NETLIFY_AUTH_TOKEN`: a Netlify personal access token (User
     settings > Applications > Personal access tokens) of a member of the
     team that owns `reliquary-web` and `reliquary-mcp`, so a release deploys
     exactly its tagged commit. Variables `NETLIFY_SITE_WEB` and
     `NETLIFY_SITE_MCP`: each site's API ID (Site configuration > General >
     Site details; not secret). Until all three are set, the deploy
     workflow skips its Netlify stage with a notice and nothing goes live.
     Afterwards, delete the `VERCEL_TOKEN` secret and the `VERCEL_TEAM_ID`
     variable, and the two Vercel projects.
   - Optional, recommended: secret `RELEASE_PLEASE_TOKEN`, a fine-grained
     token (or GitHub App token) with Contents and Pull requests read and
     write on this repository only. With it, the release pull request gets
     its `test` checks and releases trigger `deploy` and `publish-cli`
     directly; without it the `release` workflow starts them itself.
3. **Email templates**: paste Reliquary's 13 templates into Supabase
   (Authentication > Emails: the Templates tab and Security notifications,
   turning those on). `scripts/email-templates.sh` lists them and copies
   each; steps in `docs/ops/runbook.md`, "Email templates".
4. **`reliquary login` again**, ticking "also let it send .env files", so
   `reliquary env push` works.

## Decide

5. **Publish the CLI**: `publish-cli` published 0.3.1 to 0.3.3 on
   2026-09-29, and 0.3.3 is still what npm serves. Every run since (0.3.3
   again, `cli-v0.4.0`, `cli-v0.4.1`) failed with E403, "OIDC permission
   denied": trusted publishing on npmjs.com is missing, or doesn't match this
   workflow (step 4), so `npx @reliquary-ai/cli` still gives 0.3.3.
   `publish-cli.yml` authenticates by npm trusted publishing (OIDC), with a
   one-time token fallback for the bootstrap publish only (its own header
   comment has the exact npm-side fields):
   1. Create the `@reliquary-ai` npm organisation (done, 2026-09-29).
   2. Mint a granular access token scoped to `@reliquary-ai/cli` only
      (there's nothing to scope it to more narrowly until it exists) and
      add it as the `NPM_TOKEN` repository secret. Ignore npm's own
      "use trusted publishing instead" nudge here: that page only exists
      once the package does, so this one token is unavoidable for the
      very first publish.
   3. Actions > publish-cli > Run workflow from the current version's tag
      (earlier tags are superseded, not worth publishing separately).
   4. Once it exists: npmjs.com > `@reliquary-ai/cli` > Settings >
      Trusted publishing > GitHub Actions, then delete the `NPM_TOKEN`
      secret and revoke the npm token. Every publish after that
      authenticates by OIDC, no secret in this repository at all.
   Later versions publish on their own when their "Release cli vX.Y.Z"
   pull request is merged, once step 4 is done.
6. **Pricing**: keep "free for 1 to 10 people" or set new numbers. The
   landing page reads its numbers from `PRICING` in `web/src/site.ts`.
7. **Sign-ups**: on (anyone can make an account; invites work by link) or
   off (add each invitee in Supabase first). Either way the "Confirm sign
   up" template is one of the pasted ones (Do next, 3).
8. **Email sender: Resend** (chosen; `docs/ops/runbook.md`, "Email
   sender", has every click):
   - Resend account, domain `mail.reliquary.redmage.cc` in region Ireland
     (eu-west-1). Mail is sent from the EU, but Resend keeps account data
     and email logs in the US whatever the region; `/subprocessors` and
     `/privacy` already say so.
   - DNS in Squarespace: the DKIM, SPF, MX and DMARC records Resend lists,
     then Verify.
   - Two API keys, Sending access, domain `mail.reliquary.redmage.cc` only:
     `supabase-smtp` and `reliquary-web`.
   - Supabase, Authentication > Emails > SMTP Settings: `smtp.resend.com`,
     port 465, user `resend`, password the first key, sender
     `Reliquary <no-reply@mail.reliquary.redmage.cc>`; then Rate Limits: raise the
     30-an-hour email limit to what the Resend plan allows.
   - Netlify `reliquary-web`: `RESEND_API_KEY` (the second key, secret)
     and `EMAIL_FROM=Reliquary <no-reply@mail.reliquary.redmage.cc>`, then redeploy.
     Invites are then emailed; without them owners keep copying the link.
   - Check: sign in by code, and invite an address you own.
9. **Legal placeholders** in `OPERATOR` in `web/src/site.ts`, and a legal
   review before the "Draft" labels come off.

## Before the next key rotation

- `scripts/set-role-passwords.sh ops`, then follow `docs/ops/runbook.md`.

## Keep an eye on

- The open "Release vX.Y.Z" pull request: merging it is what ships.
  Versions stay 0.x (pre-alpha) until you decide on 1.0.

- The `uptime` workflow's "Production is down" issue.
- Backups: `scripts/backup.sh` then `scripts/restore-test.sh`, weekly.
- The pooler client count during real use (`docs/research/server-load.md`).
