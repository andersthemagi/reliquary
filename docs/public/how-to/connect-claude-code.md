# Connect Claude Code

Add Reliquary to Claude Code once per computer, then sign in from Claude Code; no token to copy.

Works in the Claude Code CLI and the desktop app.

## With the plugin

The Reliquary plugin adds the connection and teaches Claude Code how to work in a vault. In a terminal, run:

```bash
claude plugin marketplace add andersthemagi/reliquary
claude plugin install reliquary@reliquary
```

Then sign in as in steps 2 to 4 below. The plugin carries no token: signing in is still yours to do.

It also adds:

- **A skill for working in a vault**: when to write and when to propose, claims, flags, and what an agent can never do (see [Agents and the ceiling](../concepts/agents.md)).
- **A brief when a session starts**, in a project whose `.reliquary.json` names a vault (the file `reliquary` CLI commands read; see [Use the CLI](use-the-cli.md)). Claude Code checks your [flags](../concepts/flags.md) for that vault, how many proposals are open and how long the oldest has waited, and the steps you hold, and tells you in a few lines.
- **A reminder after `git push`** in that project: if the work changed something the vault records, Claude Code proposes an update. It only proposes; you approve it in your Inbox.

In any other project the plugin says nothing. If you'd rather not have the brief and the reminder, uninstall the plugin and connect by hand as below.

## Steps (without the plugin)

1. Add Reliquary for your user, so every project on this computer has it:

   ```bash
   claude mcp add --transport http --scope user reliquary https://mcp.reliquary.redmage.cc/mcp
   ```

   Use the MCP URL your Connect page shows if it is different.

2. Start Claude Code and run `/mcp`. Choose **reliquary**, then **Authenticate**.
3. Your browser opens Reliquary. Sign in if you need to, then choose:
   - **All my vaults, including ones I join later**, or **Only the vaults I tick** (if you belong to more than one vault, nothing is chosen for you: see [Keep client work separate](keep-client-work-separate.md));
   - **Read only** (read, search and follow changes) or **Read and write** (also write open files and propose changes).
4. Choose **Allow**. Back in Claude Code, `/mcp` shows reliquary as connected.

Claude Code keeps the connection and refreshes it by itself.

## Check it

Ask Claude Code: `Using Reliquary, list my vaults.` It calls `list_vaults` and shows each vault with your role.

## Change or remove it

- To change which vaults or access it has: revoke it on the **Connections** page, then run `/mcp` and **Authenticate** again.
- To remove it from Claude Code: `claude plugin uninstall reliquary@reliquary` if you used the plugin, or `claude mcp remove --scope user reliquary` if you added it by hand. Also revoke it on **Connections**.

## Troubleshooting

- **`/mcp` shows reliquary as failed or needing authentication:** run **Authenticate** again. A revoked or expired connection asks you to sign in again.
- **It can't see a vault:** you ticked other vaults when you allowed it, or you aren't a member. Revoke it and connect again with the vaults you want.
- **Writes are refused:** you chose read only, or you are a viewer in that vault, or the file is canon (use a proposal). See [Canon, open and rules](../concepts/canon-and-rules.md).
