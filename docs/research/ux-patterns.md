# UX patterns for the web UI

2026-09-24 · Status: RESEARCH. Phase 1 built 2026-09-24; phases 2 and 3 open

How established products structure the same jobs as Reliquary's web UI, and
what that means for our screens. Two research passes, sources checked
2026-09-24; claims marked *(unverified)* came from search snippets only.

## Where we are

The visual layer is done (Red Mage, light and dark; Impeccable detector
clean). The structure is a first pass:

- a flat file table;
- one proposals list per vault with Approve / Reject;
- policies on the vault page;
- tokens with no scope;
- no inbox, no rendered markdown, no connect guide, no members screen.

## Findings, by job

### Reviewing proposals

| Pattern | Who does it well | For Reliquary |
|---|---|---|
| Three verdicts: approve, request changes, reject (notes required on the last two) | [GitHub reviews](https://docs.github.com/articles/about-pull-request-reviews), [LangChain HITL](https://docs.langchain.com/oss/python/langchain/human-in-the-loop) | Today one Reject throws away nearly-right agent work. "Request changes" keeps the proposal open and sends the note back to the agent over MCP |
| Edit, then approve | [Claude Code permissions](https://code.claude.com/docs/en/permissions), [Agent Inbox](https://github.com/langchain-ai/agent-inbox), GitHub suggested changes | "Edit & approve" opens the proposed text; history records that the approver edited the agent's version |
| Evidence before claims | Claude Code (the diff *is* the prompt), [Lindy](https://docs.lindy.ai/testing/human-in-the-loop) | Diff first. The reason comes after it, as "Agent's stated reason (unverified)" |
| Rendered view and word-level diff | [GitHub diff views](https://docs.github.com/articles/reviewing-proposed-changes-in-a-pull-request), [Google Docs suggestions](https://support.google.com/docs/answer/6033474) | A line diff makes reflowed prose look rewritten, so people approve what they didn't read. Add Rendered / Unified / Split views and word highlights |
| Approvals bound to a revision | [GitHub stale-approval dismissal](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [GitLab](https://docs.gitlab.com/user/project/merge_requests/approvals/settings/) | Any change to a proposal voids earlier approvals, enforced in the database. "Stale" becomes "base changed: rebase or re-propose", not a dead end |
| One inbox across workspaces | [GitHub notifications](https://docs.github.com/en/subscriptions-and-notifications/reference/inbox-filters), [Linear Inbox](https://linear.app/docs/inbox) | A top-level **Review** page: everything waiting on you, grouped by vault, with snooze. Home leads with it |
| Risk shown as reasons | Dust high/low-stake tools *(unverified)*, LangChain per-tool interrupts | Badges computed from facts (deletes, large removals, rule files, a new agent) replace the generic "an agent proposed this" caution |
| Notify outside, approve inside | [n8n approvals](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.slack/approvals) | Later: email or Slack digests that *link* to the proposal. Never one-click approve from a message, because the diff must be on screen |

**Anti-patterns to avoid:**

- approve buttons above the diff;
- batch approval of anything but tiny, low-risk changes;
- approvals that survive an edit;
- terminal rejects with no feedback;
- notification spam instead of daily digests.

**Kept from our design, against one suggestion:** you may approve your own
agent's proposal, because the agent isn't the approver. The page will say
so plainly, so it doesn't read like peer review.

### Finding and reading files

| Pattern | Who | For Reliquary |
|---|---|---|
| Folder tree in a vault sidebar | [GitHub code browsing](https://github.blog/changelog/2022-11-09-introducing-an-all-new-code-search-and-code-browsing-experience/), [Basic Memory web app](https://docs.basicmemory.com/cloud/web-app) | `<details>` tree on every vault page, with canon/open marked per folder. No JavaScript needed |
| Folder pages with their README | GitHub | `/v/:vault/tree/<path>` lists the folder's contents and renders its `README.md`. "New file here" pre-fills the path |
| Rendered by default; Source and History one click away | GitHub Code/Blame/History, Basic Memory | File tabs: Preview (markdown rendered on the server, raw HTML disabled), Source, History. Editing gets its own page |
| Where a rule comes from, shown in the file header | [GitHub CODEOWNERS shield](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners), [Notion permission inheritance](https://www.notion.com/help/sharing-and-permissions) | "Canon, from rule on `clients/`, set by Andrés on 2 Sep", instead of a bare tag |
| Search in the sidebar | Basic Memory, GitHub "Go to file" | A GET form backed by the search function that already exists |

### Rules, members, tokens, activity

- **Rules move to Vault settings → Rules**, as with [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) and [Drive's 2025 inheritance change](https://workspaceupdates.googleblog.com/2025/09/upcoming-change-to-drive-sharing.html).
  - Path rules plus a "what applies to this path?" checker.
  - No bypass list: nothing becomes canon without a person.
- **Members** ([Vercel](https://vercel.com/docs/rbac/managing-team-members), [Stripe session revoke](https://docs.stripe.com/mcp#manage-sessions-as-an-administrator)): roles, pending invites, and the agent tokens that can reach this vault, which owners can revoke. Invites need email sign-in, so this waits for hosting.
- **Tokens** ([GitHub fine-grained](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens), [Vercel](https://vercel.com/docs/accounts/access-tokens), [Linear](https://linear.app/docs/api-and-webhooks)):
  - scoped to chosen vaults, read or read-write;
  - a required expiry;
  - last used with the client name;
  - scope can't be edited: revoke and recreate.

  This needs a database change.
- **Activity** ([Tailscale](https://tailscale.com/docs/features/logging/audit-logging), [GitHub audit filters](https://docs.github.com/en/organizations/keeping-your-organization-secure/managing-security-settings-for-your-organization/reviewing-the-audit-log-for-your-organization)): "Change log" becomes Activity, filterable by who, which agent, action, path and date, at vault and account level. A file's History is the same log filtered to that file.

### Connecting an agent

Every product with a remote MCP server has a per-client setup page:
[Vercel](https://vercel.com/docs/agent-resources/vercel-mcp),
[Stripe](https://docs.stripe.com/mcp), [Linear](https://linear.app/docs/mcp),
[Supabase](https://supabase.com/docs/guides/ai-tools/mcp).

For Reliquary, a **Connect** page with one section per client:

- Claude Code: the headersHelper we already use;
- Cursor and VS Code: install links;
- Claude.ai and ChatGPT: connector steps, which need OAuth;
- other clients: the raw URL and header.

Rules for the page:

- **No token inside any snippet or install link.** A token pasted into a config file becomes readable by the agent. Snippets reference the token file or an environment variable.
- **Show the raw JSON next to every install link.** Cursor's links are reported to break *(unverified)*.

## Proposed structure

```
Top nav:  Vaults ▾   Review (N)   Activity   Connect   Tokens        (theme in footer)

/                        Needs your review (across vaults), then your vaults
/review                  Everything waiting on you; snooze
/connect                 Per-client setup
/tokens                  Scoped tokens: create, show once, list, revoke
/activity                All your vaults, filterable

/v/:vault                Root folder: README + contents; sidebar on every vault page:
                         search · folder tree · Proposals (N) · Activity · Settings
/v/:vault/tree/<path>    Folder page
/v/:vault/file/<path>    Preview | Source | History, rule source in the header
/v/:vault/edit/<path>    Edit (open) or propose (canon)
/v/:vault/proposals      Open · changes requested · closed
/v/:vault/proposals/:id  Diff first → reason (unverified) → approve / request changes / reject / edit & approve
/v/:vault/settings/rules
/v/:vault/settings/members   (with hosting and invites)
```

## Plan

**Phase 1: structure and review.** Works locally and needs one small
migration.

1. Proposal pages:
   - evidence first;
   - approve / request changes / reject with notes;
   - edit & approve;
   - risk reasons;
   - the solo-approval note;
   - approvals bound to a revision.
2. A cross-vault Review page, and a home page that leads with it.
3. The vault sidebar with a folder tree, folder pages, file tabs, rendered
   markdown, rule source, and sidebar search.
4. A Rules settings page with the "what applies?" checker.
5. The Connect page.

**Phase 2: accounts and depth.**

- scoped, expiring tokens;
- activity filters and account-wide activity;
- word-level and split diffs;
- a comment thread per proposal that agents can reply to over MCP;
- snooze.

**Phase 3: with hosting.** Members and invites, and notification digests.
Later, the environment-variable screens: Config vs Secret, environments as
columns, a "used by" panel.
