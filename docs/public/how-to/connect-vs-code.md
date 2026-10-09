# Connect VS Code

VS Code connects with an access token that it asks for once and keeps in its secret storage.

## Steps

1. In Reliquary, open **Connect** in the top bar and choose the **VS Code** tab. Choose **Create read-only token**, or **Create read and write token** if the agent should also write files and propose changes. The token reaches all your vaults and expires in 90 days; for some vaults or another expiry, choose **use the full form**. If you belong to more than one vault, the tab takes you to the full form, where nothing is chosen for you: see [Keep client work separate](keep-client-work-separate.md). The page that follows shows the token once, with the steps below.
2. In your project, create `.vscode/mcp.json`:

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

3. Start the server from the file (VS Code shows **Start** above it) and paste the token when asked. Then reload the Connect page: once VS Code has used the token, the page says **Connected** and names it.

The file holds no secret, so you can commit it; each person enters their own token.

## Change or remove it

Revoke the token on Reliquary's **Connections** page. To use a new one, clear the stored input in VS Code and start the server again; it asks for the token again.
