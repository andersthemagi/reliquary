# Reliquary

A shared vault of context, automations and credentials for people and any
agent they use. ChatGPT, Claude Code, Cursor and Hermes connect over one MCP
URL; people use the web UI. Nobody's machine has to stay on.

Red Mage's internal tool first; a product only once it has earned it.

**Status:** design stage. The v3 draft is [docs/design.md](docs/design.md);
the research behind it is in [docs/research/](docs/research/).

## What it does

- **Shared context.** Each vault has entries, notes and proposals, readable
  and writable from any MCP client or the browser. Agents propose, people
  approve, and every change lands in an append-only log with a pull feed.
- **A gate the database enforces.** Every read returns only what everyone who
  will see the output may see: the person for their own agent, the declared
  audience for a routine, everyone present in a group chat.
- **Routines.** Declarative automations inside a vault, triggered by a
  schedule or a change. They run on Reliquary with the vault's own model key,
  and each run must produce an artifact. A watchdog in the database notices
  silence.
- **Environment variables.** Shared credentials per environment, Vercel-style,
  delivered by `reliquary run` or `reliquary env pull`, logged on every
  access, and never returned to a model. With emergency access, a team
  carries on if someone disappears.
- **Your data can leave.** Export and an optional git mirror.

## In this repo

- `docs/design.md`: the design (v3 draft).
- `docs/research/`: landscape, SWOT, the gate analysis, pricing.
- `spikes/gate/`: the audience gate and session minting, with hostile tests.
- `pilot/`: a Telegram bot on the gate. Research, not the product.

## Lineage

v3 of the CommonThread prototype (`andersthemagi/commonthread-project-brain`,
built 2026-09-23 through Stripe Projects). The prototype proved the
propose/approve/log loop over MCP. v2 (commit `4b11c25`) mixed Andrés's
personal routine infrastructure with the product; v3 separates them.

## Stack

Supabase (Postgres with RLS, Auth, Vault, `pg_cron`, `pgmq`, `pg_net`, Edge
Functions), Next.js for the web UI, MCP endpoint and REST, and a small CLI.
