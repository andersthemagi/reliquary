# Use the CLI

Sign a computer in once, then run commands with a vault's variables, write them to a gitignored `.env`, or send a `.env` for approval.

The CLI is `@reliquary-ai/cli`. It needs Node 20 or later. Run it with `npx @reliquary-ai/cli <command>`, or install it once with `npm install -g @reliquary-ai/cli` and run `reliquary <command>`. Every command and option is in the [CLI reference](../reference/cli.md).

## Sign in

```bash
reliquary login
```

Your browser opens Reliquary's consent page for the Reliquary CLI. Choose which vaults it may read and whether it may send `.env` files for approval, then **Allow**. The CLI lists the vaults and environments it can now read.

- On a machine without a browser, `reliquary login --no-browser` prints the link to open elsewhere.
- The sign-in shows on the **Connections** page as Reliquary CLI. It can read variable values within your role; it can't read files or change anything else.
- Signing in again replaces the previous sign-in on this computer.

## Run a command with the variables

```bash
reliquary run --vault "My project" --env development -- npm run dev
```

Everything after `--` is the command. It starts directly (no shell) with your environment plus the vault's variables, and nothing is written to disk. It exits with the command's own exit code. If a variable replaces one already in your environment, the CLI says which, by name.

On Windows, `npm`, `npx` and `pnpm` work as they are: the CLI starts `.cmd` shims through `cmd.exe` with each argument quoted. It refuses an argument with a double quote, a `%` or a line break for them, since `cmd.exe` would act on it; see [the reference](../reference/cli.md#reliquary-run).

## Write a .env file

```bash
reliquary env pull --vault "My project" --env development
```

This writes `.env` (or `--file <path>`) with mode 600, one `NAME="value"` per line. It writes only to a file that git ignores inside a git repository: a file that isn't ignored, is tracked, or is outside any repository is refused, and nothing is written. Add `.env` to `.gitignore` first. Outside a repository, pass `--outside-repo` to say you know.

Prefer `run`: a file on disk is readable by anything running as you, including agents.

## Send a .env for approval

```bash
reliquary env push --vault "My project" --env development --file .env
```

The CLI reads the file, lists any lines it can't take and why, sends the rest, and prints the names and an approval link. Nothing is set until an owner or editor applies it in the web app, within 24 hours. Add `--wait` to wait for the decision. See [Move a .env into a vault](move-env-into-vault.md).

## Set defaults for a project

Commit a `.reliquary.json` at the project's root so nobody needs `--vault` or `--env`. It holds ids and names, never values:

```json
{ "vault": "<vault id>", "environment": "development" }
```

`reliquary vaults` prints each vault's id. The CLI finds `.reliquary.json` from the current directory upwards. Flags win over the file.

## Choose the vault, environment and server

- **Vault:** `--vault` takes a name or an id, else `vault` in `.reliquary.json`, else the only vault you can reach. A name two vaults share is an error that lists their ids.
- **Environment:** `--env`, else `environment` in `.reliquary.json`, else `development`. Editors can't read owners-only environments like `production`; viewers read none.
- **Server:** `--server`, else the `RELIQUARY_URL` environment variable, else `server` in `.reliquary.json`, else `https://app.reliquary.redmage.cc`.

## Sign out

```bash
reliquary logout
```

This revokes the sign-in on the server and forgets it. You can also revoke it on the **Connections** page; the next command then asks you to run `reliquary login`.

## Where the sign-in is kept

In your system's keychain: the macOS Keychain, your Linux keyring (through `secret-tool`), or on Windows a file encrypted to your Windows account. Where there's none, in `credentials.json` in your config directory (`~/.config/reliquary` on Linux and macOS, `%APPDATA%\reliquary` on Windows, or `RELIQUARY_CONFIG_DIR`), readable only by you. `reliquary login` says which. To choose, set `RELIQUARY_CREDENTIALS` to `file` or `keychain`; details in [the reference](../reference/cli.md#where-sign-ins-are-kept).

A sign-in from before the keychain keeps working and moves into it the next time it's refreshed. No command prints a token or a value.
