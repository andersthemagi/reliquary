# Reliquary

A shared context layer for people and their AI agents, with scheduled routines
and secrets in the same place. Red Mage's internal tool first; a product only
once it has earned it.

**Status:** design stage, no code yet. Start with [docs/design.md](docs/design.md).

## What it does

- **Shared spaces.** Context for one client or one group, shared with exactly
  the people in it. Agents propose, people approve, and every change lands in
  an append-only log.
- **An update feed.** Every consumer asks "what changed since my last
  cursor". Offline devices catch up on their next pull.
- **Routines.** Schedules, a job queue, a run log, and a watchdog that lives in
  the database, so no single laptop or server has to stay up for failures to
  get noticed. Workers run `claude -p` on a VPS.
- **Secrets.** Shared per person, pulled into `.env` by a CLI, logged on every
  access, and never returned to an AI agent.

People without their own agent setup use the web dashboard and one MCP URL.

## Lineage

v2 of the CommonThread prototype (`andersthemagi/commonthread-project-brain`,
built 2026-09-23 through Stripe Projects). The prototype proved the
propose/approve/log loop over MCP; v2 rebuilds around routines, sync and
secrets. The schema, RLS helpers and append-only trigger carry over.

## Stack

Supabase (Postgres, Auth, Vault, `pg_cron`, `pgmq`, `pg_net`), Next.js for the
dashboard, MCP endpoint and REST API, and a small worker for the VPS.
