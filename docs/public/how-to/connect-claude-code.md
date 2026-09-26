# Connect Claude Code

Add Reliquary to Claude Code once per computer, then sign in from Claude Code; no token to copy.

Works in the Claude Code CLI and the desktop app.

## Steps

1. Add Reliquary for your user, so every project on this computer has it:

   ```bash
   claude mcp add --transport http --scope user reliquary https://mcp.reliquary.redmage.cc/mcp
   ```

   Use the MCP URL your Connect page shows if it is different.

2. Start Claude Code and run `/mcp`. Choose **reliquary**, then **Authenticate**.
3. Your browser opens Reliquary. Sign in if you need to, then choose:
   - **All my vaults, including ones I join later**, or **Only the vaults I tick**;
   - **Read only** (read, search and follow changes) or **Read and write** (also write open files and propose changes).
4. Choose **Allow**. Back in Claude Code, `/mcp` shows reliquary as connected.

Claude Code keeps the connection and refreshes it by itself.

## Check it

Ask Claude Code: `Using Reliquary, list my vaults.` It calls `list_vaults` and shows each vault with your role.

## Change or remove it

- To change which vaults or access it has: revoke it on the **Connections** page, then run `/mcp` and **Authenticate** again.
- To remove it from Claude Code: `claude mcp remove --scope user reliquary`. Also revoke it on **Connections**.

## Troubleshooting

- **`/mcp` shows reliquary as failed or needing authentication:** run **Authenticate** again. A revoked or expired connection asks you to sign in again.
- **It can't see a vault:** you ticked other vaults when you allowed it, or you aren't a member. Revoke it and connect again with the vaults you want.
- **Writes are refused:** you chose read only, or you are a viewer in that vault, or the file is canon (use a proposal). See [Canon, open and rules](../concepts/canon-and-rules.md).
