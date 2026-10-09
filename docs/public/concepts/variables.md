# Environment variables

A vault holds shared environment variables per environment, delivered to your programs by the CLI and never to a model.

## Environments

Every vault starts with three environments: `development`, `preview` and `production`. `production` is owners-only: only owners set or read its values, and its column on the Variables page says **Owners only**. Owners can add environments (up to 20 a vault, owners-only or not) on the Variables page's **Environments** tab, and rename or delete one from the **⋯** menu on its row; deleting asks you to type the name, and destroys its values. A name that is refused (not lowercase letters, digits, `-` and `_`, or already taken) stays in the form with the reason, so you correct it. A **Rename** or **Delete** link for an environment that is gone, renamed or deleted in another tab, takes you back to the list and says so.

## The Variables page

A vault's **Variables** page has up to four tabs:

- **Values**: a table with a row per variable and a column per environment. The name column stays in place while wide tables scroll sideways. On a phone each variable is a block with a line per environment.
- **Environments** (owners): each environment, how many values it holds and who can set it.
- **Access log** (owners and editors): see [The access log](#the-access-log).
- **Imports** (owners and editors): imports from the CLI waiting to be applied, counted on the tab. See [Imports](imports.md).

In the Values table a value reads **Set** and how long ago; hover it for who set it, the exact time and how many times it has been set. **Not set** cells offer **Set**. Each value has one **⋯** menu with **Reveal**, **Change value** and **Delete**, for people whose role lets them.

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

1. **You reveal it** in the web app: **Reveal** in one value's **⋯** menu. The value is in that one response, never in a URL, a redirect or a later page, and the reveal is logged.
2. **The CLI reads it** for `reliquary run` (into one process's environment, nothing on disk) or `reliquary env pull` (into a `.env` file that git ignores, mode 600). Each read is logged, naming every variable read. See [Use the CLI](../how-to/use-the-cli.md).

No MCP tool, log line, activity event, error message or email carries a value.

## Setting values

On the vault's **Variables** page, **Add a variable**: a name, the environments it is for and a value. Tick one environment or several: each gets its own encrypted copy, set together or not at all, so a refusal in one leaves none of them set. Environments your role can't set are shown but can't be ticked. **Change value** replaces a value, and **Delete** removes it after a confirm step. To bring in many at once, paste a `.env` with **Import .env** or send one from the CLI with `reliquary env push`: see [Imports](imports.md).

- Names are shell-style: a letter or `_`, then letters, digits or `_`, up to 128 characters. Names that change how programs start, like `PATH`, `NODE_OPTIONS`, anything starting `LD_` or `NPM_CONFIG_`, Windows' `COMSPEC` and `PATHEXT`, or trust settings like `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`, are refused. A variable that already has such a name stays readable but can't be set again.
- A value is text up to 64 KiB, without NUL characters. A vault holds at most 1000 variables.
- If the name already has a value in a ticked environment, **Add a variable** doesn't save yet: it lists those environments and offers a **Replace the existing value in** box for each. Tick them, enter the value again and save; untick an environment to keep its value. The form opened from a value's **⋯** menu says it replaces that value, so it saves at once.
- A multi-line value, such as a PEM key, is stored with `\n` line breaks, even though browsers send `\r\n` from a text box.

## The access log

The **Access log** tab on the Variables page lists every set, rotate, delete, read, reveal and refused attempt: when, who and from which client (the web app, the CLI, or an agent), what, which variables and which environment. Owners and editors can read it; viewers can't. Nobody can edit or delete a row, including the owner and Reliquary's operator. It is kept as long as the vault exists.

The row for a value that an applied [import](imports.md) set says where it came from, **from a pasted import** or **from a CLI import sent by** whoever sent it, so it doesn't look like one typed by hand.

A value that someone has read or revealed since it was last set is marked **Read since set** (or **Revealed since set**) in the Values table. Its **⋯** menu names who, and after a CLI read offers **Manage connections** to revoke the Reliquary CLI that read it. When you rotate a leaked value, that tells you whose copies are old.

## Encryption

Values are encrypted by the web app with AES-256-GCM before the database sees them, under a key kept outside the database. Each ciphertext is bound to its vault, environment and name, so a value moved to another slot fails to decrypt instead of leaking. See [Security model](security.md).

## Stated plainly

- **Agents can read what reaches them.** An agent that can run commands in a process holding a variable can read it. `reliquary run` limits exposure to one process; it doesn't stop that process. Prefer scoped, short-lived credentials where your provider offers them.
- **The operator can decrypt.** Someone with both the database and the web app's key, which means Reliquary's operator, could technically decrypt values. Client-side encryption, where only your members hold keys, is on the [roadmap](../roadmap.md) as considered.
