# Self-host Reliquary

Run Reliquary on your own server with Docker Compose: the web app, the MCP endpoint, Postgres and Supabase Auth, with HTTPS from Caddy.

Self-hosting is a preview. The license for running Reliquary's server yourself hasn't been published yet: until it is, ask Red Mage before running it for anything but a trial. The CLI is MIT.

## What you need

- A Linux server with Docker and its Compose plugin, or Podman with `podman compose`. 2 GB of memory is enough to start.
- A checkout of Reliquary's source on that server.
- An SMTP server that can send email: sign-in codes go out through it.
- For HTTPS: two hostnames pointing at the server, one for the app and one for MCP (for example `app.example.com` and `mcp.example.com`), and ports 80 and 443 open.

## What runs

| Service | What it does |
|---|---|
| `db` | Postgres 17. Its data is in the `db-data` volume. Never published outside the stack. |
| `auth` | Supabase Auth: email codes and sessions. Only the web app talks to it. |
| `db-init`, `migrate` | Run once on every start: prepare the database, then apply Reliquary's migrations. |
| `web` | The web app: sign-in, vaults, review, variables, the docs. |
| `mcp` | The MCP endpoint your agents connect to. |
| `caddy` | Optional (profile `caddy`): HTTPS certificates from Let's Encrypt, renewed on its own. |

Everyone on a self-hosted instance has no plan limits: any number of vaults, people and storage. See [Plans and limits](../concepts/plans-and-limits.md).

## Set it up

1. From the checkout, write the settings file. Use your own hostnames and SMTP server:

   ```sh
   PUBLIC_URL=https://app.example.com \
   MCP_RESOURCE=https://mcp.example.com/mcp \
   SMTP_HOST=smtp.example.com SMTP_PORT=587 SMTP_SENDER=reliquary@example.com \
   ACME_EMAIL=you@example.com \
     deploy/setup.sh
   ```

   This writes `deploy/compose/.env` (readable only by you) and generates every secret in it: the database passwords, the key that signs sessions and the key that encrypts variables. It prints the names of what it set, never a value. Run it again at any time: it never replaces a secret that is already there.

2. Put your SMTP user name and password in `deploy/compose/.env` (`SMTP_USER` and `SMTP_PASS`) with an editor, so they don't land in your shell history.

3. Keep a copy of `deploy/compose/.env` in a password manager. Without `VARIABLES_KEYS`, no stored variable can ever be read again. Never commit it or paste it anywhere.

4. Start it, with HTTPS:

   ```sh
   cd deploy/compose
   docker compose --profile caddy up -d --build
   ```

   With Podman, use `podman compose` instead of `docker compose`. The first start builds the two images and takes a few minutes.

5. Make the first account, yours:

   ```sh
   docker compose run --rm owner you@example.com
   ```

6. Open your `PUBLIC_URL`, enter that address, and sign in with the code from the email.

Reliquary is invite-only there too: add people from a vault's **Settings**, **Members**. See [Invite someone](invite-someone.md). To make an account without an invite, run the `owner` command again with their address.

## Connect your agents

Your MCP URL is your `MCP_RESOURCE`, for example `https://mcp.example.com/mcp`. Use it wherever the guides say `https://mcp.reliquary.redmage.cc/mcp`: [Connect Claude Code](connect-claude-code.md), [Connect another client](connect-other-clients.md).

For the CLI, name your server once: `reliquary login --server https://app.example.com`. See [Use the CLI](use-the-cli.md).

## Try it on one machine

Without hostnames or HTTPS, for a look around on your own computer:

```sh
PUBLIC_URL=http://127.0.0.1:8790 MCP_RESOURCE=http://127.0.0.1:8787/mcp \
SMTP_HOST=smtp.example.com SMTP_SENDER=reliquary@example.com \
  deploy/setup.sh
cd deploy/compose
docker compose up -d --build
docker compose run --rm owner you@example.com
```

Then open `http://127.0.0.1:8790`. Over plain http, session cookies can't be marked secure, so use this for a trial only.

## Behind your own proxy

Leave out `--profile caddy`. The web app listens on `127.0.0.1:8790` and MCP on `127.0.0.1:8787` (change `WEB_BIND` and `MCP_BIND` in `.env`). Your proxy must end TLS for both hostnames. Set `TRUST_PROXY_IP=1` only if it overwrites the `X-Real-IP` header with the client's address; rate limits count by it.

## Upgrade

```sh
git pull
cd deploy/compose
docker compose --profile caddy up -d --build
```

Every start applies the migrations the database hasn't had yet, each in one transaction, and nothing else. To run them on their own: `docker compose run --rm migrate`.

## Back up

The data is in the `db-data` volume. A dump of the whole database:

```sh
cd deploy/compose
docker compose exec -T db pg_dump -U postgres -Fc postgres > reliquary.dump
```

Keep dumps with the same care as `.env`: they hold every file and every encrypted variable. A vault's own export (its **Settings**) is a readable copy of its files, without variable values. See [Export, delete and erase](../concepts/export-delete-erase.md).

## Stop or remove it

- Stop: `docker compose --profile caddy down`. Your data stays in the volume.
- Remove everything, data included: `docker compose --profile caddy down -v`. This can't be undone.

## If something fails

- `docker compose ps -a` shows each service's state. `db-init` and `migrate` should say they exited with code 0.
- `docker compose logs web` (or `mcp`, `auth`, `migrate`) shows why a service stopped. The apps refuse to start when a setting is missing and name the setting, never its value.
- An error page or tool error ends with a reference: find it in `docker compose logs web` or `docker compose logs mcp`. See [Errors and reference IDs](../reference/errors.md).
