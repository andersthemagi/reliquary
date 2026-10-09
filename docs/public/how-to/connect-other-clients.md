# Connect another client

Any MCP client that speaks Streamable HTTP can connect: with OAuth sign-in if it supports it, or with an access token in a header.

## With sign-in (OAuth)

Give the client the MCP URL, `https://mcp.reliquary.redmage.cc/mcp` (your Connect page shows the one to use). A client that follows the MCP authorization spec finds Reliquary's sign-in from the URL's first 401 answer, sends you to consent, and keeps its own refreshed tokens.

Reliquary identifies clients by a Client ID Metadata Document (an https URL); there is no dynamic client registration.

## With a token

1. On the **Connect** page, choose the **Other clients** tab and choose **Create read-only token** (or **Create read and write token**). It reaches all your vaults and expires in 90 days; for some vaults or another expiry, choose **use the full form**. If you belong to more than one vault, the tab takes you to the full form, where nothing is chosen for you: see [Keep client work separate](keep-client-work-separate.md). The page that follows shows the token once.
2. Configure the client with the MCP URL and this header, reading the token from wherever the client keeps secrets:

   ```text
   Authorization: Bearer <your token>
   ```

Tokens are for clients without sign-in: headless agents like Hermes, scripts, CI. Keep them out of chats and out of files an agent can read.

## Check it

The page that shows your token also gives a test command, for bash or zsh (`curl`) and for PowerShell (`Invoke-RestMethod`). It sets the token in your terminal, then calls `tools/list`; a JSON answer that lists tools means the token works. The tools are in [MCP tools](../reference/mcp-tools.md). `list_vaults` returns the vaults the token reaches, with your role in each.

Once the client has used the token, the **Connect** page says **Connected** and names it, for 15 minutes. Reload the page to see it.

## Environment variables

MCP never carries variable values. For a program that needs them, use the CLI: `reliquary run` or `reliquary env pull`. See [Use the CLI](use-the-cli.md).
