# Invite someone

Invite a person to a vault by email with a role, or make a link anyone can open. Reliquary emails an address invite, or shows either kind of link to you to send yourself.

Only an owner can invite, in the web app.

## Steps

1. Open the vault, then **Settings**, **Members**.
2. Choose **Invite someone** at the top right. Pick a role (editor is the default):
   - **Viewer**: reads files and proposals, sees variable names.
   - **Editor**: also writes open files, proposes and approves changes, and sets variables outside owners-only environments.
   - **Owner**: everything, including rules, members, export and deletion.
   Then either:
   - Enter their **Email**, for one person; or
   - Leave **Email** blank and set **Uses** (1 to 100) instead, for a link anyone who has it may open. 1, the default, is a one-time link.
3. Choose **Create invite link**.
4. With an email address and the server has an email sender (Reliquary's hosted service does), the **Members** page says "We emailed them the link" and you're done. The email comes from Reliquary, names the vault, the role and who it's for, and holds the link.
5. Otherwise (no email sender, or no address at all) the **Members** page shows the link once. Copy it and send it to them yourself.

If the email can't be sent (the email provider refused it or didn't answer), the invite is still made: the page shows the link to copy, what failed, why, and a reference. Send the link yourself; the reference is for the operator. See [Errors and reference IDs](../reference/errors.md).

An address invite works once, for 7 days, and only for someone signed in with that email address. A link with no address works for whoever opens it, up to the uses you set, also for 7 days: each person who joins with it counts as one use, and it stops working once they're used up. Either way, if the person has no account yet, the sign-in page tells them what to do (for a link with no address, it explains what Reliquary is first). Joining by invite also lets a new account create vaults of its own while Reliquary is [invite-only](../concepts/plans-and-limits.md#invite-only).

## If they already have an account

Someone who already signs in with that address doesn't need the link. The invite waits in their **Inbox**, with **Join** and **Decline**:

- **Join** makes them a member with the role you chose, the same as opening the link.
- **Decline** ends the invite. The link stops working, the invite leaves your list on **Members**, and the vault's **Activity** shows "Declined an invite". To join later, they ask you for a new invite.

Only the person signed in with the invited address, in the web app, can answer from the Inbox, and only once their address is confirmed. Nobody else can join or decline with it, and neither can their agents. The invite is used once, whichever way they answer. See [The top bar, inbox and account](../concepts/inbox-and-account.md#inbox).

## After they join

They appear on **Members** with their role. They can connect their own AI tools, which act as them, not as you. See [Agents and the ceiling](../concepts/agents.md).

- **Change their role** with the role picker on **Members**.
- **Remove them** with **Remove**, after a confirm page. They and their agents lose access at once.
- **Cut off one of their connections** from this vault with **Revoke** under **Connections**, then confirm.

## Undo an invite

Pending invites are listed on **Members**. **Revoke**, then confirm, makes the link stop working and takes the invite out of their Inbox. Inviting the same address again replaces the old link.

## Limits

At most 50 invites waiting per vault, and 20 new invites an hour per person (a link with no address counts as one invite, however many uses it allows). A link's uses are 1 to 100. Invites waiting count toward the vault's people limit: when every place is filled, **Invite someone** is off and **Members** says how to make room. See [Members and invites](../concepts/members.md) and [Plans and limits](../concepts/plans-and-limits.md).
