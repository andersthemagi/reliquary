# Connect Codex

Add the Reliquary plugin to Codex once per computer, then sign in from Codex; no token to copy.

## With the plugin

The Reliquary plugin adds the connection and teaches Codex how to work in a vault.

1. In a terminal, add the Reliquary marketplace:

   ```bash
   codex plugin marketplace add andersthemagi/reliquary
   ```

2. Start Codex, run `/plugins`, choose **Reliquary** and install it. Then start a new session.
3. Sign in: in a terminal, run `codex mcp login reliquary`. Your browser opens Reliquary. Sign in if you need to, then choose:
   - **All my vaults, including ones I join later**, or **Only the vaults I tick** (if you belong to more than one vault, nothing is chosen for you: see [Keep client work separate](keep-client-work-separate.md));
   - **Read only** (read, search and follow changes) or **Read and write** (also write open files and propose changes).
4. Choose **Allow**. Back in Codex, `/mcp` shows reliquary as connected.
5. Run `/hooks` and trust the Reliquary hooks. Codex skips a plugin's hooks until you do, and asks again when an update changes them.

The plugin carries no token: signing in is still yours to do. Codex keeps the connection and refreshes it by itself.

It also adds:

- **A skill for working in a vault**: when to write and when to propose, claims, flags, and what an agent can never do (see [Agents and the ceiling](../concepts/agents.md)).
- **A brief when a session starts**, in a project whose `.reliquary.json` names a vault (the file `reliquary` CLI commands read; see [Use the CLI](use-the-cli.md)). Codex checks your [flags](../concepts/flags.md) for that vault, how many proposals are open and how long the oldest has waited, and the steps you hold, and tells you in a few lines.
- **A reminder after `git push`** in that project: if the work changed something the vault records, Codex proposes an update. It only proposes; you approve it in your Inbox.

In any other project the plugin says nothing.

## Without the plugin

Add the connection by hand, then sign in:

```bash
codex mcp add reliquary --url https://mcp.reliquary.redmage.cc/mcp
codex mcp login reliquary
```

Use the MCP URL your Connect page shows if it is different. Sign in and choose as in steps 3 and 4 above.

## Check it

Ask Codex: `Using Reliquary, list my vaults.` It calls `list_vaults` and shows each vault with your role.

## Change or remove it

- To change which vaults or access it has: revoke it on the **Connections** page, then run `codex mcp login reliquary` again.
- To remove it from Codex: uninstall the plugin in `/plugins`, or run `codex mcp remove reliquary` if you added it by hand. Also revoke it on **Connections**.

## Troubleshooting

- **`/mcp` shows reliquary as needing sign-in:** run `codex mcp login reliquary`. A revoked or expired connection asks you to sign in again.
- **No brief when a session starts:** check that the project's `.reliquary.json` names a vault and that you trusted the hooks in `/hooks`.
- **It can't see a vault:** you ticked other vaults when you allowed it, or you aren't a member. Revoke it and connect again with the vaults you want.
- **Writes are refused:** you chose read only, or you are a viewer in that vault, or the file is canon (use a proposal). See [Canon, open and rules](../concepts/canon-and-rules.md).

Any other refusal says what was being done, where and why, with a reference: see [Errors and reference IDs](../reference/errors.md).
