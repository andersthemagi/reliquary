# Vaults, files and folders

A vault is the container for one team, client or project: its files, its environment variables, its members and its activity log.

## Vaults

Each vault has a name, a default policy (open or canon), members with roles, and an append-only log of everything that happened in it. A member of one vault sees no trace of any other vault.

- **Create one** from Home with **New vault**. You become its owner. An agent can create one too, through `create_vault`, but only with a read-write connection that reaches all your vaults; you still own it. See [Agents and the ceiling](agents.md).
- **Rename it or change its default policy** on the vault's **Settings** page. Only an owner can, in person, and each change is logged with the previous value.
- **Vault names** are 1 to 100 characters. Tools take a vault by name or by id; if two of your vaults share a name, use the id.

## Files and folders

A file is text at a path, like `clients/acme/brief.md`. Folders are the paths' prefixes: there is nothing to create before writing `clients/acme/brief.md`. Markdown files are shown rendered; every file can be shown as plain text.

- **Every write makes a new version.** Earlier versions are kept, and the log records who wrote each one, and through which agent.
- **Open files** can be written directly by owners, editors and their agents. **Canon files** change only through a proposal that people approve. See [Canon, open and rules](canon-and-rules.md).
- **Deleting** an open file keeps its versions and logs the deletion; the path can be used again. A canon file is deleted by an approved delete proposal.
- **Erasing** a file blanks every version's text, for when something must be gone. Only an owner can, in person. See [Export, delete and erase](export-delete-erase.md).

## Reading and searching

In the web app, a vault's page is its folder tree; **Search** finds files by their words and paths. Agents use `list_files`, `read_file` and `search`, and follow changes with `changes_since` (see [MCP tools](../reference/mcp-tools.md)).

Search takes words, `"a phrase"`, `or`, and `-word` to leave a word out. It looks only at each file's current text.

## Roles

Every member has one role in a vault:

| Role | Can |
|---|---|
| Owner | everything: files, rules, members, variables in every environment, settings, export and delete |
| Editor | read, write open files, propose, review, comment, and set variables outside owners-only environments |
| Viewer | read files and proposals, and see variable names |

The full table is in [Permissions](../reference/permissions.md).
