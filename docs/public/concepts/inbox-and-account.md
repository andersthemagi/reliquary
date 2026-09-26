# The top bar, inbox and account

Every page of the web app has the same bar at the top. From the left: the Reliquary logo (Home), the main links, a search box, your **Inbox** and your account menu.

## The main links

- **Home**: how many vaults you own of your plan's limit, what needs your review when something does, and your vaults as a table: your role, files, open proposals and when each last changed, the most recently active first. On a phone each vault is a block of labelled lines.
- **Vaults**: a menu of the vaults you're in, with your role in each. Inside a vault it shows that vault's name. **New vault** is at the bottom. It appears once you're in a vault.
- **Activity**: every change across your vaults. See [Activity](activity.md).
- **Connect**: set up Claude, ChatGPT, Cursor, VS Code or the CLI.
- **Docs**: these pages.

On a phone the links take a row of their own under the bar, and the search box folds into a **Search** button.

## Search

The search box looks through file names and text in every vault you're in, and nothing else. Results show each file's vault and whether it is canon or open. Use quotes for a phrase, or `or` between words. To search one vault, use the search in its sidebar: its page says which vault it covers and has **Search all vaults** to look everywhere with the same words. Agents search one vault at a time with the `search` tool; see [MCP tools](../reference/mcp-tools.md#search).

## Inbox

The **Inbox** button counts what needs you. The count is hidden when nothing does. Open it to see the newest few items; **View all** opens the Inbox page (`/inbox`). It holds:

- **Changes to review**: open proposals in vaults where you're an owner or editor that you haven't decided on yet. See [Proposals and review](proposals-and-review.md).
- **Changes requested on your proposals**: yours, or your agents', sent back by a reviewer. Open one to read the note and choose **Revise**.
- **.env imports to apply**: imports from the CLI (sent with `reliquary env push`) that your role lets you apply. See [Imports](imports.md).
- **Invites**: invites to join a vault, made out to your address. To join, open the link the owner sent you; the Inbox tells you who sent it and when it expires.
- **Deleted vaults**: a vault you were in was deleted by an owner. The notice is counted until the Inbox or Home shows it, then it's gone.

A proposal you snoozed leaves the count and the list until the snooze ends. **Show snoozed** on the Inbox page lists them. The Inbox also shows proposals you sent back that are waiting on their proposer. Old links to `/review` open the Inbox.

## Your account

The account menu, at the right of the bar, shows who you're signed in as and links to:

- **Account settings** (`/settings`): your display name, your email, the theme, sign out and sign out everywhere.
- **Plan and usage** (`/account`): your plan and your vaults' people and storage. See [Plans and limits](plans-and-limits.md).
- **Tokens and connections** (`/tokens`): agent tokens, connected apps and CLI sign-ins, each with **Revoke**. See [Connections](connections.md).

It also switches the theme (Auto, Light or Dark) and signs you out.

## Display name

On **Account settings**, you can give yourself a display name. People who share a vault with you see it next to your email, like "Ana Ruiz (ana@example.com)", in Activity, proposals, threads and on **Members**. Nobody else sees it.

- Up to 80 characters. Spaces at either end are removed.
- No "@", so a name never looks like an email address, and no control characters, invisible characters or text-direction marks.
- Leave it empty and save to go back to your email alone.

Only you can set your name, signed in to the web app. An agent can't set or read it, over any tool: it's your profile, like your memberships. See [Agents and the ceiling](agents.md).

Your email is how you sign in and how invites find you. It can't be changed in the web app; ask the operator of your Reliquary.

## Sign out everywhere

**Sign out** on **Account settings** ends your session in this browser. **Sign out everywhere** ends every session of your account at once: in every browser and on every device, this one included. Use it if you signed in on a computer you no longer use, or lost a phone. Pages open elsewhere go to the sign-in page on their next click. Signing in again works right away.

Connections are not sessions. Agent tokens, connected apps (Claude, ChatGPT, Cursor and others) and Reliquary CLI sign-ins keep working after you sign out everywhere, unless you tick **Also revoke all my connections**. That revokes every one of them at once; to revoke them one at a time, use **Tokens and connections**. See [Connections](connections.md).

Only you can sign out everywhere, signed in to the web app. An agent can't do it for you. If Reliquary can't reach its sign-in service, nothing is ended and the page says so, with a reference (see [Errors](../reference/errors.md)).
