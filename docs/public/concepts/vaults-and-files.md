# Vaults, files and folders

A vault is the container for one team, client or project: its files, its environment variables, its members and its activity log.

## Vaults

Each vault has a name, a default policy (open or canon), members with roles, and an append-only log of everything that happened in it. A member of one vault sees no trace of any other vault.

- **Create one** from Home with **New vault**, blank or from a [template](templates.md). You become its owner. An agent can create one too, through `create_vault`, but only with a read-write connection that reaches all your vaults; you still own it. See [Agents and the ceiling](agents.md).
- **Rename it or change its default policy** on the vault's **Settings** page. Only an owner can, in person, and each change is logged with the previous value.
- **Vault names** are 1 to 100 characters. Tools take a vault by name or by id; if two of your vaults share a name, use the id.

## Files and folders

A file is text at a path, like `clients/acme/brief.md`. Folders are the paths' prefixes: there is nothing to create before writing `clients/acme/brief.md`. Markdown files are shown rendered; every file can be shown as plain text. A table in rendered markdown scrolls sideways on a narrow screen rather than spilling off it.

- **Every write makes a new version.** Earlier versions are kept, and the log records who wrote each one, and through which agent.
- **Open files** can be written directly by owners, editors and their agents. **Canon files** change only through a proposal that people approve. See [Canon, open and rules](canon-and-rules.md).
- **Not overwriting a teammate.** The web editor remembers the version it loaded. If someone else saves first, your Save doesn't silently replace their work: it shows a conflict page with their new text and your own edit, still unsaved, so you can compare before trying again. Agents get the same guard over MCP: `read_file`'s `version:` line, passed back as `expected_version` to `write_file` or `delete_file`, refuses a write or delete against a version that's no longer current, naming the current one and who wrote it.
- **Deleting** an open file keeps its versions and logs the deletion; the path can be used again. In the web app it's on the file's **More** menu, **Delete file**, behind a confirm page. A canon file is deleted by an approved delete proposal (**More**, **Propose deleting**).
- **Erasing** a file blanks every version's text, for when something must be gone. Only an owner can, in person. See [Export, delete and erase](export-delete-erase.md).

A path works the same on every system, so an exported vault opens safely on Windows too. A new path can't have:

- a backslash (`\`): use `/` between folders;
- any of `: * ? " < > |`;
- a file or folder name ending in a dot or a space;
- a file or folder named `CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9` or `LPT1` to `LPT9`, with or without an extension (`con.md` too; `console.md` is fine).

The refusal says which rule the path broke. In the web app the same form comes back with that reason, ending in its reference, and everything you typed still in it, so nothing needs retyping. A file saved before these rules keeps its path and can still be edited, proposed and deleted; an export puts it under `renamed/` (see [Export, delete and erase](export-delete-erase.md)).

## Reading and searching

In the web app, a vault's page is its folder tree: each folder and file shows whether it is canon or open, the top says what files without a rule are, and a folder's `README.md` is shown under its list. **Search** finds files by their words and paths. **New file** in a folder follows that folder's rule: in a canon folder it asks why and becomes a proposal. In an open folder it never writes over a file that is already there: it says so and keeps what you typed, so open that file and choose **Edit**, or pick another path.

On a phone, a vault's sections (**Files**, **Proposals**, **Threads**, **Tasks**, **Changes**, **Variables**, **Links**, **Settings**) are tabs at the top, and the folder tree is under **Browse files**. Agents use `list_files`, `read_file` and `search`, and follow changes with `changes_since` (see [MCP tools](../reference/mcp-tools.md)).

Search takes words, `"a phrase"`, `or`, and `-word` to leave a word out. It looks only at each file's current text.

## Diagnostics

**Settings**, then **Diagnostics**, is for working out why something happened. It has a tab for [Flags](flags.md) (what changed since you were last told), one for [Claims](claims.md) (who is working on which path) and one for the **Log**, every event the vault recorded (see [Changes and the log](activity.md)). Most people never need it, so none of them is in the vault's main navigation. What people changed, in plain words, is under **Changes**. The **Diagnostics** page itself only lists its tabs; it changes nothing.

## Roles

Every member has one role in a vault:

| Role | Can |
|---|---|
| Owner | everything: files, rules, members, variables in every environment, settings, export and delete |
| Editor | read, write open files, propose, review, comment, and set variables outside owners-only environments |
| Viewer | read files and proposals, and see variable names |

The full table is in [Permissions](../reference/permissions.md).
