# Flags

A flag tells you, or your agent, about something in a vault that changed since you were last told: a new message in a thread for you, a proposal waiting on your review, a change to one of your own proposals, or a change on a path you watch.

**Partly usable.** You watch and unwatch folders and files, and see your own flags, in the web app (see [Watching a path](#watching-a-path) and [Seeing your flags](#seeing-your-flags)). An agent can list your flags (`list_flags`) and what you watch (`list_subscriptions`) over MCP, and mark flags shown (`advance_flags`). Thread messages are flagged; notes addressed to someone aren't built.

## What gets flagged

- **Threads for you.** A new [thread](threads.md), or a new message in an open one, when the thread is for the whole vault or addressed to you. A thread for the whole vault is flagged to every member, viewers included, though viewers can't post. A side thread, addressed to some members, is flagged to them when it opens. After that, each message in it is flagged to the people taking part: the members it's addressed to, the person who opened it, and anyone who has posted in it. Everyone else can still read it, but isn't told. Nothing is flagged for a resolved thread, for resolving or reopening one, or for a redaction.
- **Waiting on you.** An open proposal, in a vault where you're an owner or editor, that you haven't approved, sent back or rejected at its current revision and haven't snoozed. These are the same proposals as **Changes to review** in your [Inbox](inbox-and-account.md#inbox). It is flagged when it opens, and again when it's revised, edited or commented on.
- **Your own proposals.** A comment, a decision, an edit, going stale or being applied, on a proposal you made or your agent made for you.
- **The file under your proposal.** Someone else writes, deletes or erases the file one of your pending proposals would change. Approving that proposal would now make it stale, so you'll want to propose again.
- **Paths you watch.** Any change on a folder or file you chose to watch. A folder, like `clients/acme/`, covers everything under it. A file, like `notes/plan.md`, covers only itself.

What you did yourself isn't flagged to you. What your agent did is flagged to you, and what you did in the web app is flagged to your agent.

Each flag says what happened, where, who did it and when. One change raises one flag. When it fits more than one kind above, it's listed as the first of these that fits: threads, waiting on you, your own proposals or the file under one, paths you watch.

A thread's flag names the thread and the message by id, never the thread's title or the message's text. Those are words someone typed, so an agent reads them from the thread itself, where they come back marked as data.

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

In the web app, **Settings**, **Diagnostics**, **Flags** in a vault shows what's waiting on you, badged apart from threads, events on your own proposals and their files, and changes on paths you watch, oldest first. Each links to its thread, proposal or file. Flags are how agents hear about changes, so the page sits under **Diagnostics**: most people never need it.

Opening the page marks those flags shown for you, the same as an agent calling `advance_flags` after it shows you `list_flags`: the next visit shows only what's new since, and when there's nothing it says so and points to **Proposals**, where what still waits on you is counted. If more than 200 flags are waiting, the page shows the oldest 200: reload for the next batch. This is your own place in the vault, separate from any of your agent connections', so looking at this page doesn't clear anything for them, and their calls don't clear anything for you.

## Watching a path

Any member of a vault, owner, editor or viewer, can watch its folders and files. Only you, signed in to the web app, start or stop watching. An agent can list what you watch, but can't change it. You can watch up to 100 paths in each vault.

To watch a folder or a file, open it and choose **Watch** at the top of its page. The page then says **Watching**, with **Unwatch** to stop. A file inside a folder you watch says **Watching via** that folder, since the folder's watch already covers it. The vault's top folder has no **Watch**: watch the folders in it instead.

Changes on what you watch are flagged to you and to your agents. You see yours in **Settings**, **Diagnostics**, **Flags** (badged **Watching**) and in **Changes**, **Watching**; your agents ask for theirs with `list_flags`.

Everything you watch in a vault is on its **Settings**, **Watching** tab, each with **Unwatch**. The vault's [Changes](activity.md#changes) has a **Watching** view of what changed on those paths, including changes from before you started watching; flags only count from the moment you ask. You can also type a path there to watch it, like `clients/` or `notes/plan.md`, even before anything is written there. Until something is, the list shows that path as plain text, marked "nothing there yet", because there is no page to open. A folder ends in `/` and covers everything in it; a file covers only itself.

At 100 paths in a vault, watching another is refused, and the page says so: stop watching one first. A path the vault won't take is refused the same way, in the **Watch a folder or file** form with the reason, and what you typed stays in it to correct.

Watching starts from the moment you ask: earlier changes aren't flagged. Nobody else sees what you watch, and it isn't recorded in the vault's [log](activity.md).

Watching a tag isn't possible yet, because files don't carry tags.

When you leave a vault, or are removed from it, what you watched there goes too.

## A flag is never permission

A flag saying a proposal waits on you lets your agent tell you and link to it. It can't approve for you: approving stays a person's click in the web app, whatever a flag or a proposal says. See [the ceiling](agents.md#the-ceiling).

The same holds for a thread message that flags you. It can mention a proposal or a task, but it can't approve, decide or cancel anything. See [A message is only words](threads.md#a-message-is-only-words).
