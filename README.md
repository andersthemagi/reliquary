# Reliquary

[![test](https://github.com/andersthemagi/reliquary/actions/workflows/test.yml/badge.svg)](https://github.com/andersthemagi/reliquary/actions/workflows/test.yml)
[![security](https://github.com/andersthemagi/reliquary/actions/workflows/security.yml/badge.svg)](https://github.com/andersthemagi/reliquary/actions/workflows/security.yml)
[![CodeQL](https://github.com/andersthemagi/reliquary/actions/workflows/codeql.yml/badge.svg)](https://github.com/andersthemagi/reliquary/actions/workflows/codeql.yml)
[![cli on npm](https://img.shields.io/npm/v/%40reliquary-ai%2Fcli.svg?label=cli)](https://www.npmjs.com/package/@reliquary-ai/cli)
[![server license: FSL-1.1-ALv2](https://img.shields.io/badge/server%20license-FSL--1.1--ALv2-blue.svg)](LICENSE.md)
[![status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange.svg)](https://reliquary.redmage.cc/roadmap)

> The canon for humans and agents.

A shared vault of context and credentials for people and every AI tool they
use. Claude, ChatGPT, Cursor, Claude Code and any other MCP client read the
same approved context; people review and approve in a web UI. Agents never
see a variable's value.

**Status:** pre-alpha, invite-only, hosted at
[reliquary.redmage.cc](https://reliquary.redmage.cc). Milestones 1 (core,
MCP and UI) and 2 (environment variables) are built; milestone 3 (links, an
MCP proxy to upstream tools like Linear) is built and in its first week of
real use. See [docs/design.md](docs/design.md) for the full design and
build order, and [the public roadmap](https://reliquary.redmage.cc/roadmap)
for what's shipped and what's next.

## What it does

- **Shared context.** Each vault has files, notes and proposals, readable
  and writable from any MCP client or the browser. Agents propose changes
  to canon files, people approve, and every change lands in an append-only
  log with quorum if you want one.
- **Secrets that never reach a model.** Environment variables, per project,
  delivered two ways: `reliquary run` starts your command with the values
  in its environment, or `reliquary env pull` writes a gitignored `.env`.
  No MCP tool, log line or error message ever returns a value. Every
  access is logged.
- **Links: other people's MCP tools, without handing out the credential.**
  Connect an upstream MCP server (a project tracker, a support inbox) once;
  Reliquary holds its credential and proxies the calls your agents are
  granted, tool by tool, read-only or not.
- **A gate the database enforces, not the API.** Every permission (who
  reads what, who approves, who reveals a secret) is a Postgres row-level
  security policy, checked with a hostile test on every push.
- **Your data can leave.** Any vault exports as plain markdown files at any
  time, and deletes for good.

## Try it

- **Hosted:** [reliquary.redmage.cc](https://reliquary.redmage.cc). Invite-only
  while in pre-alpha; request access from the site.
- **Self-hosted:** run it on your own server with Docker Compose, no plan
  limits. See [docs/public/how-to/self-host.md](docs/public/how-to/self-host.md).
- **CLI:** `npx @reliquary-ai/cli login`, then `reliquary run` or
  `reliquary env pull`. See
  [docs/public/how-to/use-the-cli.md](docs/public/how-to/use-the-cli.md).

## In this repo

- `docs/design.md`: the design (v3 draft) and build order.
- `docs/public/`: the docs served at `/docs` on the hosted site (tutorials,
  concepts, how-to guides, reference).
- `docs/research/`: hosting and architecture, server load, UX and the
  design system, testing strategy.
- `supabase/migrations/`: the schema, with hostile tests in
  `supabase/tests/`.
- `mcp/`: the remote MCP endpoint.
- `web/`: the web app (UI, public site, docs).
- `cli/`: the CLI, published as `@reliquary-ai/cli`.
- `deploy/`: self-hosting with Docker Compose. Guide:
  `docs/public/how-to/self-host.md`; smoke test: `deploy/test.sh`.
- `spikes/gate/`: the audience gate and session minting, with hostile tests.
  Research that informed v3, not the product.
- `pilot/`: a Telegram bot on the gate. Research, not the product.

## Stack

TypeScript on Node with no web framework: `web/` (server-rendered HTML, the
OAuth server, the environment API) and `mcp/` (the MCP endpoint) are small
`node:http` servers that reach Postgres through `pg`. Postgres 17 enforces
access with row-level security, Supabase Auth signs people in, and `pg_cron`
runs housekeeping where it is installed. Hosted on Vercel and Supabase, or
self-hosted with Docker Compose. The CLI has no runtime dependencies.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers what you need installed, the
day-to-day loop and how a change is reviewed; [AGENTS.md](AGENTS.md) is the
manual for agents and people alike (guardrails, testing policy, conventions).

## License

The server (everything outside `cli/`) is under the Functional Source
License, version 1.1, with the Apache 2.0 future license (FSL-1.1-ALv2):
[LICENSE.md](LICENSE.md). You may use, change and self-host it for any
purpose except offering it to others as a competing product or service;
each version also becomes Apache 2.0 two years after its release. Hosting
Reliquary for others needs a commercial license from Red Mage
(andres@redmage.cc). The CLI in `cli/` is MIT ([cli/LICENSE](cli/LICENSE)).
