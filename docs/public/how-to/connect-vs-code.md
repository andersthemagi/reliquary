# Connect VS Code

VS Code connects with an access token that it asks for once and keeps in its secret storage.

## Steps

1. In Reliquary, open the **Connections** page (the account menu, **Tokens and connections**), choose **New token** and create a token with the vaults and access you want. Copy it; it is shown once.
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

3. Start the server from the file (VS Code shows **Start** above it) and paste the token when asked.

The file holds no secret, so you can commit it; each person enters their own token.

## Change or remove it

Revoke the token on Reliquary's **Connections** page. To use a new one, clear the stored input in VS Code and start the server again; it asks for the token again.
