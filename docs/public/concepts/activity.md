# Activity

Every change in a vault is recorded in its activity log, which nobody can edit or delete.

## What is logged

Each event has a sequence number, a time, who acted, through which agent if any, what happened and where: files written, deleted and erased, proposals made, revised, approved, rejected and applied, comments and review notes, rules set, members invited, changed and removed, variables set, rotated and deleted, environments added, renamed and deleted, exports, and settings changes. Events never hold file text or a variable's value.

The log is append-only: no row can be updated or deleted, by anyone, including the vault's owner and Reliquary's operator. The one exception is deleting a whole vault, which removes its log with it. See [Export, delete and erase](export-delete-erase.md).

## Reading it

- **Activity** in the top bar covers all your vaults.
- A vault's **Activity** covers that vault.
- A file's **History** tab is the same log, for one file.

Each event is named in plain words, like "Approved", "Set a variable" or "Added an environment". Member changes say whom and which role, like "Made ben@example.test an editor", "Removed ben@example.test from the vault" or "Invited someone as a viewer". An invite never shows the address it was sent to.

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
