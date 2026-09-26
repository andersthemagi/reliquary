# Invite someone

Invite a person to a vault by email with a role, then send them the link yourself.

Only an owner can invite, in the web app.

## Steps

1. Open the vault, then **Settings**, **Members**.
2. Choose **Invite someone** at the top right, then enter their email address and pick a role (editor is the default):
   - **Viewer**: reads files and proposals, sees variable names.
   - **Editor**: also writes open files, proposes and approves changes, and sets variables outside owners-only environments.
   - **Owner**: everything, including rules, members, export and deletion.
3. Choose **Create invite link**. The **Members** page shows the link once.
4. Copy the link and send it to them yourself. Reliquary doesn't email invites yet.

The link works once, for 7 days, and only for someone signed in with that email address. If they have no account yet, the sign-in page tells them what to do. Joining by invite also lets a new account create vaults of its own while Reliquary is [invite-only](../concepts/plans-and-limits.md#invite-only).

## If they already have an account

Someone who already signs in with that address doesn't need the link. The invite waits in their **Inbox**, with **Join** and **Decline**:

- **Join** makes them a member with the role you chose, the same as opening the link.
- **Decline** ends the invite. The link stops working, the invite leaves your list on **Members**, and the vault's **Activity** shows "Declined an invite". To join later, they ask you for a new invite.

Only the person signed in with the invited address, in the web app, can answer from the Inbox, and only once their address is confirmed. Nobody else can join or decline with it, and neither can their agents. The invite is used once, whichever way they answer. See [The top bar, inbox and account](../concepts/inbox-and-account.md#inbox).

## After they join

They appear on **Members** with their role. They can connect their own AI tools, which act as them, not as you. See [Agents and the ceiling](../concepts/agents.md).

- **Change their role** with the role picker on **Members**.
- **Remove them** with **Remove**, after a confirm page. They and their agents lose access at once.
- **Cut off one of their agent connections** from this vault with **Revoke** under **Agent connections**, then confirm.

## Undo an invite

Pending invites are listed on **Members**. **Revoke**, then confirm, makes the link stop working and takes the invite out of their Inbox. Inviting the same address again replaces the old link.

## Limits

At most 50 invites waiting per vault, and 20 new invites an hour per person. Invites waiting count toward the vault's people limit: when every place is filled, **Invite someone** is off and **Members** says how to make room. See [Members and invites](../concepts/members.md) and [Plans and limits](../concepts/plans-and-limits.md).
