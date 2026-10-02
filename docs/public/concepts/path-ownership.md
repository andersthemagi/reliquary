# Path ownership

A folder or file can name specific people as its owners: open for them, canon (its existing rule) for everyone else.

An owner of the vault names and removes a path's owners in the web app, from **Rules**. Named owners, and their agents over MCP, write and delete the path directly; comment on, approve, reject and edit-then-approve proposals for it; and their approval is the only kind that counts toward its quorum, all of this whatever their own role in the vault, a viewer included. The file, editor and proposal pages show this: a named owner sees **Edit** instead of **Propose a change** on a path they own, and the review controls (**Approve**, **Reject**, **Edit, then approve**, commenting) even if plain viewer access alone wouldn't give them.

## What it changes

- **For a path's named owners**, the path is open: they write and delete it directly, no proposal.
- **For everyone else** with write access to the vault, the same path stays canon: they propose, and it lands once enough of the *named owners* approve. A non-owner's own approval never counts toward that path's quorum, whatever their vault role.
- **A path with no named owner** behaves exactly as it always has. Naming an owner only ever narrows who a path's canon rule applies to; it never changes a path nobody owns.

A folder's owners cover what's under it, except where a rule inside it applies instead: a file under `clients/acme/`, which has its own rule, follows the owners of `clients/acme/`, not those of `clients/`.

## Who can be an owner

An owner list may include anyone who is a member of the vault, **including a viewer**. Naming a viewer the owner of a path promotes them to write access for that path alone, and to deciding on proposals for it; they stay a viewer everywhere else in the vault.

## Leaving the vault takes it with them

A path's owner list goes with vault membership. If a named owner leaves the vault, is removed by an owner, or deletes their account, they lose that path's ownership row along with everything else membership gave them: they can no longer write or delete the path directly, and if they had approved a still-open proposal on it, that approval stops counting toward its quorum. Changing someone's role, without removing them, leaves their ownership of a path untouched.

## No vault-wide override

The vault `owner` role's own powers (rename, delete, export, members) are a fixed, enumerated list; they don't extend to someone else's owned path. A vault owner who isn't named as a path's owner proposes on it like anyone else. There is no break-glass path today; if one is ever built, it reuses Emergency access (still on the [roadmap](../roadmap.md), not yet built), not a new mechanism.

## See a path's owners

Open the vault, then **Settings**, **Rules**. A rule with named owners says how many under its path, as a link, like **2 named owners**. Every member sees it and can open the list.

The list shows each owner by email, their role in the vault, and who named them and when. A viewer's row says they write and approve this path only, so nobody mistakes it for a wider role.

## Name an owner

Only an owner of the vault can, in person, in the web app: no agent, token or connection may. The path needs a rule first: see [Set rules](../how-to/set-rules.md).

1. On **Rules**, open the **⋯** menu on the rule's row and choose **Owners**.
2. Under **Name an owner**, choose a member, then **Name owner…**. Nothing changes yet.
3. Read the confirm page: who they are, that they and their agents will write the path directly with no review, how its quorum changes, and which rules inside it keep their own owners.
4. Choose **Name**, their email, **owner of** and the path, or **Cancel**.

It's logged in the vault's [log](activity.md). On a path whose rule is open, naming an owner changes nothing until the rule becomes canon, and the page says so.

## Remove an owner

1. On the path's **Owners** page, choose **Remove** on their row.
2. Read what they go back to: reading only, for a viewer, or proposing like anyone else, for an editor. If they're the last named owner, any editor's or owner's approval counts toward the path's quorum again.
3. Choose **Remove**, their email, **as owner**, or **Cancel**.

Removing a rule removes its named owners with it. Adding the rule again doesn't bring them back: name them again.
