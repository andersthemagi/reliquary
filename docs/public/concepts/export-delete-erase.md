# Export, delete and erase

Your data can leave: an owner can export a vault, delete it at once, or erase a single file's text, each in person, behind a confirm step.

All three are in the [ceiling](agents.md): no agent or token can do them.

## Export a vault

On **Settings**, **Export**, an owner chooses **Download export** to get the vault as a `.tar.gz`:

- `files/`: the current text of every live file, at its path.
- `renamed/`: a file whose path another system could read as something else (a backslash, a colon, a name ending in a dot or space, a device name like `CON`; only files saved before such paths were refused). Each is saved as a number and the path with those characters as `_`, and the manifest's `renamed` list gives its path in the vault, so nothing lands outside the folder you extract to.
- `threads/`: each of the vault's [threads](threads.md) as a Markdown file, numbered in the order they opened, like `0001-launch-plan.md`. It starts with the title, who opened it and through which agent, what it is about, who it is addressed to, and whether it is open or who resolved it. Then every message in order under a numbered heading with its author, agent and time, its text quoted (each line starts with `>`). A thread about a task names it as `task:<plan path>#<step key>`: tasks aren't in the export, but the plan file is, under `files/`.
- `reliquary-export.json`: the vault, its default policy and rules, variable names with the environments that have a value, each file's SHA-256 and size, the `renamed` list, and `threads`: each thread's id, title, file, scope, addressees, anchor, resolved state and message count.

Variable values are never exported, only names. A [redacted](threads.md#redacting-a-message) message keeps its place, author and time in its thread's file, and says who redacted it and when, without its text. Redacting doesn't take back an export someone already downloaded.

The archive is one snapshot, fixed when the export starts: a message posted after that isn't in it, but a message redacted while the export runs comes out without its text. A vault can be exported at most 10 times an hour, and a vault over 100 MiB of file text is refused (threads don't count toward that). The export is logged. A download cut off halfway is not a valid archive, so a partial export never looks whole. Cancelling a download stops that export and nothing else.

Not yet in the export: earlier versions, proposals and their comments, tasks and the log.

Nothing reads an export back in yet, a self-hosted Reliquary included: an export is a copy for you to keep and read, and its threads aren't restored anywhere.

## Delete a vault

In the **Danger zone** at the bottom of **Settings**, **General**, an owner chooses **Delete vault** and deletes it by typing its name. Deletion is immediate and can't be undone: files, versions, proposals, comments, threads, rules, members, invites, variables and both logs are gone. Only who deleted it, when, and counts are kept, without the vault's name.

Every other member sees a one-time notice on Home ("<name> was deleted by <email> on <date>") within 30 days. Tokens that reached only that vault are revoked. Export first if you might need anything.

Backups age out on their own schedule after a deletion; see the [privacy policy](/privacy).

## Erase a file

For text that must be gone, like personal data or a pasted secret: on a file's page, **More**, **Erase file**. The owner types the path to confirm. Every version's text is blanked, and so are the notes and comments on its proposals. The file itself is then removed from the vault. The log keeps its entries (who did what, when) and gains one for the erasure. Erased text is never found by search, shown, exported or sent to agents.

Deleting a file is different: it keeps the versions. See [Vaults, files and folders](vaults-and-files.md).

## Delete your account

Deleting your account is separate from deleting a vault: you leave your vaults, and what you wrote stays in them. Only a vault nobody else is in is deleted with your account. See [Delete your account](../how-to/delete-your-account.md).
