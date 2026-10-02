# The top bar, inbox and account

Every page of the web app has the same bar at the top. From the left: the Reliquary logo (Home), the main links, a search box, **Feedback**, your **Inbox** and your account menu.

## The main links

- **Home**: how many vaults you own of your plan's limit, what needs your review when something does, and your vaults as a table: your role, files, open proposals and when each last changed, the most recently active first. On a phone each vault is a block of labelled lines.
- **Vaults**: a menu of the vaults you're in, with your role in each. Inside a vault it shows that vault's name. **New vault** is at the bottom. It appears once you're in a vault.
- **Activity**: every change across your vaults. See [Changes and the log](activity.md).
- **Connect**: set up Claude, ChatGPT, Cursor, VS Code or the CLI.
- **Docs**: these pages.

On a phone the links take a row of their own under the bar, and the search box folds into a **Search** button.

## Search

The search box looks through file names and text in every vault you're in, and nothing else. Results show each file's vault and whether it is canon or open. Use quotes for a phrase, or `or` between words. To search one vault, use the search in its sidebar: its page says which vault it covers and has **Search all vaults** to look everywhere with the same words. Agents search one vault at a time with the `search` tool; see [MCP tools](../reference/mcp-tools.md#search).

## Feedback

The **Feedback** button, on every page (on a phone, **Send feedback** in the account menu), opens a short form to send the people who run Reliquary a bug, an idea or a question, with the page you're on if you like. **Your feedback** opens the Feedback page, with what you and your agents sent, its status and any reply. See [Send feedback or report a bug](../how-to/send-feedback.md).

## Inbox

The **Inbox** button counts what needs you. The count is hidden when nothing does. Open it to see the newest few items; **View all** opens the Inbox page (`/inbox`). It holds:

- **Changes to review**: open proposals in vaults where you're an owner or editor that you haven't decided on yet. See [Proposals and review](proposals-and-review.md).
- **Changes requested on your proposals**: yours, or your agents', sent back by a reviewer. Open one to read the note and choose **Revise**.
- **.env imports to apply**: imports from the CLI (sent with `reliquary env push`) that your role lets you apply. See [Imports](imports.md).
- **Invites**: invites to join a vault, made out to your address, with who sent each and when it expires. Choose **Join** to become a member with the invite's role, or **Decline** to turn it down (see below). The link the owner sent you works too.
- **Deleted vaults**: a vault you were in was deleted by an owner. The notice is counted until the Inbox or Home shows it, then it's gone.

### Join or decline an invite

- **Join** makes you a member of the vault with the role the owner chose, and opens it. It is the same as opening the invite link, which then stops working.
- **Decline** ends the invite: its link stops working and it leaves your Inbox and the owners' list of invites. The vault's **Log** shows the owners that an invite was declined, never your address. To join later, ask an owner for a new invite.

Only you can answer an invite to your address, signed in to the web app. Nobody else can use it, even with its id, and neither can an agent, token, connected app or CLI sign-in. Your address must be confirmed: until it is, invites don't show in your Inbox, so use the link instead. If the vault is full, **Join** says so and the invite keeps waiting; choose **Join** again once an owner makes room.

A proposal you snoozed leaves the count and the list until the snooze ends. **Show snoozed** on the Inbox page lists them. The Inbox also shows proposals you sent back that are waiting on their proposer. Old links to `/review` open the Inbox.

## Your account

The account menu, at the right of the bar, shows who you're signed in as and links to:

- **Account settings** (`/settings`): your display name, your email address, the theme, sign out, sign out everywhere and delete account.
- **Plan and usage** (`/account`): your plan and your vaults' people and storage. See [Plans and limits](plans-and-limits.md).
- **Connections** (`/connections`): everything that can act as you (tokens, apps and the Reliquary CLI), each with **Revoke**. See [Connections](connections.md).
- **Send feedback** (`/feedback`), as above.
- **Welcome tour** (`/welcome`): the short slideshow that opens the first time you sign in. See [Take the welcome tour](../how-to/take-the-welcome-tour.md).

It also switches the theme (Auto, Light or Dark) and signs you out.

## Display name

On **Account settings**, you can give yourself a display name. People who share a vault with you see it next to your email, like "Ana Ruiz (ana@example.com)", in Activity, proposals, threads and on **Members**. Nobody else sees it.

- Up to 80 characters. Spaces at either end are removed.
- No "@", so a name never looks like an email address, and no control characters, invisible characters or text-direction marks.
- Leave it empty and save to go back to your email alone.

Only you can set your name, signed in to the web app. An agent can't set or read it, over any tool: it's your profile, like your memberships. See [Agents and the ceiling](agents.md).

## Your email address

Your email is how you sign in and how invites find you. To change it, enter the new address under **Email** on **Account settings** and choose **Send confirmation link**.

1. Reliquary's sign-in service emails a link to the new address, and one to your current address too if this site asks both (it does by default). Nothing changes yet: you keep signing in with your current address, and **Account settings** shows the change waiting for confirmation.
2. Open the link (or both links). With two, the first one you open says to open the other. Then the change is made, and you land on **Account settings**, signed in.
3. From then on you sign in with the new address.

What changes and what stays:

- Your vaults, roles, connections, plan and display name stay as they are. They belong to your account, not your address.
- People who share a vault with you see the new address, in Members, Activity and proposals.
- Invites are matched to the address your account has when you open one. An invite made out to your old address stops working: ask the owner for a new one. An invite made out to your new address works with its link.
- Until you confirm, a change grants nothing: invites made out to the new address don't show in your Inbox and can't be accepted.
- Your old address is free again. Someone who later signs up with it gets the invites made out to it, but nothing of yours.

If the new address already belongs to another Reliquary account, the change is refused. Only you can change your address, signed in to the web app; an agent can't. A confirmation link expires after a while: if yours did, send a new one.

## Sign out everywhere

**Sign out** on **Account settings** ends your session in this browser. **Sign out everywhere** ends every session of your account at once: in every browser and on every device, this one included. Use it if you signed in on a computer you no longer use, or lost a phone. Pages open elsewhere go to the sign-in page on their next click. Signing in again works right away.

Connections are not sessions. Tokens, apps (Claude, ChatGPT, Cursor and others) and the Reliquary CLI keep working after you sign out everywhere, unless you tick **Also revoke all my connections**. That revokes every one of them at once; to revoke them one at a time, use **Connections**. See [Connections](connections.md).

Only you can sign out everywhere, signed in to the web app. An agent can't do it for you. If Reliquary can't reach its sign-in service, nothing is ended and the page says so, with a reference (see [Errors](../reference/errors.md)).

## Delete your account

**Delete account** on **Account settings** deletes your account at once: you leave every vault, your connections are deleted, and Reliquary forgets your email address, display name and plan. What you wrote in vaults stays there, and people see it as written by **a deleted account**. You can't delete your account while you're the only owner of a vault. See [Delete your account](../how-to/delete-your-account.md).
