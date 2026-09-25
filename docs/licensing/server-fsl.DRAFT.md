# Server license (DRAFT, not in force)

**DRAFT pending the owner's decision and a legal review. Not a grant of any
right.** See [README.md](README.md).

The proposal is the Functional Source License, version 1.1, with the Apache
2.0 future license (FSL-1.1-ALv2). This file holds only the parameters and
the reasoning. The license text itself must be the canonical one from
<https://fsl.software/>, copied verbatim when the owner decides, never
retyped or edited here.

## Parameters

| Parameter | Proposed value |
|---|---|
| Licensor | Red Mage (the legal entity's exact name to be confirmed) |
| Software | Reliquary's server: `web/`, `mcp/`, `supabase/`, `deploy/` and the files they need to build and run |
| Not covered | `cli/` (MIT), third-party code under its own license, the Reliquary name and logo |
| Future license | Apache License 2.0 |
| Change date | two years after each version is made available (FSL's fixed term) |

## What it would allow and forbid, in plain words

Allowed, free: using, copying, changing and running it for any purpose that
isn't a Competing Use, including a company running it internally for its own
people, commercial or not, at any size; research, education, evaluation;
contributing.

Not allowed without a commercial license: making it available to others as a
commercial product or service that substitutes for Reliquary, or that
substitutes for another product or service Red Mage offers with it (for
example an agency hosting it for its clients as a paid service). The
commercial terms are drafted in [commercial.DRAFT.md](commercial.DRAFT.md).

After two years, each version is also available under Apache 2.0.

## Open questions for the legal review

- Whether an agency inviting clients into vaults it hosts for its own
  projects is a Competing Use, and how to say so in a FAQ.
- Whether the migrations (SQL) and deploy files need anything beyond FSL's
  terms.
- Notices required for bundled third-party code (the images in
  `deploy/compose/compose.yml` are fetched, not redistributed).
