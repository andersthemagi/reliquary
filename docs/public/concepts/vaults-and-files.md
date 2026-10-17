# Vaults, files and folders

A vault is the container for one team, client or project: its files, its environment variables, its members and its activity log.

## Vaults

Each vault has a name, a default policy (open or canon), members with roles, and an append-only log of everything that happened in it. A member of one vault sees no trace of any other vault.

- **Create one** from Home with **New vault**, blank or from a [template](templates.md). You become its owner. An agent can create one too, through `create_vault`, but only with a read-write connection that reaches all your vaults; you still own it. See [Agents and the ceiling](agents.md).
- **Find it on Home.** **Your vaults** has the vaults you created, the ones your plan counts. **Shared with you** has the vaults others created that you belong to, each with your role; it isn't shown when there are none. Each vault is a card: its first letter on a coloured tile, its name (choose anywhere on the card to open it), its tier, its people and storage with a bar each, its open proposals and ready [tasks](tasks.md) when there are any, and when anything last happened in it. The most recently active come first. Once you're in more than six vaults, Home adds a box to filter them by name (type, then press the search button) and sorts them by **Recent**, **Name** or **Needs attention**, which puts the vaults with proposals open or tasks ready first.
- **Rename it or change its default policy** on the vault's **Settings** page. Only an owner can, in person, and each change is logged with the previous value. A name is 1 to 100 characters: a blank or longer one is refused on the form, with the reason, before the page that asks you to confirm, and what you typed stays there.
- **Vault names** are 1 to 100 characters. Tools take a vault by name or by id; if two of your vaults share a name, use the id. If **Create vault** is refused (a blank name, or a template that doesn't fit your plan's storage), the form comes back with the reason and a reference, and the name, template and default you chose are still there.

## Files and folders

A file is text at a path, like `clients/acme/brief.md`. Folders are the paths' prefixes: there is nothing to create before writing `clients/acme/brief.md`. Markdown files are shown rendered; every file can be shown as plain text. A table in rendered markdown scrolls sideways on a narrow screen rather than spilling off it.

- **Every write makes a new version.** Earlier versions are kept, and the log records who wrote each one, and through which agent.
- **Open files** can be written directly by owners, editors and their agents. **Canon files** change only through a proposal that people approve. See [Canon, open and rules](canon-and-rules.md).
- **Not overwriting a teammate.** The web editor remembers the version it loaded. If someone else saves first, your Save doesn't silently replace their work: it shows a conflict page with their new text and your own edit, still unsaved, so you can compare before trying again. If the file was deleted while you edited, Save doesn't bring it back: you get **New file** with your text in it, and **Create file** puts it back. Agents get the same guard over MCP: `read_file`'s `version:` line, passed back as `expected_version` to `write_file` or `delete_file`, refuses a write or delete against a version that's no longer current, naming the current one and who wrote it. A file someone has deleted since has no current version, so a write holding the version from before the delete is refused too and the file stays deleted; to create it again, write without `expected_version`.
- **Deleting** an open file keeps its versions and logs the deletion; the path can be used again. In the web app it's on the file's **More** menu, **Delete file**, behind a confirm page. If someone saves the file after you open that page, confirming is refused and the file stays: the page shows it as it is now, so you can look first and delete it again if you still mean to. A canon file is deleted by an approved delete proposal (**More**, **Propose deleting**).
- **Erasing** a file blanks every version's text, for when something must be gone. Only an owner can, in person. See [Export, delete and erase](export-delete-erase.md).

A path works the same on every system, so an exported vault opens safely on Windows too. A new path can't have:

- a backslash (`\`): use `/` between folders;
- any of `: * ? " < > |`;
- a file or folder name ending in a dot or a space;
- a file or folder named `CON`, `PRN`, `AUX`, `NUL`, `COM1` to `COM9` or `LPT1` to `LPT9`, with or without an extension (`con.md` too; `console.md` is fine).

The refusal says which rule the path broke. In the web app the same form comes back with that reason, ending in its reference, and everything you typed still in it, so nothing needs retyping. A file saved before these rules keeps its path and can still be edited, proposed and deleted; an export puts it under `renamed/` (see [Export, delete and erase](export-delete-erase.md)).

## A vault's overview

A vault opens on its **Overview**, the first item in its sidebar: a start-here page for someone joining mid-project. The top has **Connect an agent** and, if you can write, **New file**. Under the vault's name is one line of facts, each a link: **Nothing waiting on you** (or how many [flags](flags.md) you haven't seen), how many [tasks](tasks.md) are ready to pick up, how many members (by role when you point at it), and agent connections. An owner sees every member's connections to the vault; everyone else sees their own. Under it are short lists, each with **See all** for the full page:

- **Waiting on you**, only when something is: proposals waiting for your review, oldest first.
- **In progress**: each task someone is working on, and who: a person, or a person via their agent.
- **Recent changes**: the last five lines of **Updates**, in the same words.

Opening the overview doesn't mark flags seen; only **Updates** does. A list with nothing to show says so in one line. Under the lists is the vault's top `README.md`, if it has one. The overview is built from what the vault already records: nothing on it is generated or summarised.

## Reading and searching

In the web app, **Files** in a vault's sidebar is its folder list: each folder and file shows whether it is canon or open, the top says what files without a rule are, and a folder's `README.md` is shown under its list. The vault's name at the start of a breadcrumb goes to its **Overview**; deleting or erasing a file takes you back to **Files**. **Search** finds files by their words and paths. **New file** in a folder follows that folder's rule: in a canon folder it asks why and becomes a proposal. In an open folder it never writes over a file that is already there: it says so and keeps what you typed, so open that file and choose **Edit**, or pick another path.

On a wide screen, a vault's sidebar lists its sections in two groups: **Work** (**Overview**, **Files**, **Proposals**, **Threads**, **Tasks**, **Updates**), the ones you use every day, then **Setup** (**Variables**, **Links**, **Settings**). **Proposals** counts the open proposals, and **Updates** counts the [flags](flags.md) waiting for you. Under them, **Files** heads the folder tree, and the search box has its own search button. On a phone, one menu at the top names the section you're in, with a count when proposals or flags are waiting; open it for the same sections and groups as the sidebar, then the folder tree. Agents use `list_files`, `read_file` and `search`, and follow changes with `changes_since` (see [MCP tools](../reference/mcp-tools.md)).

Search takes words, `"a phrase"`, `or`, and `-word` to leave a word out. It looks only at each file's current text.

### Search by meaning

An agent's `search` also finds files by meaning, so a question finds the file that answers it even when they share no words: "what are we charging" finds `decisions/pricing.md` when it talks about seats and plans. Results found both ways come first. A file found by meaning alone shows the first lines of the part of it that matched.

- **How it works.** Each file's current text is turned into numbers (embeddings) by gte-small, a small model that runs inside Reliquary's database provider, Supabase. No file text goes to any other company, and Reliquary holds no key for one. The numbers are stored beside the text, readable by exactly the people who can read the file, and removed when the file changes, is deleted or erased.
- **New files.** A file is embedded by the next search of its vault, so a file written moments ago may be found by its words only until then.
- **Long files.** Meaning covers the first 10 KB or so of a file (8 parts of about 1,200 characters). The rest is still found by its words.
- **When it's unavailable,** search still answers by words, and its first line says so: `Search by meaning is unavailable right now (...; ref 1a2b3c4d). These results match words only.` The reference finds the detail in the server log ([Errors](../reference/errors.md)).
- **Where it doesn't apply.** The web app's search boxes match words and file names only. A [self-hosted](../how-to/self-host.md#search-by-meaning) server searches by words unless its operator sets search by meaning up.

## Settings

A vault's **Settings** has a menu beside the page (above it on a phone), in three groups:

- **Vault**: **General** (the name and default policy, and the **Danger zone** at the bottom, with **Leave this vault** and, for owners, **Delete vault**), **Members**, **Rules** and **Usage**.
- **You**: **Watching**, the folders and files you watch.
- **Advanced**: **Diagnostics** and, for owners, **Export**.

## Diagnostics

**Settings**, then **Diagnostics**, is for working out why something happened. It has a tab for [Claims](claims.md) (who is working on which path) and one for the **Log**, every event the vault recorded (see [Changes and the log](activity.md)). Most people never need it, so neither is in the vault's main navigation. What is new for you, and what people changed in plain words, is under **Updates**. The **Diagnostics** page itself only lists its tabs; it changes nothing.

## Roles

Every member has one role in a vault:

| Role | Can |
|---|---|
| Owner | everything: files, rules, members, variables in every environment, settings, export and delete |
| Editor | read, write open files, propose, review, comment, and set variables outside owners-only environments |
| Viewer | read files and proposals, and see variable names |

The full table is in [Permissions](../reference/permissions.md).
