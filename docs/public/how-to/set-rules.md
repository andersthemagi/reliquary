# Set rules

Make a folder or file canon (changes need approval) or open (written directly), and choose how many people must approve.

Only an owner can set rules, in the web app. What rules mean: [Canon, open and rules](../concepts/canon-and-rules.md).

## See the rules

Open the vault, then **Settings**, **Rules**. The table lists every rule in folder order: a folder's rule, then the rules inside it. Under each path it says whether the rule is on a folder or a file, and which rule it overrides. **Approvals needed** is shown for canon rules; **Set by** says who saved the rule and when (hover the time for the exact time).

## Add or change a rule

1. On **Rules**, choose **Add rule** at the top.
2. Under **Add or change a rule**, fill in:
   - **Path or folder**: a folder ends in `/`, like `clients/`; a file is its full path, like `pricing.md`.
   - **Policy**: **Canon** or **Open**.
   - **Approvals needed**: for canon, how many different people must approve a change, a whole number from 1 to 20. Open rules don't use it.
3. Choose **Save rule**.

To change an existing rule, open the **⋯** menu on its row and choose **Change**: the form opens with the rule filled in. Saving a rule for a path that already has one replaces it. The change is logged.

If **Approvals needed** isn't a whole number from 1 to 20, the form refuses it and says why, with a reference; nothing is saved.

A rule can ask for more approvals than there are people to give them. Only the vault's owners and editors can approve under a rule, or only the rule's named owners if it has any (see [Path ownership](../concepts/path-ownership.md)). Reliquary still saves the rule, since a team may be growing into it, but the message after saving is a warning that says how many people can approve now. Until more people can, or you lower the number, changes under that rule stay open.

A rule's path is a path inside the vault, written the way files are. The form refuses, and says why, a path that:

- starts with `/` (write `clients/`, not `/clients/`);
- has a `..` or `.` segment, like `../x` or `./clients/`;
- has an empty folder name, like `clients//`;
- has a control character, such as a tab or a line break, or is longer than 1024 characters.

The message shows in the form with a reference; what you typed stays in it to correct.

## Check what applies

Under **What applies to a path?**, type any path, like `clients/acme/brief.md`, and choose **Check**. The page says whether it is canon or open, which rule decides (or the vault default), and how many approvals a change needs.

## Remove a rule

1. Open the **⋯** menu on the rule's row and choose **Remove**.
2. Read what changes: which rule the path follows next (the next rule up, or the vault default), how many files change policy, which rules inside it stay, any proposals waiting there, and any named owners, who are removed with it.
3. Choose **Remove the rule on** followed by the path, or **Cancel**.

A rule saved before paths were checked, on a path like `../x`, never applied to any file. You can still remove it.

## Name a path's owners

A rule's **⋯** menu also has **Owners**: the people who write that path directly while it stays canon for everyone else. See [Path ownership](../concepts/path-ownership.md#name-an-owner).

## Change the vault default

The default for paths without a rule is on **Settings**: pick open or canon and save, then confirm.

## Examples

| Rule | Effect |
|---|---|
| `clients/` canon, 1 approval | anything under `clients/` needs one person's approval |
| `clients/acme/notes/` open | Acme's notes can be written directly, though `clients/` is canon |
| `pricing.md` canon, 2 approvals | the price list needs two different people |

Proposals already open keep waiting. Each approval counts against the rule in force at that moment, so a changed quorum applies from the next approval.
