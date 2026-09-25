# CLI

Every `reliquary` command and option, with exit codes, environment variables and the project file.

Install: `npm install -g @reliquary-ai/cli` (Node 20 or later), or prefix every command with `npx @reliquary-ai/cli`. How to use it day to day: [Use the CLI](../how-to/use-the-cli.md).

## Help

The CLI's own help, generated from its source:

<!-- generated:cli-help -->

## Commands

### reliquary login

Signs this computer in with your browser. Opens the consent page (and prints its link), where you choose the vaults the CLI may read and whether it may send `.env` files for approval. Waits up to 5 minutes, then lists the vaults and environments it can read. Signing in again revokes the previous sign-in on this computer.

| Option | Does |
|---|---|
| `--no-browser` | print the link without opening a browser, to open it on another device |
| `--server <url>` | the Reliquary server to sign in to |

### reliquary logout

Revokes this computer's sign-in on the server, then forgets it. Takes `--server <url>`.

### reliquary vaults

Prints each vault the sign-in reaches, one per line: its id, name, your role, and the environments you may read. Takes `--server <url>`.

### reliquary run

```text
reliquary run [--vault V] [--env E] -- <command> [args...]
```

Fetches one environment's variables and starts the command directly (no shell), with your environment plus the variables. Nothing is written to disk. Standard input, output and error are the command's; SIGINT, SIGTERM, SIGHUP, SIGQUIT and SIGUSR2 are passed on. A variable that replaces one already in your environment is named on stderr. Takes `--vault`, `--env` and `--server`.

Exit code: the command's own; 128 plus the signal number if a signal ended it; 127 if the command wasn't found.

On Windows:

- A bare command name is looked up on `PATH` with `PATHEXT`, like `cmd.exe` does, but not in the current directory; write `.\tool.exe` for one there.
- `.exe` and `.com` files start directly. `.cmd` and `.bat` files, like the `npm`, `npx`, `pnpm` and `yarn` shims, start through `cmd.exe /d /v:off /s /c` with every argument in double quotes, so `&`, `|`, `<`, `>`, `^` and parentheses reach the command as text. An argument holding a double quote, a `%` or a line break can't be passed to a `.cmd` or `.bat` safely, so the CLI refuses it with exit code 2 and runs nothing; run the program the shim wraps directly (for example `node <script>`) instead. Other files (`.ps1`, `.js`) are refused: run them through their interpreter.
- Variable names are case-insensitive: a variable replaces an inherited one whatever its case, and two variables whose names differ only in case are refused.
- Ctrl+C reaches the command directly, and the CLI waits for it to finish; closing the console window ends the command and everything it started.

### reliquary env pull

```text
reliquary env pull [--vault V] [--env E] [--file .env] [--outside-repo]
```

Writes one environment to a file (default `.env`), mode 600, one `NAME="value"` per line in name order, under a header saying where it came from. Backslash, double quote, newline and carriage return are escaped. Prints the names, never the values.

The file must be inside a git work tree and ignored by git; a file that isn't ignored, is tracked, or is a symbolic link is refused and nothing is written. The check runs before fetching and again before writing.

| Option | Does |
|---|---|
| `--file <path>` | the file to write (default `.env`) |
| `--outside-repo` | allow a file outside any git repository |

Also takes `--vault`, `--env` and `--server`.

### reliquary env push

```text
reliquary env push [--vault V] [--env E] [--file .env] [--wait [--timeout 15m]]
```

Sends a `.env` file's variables to the vault for approval. Nothing is set until an owner or editor applies it in the web app, within 24 hours. Lines it can't take are listed with their reasons and not sent. Prints the names (new, or replacing a value) on stderr and the approval link on stdout, never a value. The sign-in must have been allowed to send `.env` files; an editor can't push to an owners-only environment.

| Option | Does |
|---|---|
| `--file <path>` | the file to send (default `.env`; a regular file under 512 KiB) |
| `--wait` | wait until a person applies or rejects it |
| `--timeout <t>` | with `--wait`: how long, like `90s`, `15m` or `2h` (default `15m`, at most `24h`) |

Also takes `--vault`, `--env` and `--server`.

Exit code: 0 when sent (with `--wait`, when applied); 1 when refused, rejected or expired; 3 when `--wait` ran out of time first (the push stays pending).

## Options for every command

| Option | Does |
|---|---|
| `--server <url>` | the Reliquary server: https, or plain http only for `127.0.0.1`, `[::1]` or `localhost` |
| `--vault <v>` | a vault's name or id; not needed if you can reach only one |
| `--env <e>` | an environment's name; default `development` |
| `-h`, `--help` | the help above |
| `-v`, `--version` | the CLI's version |

## How the vault, environment and server are chosen

| Setting | First of |
|---|---|
| Server | `--server`, `RELIQUARY_URL`, `server` in `.reliquary.json`, `https://app.reliquary.redmage.cc` |
| Vault | `--vault`, `vault` in `.reliquary.json`, the only vault the sign-in reaches |
| Environment | `--env`, `environment` in `.reliquary.json`, `development` |

A vault name that two of your vaults share is an error listing their ids.

## .reliquary.json

A project file the CLI finds from the current directory upwards. Commit it; it holds ids and names, never values:

```json
{ "server": "https://app.reliquary.redmage.cc", "vault": "<vault id>", "environment": "development" }
```

All three keys are optional.

## Environment variables

| Variable | Does |
|---|---|
| `RELIQUARY_URL` | the server, when `--server` isn't given |
| `RELIQUARY_CONFIG_DIR` | where sign-ins are kept, instead of the default config directory |
| `RELIQUARY_NO_BROWSER` | when set, `login` prints the link without opening a browser |
| `RELIQUARY_CREDENTIALS` | `file` or `keychain`: where sign-ins are kept, instead of choosing by itself |

## Where sign-ins are kept

One sign-in per server, in the operating system's keychain when there is one:

| System | Where |
|---|---|
| macOS | the login Keychain, as `reliquary-cli` items, through `/usr/bin/security` |
| Linux | your keyring through the Secret Service (GNOME Keyring, KWallet), with `secret-tool` from libsecret, when it's installed and a keyring answers |
| Windows | `credentials.dpapi` in the config directory, encrypted with DPAPI so only your Windows account on this computer can read it |

Without one (a server, a container, Linux without `secret-tool`), sign-ins are kept in `credentials.json` in the config directory, mode 600 in a mode 700 directory. `reliquary login` says which it used. The config directory is `RELIQUARY_CONFIG_DIR`, else `%APPDATA%\reliquary` on Windows, else `$XDG_CONFIG_HOME/reliquary`, else `~/.config/reliquary`; it also holds the lock file that keeps two commands from refreshing at once.

`RELIQUARY_CREDENTIALS=file` always uses the file. `RELIQUARY_CREDENTIALS=keychain` always uses the keychain, and fails if none answers instead of falling back to the file.

A token never goes into a command's arguments, where other programs could see it: the keychain tools get it on standard input.

A sign-in made before the keychain, in `credentials.json`, keeps working. The next time it changes (a refresh within the hour, a new `login`, or `logout`), it moves into the keychain and out of the file.

## Exit codes and errors

| Code | Means |
|---|---|
| 0 | done |
| 1 | an error, in a plain sentence on stderr starting `reliquary:` |
| 2 | a usage error (an unknown command or option, a missing value, an argument `run` can't pass to a `.cmd` on Windows) |
| 3 | `env push --wait` ran out of time |
| other | `run` passes on its command's exit code |

Common errors: your sign-in was revoked or expired (run `reliquary login`); the keychain is locked or doesn't answer (unlock it, or set `RELIQUARY_CREDENTIALS=file`); your role can't read that environment; no such vault or environment for this sign-in; the server has no key for variables. No error prints a value, a token or a server response.
