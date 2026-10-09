# Changes and the log

What people and their agents changed in a vault, in plain words, and the full log behind it, which nobody can edit or delete.

## Changes

A vault's **Changes** lists what people and their agents did to its content: files written, deleted and erased, and proposals opened, approved, sent back for changes, rejected, revised, edited and commented on. Newest first, under a heading for each day: **Today**, **Yesterday**, then the weekday and date (in UTC, like every time here).

Each line says who, what and where, and links to the file or the proposal. For example "Ana wrote notes/plan.md", "Ben's agent Hermes on Linux opened a proposal on canon/rules.md" or "You approved the proposal on canon/rules.md". Your own changes say "You" and "Your agent". A file that has been deleted or erased since shows as plain text: there is nothing to open.

When one person, or one agent, writes the same file several times in a row, it is one line: "Ana wrote notes/plan.md 4 times". Another person's change in between, or the day changing, starts a new line. A write that applies an approved proposal is its own line: "Ben wrote canon/rules.md, from an approved proposal".

Three links above the list choose what to show: **Everyone** (the default), **Mine** and **Watching**. **Mine** is what you changed, and what your agents changed for you. **Watching** is what changed on the folders and files you [watch](flags.md#watching-a-path): a folder covers everything under it and a file only itself, the same rule [flags](flags.md) use. It includes changes from before you started watching. Only your own watches count, and nobody else sees which view you chose.

Pages hold 30 lines. **Older** goes back, and **Newest** returns to the latest, in the view you chose.

Changes leaves out members and invites, rules, variables, links, claims, plan steps and exports: those are in the log below. Opening Changes, in any view, doesn't mark your [flags](flags.md) as shown, or your agents'.

## What is logged

Every change in a vault is recorded in its activity log, which nobody can edit or delete. Each event has a sequence number, a time, who acted, through which agent if any, what happened and where: files written, deleted and erased, proposals made, revised, approved, rejected and applied, comments and review notes, rules set, members invited, changed and removed, variables set, rotated and deleted, environments added, renamed and deleted, exports, and settings changes. Events never hold file text or a variable's value.

The log is append-only: no row can be updated or deleted, by anyone, including the vault's owner and Reliquary's operator. The one exception is deleting a whole vault, which removes its log with it. See [Export, delete and erase](export-delete-erase.md).

## Reading it

- **Activity** in the top bar covers all your vaults.
- In a vault, **Settings**, **Diagnostics**, **Log** covers that vault.
- A file's **History** tab is the same log, for one file.

Each event is named in plain words, like "Approved", "Set a variable" or "Added an environment". Member changes say whom and which role, like "Made ben@example.test an editor", "Removed ben@example.test from the vault" or "Invited someone as a viewer". An invite never shows the address it was sent to.

The path of a write links to its file while the file is there. Once it's deleted, the path is plain text, since there is nothing to open.

Times read like "6 min ago". Hover over one for the exact time in UTC.

On a phone, each event is two lines: what happened and when, then who, the vault and the path.

## Filtering

Select **Filters** to filter by person, by agent (or people or agents only), by action, by path prefix and by date, then **Apply filters**. The **Action** filter lists every event, plus groups: **Any file change**, **Any proposal event** and **Any variable change**.

The filters in use show as chips beside the **Filters** button, like "Agent: Agents only". Select a chip to remove just that filter, or **Clear filters** to remove them all. When nothing matches, the page says so and offers **Clear filters**.

Pages show 50 events at a time. **Older** goes back, and **Newest** returns to the latest events, keeping your filters.

## For agents

`changes_since` reads the same log as a cursor feed: events after a cursor, oldest first, with the text of comments and review notes (fenced as data). Pass back the `next cursor` it returns. It names people by id, never by email. See [MCP tools](../reference/mcp-tools.md#changes_since).

## The variables access log

Reads, reveals and changes of environment variables have their own append-only log, on the Variables page. See [Environment variables](variables.md#the-access-log).
