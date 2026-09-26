# Delete your account

Deleting your account is immediate and can't be undone. You leave every vault, your connections stop working, and Reliquary forgets your email address, display name and plan. What you wrote in vaults stays in those vaults.

## Before you start

- **Vaults you own alone.** A vault always keeps an owner, so you can't delete your account while you're the only owner of a vault. For each one, either make someone else an owner (the vault's **Settings**, **Members**) or delete the vault (**Settings**, **Danger zone**). The delete page lists these vaults with a link to each.
- **A copy.** To keep a vault's files, export it first: **Settings**, **Export**. See [Export, delete and erase](../concepts/export-delete-erase.md).
- **What you wrote.** Files, proposals, comments and the activity log belong to each vault and its owners, so they stay. To remove something you wrote, erase it (owners only, **More**, **Erase content**) or ask an owner to, before you delete your account.

## Delete it

1. Open the account menu at the top right and choose **Account settings**.
2. Under **Delete account**, choose **Delete account**.
3. Read the page: it lists the vaults you'll leave, how many connections are deleted and what stays.
4. Type your email address exactly as it is on your account, and choose **Delete my account**.

You're signed out everywhere at once, and the page confirms what was deleted.

## What happens

Deleted at once:

- your memberships: you leave every vault, and each vault's activity log records that you left;
- your connections: tokens, apps (Claude, ChatGPT, Cursor and others) and the Reliquary CLI;
- invites you made that are still waiting, which are withdrawn;
- your email address, display name, plan, and your sign-in account itself;
- `.env` files you pasted on a Variables page and didn't apply.
- [feedback](send-feedback.md) you and your agents sent, with its status and replies (a notice already emailed to the operator stays in their mailbox).

Kept, in each vault:

- what you wrote: file versions, proposals, approvals, comments and notes;
- the activity log and the variables access log, which are append-only.

Wherever the web app would show your email, people now see **a deleted account**. Vaults you created that others still own count against the longest-standing remaining owner's plan from then on.

Backups keep deleted data until they age out; see the [privacy policy](/privacy).

## Afterwards

You can sign up again later with the same address. That's a new account: it has none of your old vaults, and it joins a vault by invite like anyone new. Invites other people made out to your address stay theirs, and a new account at that address can accept them.

Only you can delete your account, signed in to the web app. An agent can't do it for you, over any tool. See [Agents and the ceiling](../concepts/agents.md).
