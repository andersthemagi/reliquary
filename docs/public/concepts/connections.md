# Connections

A connection is anything that can act as you: an agent, an app or the CLI. Every one of yours is on the **Connections** page (the account menu at the top right, then **Connections**; its address is `/connections`), where you can revoke it. The page used to be at `/tokens`: old links and bookmarks still land on it.

## The three types

The **Type** column on the Connections page shows which one each is.

| | App | Token | Reliquary CLI |
|---|---|---|---|
| For | MCP clients that sign in: Claude Code, Claude.ai, ChatGPT | MCP clients that can only send a header: Cursor, VS Code, scripts, headless agents | the `reliquary` CLI on one computer |
| Made by | signing in from the client and choosing **Allow** | **Create read-only token** on the Cursor, VS Code or Other clients tab of Connect, or **New token** on the Connections page | `reliquary login` and choosing **Allow** |
| Reaches | the MCP endpoint | the MCP endpoint | the env API only: variable values, never files |
| Vaults | all yours, or the ones you tick | all yours, or the ones you tick | all yours, or the ones you tick |
| Access | read only, or read and write | read only, or read and write | reads values; optionally sends a `.env` for approval |
| Lifetime | 1-hour access tokens, refreshed by the client; at most a year | 7 days to a year, fixed when made | 1-hour access tokens, refreshed by the CLI; at most a year |
| Named | the client's name, "from" its site | the name you gave it | "Reliquary CLI" |

Apps and the CLI sign in through the web app at `https://app.reliquary.redmage.cc`, the issuer your client checks. The CLI uses that server unless you name another with `--server`.

Every connection acts as you, minus the [ceiling](agents.md). It can never do more than your role allows in a vault.

## Prefer an app where the client can sign in

When a client signs in, there is no secret to copy: it signs in through your browser and keeps its own refreshed tokens. Make a token only for clients that can't sign in, and keep it out of chats and config files an agent can read: read it from an environment variable or a password prompt. See [Connect Cursor](../how-to/connect-cursor.md) and [Connect VS Code](../how-to/connect-vs-code.md).

## Make a token

Quickest, for Cursor, VS Code or another client that can't sign in:

1. On the **Connect** page, open that client's tab.
2. Name the token after the agent and machine, then choose **Create read-only token** or **Create read and write token**. It reaches all your vaults and expires in 90 days.
3. The next page shows the token once, with the steps for that client and the token already in them.

For some vaults, or another expiry, choose **use the full form** on the tab, or **New token** on the Connections page: name it, choose its vaults, **Read only** or **Read and write**, and when it expires, then **Create token**. Copy the token, then choose **Done**. It is shown once.

## Check that it connected

The **Connect** page says **Connected** and names a connection used in the last 15 minutes, with when and from which client. If none was, it says so. Reload it after the last step. A revoked or expired connection never counts.

## Scope is fixed

A connection's vaults and access are fixed when it is made. To change them, revoke it and make another. "All my vaults" includes vaults you join later; ticking vaults limits it to those.

## Revoking

On the Connections page, choose **Revoke** next to it. A confirm page shows its type, vaults, access and last use; choose **Revoke** with its name to confirm. It is refused on its next request.

Only you can revoke your own, in person: no agent, token, app or CLI can revoke one (an app can still end its own connection). A vault owner can also cut a member's connection off from their vault on **Members**, without touching the member's other vaults.

When you leave a vault, or are removed, connections that reached only that vault are revoked, and the vault drops out of connections that reached several.

If one leaked, see [Rotate a leaked token](../how-to/rotate-a-leaked-token.md).

## What the Connections page shows

Live connections come first. Each shows its name, type, vaults, access, when it was last used and by which client (the name the client reports), and when it expires. Expired and revoked ones are folded under **Expired and revoked**, with when each ended, so you can still see what had access.

Tokens are stored only as hashes: a new token is shown once, when you create it, and never again.
