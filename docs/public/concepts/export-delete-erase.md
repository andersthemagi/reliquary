# Export, delete and erase

Your data can leave: an owner can export a vault, delete it at once, or erase a single file's text, each in person, behind a confirm step.

All three are in the [ceiling](agents.md): no agent or token can do them.

## Export a vault

On **Settings**, **Export**, an owner chooses **Download export** to get the vault as a `.tar.gz`:

- `files/`: the current text of every live file, at its path.
- `reliquary-export.json`: the vault, its default policy and rules, variable names with the environments that have a value, and each file's SHA-256 and size.

Variable values are never exported, only names. The archive is one snapshot, fixed when the export starts. A vault can be exported at most 10 times an hour, and a vault over 100 MiB of text is refused. The export is logged. A download cut off halfway is not a valid archive, so a partial export never looks whole.

Not yet in the export: earlier versions, proposals and the log.

## Delete a vault

On **Settings**, **Danger zone**, an owner chooses **Delete vault** and deletes it by typing its name. Deletion is immediate and can't be undone: files, versions, proposals, comments, rules, members, invites, variables and both logs are gone. Only who deleted it, when, and counts are kept, without the vault's name.

Every other member sees a one-time notice on Home ("<name> was deleted by <email> on <date>") within 30 days. Tokens that reached only that vault are revoked. Export first if you might need anything.

Backups age out on their own schedule after a deletion; see the [privacy policy](/privacy).

## Erase a file

For text that must be gone, like personal data or a pasted secret: on a file's page, **More**, **Erase content**. The owner types the path to confirm. Every version's text is blanked, and so are the notes and comments on its proposals. The log keeps its entries (who did what, when) and gains one for the erasure. Erased text is never found by search, shown, exported or sent to agents.

Deleting a file is different: it keeps the versions. See [Vaults, files and folders](vaults-and-files.md).
