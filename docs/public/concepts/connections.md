# Tokens, connections and sign-ins

Three kinds of credential let software act for you, and all of them are listed on your Tokens page, where you can revoke any of them.

## The three kinds

| | OAuth connection | Access token | CLI sign-in |
|---|---|---|---|
| For | MCP clients that support sign-in: Claude Code, Claude.ai, ChatGPT | MCP clients that can only send a header: Cursor, VS Code, scripts, headless agents | the `reliquary` CLI on one computer |
| Made by | signing in from the client and choosing **Allow** | **Tokens**, **Create token** in the web app | `reliquary login` and choosing **Allow** |
| Reaches | the MCP endpoint | the MCP endpoint | the env API only: variable values, never files |
| Vaults | all yours, or the ones you tick | all yours, or the ones you tick | all yours, or the ones you tick |
| Access | read only, or read and write | read only, or read and write | reads values; optionally sends a `.env` for approval |
| Lifetime | 1-hour access tokens, refreshed by the client; the grant lasts at most a year | 7 days to a year, fixed when made | 1-hour access tokens, refreshed by the CLI; at most a year |
| Shown as | the client's name, "from" its site | the name you gave it | "Reliquary CLI" |

All three act as you, minus the [ceiling](agents.md). A connection or token can never do more than your role allows in a vault.

## Prefer OAuth where the client supports it

With OAuth there is no secret to copy: the client signs in through your browser and keeps its own refreshed tokens. Use an access token only for clients without sign-in, and keep it out of chats and config files that an agent can read: read it from an environment variable or a password prompt. See [Connect Cursor](../how-to/connect-cursor.md) and [Connect VS Code](../how-to/connect-vs-code.md).

## Scope is fixed

A token's or connection's vaults and access are fixed when it is made. To change them, revoke it and make another. "All my vaults" includes vaults you join later; ticking vaults limits it to those.

## Revoking

Revoke any of them on the **Tokens** page; the next request it makes is refused. Only you can revoke your own, in person: no agent, token or client can revoke one (an OAuth client can still end its own grant). A vault owner can also cut a member's connection off from their vault on **Members**, without touching the member's other vaults.

When you leave a vault, or are removed, tokens that reached only that vault are revoked, and the vault drops out of tokens that reached several.

If a token leaked, see [Rotate a leaked token](../how-to/rotate-a-leaked-token.md).

## What the Tokens page shows

Each entry shows its name, vaults, access, when it was last used and by which client (the name the client reports), and when it expires. Tokens themselves are stored only as hashes: a new token is shown once, when you create it, and never again.
