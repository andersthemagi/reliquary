# Internal docs

Notes for people and agents who work on Reliquary. The public docs are in
[public/](public/): they are served at `/docs` and are not described here.
Nothing in this folder is published, and the public docs never link to it.

Read in this order when you change something:

1. [AGENTS.md](../AGENTS.md): guardrails, testing and commit rules.
2. [design.md](design.md): what Reliquary is and why. Read "What it is" and
   "Principles", then the section for your area. Its Contents table says
   which sections are built.
3. [progress.md](progress.md): what shipped, file by file, and the owner's
   decisions on building ahead. Read the section for the area you touch.
4. [parity.md](parity.md): every action on the web app and over MCP, and the
   gaps left on purpose. A new MCP tool needs a row.
5. [variables.md](variables.md): how variables, the environment API and the
   CLI's sign-in work, and what the Variables page must never do.
6. [ops/runbook.md](ops/runbook.md): hosts, deploys, rotating secrets,
   backups, finding an error by its reference.
   [ops/owner-checklist.md](ops/owner-checklist.md) is what is left for the
   owner.
7. [research/](research/): hosting, server load, the testing strategy, the UI
   design system and audits. Background, not a spec.
8. [brand/](brand/): the source of the link-preview image and how to regenerate it.

Which test proves a feature, and which docs page explains it, is in
[tests/features.md](../tests/features.md), not here.
