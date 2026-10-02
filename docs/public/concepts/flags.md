# Flags

A flag tells you, or your agent, about something in a vault that changed since you were last told: a proposal waiting on your review, a change to one of your own proposals, or a change on a path you watch.

**Partly usable.** You watch and unwatch folders and files, and see your own flags, in the web app (see [Watching a path](#watching-a-path) and [Seeing your flags](#seeing-your-flags)). An agent can list your flags (`list_flags`) and what you watch (`list_subscriptions`) over MCP, and mark flags shown (`advance_flags`). Notes addressed to someone aren't built.

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

## How an agent learns it has flags

MCP has no push: Reliquary can't wake an agent or interrupt it. So when flags wait for a connection in a vault, each successful call it makes there (a call that names the vault, or a proposal in it) ends with one more line:

```
Reliquary: 3 flags are waiting for you in this vault. Call list_flags.
```

The line gives the count, up to "more than 20", and nothing else. It never holds a vault's name, a path, a proposal's text or anything else someone typed, so it can't carry instructions. The agent then calls `list_flags`, shows you what it returns, and calls `advance_flags`. The line stops until something new is flagged. Reliquary tells every agent this when it connects.

The line repeats on every call until the agent calls `advance_flags`: seeing it uses nothing up. It isn't added to `list_flags` or `advance_flags` themselves, to a call that failed, or to a call that names no vault, like `list_vaults`. A read-only connection gets it too.

It only reaches an agent that is making calls in that vault. An agent that is idle, or working in another vault, finds out on its next call there. Nothing wakes it.

## Seeing your flags

Every vault has a **Flags** section for the person signed in to the web app: what's waiting on you, badged apart from events on your own proposals and their files, and changes on paths you watch, oldest first. Each links to its proposal or file.

Opening the page marks those flags shown for you, the same as an agent calling `advance_flags` after it shows you `list_flags`: the next visit shows only what's new since. This is your own place in the vault, separate from any of your agent connections', so looking at this page doesn't clear anything for them, and their calls don't clear anything for you.

## Watching a path

Any member of a vault, owner, editor or viewer, can watch its folders and files. Only you, signed in to the web app, start or stop watching. An agent can list what you watch, but can't change it. You can watch up to 100 paths in each vault.

To watch a folder or a file, open it and choose **Watch** at the top of its page. The page then says **Watching**, with **Unwatch** to stop. A file inside a folder you watch says **Watching via** that folder, since the folder's watch already covers it. The vault's top folder has no **Watch**: watch the folders in it instead.

Everything you watch in a vault is on its **Settings**, **Watching** tab, each with **Unwatch**. You can also type a path there to watch it, like `clients/` or `notes/plan.md`, even before anything is written there. A folder ends in `/` and covers everything in it; a file covers only itself.

At 100 paths in a vault, watching another is refused, and the page says so: stop watching one first.

Watching starts from the moment you ask: earlier changes aren't flagged. Nobody else sees what you watch, and it isn't recorded in the vault's [Activity](activity.md).

Watching a tag isn't possible yet, because files don't carry tags.

When you leave a vault, or are removed from it, what you watched there goes too.

## A flag is never permission

A flag saying a proposal waits on you lets your agent tell you and link to it. It can't approve for you: approving stays a person's click in the web app, whatever a flag or a proposal says. See [the ceiling](agents.md#the-ceiling).
