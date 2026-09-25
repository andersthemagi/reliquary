# Invite someone

Invite a person to a vault by email with a role, then send them the link yourself.

Only an owner can invite, in the web app.

## Steps

1. Open the vault, then **Settings**, **Members**.
2. Under **Invite someone**, enter their email address and pick a role (editor is the default):
   - **Viewer**: reads files and proposals, sees variable names.
   - **Editor**: also writes open files, proposes and approves changes, and sets variables outside owners-only environments.
   - **Owner**: everything, including rules, members, export and deletion.
3. Choose **Create invite link**. The page shows the link once.
4. Copy the link and send it to them yourself. Reliquary doesn't email invites yet.

The link works once, for 7 days, and only for someone signed in with that email address. If they have no account yet, the sign-in page tells them what to do.

## After they join

They appear on **Members** with their role. They can connect their own AI tools, which act as them, not as you. See [Agents and the ceiling](../concepts/agents.md).

- **Change their role** with the role picker on **Members**.
- **Remove them** with **Remove**, after a confirm page. They and their agents lose access at once.
- **Cut off one of their agent connections** from this vault with **Revoke** under their connections.

## Undo an invite

Pending invites are listed on **Members**. **Revoke** makes the link stop working. Inviting the same address again replaces the old link.

## Limits

At most 50 invites waiting per vault, and 20 new invites an hour per person. See [Members and invites](../concepts/members.md).
