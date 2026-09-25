# Set rules

Make a folder or file canon (changes need approval) or open (written directly), and choose how many people must approve.

Only an owner can set rules, in the web app. What rules mean: [Canon, open and rules](../concepts/canon-and-rules.md).

## Add or change a rule

1. Open the vault, then **Settings**, **Rules**.
2. Under **Add or change a rule**, fill in:
   - **Path or folder**: a folder ends in `/`, like `clients/`; a file is its full path, like `pricing.md`.
   - **Policy**: **Canon** or **Open**.
   - **Approvals**: for canon, how many different people must approve a change, from 1 to 20.
3. Choose **Save rule**.

Saving a rule for a path that already has one replaces it. The change is logged.

## Check what applies

Under **What applies to a path?**, type any path, like `clients/acme/brief.md`, and choose **Check**. The page says whether it is canon or open, which rule decides (or the vault default), and how many approvals a change needs.

## Remove a rule

Choose **Remove** next to it. The path then follows the next rule up, or the vault default.

## Change the vault default

The default for paths without a rule is on **Settings**: pick open or canon and save, then confirm.

## Examples

| Rule | Effect |
|---|---|
| `clients/` canon, 1 approval | anything under `clients/` needs one person's approval |
| `clients/acme/notes/` open | Acme's notes can be written directly, though `clients/` is canon |
| `pricing.md` canon, 2 approvals | the price list needs two different people |

Proposals already open keep waiting. Each approval counts against the rule in force at that moment, so a changed quorum applies from the next approval.
