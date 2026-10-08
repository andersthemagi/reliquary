# Connect Cursor

Cursor connects with an access token that it reads from an environment variable, so the token never sits in a config file.

## Steps

1. In Reliquary, open **Connect** in the top bar and choose the **Cursor** tab. Name the token after the agent and machine, like `Cursor on my laptop`, then choose **Create read-only token**, or **Create read and write token** if the agent should also write files and propose changes. The token reaches all your vaults and expires in 90 days. For some vaults or another expiry, choose **use the full form** under the buttons.
2. Copy the steps on the page that follows. The token is in them, and it is shown once.
3. Set it as `RELIQUARY_TOKEN` in the environment Cursor starts from, then start Cursor from that shell. The page gives the command for bash or zsh and for PowerShell, to paste in your own terminal, never in a chat. In bash or zsh:

   ```bash
   export RELIQUARY_TOKEN='paste-the-token-here'
   ```

4. Add Reliquary with the **Add Reliquary to Cursor** link on that page, or put this in `~/.cursor/mcp.json`:

   ```json
   {
     "mcpServers": {
       "reliquary": {
         "url": "https://mcp.reliquary.redmage.cc/mcp",
         "headers": {
           "Authorization": "Bearer ${env:RELIQUARY_TOKEN}"
         }
       }
     }
   }
   ```

5. In Cursor's MCP settings, check that reliquary is enabled and lists its tools. Then reload the Connect page: once Cursor has used the token, the page says **Connected** and names it.

## Keep the token safe

- Never paste it into a chat or a file an agent can read. Anything an agent can read, it can leak.
- If it leaks, revoke it: see [Rotate a leaked token](rotate-a-leaked-token.md).
- It expires on the date you chose; make a new one then.
