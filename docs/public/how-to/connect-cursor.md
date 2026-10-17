# Connect Cursor

Cursor connects with an access token that it reads from an environment variable, so the token never sits in a config file.

## Steps

1. In Reliquary, open **Connect** in the top bar and choose the **Cursor** tab. Name the token after the agent and machine, like `Cursor on my laptop`, then choose **Create read-only token**, or **Create read and write token** if the agent should also write files and propose changes. The token reaches all your vaults and expires in 90 days. For some vaults or another expiry, choose **use the full form** under the buttons. If you belong to more than one vault, the tab shows **Choose vaults and create a token** instead, which opens the full form, where nothing is chosen for you: see [Keep client work separate](keep-client-work-separate.md).
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

## Troubleshooting

- **reliquary fails with `No token: send Authorization: Bearer <token>`:** Cursor didn't get `RELIQUARY_TOKEN`, usually because it was started from the dock or a menu, not from the shell where you set it. Quit Cursor and start it from that shell.
- **"The token isn’t live: it is unknown, expired or revoked, or was issued for another resource", or a tool call says "This token was revoked or expired during the request. Reconnect.":** the token expired or was revoked. Make a new one on the **Connect** page, set it as `RELIQUARY_TOKEN` and start Cursor again. If it leaked, see [Rotate a leaked token](rotate-a-leaked-token.md).
- **It can't see a vault:** the token's vaults were chosen without it, or you aren't a member. Make a new token that reaches it.
- **Writes are refused:** the token is read only, or you are a viewer in that vault, or the file is canon (use a proposal). See [Canon, open and rules](../concepts/canon-and-rules.md).

Any other refusal says what was being done, where and why, with a reference: see [Errors and reference IDs](../reference/errors.md).
