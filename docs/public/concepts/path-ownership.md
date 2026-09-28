# Path ownership

A folder or file can name specific people as its owners: open for them, canon (its existing rule) for everyone else.

**Partly usable.** Owners can add, edit and delete their owned path directly, and can approve or reject proposals on it (their approval is the only kind that counts toward its quorum). Owners cannot yet use the one-step edit-and-approve, and cannot yet comment on a proposal for a path they own unless they also have ordinary editor or owner access to the vault: both stay editor/owner-only for now. There is no web app or MCP tool for naming an owner yet: it exists as a database function only.

## What it changes

- **For a path's named owners**, the path is open: they write and delete it directly, no proposal.
- **For everyone else** with write access to the vault, the same path stays canon: they propose, and it lands once enough of the *named owners* approve. A non-owner's own approval never counts toward that path's quorum, whatever their vault role.
- **A path with no named owner** behaves exactly as it always has. Naming an owner only ever narrows who a path's canon rule applies to; it never changes a path nobody owns.

## Who can be an owner

An owner list may include anyone who is a member of the vault, **including a viewer**. Naming a viewer the owner of a path promotes them to write access for that path alone, and to deciding on proposals for it; they stay a viewer everywhere else in the vault.

## Leaving the vault takes it with them

A path's owner list goes with vault membership. If a named owner leaves the vault, is removed by an owner, or deletes their account, they lose that path's ownership row along with everything else membership gave them: they can no longer write or delete the path directly, and if they had approved a still-open proposal on it, that approval stops counting toward its quorum. Changing someone's role, without removing them, leaves their ownership of a path untouched.

## No vault-wide override

The vault `owner` role's own powers (rename, delete, export, members) are a fixed, enumerated list; they don't extend to someone else's owned path. A vault owner who isn't named as a path's owner proposes on it like anyone else. There is no break-glass path today; if one is ever built, it reuses Emergency access (still on the [roadmap](../roadmap.md), not yet built), not a new mechanism.

## Naming an owner

A path needs an existing rule (canon, set on **Settings** or with `set_policy`) before anyone can be named its owner. Naming or removing one is an owner's, in person: no agent, token or connection may do it. The product will require an explicit confirm step for granting one, the same way deleting a vault requires its name typed, once this reaches the web app.
