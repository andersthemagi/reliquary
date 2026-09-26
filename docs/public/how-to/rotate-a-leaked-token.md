# Rotate a leaked token

If an access token, a connection or a CLI sign-in may have leaked, revoke it, check what it did, and make a new one.

A token has leaked if it was pasted into a chat, committed, printed where an agent could read it, or seen by someone who shouldn't have it. Treat "maybe" as yes.

## 1. Revoke it

1. In the web app, open the account menu at the top right, then **Tokens and connections**.
2. Find it by name, vaults and last use, and choose **Revoke**.

It stops working on its next request. Only you can revoke your own tokens, in person; a vault owner can also cut any member's connection off from their vault on **Settings**, **Members**.

For a CLI sign-in on a computer you still have, `reliquary logout` does the same and forgets it there.

## 2. Check what it did

- **Activity**: filter by agent, or by the vaults it reached, for the time since it leaked. Every write, proposal and comment it made is there, attributed to it.
- **Variables**, **Access log** in each vault: a CLI sign-in's reads are logged with the variables it read. An MCP token or connection can't read values at all.
- **Tokens**: its last use and the client that used it.

If it wrote to open files, look at their History and restore anything wrong with a new write. Canon files changed only with a person's approval.

## 3. Make a new one

- **Claude Code, Claude.ai, ChatGPT:** connect again (for Claude Code, `/mcp`, **Authenticate**).
- **Cursor, VS Code and other token clients:** create a new token on **Tokens** and put it where the client reads it (see [Connect Cursor](connect-cursor.md) and [Connect VS Code](connect-vs-code.md)).
- **The CLI:** `reliquary login`.

Keep the new one out of chats and files an agent can read.

## If a variable's value leaked

That is a different secret: rotate it at its provider, then set the new value on the vault's **Variables** page with **Rotate**. The Variables page shows who read or revealed the old value since it was set. See [Environment variables](../concepts/variables.md#the-access-log).
