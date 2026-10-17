# Connect VS Code

VS Code connects with an access token that it asks for once and keeps in its secret storage.

## Steps

1. In Reliquary, open **Connect** in the top bar and choose the **VS Code** tab. Name the token after the agent and machine, like `VS Code on my laptop`, then choose **Create read-only token**, or **Create read and write token** if the agent should also write files and propose changes. The token reaches all your vaults and expires in 90 days; for some vaults or another expiry, choose **use the full form**. If you belong to more than one vault, the tab shows **Choose vaults and create a token** instead, which opens the full form, where nothing is chosen for you: see [Keep client work separate](keep-client-work-separate.md). The page that follows shows the token once, with the steps below.
2. Choose **Add Reliquary to VS Code** on that page (or **Add Reliquary to VS Code Insiders**) and confirm the install when VS Code asks. The link carries the server's address and a prompt for the token, never the token itself. If the link doesn't open, create `.vscode/mcp.json` in your project instead:

   ```json
   {
     "inputs": [
       {
         "type": "promptString",
         "id": "reliquary-token",
         "description": "Reliquary access token",
         "password": true
       }
     ],
     "servers": {
       "reliquary": {
         "type": "http",
         "url": "https://mcp.reliquary.redmage.cc/mcp",
         "headers": {
           "Authorization": "Bearer ${input:reliquary-token}"
         }
       }
     }
   }
   ```

3. If you made the file, start the server from it (VS Code shows **Start** above it). Either way, paste the token when VS Code asks. Then reload the Connect page: once VS Code has used the token, the page says **Connected** and names it.

Neither the link nor the file holds a secret, so you can commit the file; each person enters their own token.

## Change or remove it

Revoke the token on Reliquary's **Connections** page. To use a new one, clear the stored input in VS Code and start the server again; it asks for the token again.

## Troubleshooting

- **The server fails with `No token: send Authorization: Bearer <token>`:** VS Code sent no token, usually because its prompt was dismissed. Start the server again and paste the token when asked.
- **"The token isn’t live: it is unknown, expired or revoked, or was issued for another resource", or a tool call says "This token was revoked or expired during the request. Reconnect.":** the token expired or was revoked. Make a new one on the **Connect** page, clear the stored input and start the server again. If it leaked, see [Rotate a leaked token](rotate-a-leaked-token.md).
- **It can't see a vault:** the token's vaults were chosen without it, or you aren't a member. Make a new token that reaches it.
- **Writes are refused:** the token is read only, or you are a viewer in that vault, or the file is canon (use a proposal). See [Canon, open and rules](../concepts/canon-and-rules.md).

Any other refusal says what was being done, where and why, with a reference: see [Errors and reference IDs](../reference/errors.md).
