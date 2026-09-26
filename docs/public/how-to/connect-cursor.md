# Connect Cursor

Cursor connects with an access token that it reads from an environment variable, so the token never sits in a config file.

## Steps

1. In Reliquary, open the **Connections** page (the account menu, **Tokens and connections**) and choose **New token**:
   - name it after the agent and machine, like `Cursor on my laptop`;
   - choose its vaults and **Read only** or **Read and write**;
   - choose when it expires (90 days is the default).
2. Copy the token. It is shown once.
3. Set it as `RELIQUARY_TOKEN` in the environment Cursor starts from, for example in your shell profile, then start Cursor from a new shell. Paste it in your own terminal, never in a chat:

   ```bash
   export RELIQUARY_TOKEN='paste-the-token-here'
   ```

4. Add Reliquary with the **add Reliquary to Cursor** link on your Connect page, or put this in `~/.cursor/mcp.json`:

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

5. In Cursor's MCP settings, check that reliquary is enabled and lists its tools.

## Keep the token safe

- Never paste it into a chat or a file an agent can read. Anything an agent can read, it can leak.
- If it leaks, revoke it: see [Rotate a leaked token](rotate-a-leaked-token.md).
- It expires on the date you chose; make a new one then.
