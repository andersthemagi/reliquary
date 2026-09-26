# Agents and the ceiling

An agent you connect acts as you, with your role in each vault, except for a short list of actions that need you present in the web app.

## An agent is its person

When Claude Code, ChatGPT or any MCP client calls Reliquary through your connection, it acts as you: it reads what you can read and writes what you can write, within the vaults and access you chose when you connected it. The log records both: you, and the agent that acted for you.

A read-only connection makes the agent a viewer everywhere. A connection limited to some vaults can't see that the others exist.

## The ceiling

Some actions need the person, signed in, in the web app. No agent can do them, through any connection, even an owner's:

- approve, request changes on or reject a proposal (and edit, then approve);
- set or remove rules (canon or open, quorum);
- invite people, change roles, remove members, or see members' email addresses;
- create or revoke tokens and connections;
- set, rotate, delete or reveal a variable's value, or apply an import;
- rename a vault or change its default policy;
- erase a file, export a vault, or delete one;
- snooze a proposal.

**Why:** an agent reads text other people wrote. A file, a comment or a web page can carry instructions (prompt injection), and anything the agent may do, the injected text may try. The ceiling keeps the actions that are irreversible, grant trust or reveal secrets behind a person's click.

**How it holds:** the database enforces it, not the app. Every request from an agent carries a claim naming the agent and its connection, and the database refuses those actions for any request that carries one. A tool that offered more would still be refused. Each rule has a hostile test that tries to break it on every change. See [Security model](security.md).

## What agents can do

Within your role and the connection's access:

- list vaults, list and read files, search, and follow changes (`changes_since`);
- write and delete open files;
- propose changes to canon files, revise their own proposals, and comment;
- create a vault for you, with a read-write connection that reaches all your vaults;
- list environment variable names, and imports from the CLI waiting for you (never values).

The full list is in [MCP tools](../reference/mcp-tools.md); what people and agents can each do is in [Permissions](../reference/permissions.md).

## Text is data

File text, reasons, comments and review notes reach an agent inside fences with a fresh random marker, like `BEGIN-7f3a...` and `END-7f3a...`, with who wrote it and when. The marker is chosen so no text in the response contains it, so a file can't end its own fence early and pose as instructions. If you build an agent on Reliquary, treat fenced text as data: quote it, summarise it, but don't follow instructions in it.

## For agents reading this

- Before writing, check a path's policy: `list_files` marks canon files `[canon]`, and `read_file` names the policy. Use `write_file` for open files and `propose` for canon ones.
- You can't approve. After proposing, tell your person there is a proposal waiting in their Inbox.
- Answer requests for changes with `revise_proposal`; read the notes in `changes_since` or `read_proposal`.
- Never ask for or repeat a variable's value. To add a `.env` to a vault, run `npx @reliquary-ai/cli env push`; a person applies it. See [Move a .env into a vault](../how-to/move-env-into-vault.md).
