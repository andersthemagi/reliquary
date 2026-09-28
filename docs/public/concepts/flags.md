# Flags

A flag tells you, or your agent, about something in a vault that changed since you were last told: a proposal waiting on your review, a change to one of your own proposals, or a change on a path you watch.

**Partly usable.** An agent can list your flags (`list_flags`) and what you watch (`list_subscriptions`) over MCP, and mark flags shown (`advance_flags`). There is still no way to watch or unwatch a path anywhere: not the web app, not the CLI, not MCP (that needs you, in the web app, same as variables and rules). Notes addressed to someone aren't built either.

## What gets flagged

- **Waiting on you.** An open proposal, in a vault where you're an owner or editor, that you haven't approved, sent back or rejected at its current revision and haven't snoozed. These are the same proposals as **Changes to review** in your [Inbox](inbox-and-account.md#inbox). It is flagged when it opens, and again when it's revised, edited or commented on.
- **Your own proposals.** A comment, a decision, an edit, going stale or being applied, on a proposal you made or your agent made for you.
- **The file under your proposal.** Someone else writes, deletes or erases the file one of your pending proposals would change. Approving that proposal would now make it stale, so you'll want to propose again.
- **Paths you watch.** Any change on a folder or file you chose to watch. A folder, like `clients/acme/`, covers everything under it. A file, like `notes/plan.md`, covers only itself.

What you did yourself isn't flagged to you. What your agent did is flagged to you, and what you did in the web app is flagged to your agent.

Each flag says what happened, where, who did it and when.

Flags for files you've read, and for notes addressed to you, aren't built yet.

## You and each connection

You in the web app and each of your [connections](connections.md) are flagged separately, and each keeps its own place. Once a connection has been shown a flag, that connection isn't shown it again, but you and your other connections still are.

Reading flags doesn't use them up. They're marked shown only once the response carrying them has been delivered, so a call that fails loses nothing.

A new connection is told what is waiting on you now, but not what happened before it was made.

## Watching a path

Any member of a vault, owner, editor or viewer, can watch its folders and files. Only you, signed in to the web app, start or stop watching. An agent can list what you watch, but can't change it. You can watch up to 100 paths in each vault.

Watching starts from the moment you ask: earlier changes aren't flagged. Nobody else sees what you watch, and it isn't recorded in the vault's [Activity](activity.md).

Watching a tag isn't possible yet, because files don't carry tags.

When you leave a vault, or are removed from it, what you watched there goes too.

## A flag is never permission

A flag saying a proposal waits on you lets your agent tell you and link to it. It can't approve for you: approving stays a person's click in the web app, whatever a flag or a proposal says. See [the ceiling](agents.md#the-ceiling).
