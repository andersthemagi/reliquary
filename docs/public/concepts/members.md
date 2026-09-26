# Members and invites

People join a vault only by invite, with a role an owner picks, and only the owner of a vault manages who is in it.

## Members

A vault's members are on **Settings**, **Members**. Every member sees who else is in the vault, by email and role, and how many of the vault's places are filled. Owners also get:

- **Invite someone**, at the top right: a page with an email address and a role (owner, editor or viewer). When the vault has no places left, the button is off and the page says how to make room (see [Plans and limits](plans-and-limits.md)).
- A role picker for each member, and **Remove** behind a confirm page.
- Pending invites, with when each was sent and expires, and **Revoke** behind a confirm page.
- Each member's agent connections that reach this vault, with when each was created and last used, and **Revoke** behind a confirm page, which cuts that connection off from this vault only. A member's command-line sign-in shows as **Reliquary CLI**, "Command-line sign-in".

A vault always keeps an owner: the only owner can't step down, leave or remove themself. Make someone else an owner first.

Managing members is in the [ceiling](agents.md): no agent can do any of it, and no agent ever learns members' email addresses.

## Invites

An invite is a link for one email address, with a role:

- It works once, for 7 days, and only for someone signed in with that address.
- The address matches however it is typed: upper or lower case, and an accent typed as one character (é) or as a letter and a combining accent.
- Reliquary doesn't email invites yet: the owner copies the link, shown once, and sends it.
- Inviting an address again replaces its earlier invite.
- An owner can have at most 50 invites waiting in a vault, and one person can create 20 an hour.

The person opens the link, signs in (or is asked to, and comes back), and joins with that role. Joining by invite also admits a new account while Reliquary is [invite-only](plans-and-limits.md#invite-only). See [Invite someone](../how-to/invite-someone.md).

## Leaving and removal

Any member can leave on **Settings**, **Danger zone**, **Leave this vault**, after a confirm page. A removed or departed member, and their agents, lose access at once: tokens that reached only that vault are revoked, and the vault drops out of tokens that reached several. Coming back takes a new invite.

Leaving, removal and role changes are logged, by id, never by email.

## How people are shown

Where the web app names a person (Activity, proposals, threads, the Inbox, Members), it shows their email if they share a vault with you now, with their display name before it if they set one ("Ana Ruiz (ana@example.com)"; see [Display name](inbox-and-account.md#display-name)). Anyone else, like a former member, shows as a short id.
