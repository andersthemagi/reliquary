# Reliquary docs

Reliquary is a shared vault of context and environment variables for people and the AI agents they use, over one MCP URL.

Your agents read the same approved files from Claude Code, Claude.ai, ChatGPT, Cursor or any MCP client. They propose changes; people approve them in the web app. Environment variables reach your programs through the `reliquary` CLI and never reach a model. The database enforces every rule, including what an agent can't do.

Reliquary is pre-alpha: things change and may break; data is backed up daily. See the [roadmap](https://github.com/users/andersthemagi/projects/3), which is a GitHub project board, and the [changelog](changelog.md) for what changed in each release.

## Start here

- [Getting started](tutorials/getting-started.md): create a vault, connect Claude Code, approve your agent's first proposal, and run a command with your first variable. About 15 minutes.

## How these docs are organised

| Section | Read it when you want to |
|---|---|
| [Tutorials](tutorials/getting-started.md) | learn by doing, start to finish |
| Concepts | understand how a part works and why, starting with [vaults](concepts/vaults-and-files.md) |
| How-to guides | get one job done, like [connecting Cursor](how-to/connect-cursor.md) or [moving a .env into a vault](how-to/move-env-into-vault.md) |
| Reference | look up exact facts: [MCP tools](reference/mcp-tools.md), [CLI](reference/cli.md), [permissions](reference/permissions.md), [limits](reference/limits.md) |

## Where things are

- The web app: `https://app.reliquary.redmage.cc`. Sign in with your email; invites are how people join. Its OAuth sign-in for agents and the CLI lives there too.
- The website and these docs: `https://reliquary.redmage.cc`, with the docs at `/docs`; `/roadmap` goes to the roadmap board. **Sign in** there takes you to the web app.
- The MCP URL: `https://mcp.reliquary.redmage.cc/mcp`. Your Connect page in the web app always shows the one to use.
- The CLI: `npx @reliquary-ai/cli`, or install it with `npm install -g @reliquary-ai/cli` and run `reliquary`.
- In the web app: what needs you in the **Inbox**, search across your vaults, and your display name, theme and tokens in the account menu, all in the top bar. See [The top bar, inbox and account](concepts/inbox-and-account.md).

## For agents

Every page is also plain Markdown: add `.md` to its URL, like `/docs/concepts/agents.md`. [`/llms.txt`](/llms.txt) lists every page with a one-line summary, and [`/llms-full.txt`](/llms-full.txt) is all of them in one file. If you are an agent working in a Reliquary vault, read [Agents and the ceiling](concepts/agents.md) and the [MCP tools](reference/mcp-tools.md) first.
