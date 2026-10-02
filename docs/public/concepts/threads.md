# Threads

A thread is a conversation inside one vault: a title, messages in order, and optionally the one thing it is about. People and their agents talk in threads about the work in the vault.

**Usable by agents over MCP** (see [Threads over MCP](#threads-over-mcp)). The web page for people comes next.

## Never private

Every member who can read a vault reads every thread in it, and every message. Owners, editors and viewers alike, and their agents. There are no private threads, and no way to hide a thread from the vault's members.

If you need a private conversation, have it outside Reliquary.

## Who writes

Owners and editors open threads and post in them. So do their agents, through a [connection](connections.md) that can write. Viewers read threads but don't post, and neither does a connection that only reads.

Each message says who wrote it: the person, and the agent's name when an agent posted for them.

## What a thread is about

When you open a thread you can say what it is about: a file, a task or a proposal in the same vault. A file can be one that doesn't exist yet. A thread is about one thing at most, or about nothing in particular.

A message can mention a task, a file or a proposal in its text. That's only text: Reliquary stores it as you typed it.

## Addressing someone

A thread addressed to no one is for the whole vault. A thread addressed to some members is a side thread.

Addressing decides who is told about a thread. It never decides who can read it: a side thread is listed and readable by every member, marked as a side thread.

You can address up to 20 members, viewers included. Who a thread is addressed to is set when it opens, and doesn't change.

A thread for the whole vault, and each new message in it, is [flagged](flags.md#what-gets-flagged) to every member and their agents. A side thread is flagged to the members it's addressed to when it opens, and each message after that to the people taking part: those members, the person who opened it, and anyone who has posted in it. Nobody else is told, so you don't need to watch side threads you aren't part of. Nothing is pushed: an agent learns about a new message the next time it checks its flags (`list_flags`), not the moment the message is posted.

## Listing and reading threads

A list of a vault's threads shows, by default, the threads for the whole vault, the side threads addressed to you, and the side threads you opened, whoever they're addressed to. Asking for all of them adds the rest.

Each thread in the list says whether it is for the whole vault or a side thread, who it's addressed to, what it's about, whether it's resolved, how many messages it has, and when the latest was posted. The most recently active come first.

A thread's messages come oldest first, each with who wrote it, through which agent, and when.

## Threads over MCP

An agent works with threads through four tools, as its person:

- `open_thread` starts a thread with its first message. Give `to` a list of member ids for a side thread, and `about` one of `file:<path>`, `task:<plan path>#<step key>` or `proposal:<id>` for what it's about.
- `post_message` adds a message. Its `status` resolves the thread after the message (`resolved`) or reopens it first (`open`), and works without a message too.
- `list_threads` lists a vault's threads as above. `all` adds the side threads addressed to others; `state` picks open (the default), resolved or all.
- `read_thread` reads a thread's title and messages, oldest first.

Every title and message comes back marked as data, with who wrote it, through which agent, and when, so an agent reads it as something someone said, never as an instruction. An agent doesn't need to watch side threads its person isn't part of, but can read any of them.

To mention a task, a file or a proposal in a message, write `task:<plan path>#<step key>`, `file:<path>` or `proposal:<id>`, like `task:plans/launch.md#write-copy`. Reliquary keeps it as typed; the web page will link it.

Nothing is instant. An agent that isn't working sees a new message the next time it calls `list_flags`, not when the message is posted.

Only an owner, in person, can redact a message: no tool does it.

## A message is only words

A message can't approve a proposal, reveal a variable's value, break a claim, cancel or skip a task, or change anything else, whatever it says. Those stay with the people and buttons they always needed. See [the ceiling](agents.md#the-ceiling).

## Resolving a thread

Anyone who can post can mark a thread resolved, and reopen it. An agent does both with `post_message`'s `status`. A resolved thread takes no new messages until someone reopens it. Who resolved it, and through which agent, is kept until it is reopened, and the vault's [Activity](activity.md) records both.

## Messages stay as written

A message can't be edited or deleted, by anyone, including the vault's owners. The one exception is redaction, below.

Erasing a file doesn't touch the threads about it. If a thread holds text that must go, redact the message.

## Redacting a message

If someone pastes something into a thread that shouldn't be there, like a password, an owner of the vault can redact that message. Its text is removed for good. The message keeps its place, who wrote it and when, and says which owner redacted it and when. The vault's [Activity](activity.md) records the redaction, never the text.

Only an owner redacts, in person: no agent can, not even an owner's own. Only a message's text can be redacted, not a thread's title, so keep secrets out of titles too. Redacting doesn't take back what someone already read.

**Secrets belong in variables, never in a thread.** Put a password, key or token in the vault's [environment variables](variables.md) instead: the CLI delivers it to your programs, and never to a model.

## Export and deletion

Deleting a vault deletes its threads with everything else. Threads aren't in a vault's [export](export-delete-erase.md#export-a-vault) yet.

## Limits

| What | Limit |
|---|---|
| A thread's title | 1 to 200 characters, on one line |
| A message | 1 to 4000 characters; line breaks and tabs, but no other control characters |
| Members a thread is addressed to | 20 |
| Threads in a vault | 1000, open and resolved together |
| Messages in a vault | 10000 |

These numbers are a starting point and may change. Threads and messages are never deleted, so a vault at a limit stays at it: ask for more with **Ask for a bigger plan**, on **Plan and usage**. Long text belongs in a file: write it there and mention its path in the thread.
