# Env API

The HTTP API the Reliquary CLI uses to read environment variables and send pushes, for anyone building their own client.

The API lives on the web app, at `https://reliquary.redmage.cc/api/env`. It only accepts CLI sign-ins: an MCP token or connection is refused, and a CLI sign-in is refused at the MCP endpoint.

## Signing in

OAuth 2.1 against the web app, as a public client:

| | |
|---|---|
| Metadata | `GET /.well-known/oauth-authorization-server` |
| Client id | `<server>/cli/oauth-client.json` (the Reliquary CLI's own; no other client may ask for this API) |
| Resource | `<server>/api/env`, exactly, at authorize, token and refresh |
| Redirect | `http://127.0.0.1:<any port>/callback` or `http://[::1]:<any port>/callback` |
| PKCE | S256 only |
| Access token | starts `rle_`, lasts 1 hour |
| Refresh token | starts `rlr_`, rotates on every use; presenting a used one revokes the whole sign-in. The sign-in lasts at most a year |
| Revoke | `POST /oauth/revoke` with `token` and `client_id`; always 200 |

The answer to authorize carries `code`, `state` and `iss`; check that `state` is yours and `iss` is the server.

## Requests

Send `Authorization: Bearer rle_...` on every request. Anything else gets:

```text
401 {"error": "invalid_token"}
WWW-Authenticate: Bearer realm="reliquary", resource_metadata="<server>/.well-known/oauth-protected-resource/api/env"
```

Every answer is JSON, `cache-control: no-store, private`, with no CORS headers.

### GET /api/env/vaults

The vaults the sign-in reaches, each with the environments your role may read (empty for a viewer). Reads no values, and isn't in the access log.

```json
{ "vaults": [ { "id": "<uuid>", "name": "My project", "role": "owner",
                "environments": ["development", "preview", "production"] } ] }
```

### GET /api/env/`<vault id>`/`<environment>`

Every variable with a value in that environment, decrypted, in name order. Logged in the vault's access log as a read, with the names.

```json
{ "vault": "<uuid>", "environment": "development",
  "variables": { "API_KEY": "...", "DATABASE_URL": "..." } }
```

| Status | Body | When |
|---|---|---|
| 403 | `{"error": "forbidden"}` | your role can't read that environment (a viewer; an editor on an owners-only one). Logged as refused |
| 404 | `{"error": "not_found"}` | the vault isn't reachable with this sign-in, or the environment doesn't exist |
| 500 | `{"error": "decrypt_failed"}` | a value didn't decrypt; nothing is delivered, not even the others |
| 503 | `{"error": "not_configured"}` | the server has no key for variables |

### POST /api/env/`<vault id>`/`<environment>`/imports

Sends variables for a person to apply (a push). Needs a sign-in allowed to send `.env` files. JSON, at most 1 MiB:

```json
{ "variables": { "API_KEY": "...", "DATABASE_URL": "..." },
  "refused": [ { "line": 4, "name": "PATH", "reason": "changes how programs start" } ] }
```

`refused` (optional) lists lines your client didn't send, shown to the reviewer. The answer:

```json
201 { "import": "<uuid>", "status": "pending", "vault": "<uuid>", "environment": "development",
      "names": ["API_KEY", "DATABASE_URL"], "overwrites": ["API_KEY"], "expires_at": "...",
      "url": "<server>/v/<vault>/variables/imports/<import>" }
```

Errors: 400 `invalid_request` (not JSON, a bad or refused name, an empty or oversized value; never echoed), 403 `forbidden` or `push_not_allowed`, 404 `not_found`, 413 `too_large`, 415 `unsupported_media_type`, 429 `rate_limited`, 503 `not_configured`.

### GET /api/env/imports/`<import id>`

The push's status, for the person who sent it: `pending`, `applied`, `rejected` or `expired`.

```json
{ "import": "<uuid>", "status": "pending", "environments": ["development"],
  "names": ["API_KEY"], "expires_at": "...", "decided_at": null }
```

## Other methods

Other methods get 405. Names follow the rules in [Environment variables](../concepts/variables.md#setting-values); limits are in [Limits](limits.md).
