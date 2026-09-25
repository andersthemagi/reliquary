# Licensing (DRAFT, not in force)

**Status: DRAFT pending the owner's decision and a legal review.** Nothing in
this folder is a license anyone has been granted. Until the owner decides,
the server (`web/`, `mcp/`, `supabase/`, `deploy/`) has no open-source or
source-available license: all rights are reserved by Red Mage. The CLI (`cli/`) is MIT, as `cli/LICENSE` says; that
doesn't change.

Internal: this folder is not public docs. Never link it from `docs/public`
or copy it there until the owner has decided and the texts are final.

## The proposal

From `docs/research/storage-and-addons.md` (section 4, on `main`) and
`docs/research/pricing.md`:

| Part | Proposed license | Draft |
|---|---|---|
| CLI (`cli/`) | MIT (in force today) | `cli/LICENSE` |
| Server: web app, MCP server, migrations, deploy files | FSL-1.1-ALv2 (Functional Source License, converting to Apache 2.0 two years after each release) | [server-fsl.DRAFT.md](server-fsl.DRAFT.md) |
| Hosting Reliquary for others (agencies, MSPs), support | A commercial partner license | [commercial.DRAFT.md](commercial.DRAFT.md) |

Self-hosting for your own use stays free at any size, with every feature:
the self-hosted build has no plan limits (`deploy/sql/10_self_hosted.sql`)
and no feature gating.

## Decisions for the owner

1. **The server's license.** FSL-1.1-ALv2 as proposed, FSL-1.1-MIT, BSL 1.1,
   AGPL-3.0, or keep it closed for now. Self-hosting works technically
   either way (`deploy/`); only who may run it changes.
2. **When the source opens.** A public repository, or source to customers
   only.
3. **Contributions.** A CLA (needed to sell a commercial license for code
   others wrote) or DCO sign-off only.
4. **Commercial license terms**: what counts as "hosting for others" when an
   agency invites clients into vaults it hosts; price (the research suggests
   $5 per client vault a month, $50 minimum); support tiers.
5. **Trademark.** Whether "Reliquary" and the logo may be used by
   self-hosters and forks, and how.
6. **Legal review** of every text here before anything is published.

## When decided

- Put the chosen license's canonical text, verbatim and unedited, in a root
  `LICENSE` (and `LICENSE` files in `web/` and `mcp/` if they differ), with
  the parameters filled in. Never paraphrase a license.
- Add `"license"` to `web/package.json` and `mcp/package.json`.
- Say it in `README.md` and in `docs/public/how-to/self-host.md`.
- Publish the commercial terms, or a contact, where people will look.
