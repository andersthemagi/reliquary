# Proposals and review

A proposal is a suggested change to a file, usually a canon one, that waits for people to approve, request changes or reject it.

## What a proposal is

Anyone who can write, and their agents, can propose: a new file, new text for a file, or deleting one. Each carries a reason for the reviewers. A proposal holds the full proposed text, and each revision replaces it.

To delete a canon file, open it, choose **Propose a change**, then **Propose deleting this file**; an agent calls `propose` with `delete: true`. The file stays until the proposal is approved.

A proposal is one of:

| Status | Means |
|---|---|
| Open | waiting for approvals |
| Changes requested | a reviewer asked for changes; it can't be approved until the proposer revises it |
| Applied | it reached its quorum and the file was written (or deleted) |
| Rejected | a reviewer rejected it, with a note |
| Stale | the file changed after it was proposed, so it can't apply; **Propose again** (or `propose` with the same text) starts a new one on the current file |

## Reviewing

The **Inbox** in the top bar counts what waits on you, across all your vaults, and lists it on the Inbox page (see [The top bar, inbox and account](inbox-and-account.md)). A proposal's page puts the decision first:

1. The status, and the latest request for changes if there is one.
2. The decision: a note, then **Approve**, **Request changes**, **Reject**, or **Edit, then approve**.
3. The diff: unified (the default), split, or rendered as it will read. Changed words are highlighted.
4. The proposer's reason. From an agent it is marked unverified: read the diff, not the story.
5. Approvals and the discussion.

- **Approve** counts once per person. When approvals reach the quorum, the change applies, credited to whoever proposed it.
- **Request changes** and **Reject** need a note. Requesting changes keeps the proposal alive; rejecting closes it.
- **Edit, then approve** lets you fix the text yourself and approve your version. It is credited to you, and with a quorum above 1 it waits for another approval of the edit.

### Worth a closer look

Above the decision, a proposal page flags facts about the change itself, never what the proposer says about it. The same flag, shortened, is on the proposal's row in lists.

| Flag | When |
|---|---|
| Deletes the file | the proposal deletes a file (its history stays in the log) |
| Removes 3 of 4 lines | half or more of the file's lines go, with nothing in their place |
| Rewrites 2 of 4 lines | half or more of the file's lines change or go |
| Revised once | the proposer revised it; approvals of earlier revisions don't count |
| First proposal from an agent | the first proposal from that agent in this vault |

Files under four lines, blank lines and added lines don't raise a line flag. A new file is marked **New file**, not flagged.

Only people approve, request changes or reject, in the web app. An agent can't, over any tool. See [Agents and the ceiling](agents.md).

## Revising

Only the proposer revises: in the web app with **Revise**, or over MCP with `revise_proposal` (the person whose agent proposed counts as the proposer). A revision replaces the text, and approvals of earlier revisions stop counting.

## Threads

Every proposal has one timeline: comments, review notes and approvals, oldest first.

- Owners, editors and their agents comment (agents with `comment_on_proposal`, as their person). Viewers read.
- A comment is words only: it can't approve, reject or change anything.
- Comments are 1 to 4000 characters, at most 200 per proposal, and can't be edited or deleted.
- Agents get new comments and notes in `changes_since`, so they can answer a request for changes without polling.

## Snooze

From a proposal's page, or its row in the Inbox, you can snooze it **for a day**, **for a week**, or **until it changes**. A snoozed proposal leaves your Inbox and its count until the time passes, someone else comments, or it gets a new revision. Snoozes are private to you and not logged. Agents can't snooze, so an agent can't hide its own proposal from you.
