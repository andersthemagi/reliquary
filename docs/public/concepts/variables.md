# Environment variables

A vault holds shared environment variables per environment, delivered to your programs by the CLI and never to a model.

## Environments

Every vault starts with three environments: `development`, `preview` and `production`. `production` is owners-only: only owners set or read its values. Owners can add environments (up to 20 a vault, owners-only or not), rename them, and delete them by typing the name, on the Variables page's **Environments** page. Deleting an environment destroys its values.

## Who can do what

| Who | See names and who set them | Set, rotate, delete | Get a value |
|---|---|---|---|
| Owner, in the web app | yes | every environment | reveal one at a time, or through the CLI |
| Editor, in the web app | yes | not in owners-only environments | same, not in owners-only environments |
| Viewer | yes | no | no |
| Any agent, over MCP | yes, with `list_variables` | no | never |
| The CLI, signed in as you | the vaults and environments it may read | no; it can send a `.env` for a person to apply | a whole environment, within your role |

The database enforces this table, not the web app. See [Agents and the ceiling](agents.md).

## How a value leaves Reliquary

Only two ways:

1. **You reveal it** in the web app: **Reveal** next to one value. The value is in that one response, never in a URL, a redirect or a later page, and the reveal is logged.
2. **The CLI reads it** for `reliquary run` (into one process's environment, nothing on disk) or `reliquary env pull` (into a `.env` file that git ignores, mode 600). Each read is logged, naming every variable read. See [Use the CLI](../how-to/use-the-cli.md).

No MCP tool, log line, activity event, error message or email carries a value.

## Setting values

On the vault's **Variables** page, **Add a variable**: a name, an environment and a value. **Rotate** replaces a value (its version goes up by one), and **Delete** removes it after a confirm step. To bring in many at once, paste a `.env` or push one from the CLI: see [Imports](imports.md).

- Names are shell-style: a letter or `_`, then letters, digits or `_`, up to 128 characters. Names that change how programs start, like `PATH`, `NODE_OPTIONS`, anything starting `LD_` or `NPM_CONFIG_`, Windows' `COMSPEC` and `PATHEXT`, or trust settings like `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`, are refused. A variable that already has such a name stays readable but can't be set again.
- A value is text up to 64 KiB, without NUL characters. A vault holds at most 1000 variables.

## The access log

**Variables**, **Access log** lists every set, rotate, delete, read, reveal and refused attempt: who, when, which variables, and from which client (the web app, the CLI, or an agent). Owners and editors can read it; viewers can't. Nobody can edit or delete a row, including the owner and Reliquary's operator. It is kept as long as the vault exists.

Next to each value, the Variables page shows who has read or revealed it since it was last set, with a link to revoke their sign-in. When you rotate a leaked value, that tells you whose copies are old.

## Encryption

Values are encrypted by the web app with AES-256-GCM before the database sees them, under a key kept outside the database. Each ciphertext is bound to its vault, environment and name, so a value moved to another slot fails to decrypt instead of leaking. See [Security model](security.md).

## Stated plainly

- **Agents can read what reaches them.** An agent that can run commands in a process holding a variable can read it. `reliquary run` limits exposure to one process; it doesn't stop that process. Prefer scoped, short-lived credentials where your provider offers them.
- **The operator can decrypt.** Someone with both the database and the web app's key, which means Reliquary's operator, could technically decrypt values. Client-side encryption, where only your members hold keys, is on the [roadmap](../roadmap.md) as considered.
