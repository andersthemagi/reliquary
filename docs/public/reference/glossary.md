# Glossary

The words Reliquary uses, each in one or two sentences, with a link to where it is explained.

**Access log.** A vault's append-only record of every set, rotate, delete, read, reveal and refused attempt on its environment variables. See [Environment variables](../concepts/variables.md#the-access-log).

**Activity.** A vault's append-only log of every change: who, which agent, what and where. See [Activity](../concepts/activity.md).

**Agent.** An AI tool or program acting for a person through a connection. It has its person's role, minus the ceiling. See [Agents and the ceiling](../concepts/agents.md).

**App.** A type of connection: an MCP client you allowed by signing in from it and choosing **Allow**, like Claude Code, Claude.ai or ChatGPT. It keeps its own short-lived tokens, so there is nothing to copy. See [Connections](../concepts/connections.md).

**Canon.** A file policy: the file changes only through a proposal approved by enough people. See [Canon, open and rules](../concepts/canon-and-rules.md).

**Ceiling.** The actions no agent can do, however its person connected it: approving, rules, path owners, members, grants, secret values, links, export, deletion and erasure. See [Agents and the ceiling](../concepts/agents.md#the-ceiling).

**Connection.** Anything that can act as you. It has a type: **Token**, **App** or **Reliquary CLI**. All are listed on the **Connections** page (the account menu), where you revoke them. See [Connections](../concepts/connections.md).

**Data fencing.** Wrapping text people and agents wrote in random markers when it goes to an agent, so it reads as data and can't pose as instructions. See [MCP tools](mcp-tools.md#data-fencing).

**Default policy.** What a vault's paths are, canon or open, where no rule says otherwise. Set on **Settings**.

**Display name.** An optional name you set on **Account settings**, shown to people who share a vault with you next to your email. Only you set it, in the web app. See [The top bar, inbox and account](../concepts/inbox-and-account.md#display-name).

**Environment.** A named set of values for a vault's variables, like `development`, `preview` or `production`. See [Environment variables](../concepts/variables.md#environments).

**Env API.** The web app's HTTP API that the CLI uses to read variables and send imports. See [Env API](env-api.md).

**Erase.** Blanking every version of a file's text, while the log keeps its entries. Owners only, in person. See [Export, delete and erase](../concepts/export-delete-erase.md#erase-a-file).

**Flag.** Something in a vault that changed since you, or one of your connections, was last told: a proposal waiting on your review, a change to your own proposal, or a change on a path you watch. You see yours under **Settings**, **Diagnostics**, **Flags**. See [Flags](../concepts/flags.md).

**Import.** A whole `.env` brought in at once, pasted in the web app or sent from the CLI, waiting for a person to apply it. See [Imports](../concepts/imports.md).

**Inbox.** The top bar's list of what needs you: changes to review, your proposals sent back, .env imports to apply, invites and deleted-vault notices. See [The top bar, inbox and account](../concepts/inbox-and-account.md#inbox).

**Invite.** A single-use link for one email address and a role, the only way to join a vault. See [Members and invites](../concepts/members.md).

**Link.** A vault's credential to a remote MCP server, like Stripe or Linear, so a team shares a platform account with their agents without sharing the key. Not to be confused with a connection: a link is Reliquary reaching out, a connection is a client reaching in. See [Links](../concepts/links.md).

**MCP.** The Model Context Protocol, how AI tools call Reliquary's tools over one URL. See [MCP tools](mcp-tools.md).

**Open.** A file policy: owners, editors and their agents write the file directly, each write a new version. See [Canon, open and rules](../concepts/canon-and-rules.md).

**Owners-only environment.** An environment, like `production`, whose values only owners set or read.

**Path owner.** Someone named on a specific path's owner list: open for them there, whatever the path's own rule says for everyone else, and their approval is what its quorum counts. Anyone who is a member may be named, including a viewer, promoted for that one path only. See [Path ownership](../concepts/path-ownership.md).

**Proposal.** A suggested change to a file that waits for people to approve, request changes or reject it. See [Proposals and review](../concepts/proposals-and-review.md).

**Push.** Sending a `.env` with `reliquary env push`, often by an agent. It makes an import from the CLI, which a person applies in the web app. See [Imports](../concepts/imports.md).

**Quorum.** How many different people must approve a canon change, 1 to 20, set by a rule. See [Canon, open and rules](../concepts/canon-and-rules.md#quorum).

**Reliquary CLI.** A type of connection: the `reliquary` CLI on one computer, connected with `reliquary login`. It reads variable values within your role, and may send `.env` files for approval. See [Use the CLI](../how-to/use-the-cli.md).

**Reveal.** Showing one variable's value in the web app, to a person, once, logged. See [Environment variables](../concepts/variables.md).

**Revoke.** Ending a connection, on the **Connections** page. It is refused on its next request. See [Connections](../concepts/connections.md#revoking).

**Role.** A member's standing in a vault: owner, editor or viewer. See [Permissions](permissions.md).

**Rule.** A policy (canon or open, with a quorum) on a folder or a file, set by an owner. See [Set rules](../how-to/set-rules.md).

**Snooze.** Hiding a proposal from your own Inbox for a day, a week, or until it changes. Private to you. See [Proposals and review](../concepts/proposals-and-review.md#snooze).

**Token.** A type of connection: a secret you paste into an MCP client that can't sign in, which sends it in a header (`Authorization: Bearer ...`). Made with **New token**, scoped to vaults and access, always expiring. See [Connections](../concepts/connections.md).

**Vault.** The container for one team, client or project: files, variables, members and activity. See [Vaults, files and folders](../concepts/vaults-and-files.md).

**Watch.** Asking to be flagged about changes on a folder or file in a vault. Yours only, set in person, and private to you. See [Flags](../concepts/flags.md#watching-a-path).
