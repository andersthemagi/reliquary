# Glossary

The words Reliquary uses, each in one or two sentences, with a link to where it is explained.

**Access log.** A vault's append-only record of every set, rotate, delete, read, reveal and refused attempt on its environment variables. See [Environment variables](../concepts/variables.md#the-access-log).

**Access token.** A secret an MCP client sends in a header (`Authorization: Bearer ...`) to act as you, for clients without sign-in. Scoped to vaults and access, always expiring. See [Tokens, connections and sign-ins](../concepts/connections.md).

**Activity.** A vault's append-only log of every change: who, which agent, what and where. See [Activity](../concepts/activity.md).

**Agent.** An AI tool or program acting for a person through a connection or token. It has its person's role, minus the ceiling. See [Agents and the ceiling](../concepts/agents.md).

**Canon.** A file policy: the file changes only through a proposal approved by enough people. See [Canon, open and rules](../concepts/canon-and-rules.md).

**Ceiling.** The actions no agent can do, however its person connected it: approving, rules, members, grants, secret values, export, deletion and erasure. See [Agents and the ceiling](../concepts/agents.md#the-ceiling).

**CLI sign-in.** The `reliquary` CLI's OAuth grant on one computer. It reads variable values within your role, and may send `.env` files for approval. See [Use the CLI](../how-to/use-the-cli.md).

**Connection.** An MCP client you allowed through OAuth sign-in, like Claude Code or ChatGPT. See [Tokens, connections and sign-ins](../concepts/connections.md).

**Data fencing.** Wrapping text people and agents wrote in random markers when it goes to an agent, so it reads as data and can't pose as instructions. See [MCP tools](mcp-tools.md#data-fencing).

**Default policy.** What a vault's paths are, canon or open, where no rule says otherwise. Set on **Settings**.

**Display name.** An optional name you set on **Account settings**, shown to people who share a vault with you next to your email. Only you set it, in the web app. See [The top bar, inbox and account](../concepts/inbox-and-account.md#display-name).

**Environment.** A named set of values for a vault's variables, like `development`, `preview` or `production`. See [Environment variables](../concepts/variables.md#environments).

**Env API.** The web app's HTTP API that the CLI uses to read variables and send pushes. See [Env API](env-api.md).

**Erase.** Blanking every version of a file's text, while the log keeps its entries. Owners only, in person. See [Export, delete and erase](../concepts/export-delete-erase.md#erase-a-file).

**Import.** A whole `.env` brought in at once, by paste or push, waiting for a person to apply it. See [Imports](../concepts/imports.md).

**Inbox.** The top bar's list of what needs you: changes to review, your proposals sent back, .env imports to apply, invites and deleted-vault notices. See [The top bar, inbox and account](../concepts/inbox-and-account.md#inbox).

**Invite.** A single-use link for one email address and a role, the only way to join a vault. See [Members and invites](../concepts/members.md).

**MCP.** The Model Context Protocol, how AI tools call Reliquary's tools over one URL. See [MCP tools](mcp-tools.md).

**Open.** A file policy: owners, editors and their agents write the file directly, each write a new version. See [Canon, open and rules](../concepts/canon-and-rules.md).

**Owners-only environment.** An environment, like `production`, whose values only owners set or read.

**Proposal.** A suggested change to a file that waits for people to approve, request changes or reject it. See [Proposals and review](../concepts/proposals-and-review.md).

**Push.** An import sent from the CLI with `reliquary env push`, often by an agent, that a person applies in the web app. See [Imports](../concepts/imports.md).

**Quorum.** How many different people must approve a canon change, 1 to 20, set by a rule. See [Canon, open and rules](../concepts/canon-and-rules.md#quorum).

**Reveal.** Showing one variable's value in the web app, to a person, once, logged. See [Environment variables](../concepts/variables.md).

**Role.** A member's standing in a vault: owner, editor or viewer. See [Permissions](permissions.md).

**Rule.** A policy (canon or open, with a quorum) on a folder or a file, set by an owner. See [Set rules](../how-to/set-rules.md).

**Snooze.** Hiding a proposal from your own Inbox for a day, a week, or until it changes. Private to you. See [Proposals and review](../concepts/proposals-and-review.md#snooze).

**Vault.** The container for one team, client or project: files, variables, members and activity. See [Vaults, files and folders](../concepts/vaults-and-files.md).
