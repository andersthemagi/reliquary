# Connect ChatGPT

Add Reliquary to ChatGPT as a connector with OAuth, then sign in to Reliquary to allow it.

ChatGPT's custom connectors use developer mode, which depends on your plan and workspace settings.

## Steps

1. In ChatGPT, open **Settings**, **Apps and Connectors**, and under **Advanced** turn on **Developer mode**.
2. Create a connector. Name it `Reliquary`, paste the MCP URL `https://mcp.reliquary.redmage.cc/mcp` (or the one your Connect page shows), and choose **OAuth** authentication.
3. ChatGPT sends you to Reliquary. Sign in if you need to, choose the vaults and **Read only** or **Read and write**, and choose **Allow**.

## Use it

Turn the connector on in a chat and ask, for example: `Using Reliquary, list the open proposals in "My project".`

## Change or remove it

Revoke the connection on Reliquary's **Tokens** page, and delete the connector in ChatGPT's settings. Connect again to choose different vaults or access.
