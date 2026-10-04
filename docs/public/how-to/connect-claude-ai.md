# Connect Claude.ai

Add Reliquary to Claude.ai as a custom connector, then sign in to Reliquary to allow it.

Custom connectors may need a paid Claude plan, and on Team and Enterprise plans an owner may have to add them.

## Steps

1. In Claude.ai, open **Settings**, **Connectors**, and choose **Add custom connector**.
2. Name it `Reliquary` and paste the MCP URL: `https://mcp.reliquary.redmage.cc/mcp` (or the one your Connect page shows).
3. Choose **Add**, then **Connect**. Claude sends you to Reliquary.
4. Sign in if you need to, choose the vaults and **Read only** or **Read and write**, and choose **Allow**. If you belong to more than one vault, nothing is chosen for you: see [Keep client work separate](keep-client-work-separate.md).

## Use it

In a chat, turn the Reliquary connector on from the tools menu, then ask, for example: `Search my Reliquary vault "My project" for the client brief.`

## Change or remove it

Revoke the connection on Reliquary's **Connections** page; Claude shows it as disconnected and you can connect again with different vaults or access. To remove the connector, delete it in Claude's **Settings**, **Connectors**.
