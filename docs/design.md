# Reliquary v3: design

2026-09-24, revised 2026-10-09 · Status: built through milestone 3 and the
work started beside it; routines and everything after are still design. The
Contents table says which is which. Replaces v2 (commit `4b11c25`).

A shared vault of context, automations and credentials that people and any
agent can use, with no machine of anyone's that has to stay on.

The gate it relies on is proven in `spikes/gate/`; `pilot/` is a working
Telegram surface on the same gate. Research behind the design is in
`docs/research/`. What is built, file by file, is in [progress.md](progress.md);
the rules for working in the repo are in [AGENTS.md](../AGENTS.md).

## Contents

| # | Section | Status |
|---|---|---|
| 1 | [What changed from v2](#what-changed-from-v2) | History |
| 2 | [What it is](#what-it-is) | Overview |
| 3 | [Principles](#principles) | Overview |
| 4 | [Concepts](#concepts) | Built |
| 5 | [Identity and permissions](#identity-and-permissions) | Built |
| 6 | [Access surfaces](#access-surfaces) | Built, except service agent tokens |
| 7 | [Context](#context) | Built |
| 8 | [Path ownership](#path-ownership) | Built |
| 9 | [Notifications](#notifications) | Partly built: flags, watching and the MCP hint; not addressed notes, staleness or nudges |
| 10 | [Claims and work plans](#claims-and-work-plans) | Built, except waiting in line |
| 11 | [Threads](#threads) | Built, except export |
| 12 | [Links](#links) | Built |
| 13 | [Routines](#routines) | Designed, not built |
| 14 | [Environment variables](#environment-variables) | Built |
| 15 | [Continuity](#continuity) | Designed, not built |
| 16 | [Client engagements](#client-engagements) | Designed, not built |
| 17 | [Git mirror and export](#git-mirror-and-export) | Export built; the git mirror is designed |
| 18 | [Privacy, erasure and compliance](#privacy-erasure-and-compliance) | Erasure and deletion built; the rest designed |
| 19 | [Architecture](#architecture) | As built |
| 20 | [Data model](#data-model) | As built |
| 21 | [Hostile tests](#hostile-tests) | Built for what exists; the rest is the list to write |
| 22 | [Build order](#build-order) | Current |
| 23 | [Open decisions](#open-decisions) | Decided: 1 to 4; open: 5 and 6 |
| 24 | [Where it falls flat, and what scales later](#where-it-falls-flat-and-what-scales-later) | Reference |
| 25 | [Out of scope](#out-of-scope) | Reference |

Status is as of 2026-10-09. "Built" means shipped and tested; a section marked
so can still carry a "what this doesn't settle" list.

## What changed from v2

v2 was Andrés's personal infrastructure and a product at the same time:
thirteen AIS-OS routines moved to a VPS worker, plus shared spaces synced
into one repo. v3 separates the two.

- **Reliquary is the product.** It is a hosted vault reachable over MCP and a
  web UI. Andrés's AIS-OS is its first customer, not its design centre.
- **Customers run no servers.** v2 needed a VPS worker running `claude -p`.
  v3 routines run on Reliquary, with the customer's own model key.
- **Andrés's personal routines are out of scope.** Moving them off the
  MacBook is an AIS-OS decision (Claude Code cloud routines, n8n, or
  launchd). Any that act on shared context become Reliquary routines.
- **Secrets become a product feature:** shared environment variables per
  vault, Vercel-style, and a large part of the continuity story.
- **The gate generalises.** Access is decided by who will see the output:
  the person for their own agent, the declared audience for a routine,
  everyone present for a chat.

## What it is

```
 ChatGPT (connector) ─┐
 Claude Code ─────────┤
 Cursor ──────────────┼─ MCP ─┐        ┌──────────── a vault ─────────────┐
 Hermes (Nous) ───────┤       ├──────▶ │ context   files, canon/open, log │
 scripts, CI ─────────┘       │  gate  │ routines  automations on context │
 browser ──────── web UI ─────┤        │ env       shared variables        │
 terminal ─────── CLI ────────┘        │ links      shared upstream MCP    │──▶ Stripe, Linear,
                                       │ members   people and agents      │    any remote MCP
                                       └──────────────┬───────────────────┘
                                                      └──▶ optional git mirror
```

Five jobs:

1. **Share context across people and whatever agent each one uses.** A
   ChatGPT user and a Claude Code user read and propose to the same
   approved context.
2. **Automate on that context without anyone's machine.** A routine runs on
   a schedule or on a change, reads through the gate, and produces an
   artifact.
3. **Build with the same accounts, and survive losing a person.** Shared
   variables, access logs, and emergency access mean the team and their
   agents can carry on.
4. **Share tools, not keys.** A vault holds links to other MCP
   servers with the team's credentials. Members' agents and routines use
   those tools through Reliquary and never see the credential.
5. **Run client engagements without email.** A client hands over context and
   credentials into a vault instead of an inbox, and gets it all back, or
   gone, when the work ends.

## Principles

1. **Any agent, any model.** One MCP URL for every client. Routines run on
   the vault's own model key. No feature requires a specific vendor.
2. **The database enforces access.** Every rule in the access table is RLS
   or a trigger, and every rule has a hostile test.
3. **Your agent is you, minus a few things.** An agent connected by a person
   acts with that person's permissions, except the actions that need the
   person present ([Identity and permissions](#identity-and-permissions)).
4. **Canon needs people; open is open.** Files marked canon change only
   through a proposal approved by the required number of people. Files
   marked open can be written by any member or agent allowed to write.
   Every change to either is logged.
5. **Secret values never enter model context.** Not through MCP, logs,
   change events, errors, or routine prompts. Where a value must reach a
   process, say plainly what that process can do with it.
6. **Verify the artifact.** A routine run is only `ok` when it reports what
   it produced.
7. **Your data can leave.** Export and git mirror from day one; self-hosting
   stays possible. A vault must outlive any one person, Reliquary included.
8. **Nobody's machine has to stay on.** Nothing a vault needs runs on a
   member's laptop.
9. **Good over perfect.** Build the smallest version that holds the
   guarantees above. Note where it will need to scale, and don't build that
   yet ([Where it falls flat](#where-it-falls-flat-and-what-scales-later)).
10. **Say who each surface is for.** What a person reads or acts on leads
    the web UI. Logging for diagnosing a problem stays reachable under
    Diagnostics, never deleted and never the front door. The parity rule
    says what each side may do, not what each side should be shown
    ([Who each surface is for](#who-each-surface-is-for)).

## Concepts

- **Account.** A person, signed in with email or OAuth. Accounts own
  nothing directly; vaults do.
- **Vault.** The container: members, context, routines, environment
  variables, and an append-only log. A team, a client, or a project each
  gets its own vault. (v2 called it a space.)
- **Member.** An account with a role in a vault: `owner`, `editor` or
  `viewer`.
- **Agent connection.** An MCP client a member authorised through OAuth. It
  acts *as that member*, with the delegation limits below. Attributed as
  "Claude Code for Andrés".
- **Service agent.** A headless agent with its own token and explicit
  grants, not tied to a person: CI, a Hermes instance on a server, a chat
  bot.
- **File.** A unit of context: markdown at a path, in folders
  (`clients/acme/brief.md`). Files are what agents read and write.
- **Policy.** Every file is `canon` or `open`, set on the file or inherited
  from its folder:
  - **canon:** changes only through a proposal approved by the folder's
    quorum of people (default 1). Presented to agents as approved fact.
  - **open:** any member or agent with write access edits it directly.
    Presented as attributed and unconfirmed. Chat remarks, routine output
    and scratch work live here, and open folders can set an expiry.
- **Proposal.** A suggested new file, edit, move, or retraction of a canon
  file, waiting for approvals.
- **Link.** A remote MCP server plus the credential to reach it,
  stored in the vault. Members and routines use its tools through
  Reliquary. Not to be confused with an agent connection (above): a link is
  Reliquary reaching *out*, a connection is a client reaching *in*.
- **Routine.** A declarative automation inside a vault: a trigger, a
  prompt, an audience, and outputs.
- **Environment.** A named set of variables in a vault (`development`,
  `preview`, `production`, or custom), like Vercel's.
- **Log.** Every change to a vault, append-only, with a monotonic sequence
  number for the feed.

## Identity and permissions

### Roles

| Action | owner | editor | viewer | service agent |
|---|---|---|---|---|
| Read context | yes | yes | yes | if granted |
| Write open files | yes | yes | no | if granted |
| Propose changes to canon files | yes | yes | no | if granted |
| Approve or reject (counts toward quorum) | yes | yes | no | never |
| Set a file or folder's policy and quorum | yes | no | no | never |
| Use a link's tools | if granted | if granted | if granted, read-only tools | if granted |
| Add or edit links | yes | no | no | never |
| Create and edit routines | yes | yes | no | never |
| Use environment variables (pull, run) | if granted | if granted | no | if granted, per environment |
| Reveal a variable's value in the UI | if granted | if granted | no | never |
| Manage members, grants, emergency access | yes | no | no | never |
| Export, configure git mirror | yes | no | no | never |

### Delegation: agents act as their person, with a ceiling

When Andrés's Claude Code calls Reliquary, the session carries two
identities: the agent and the person it acts for (an RFC 8693 `act` claim).
RLS checks both.

The agent gets the person's permissions **except** the actions that are
irreversible, grant trust or reveal a secret, which need the person present in
the web UI. The list is kept in one place, [Agents and the
ceiling](public/concepts/agents.md#the-ceiling). The first four were
approving or rejecting proposals, revealing a variable's value, managing
members, grants or emergency access, and deleting a vault or exporting it.

**Why the ceiling:** an agent reads text other people wrote. Prompt
injection turns any permission the agent holds into a permission the
injected text holds. The ceiling keeps the few irreversible or
trust-granting actions behind a human click. Everything else is open to
their agent: reading, writing open files, proposing canon changes, and using
granted links.

**Quorum.** A canon change lands when it has approvals from the folder's
quorum of distinct people. The proposer's own approval counts, but only as
a click in the UI; their agent's proposal is not their approval. Agents
never count. In a one-person vault this means "my agent proposes, I tap
approve".

### The gate: filter on who will see the output

Every read resolves an **audience**, and returns only what everyone in it
may see:

| Caller | Audience |
|---|---|
| A member's agent, or the member in the UI | that member |
| A service agent | its grants |
| A routine | the audience it declares (e.g. the vault's editors, or one channel) |
| A chat surface (group) | everyone present, intersected (`pilot/`) |

This is the rule proven in `spikes/gate/`, with 63 hostile tests and p95
under 6 ms at 200k rows.

## Access surfaces

- **Remote MCP.** One URL for every vault (`/mcp`, with the vault an argument
  to each tool), with OAuth 2.1 as the MCP authorization
  spec (2026-07-28) requires: protected resource metadata, audience-bound
  tokens, no token passthrough. It works with ChatGPT connectors, Claude
  (Code, desktop, web), Cursor, Hermes and anything else that speaks remote
  MCP. Setup is paste the URL and sign in.
- **Service agent tokens.** For headless agents that can't do an OAuth
  dance. Tokens are hashed, scoped, expiring and revocable, and are traded
  for short-lived sessions (the minting design in `spikes/gate/`).
- **Web UI.** Browse, search, edit, review proposals, manage routines,
  environment variables, members and the log. This is where the
  human-present actions happen. It has to work on a phone.
- **CLI.** `reliquary env pull`, `reliquary run -- <cmd>`,
  `reliquary feed pull`, `reliquary export`.
- **REST.** The same shapes as MCP, for scripts.
- **Later: chat surfaces.** Telegram first (`pilot/`), using the
  intersection gate.

### MCP tools

| Tool | Notes |
|---|---|
| `search` | Full text first; embeddings when it proves too weak |
| `read_file`, `list_files` | Text returned as quoted data with its policy, author and approvals |
| `changes_since` | The feed: events after a cursor, oldest first |
| `write_file` | Open files only; refused on canon files with a pointer to `propose` |
| `propose` | New file, edit, move or retraction of a canon file, with a reason |
| `list_proposals` | Pending and recent |
| `list_routines`, `routine_runs` | Status and artifacts |
| `list_variables` | Variable names and which environments they are in. **Never values** |
| `<link>.<tool>` | Each granted link's tools, proxied (see [Links](#links)) |

This table is the original sketch. The tools that exist are the contract in
`mcp/test/contract.snapshot.json`, published as
`docs/public/reference/mcp-tools.md`; `list_routines` and `routine_runs`
are not built.

No MCP tool returns a variable's value or a link's credential, on any
scope.

### Who each surface is for

Settled 2026-10-02 (owner's decision), built 2026-10-03 (#120 to #125): a
vault's sidebar leads with what a person reads or acts on, and Flags and
Claims sit under Diagnostics. Until then it listed Activity, Flags and
Claims right after Proposals.

A vault has two audiences, and the web UI keeps them apart:

- **A person** is looking for something to read or to act on: the work
  agents are doing, the conversation about it, what changed, what waits
  for their review. That leads the primary navigation and each page's
  default view.
- **Diagnosing a problem** needs logging: the full event log, the flags a
  connection was shown, the claims table. It stays reachable, one click
  away under a Diagnostics area, and is never deleted.

This needed saying because [parity.md](parity.md) asks for every agent
capability on both surfaces. That answers "may they?", not "would a person
want it?". Flags, claims and activity are logging functions that were
mirrored into the web UI because the table asked for them there.

What follows from it:

- **Existing URLs keep resolving.** `/v/:id/activity`, `/v/:id/flags` and
  `/v/:id/claims` are linked from docs and bookmarks.
- **Activity splits in two.** A plain-language Changes feed holds the
  content events a person cares about. The full log stays under
  Diagnostics.
- **Flags stay as they are** ([Notifications](#notifications)). MCP has no
  push, so an agent learns things on its next tool call. The word "flag"
  leaves the primary UI.
- **Two vocabularies, on purpose.** The web UI says Tasks, Threads,
  Changes and Diagnostics. MCP tool names and SQL keep `work_plan`, `step`
  and `claim`: the design avoided `task` on the tool side because an
  MCP-spec extension uses it ([Claims and work plans](#claims-and-work-plans),
  item 1). A plan's steps are shown to people as tasks.

## Context

- **Files** are markdown at a path, with optional tags. Folders exist as
  path prefixes, with a policy record where one is set.
- **Policy is inherited:** a file's own setting wins, then the nearest
  folder's, then the vault default (`open` unless the person chose
  `canon` when making the vault or later in Settings). Changing a policy
  is itself a logged event.
- **Moving an open file into canon** (for example, promoting a chat remark)
  is a proposal.
- **Every version is kept, and every change is logged.** `file_versions`
  stores each version's full text; the log records the change and the version
  it made, and a diff is computed when it is shown. A restore action is
  not built.
- **The feed** has one call, `changes_since(vault, cursor)`, over MCP; the web
  app's Changes and Log read the same events. A REST feed and a CLI `feed`
  command are not built. Deletions and retractions appear as events, never
  as gaps.
- **File text is data.** Every surface wraps it as quoted content with its
  policy, author and date. Proposals that address an AI system are flagged in
  review.

## Path ownership

Written 2026-09-28, an addendum settled the way [Links](#links)'s was,
before it was built, and built the same day
(`20260928130000_path_ownership.sql`, [progress.md](progress.md)). A folder
or file can name specific people as its owners, narrowing `policy_for` from a fixed per-path setting to one
that depends on who's asking:

- **For a path's named owners**, the path is **open**: they, and their
  agents, write it directly, no proposal.
- **For everyone else** with write access to the vault, the same path is
  **canon**: they propose, and it lands once enough of the *named owners*
  approve.

This is "approver groups per folder", already named in [Where it falls
flat](#where-it-falls-flat-and-what-scales-later) as a later-scale item,
brought forward on the owner's call (2026-09-28), alongside Links rather
than after it. It replaces neither canon nor open as policies: a path
with no named owners behaves exactly as today.

### Who can be an owner

A path's owner list may include anyone who is a member of the vault,
**including a viewer** (owner's decision, 2026-09-28): naming a viewer a
path's owner promotes them to write access for that path alone; they stay
a viewer everywhere else in the vault. Path ownership is about who's
responsible for this content, not a side door into a broader role.

### Quorum draws from the owner list

Today `decide()` counts an approval from any member with write access to
the vault. A path with named owners counts only approvals **from that
list** toward its quorum, same mechanics otherwise: the folder's quorum
is still a headcount, just within the narrowed group; the proposer's own
approval still counts only as a UI click; agents never count.

### Guardrails (owner's call, 2026-09-28)

- **Confirm before granting.** Naming someone a path owner is a bigger
  trust delta than ordinary editor access: it hands their agent
  unsupervised, no-review write power over a shared region of the vault.
  The web app requires an explicit confirm step (typed name or a second
  click, matching the delete and rotate pattern elsewhere), never a quiet
  toggle in a form.
- **No vault-wide override.** The `owner` role's existing powers (rename,
  delete, export, members) are a fixed, enumerated list, per [Identity and
  permissions](#identity-and-permissions); they don't swallow path
  ownership. A vault owner who isn't a named path owner still proposes on
  that path like anyone else.
- **Break-glass reuses Emergency Access**, not a new mechanism, if one is
  ever wanted: a named trusted member requests it, it grants after a
  waiting period unless declined, and it is logged, per
  [Continuity](#continuity). No dedicated override path exists yet.

### Data model, as built

- `public.path_owners(vault_id, path, user_id, added_by, added_at)`, one row
  per (path rule, owner), keyed on the first three and referencing
  `public.path_policies (vault_id, path)`: a path needs a rule before it
  can have an owner.
- `private.policy_for(vault, path)` keeps its signature (policy and quorum)
  and reads the caller: a named owner gets `open`, everyone else the rule.
  `private.can_write_path(vault, path)` is `can_write(vault)` plus the
  path's named owners, and replaces `can_write` in `write_file`,
  `delete_file` and `decide`.
- `decide()`'s quorum count is filtered to the owner list only when a
  path has one.
- Granting and revoking ownership: `set_path_owner` and
  `remove_path_owner`, owners only, in person (`require_human`), logged as
  `path_owner.add` and `path_owner.remove`.

### Open questions this doesn't resolve

- ~~Whether an owner list attaches to a `path_policies` row.~~ It does:
  naming an owner needs a rule on the path first.
- ~~Whether removing someone from a path's owner list is itself
  owner-list-gated.~~ It is vault-owner-only, matching who sets the rule.
- How the web UI surfaces "you're an owner of this path" distinctly from
  "you're a vault editor", so nobody mistakes narrower-than-they-think
  access for broader, or the reverse.

## Notifications

Written 2026-09-28, alongside [Path ownership](#path-ownership) above,
settled the same way. Built since: watching, flags and the MCP hint (below);
not built: addressed notes, working-set staleness and nudges. Agents connect
over MCP, which is request/response with no push, so "notified" means **flagged on the
agent's next tool call**, whatever call that happens to be. The web app
already computes most of this for people, in `shell_summary` (the
Inbox's data source): proposals waiting on your review, your own
proposals sent back, pending imports, invites and deletion notices. This
section is mostly about giving an **agent** the same thing over MCP, with
two genuinely new categories alongside it.

### Four categories

| Category | What it flags | Opt-in? |
|---|---|---|
| Direct address | A note or file addressed `to:` you | No, always surfaced |
| Working-set staleness | A file you recently read, or a proposal you have pending, changed under you | No, tied to your own recent activity |
| Standing responsibility | A proposal is waiting on you specifically (a vault owner, or a path's named owner) | No, always surfaced: it's blocking on you |
| Subscriptions | Tags or paths you chose to watch | Yes, off by default |

Only the fourth is a standing preference. The other three follow from
what you already are (an owner, a required approver) or already did
(read this file, opened this proposal); nothing to configure.

### A separate watermark

Notification state needs its own **last-notified** marker per identity
(a person, or a specific agent connection), distinct from
`changes_since`'s feed cursor: the feed is "what changed", notifications
are "what changed that you haven't been told about yet". It advances the
moment a flag is actually shown in a response, not on request, so a call
that errors before returning, or a client that discards the response,
doesn't lose the flag.

### Addressed notes

Not a new object type. An open file (or a log entry, for something
transient) with a `to:` field naming one or more members. Content is not
private: anyone who can read the vault reads it, same as any open file.
Addressing controls only whose *notification* queue it lands in, never
who can see it. Two people wanting an actual private side-channel are
asking for something this vault doesn't offer, and the model says so
rather than pretending to.

### Proactive approval nudges

Folds entirely into "standing responsibility" above; no separate
mechanism. An agent that sees a pending-approval flag may say so and link
straight to the proposal, saving its person a search. This changes
nothing about the ceiling: **the agent still can't approve**, whatever the
flag says or whatever a proposal's own content tries to suggest. Worth
stating plainly because "agent nudges its person about a proposal" sits
one prompt-injection away from someone assuming the nudge means the agent
can act on it. It can't, structurally: `decide()` refuses without
`require_human()` regardless of any flag, note or nudge that preceded the
call.

### Not "notify"

Routines already have a `notify:` output (a webhook, e.g. `{ channel:
discord, webhook: env:... }`): an outbound send to something outside
Reliquary. This is a different, inbound-to-the-agent mechanism, and needs
its own word rather than reusing "notify" the way "connection" briefly
meant two things. Working name: **flag** ("a proposal is flagged for
you"). Not settled if a better word turns up before this is built.

### Data model, as built (schema and SQL functions, 2026-09-28)

`20260928150000_flags.sql`, hostile tests in `supabase/tests/flags_test.sql`:

- `public.flag_watermarks(id, user_id, vault_id, token_id, last_seq,
  updated_at)`. Built without the sketched `identity_kind`: a real foreign
  key to `access_tokens` (null for the person in the web app) already
  distinguishes a connection from the person, and a deleted connection
  takes its watermark with it (`unique nulls not distinct (user_id,
  vault_id, token_id)`) rather than leaving an orphaned `identity_id`.
- `public.list_flags(vault, limit)` (also the `list_flags` MCP tool)
  returns categories 2 (your own proposals, and one whose base file
  changed under it), 3 (`shell_summary`'s review set, reused rather than
  redefined) and 4 (watched paths), oldest first, and never moves the
  watermark itself.
- `public.advance_flags(vault, through)` is the separate call that moves
  it, forward only, never past the vault's latest entry, matching "a flag
  advances when it's shown, not on request" above.
- Working-set staleness for files you've read, and category 1 (addressed
  notes), are still not built; see below.
- Subscriptions: `public.subscriptions(id, user_id, vault_id, kind,
  target, created_at)`, `kind` `'path'` built (a folder or a file);
  `'tag'` is accepted by the column but refused by `create_subscription`
  (22023), since no migration gives files tags yet, so a tag subscription
  could never match anything.

### Delivery over MCP: a hint, not the flags (settled 2026-10-02)

Flags don't ride in every MCP response; a one-line hint does. When flags
wait for the calling connection in the vault a successful call named (or
a named proposal's vault), the server adds one fixed line with the count:
"Reliquary: 3 flags are waiting for you in this vault. Call list_flags."
The server's instructions at initialize say what to do with it:
`list_flags`, show the person, `advance_flags`.

Why: `list_flags` alone reaches only an agent that thinks to call it, and
a `flags` field on every response would cost every call bytes and carry
text people wrote outside each tool's fences. The hint reaches any agent
that makes a call, costs nothing when nothing waits, and holds only the
server's words and a number, so it can't be an injection channel. It moves
no watermark. The count is `public.flags_waiting`, which calls
`list_flags`, so who is flagged stays defined in one place. It can't wake
an idle agent: MCP has no push, so an agent learns on its next call.

### Open questions this doesn't resolve

- Whether subscriptions are person-only to create (matching variables and
  rules) or an agent may create one for its person: a read-scoped,
  reversible action, unlike everything actually on the ceiling, so it
  doesn't obviously need a human in the loop the way approving or
  revealing a secret does. Built person-only for now, the safer default,
  not a final answer.
- Working-set staleness's exact trigger: does re-reading a file that
  changed clear its own staleness flag, or does it need an explicit
  acknowledgement? Moot until staleness-from-reads exists at all: nothing
  logs a read today (`read_file`, `list_files`, `changes_since` are plain
  selects), so category 2 covers only your own proposals for now.
- A snooze that runs out on its own returns a proposal to the Inbox but
  doesn't raise a fresh flag for it, since nothing is logged when a
  snooze ends. A snooze someone else's comment interrupts does re-flag
  it, because the comment itself is a logged event.

## Claims and work plans

Written 2026-09-30, settling CL-0.2 of the claims, waiting and work
plans effort (tracking issue #52; the exception is logged in
[progress.md](progress.md#decisions)). Built as of 2026-10-09: phase 1 (compare-and-swap writes), phase 2 (claims)
and phase 3 (work plans), apart from waiting in line (item 11, CL-3.9, #74);
[progress.md](progress.md) has what shipped. Validated first in a throwaway
PostgreSQL 16 model, not Reliquary's schema and with no RLS: [spikes/claims/](../spikes/claims/README.md).
Twelve points, each with the reason it was decided that way.

### 1. Names

`work_plan`, `step` and `claim`, not `plan` (already a billing plan,
[Plans and limits](public/concepts/plans-and-limits.md)) or `task` (an
MCP-spec extension). Tools: `claim_path`, `renew_claim`, `release_claim`,
`list_claims`, `register_work_plan`, `work_plan_status`, `claim_step`,
`complete_step`, `release_step`, and person-only `break_claim`,
`cancel_step`, `skip_step`: the last three follow the same ceiling as
approving and revealing a secret, an agent's role never executes them.

### 2. Ownership proof and identity

A connection is not a session: two browser windows, or two agent
processes, sharing one token or one person look identical to the
database unless something distinguishes them. `claim()` returns a random
secret once; only its hash is stored, the same shape as a link's
credential or an access token. Renewing, releasing or completing a claim
needs that secret, the claim's fence (a counter that bumps on every
grant, so a stale holder that wakes up after a reclaim can't mistake
itself for the current one), the same connection and the same person.
Both identities come from the request's own verified claims (the token
id and the user id), never an argument the caller supplies, the same
reason `private.uid()` and `private.agent()` already work that way
everywhere: an argument is something a caller can lie about. The
holder's label (what shows on the Claims page) is self-reported and
quoted as data, never trusted for identity.

### 3. Claim rules

How long a claim holds exclusive use of a path is a rule, not a
constant: a vault default plus optional overrides by path prefix, the
same specificity resolution `path_policies` already uses (exact path,
then longest folder prefix). Default 48 hours. Every check-in restarts
the lease, so a working agent never loses its claim mid-task and a
silent one loses it after exactly one lease, with no cron dependency:
expiry is judged by the database clock the next time anyone tries to
claim, the same lazy-expiry pattern access tokens and OAuth grants use.
A caller may ask for a shorter lease, never a longer one than the rule's
maximum, and never below one minute (shorter is indistinguishable from a
caller bypassing the point of leasing at all). No amount of checking in
holds a claim past the rule's hold limit, so a claim can't be kept alive
forever. Only a person, in the web app, sets rules: an agent never can,
matching who sets folder rules and variable grants today.

Three presets ship as starting points, to tune once the pilot shows a
problem, not because they were measured: **Hackathon** (lease 30
minutes, longest check-again hint 1 minute, place in line 15 minutes),
**Team** (8 hours, 15 minutes, 2 hours), **Org** (48 hours, 1 hour, 6
hours). The rule also carries the guard settings of item 12 below: the
minimum gap between full evaluations (starting point a quarter of the
longest hint), the most steps one connection may hold (1) and one
person's agents together (5), the hold limit (Org: 7 days), the free
lapses before a cooldown starts (1) and the cooldown's cap (the lease
itself). Total load is agents divided by the gap, so the default gap is
long (minutes) and a short one is opt-in per vault, bounded below by a
floor (starting point 10 seconds): the spike's own load numbers (below)
are why, since a short gap multiplies the call rate directly.

### 4. Who may claim

Whoever can write the path, the same `can_write_path` check `write_file`
already runs, so a claim never grants access a write wouldn't already
have. A read-only connection cannot claim, for the same reason it cannot
write. Breaking someone else's claim needs a person present
(`require_human`), the same ceiling as revealing a secret or managing
members: an agent can walk away from its own claim, never force another
one open.

### 5. Claims do not block writes

Compare-and-swap (shipped, phase 1) protects the *write*: it refuses a
save whose base changed underneath it. A claim says who is *working* on
a path: a courtesy and a coordination signal, not an access gate. The
two are independent on purpose: a claim without a write still expires
harmlessly, and a write without a claim still has to pass its
`expected_version` check. A later per-folder rule could require a claim
before a write is accepted at all, but that's a new rule to add later,
not something this phase does.

### 6. Plan format

A fenced block in the plan file itself, not a separate table a person
never sees while reading the plan: the same reasoning that put path
rules in a UI form rather than a sidecar file. A strict, small syntax
(the grammar itself is settled in CL-3.1, not here). Registration reads
the file's *current* version and refuses anything but an approved
(applied) version on a canon path, so a plan can't be registered from a
draft still awaiting review, or from a version a concurrent edit already
superseded.

### 7. Step states

Stored: `open`, `claimed`, `done`, `cancelled`. Computed, never stored,
so nothing can drift out of sync with the graph: `ready` (open, every
blocker done), `blocked` (open, a blocker not done yet),
`blocked_by_cancelled` (a blocker is cancelled, so it can never become
done). A cancelled step never counts as done: a step waiting on it
stays blocked forever unless a person cancels it too, matching the
spike's own finding that a cancelled blocker needs its own computed
state, not a silent pass-through. A step may carry `gate: review`, which
holds its dependents until a person approves it directly or its linked
proposal is applied, for a step whose output needs a person's judgement
before anything downstream should start, not just before it's marked
done.

### 8. Limits

Categories needing a first-release default: active claims per vault,
steps per plan, blockers per step, label and title length, one place in
line per person per plan, a cap on a person's places across the vault,
and the MCP rate limit. All chosen without measurement, the same spirit
as the presets in item 3, meant to change the moment the pilot shows a
problem. The rate limit is settled with numbers, because the spike
measured it directly: `request_work` gets its own bucket of 30 calls a
minute per token (the general limit stays 120, untouched), each vault
gets a budget of 300 `request_work` calls a minute across all its
people and agents together, and the default gap between full
evaluations is 15 minutes with a 10 second floor (item 3).

**Confirmed, 2026-10-02** (owner's call, before CL-3.1 built against
them): the other categories above (active claims per vault, steps per
plan, blockers per step, label length, title length, and the per-person
place-in-line cap) had no chosen number as of CL-0.2. Proposed there by
analogy with the nearest existing limits (`REASON`'s 4000 characters for
a proposal reason or comment; a vault name's 100 characters;
membership's 20 invites an hour) and confirmed as starting points, not
measurements, same spirit as the presets in item 3: a label of 200
characters (already shipped this way in phase 2's `path_claims`), a
title of 200 characters, 500 active claims per vault, 500 steps per
plan, 50 blockers per step, and 3 places in line per person across a
vault.

### 9. Events

One dot each, matching the existing activity-label convention
(`file.write`, `proposal.approve`): `claim.grant`, `claim.renew`,
`claim.release`, `claim.break`, `claim.expire`, `work_plan.register`,
`step.claim`, `step.complete`, `step.release`, `step.cancel`,
`step.skip`, `queue.join`, `queue.leave`, `queue.expire`.

### 10. Export, erasure, deletion

Claims and steps are state, not content: they describe who's doing
what, not a vault's substance, so neither is exported, the same
distinction export already draws for the log. `delete_vault` removes
them, cascading the same way memberships and variables already do.
`erase_file` releases any claim on the path it erases, since a claim on
a path whose content no longer exists is meaningless. The log keeps its
entries regardless: append-only means append-only, and a claim's
history is exactly the kind of "what happened" the log exists to
answer.

### 11. Waiting without spinning

Asking for work (`request_work`, the tool behind the tickets in item 3)
always answers at once, never blocks, in one of: `granted`; `wait` (the
agent's place in line, how many steps are ready, and a suggested time to
check again); `at_capacity` (finish or give back what you hold first);
`cooling_down` (with how long); `blocked_by_cancelled` (a person has to
act, stop polling); `plan_complete` (stop polling); `refused` (too many
places in line already); `no_such_plan`. A waiting caller holds a place
in line. The fairness rule: the k-th oldest *live* place may claim only
if at least k steps are ready, first come, first served, and no step
sits idle while fewer agents are waiting than steps are ready. A place
stays live only while its holder keeps checking in, within the rule's
place-in-line time, so an agent that vanishes drops out of line and one
that returns late starts at the back, never cutting in ahead of whoever
waited. The suggested time is the earliest claimed step's lease end,
capped by the rule's longest hint, a suggestion, not a promise: a step
can finish earlier. The server cannot wake a sleeping agent: nothing
here can push, so the tool descriptions have to tell the agent plainly
to stop and return at the suggested time; bringing it back is the
agent's own harness's job, or a person's, the same limit MCP's
request/response shape already puts on [Notifications](#notifications).

### 12. The agent is not trusted

No rule may depend on an agent behaving, and none needs a model: every
one is a predicate the database checks in the same statement as the
change, the same design principle [Notifications](#notifications) and
every access rule already follow, taken further here because claims and
work plans are coordination machinery an agent could otherwise game to
starve others of work, not just a single path's access:

- **(a) One way in.** An agent's database role executes only the
  agent-facing functions (`agent_request_work`, `agent_complete_step`,
  `agent_checkin_step`, `agent_release_step`, `agent_leave_queue`, and
  their claim equivalents) and holds no privilege on any table directly;
  a function that ignores the queue is simply not executable by that
  role, so there is no path around the rules to find.
- **(b) Identity from the session, never an argument** (item 2, applied
  here too).
- **(c) A step is claimable only if** it is open or its lease has
  lapsed, its *stored* count of unfinished blockers is 0, the caller's
  person is next in line by the rule of item 11, and neither the
  connection nor the person is over its cap, all four checked in the
  one statement that grants the claim.
- **(d) Cheap refusal.** A caller that comes back before its minimum gap
  gets its last answer from one indexed read and writes nothing: the
  spike's own numbers (below) are why this matters, since without it a
  hammering caller costs as much as a real evaluation.
- **(e) The unit of fairness is the person, not the connection or the
  agent.** One place in line per person per plan; one cap on what a
  person's agents hold together; a claim that lapses unfinished is a
  strike against the *person*, not the connection that happened to hold
  it. The first lapse is free; later ones earn a cooldown that doubles
  up to a cap; finishing a step clears the count. Keying by person
  rather than connection is the one change the spike's own hostile-crowd
  run found necessary: keyed by connection, a crowd spread across many
  connections got its share of every grant even while the fairness rule
  was followed to the letter, the finding that changed the design, per
  the spike's results.
- **(f) Readiness is a stored count**, decremented in step order when a
  blocker completes, never a live join across the plan's edges: a
  step's claimability never depends on reading another plan, and a test
  checks the stored counts against the graph's actual state after every
  scenario, the same invariant-checking habit `storage_scan` already
  brings to the byte counter.
- **(g) Refreshing a place in line changes no indexed column**, and the
  table keeps spare room, so polling for status never grows an index,
  the same "reading shouldn't cost like writing" instinct behind (d).

**Validated in the spike** (full numbers in `spikes/claims/README.md`):
10,000 contended claim attempts on 200 paths gave exactly 200 grants,
against 14 to 40 duplicates for a naive read-then-write version. A
120-step dependency graph under crashes had 0 claims past an unfinished
blocker; with the gate removed, 221. Following the suggested wait time
made about 25 times fewer calls with abandoned claims and about 11 times
fewer without. The hostile-agent design's 70 assertions across 15 groups
all passed, and removing any one of its 15 guards in turn broke a named
assertion: 15 of 15 caught, re-verified when the spike was installed
into this repo (CL-0.4). At 100 agents asking as fast as they can, the
guarded design held 53,992 calls a second at 1.9 ms against 6,172 at 16
ms for the earlier, connection-keyed one; the same shape held at 500
agents and across 5,000 simulated vaults.

### What this doesn't show

- **The hosted path.** Nothing in the spike goes through the MCP server,
  the serverless functions or Supabase's transaction-mode pooler. The
  existing per-token limit (120 tool calls a minute, `mcp/src/ratelimit.ts`)
  already bounds a single hostile connection to 2 calls a second
  regardless of anything claims add; each call costs about 3 pooler
  round trips today (`docs/research/server-load.md`'s own measured
  count), so that total is the ceiling CL-3.10/CL-3.11's load tests need
  to measure, not the SQL.
- **RLS and this project's own tables.** The spike's agent role stands
  in for the eventual API role; Reliquary's real tables, foreign keys
  and RLS policies aren't there.
- **Real agents.** Whether one actually follows a suggested check-again
  time, rather than polling anyway, is what the hand-run pilot (CL-0.3)
  has to show: the spike can only prove the server-side mechanics are
  sound, not that an agent behaves.
- **Busywork that looks like progress.** A check-in can't be told apart
  from real work; `max_hold` bounds how long that can go on, but nothing
  here detects it.

**Accept:** every item above has a decision and a reason. Item 8's limits
were confirmed on 2026-10-02.

## Threads

Written 2026-10-02 (owner's decision), built 2026-10-03: the database (#126),
flags for messages (#127), the web page (#128) and the MCP tools (#129).
Not built: threads in a vault's export. A thread is where people and their
agents talk about the work. A vault had no such place: a proposal's comments exist only on that proposal,
and notes addressed `to:` someone are not built
([Notifications](#notifications)). Ten points, each with the reason it was
decided that way. "Task" below is a work plan's step as people see it
([Who each surface is for](#who-each-surface-is-for)).

### 1. What a thread is

A conversation inside one vault: a title, an optional anchor and messages
in order. The anchor is one thing at most: a file path (the file need not
exist yet), a task or a proposal, the last two in this vault. A task
anchor is the plan step's id. People open threads and post to them, and so
do their agents. Each message is attributed to the
person and, where one acted, the agent, the same attribution every other
write carries. A thread never spans vaults.

Why a new object: neither existing place fits. A conversation about a
task, or about work with no proposal behind it, has nowhere to live.

### 2. Never private

Every member who can read the vault can read every thread. There are no
private threads and no way to hide a thread from the vault's members.
Someone who needs privacy takes it outside the app.

Why: [Notifications](#notifications) already declines a private
side-channel for addressed notes and says so rather than pretending to.
This is the same stance. It also keeps the access rule for threads to one
line: read the vault, read its threads.

### 3. Side threads

A thread may be addressed to specific members, up to 20, viewers included.
Who it is addressed to is fixed when it opens. Addressing controls only
who is notified, never who can read. A thread with no addressees is
vault-wide: every member's connections are flagged about it. A thread
addressed to some members flags only them. A side thread stays listed and
readable, with a visible marker. The default listing is the vault-wide
threads, the threads addressed to the caller's person and the threads that
person opened, and an option adds the rest. An agent doing active work
need not watch side threads. When it needs one, the content is there to
parse.

Why: not every conversation concerns every agent, and a flag is what
interrupts one. Addressing narrows who is interrupted. If it also narrowed
who can read, it would be item 2's private thread under another name.
The addressees are fixed because a thread changes only by being resolved
or reopened, so what the log and every flag said about who was told stays
true. Past 20, the whole vault is the better audience. A viewer can be an
addressee: they can read a thread and be told about it, though not post.

### 4. Who may post

Owners and editors post. An agent posts as its person and needs a
read-write connection. Viewers read, and so do read-only connections. The
same people resolve a thread and reopen it, and a resolved thread refuses
new posts until it is reopened.

Why: it is the rule for comments on proposals, so there is one split to
learn, and a read-only connection cannot write anything anyway. Resolving
and reopening are reversible and logged, so neither sits behind the
ceiling.

### 5. Messages are data

Messages are append-only. To an agent a message is data: it comes back
quoted, with its author and time, never as an instruction. A message may
mention a proposal or a task. It cannot decide, approve, reveal, break a
claim or cancel anything. The ceiling ([Identity and
permissions](#identity-and-permissions)) is untouched: approving,
revealing a variable's value, managing members, and deleting or exporting
a vault, plus breaking a claim and cancelling or skipping a step, which
stay a person's in the web app. "A flag is never permission" applies to
messages too.

Why: an agent reads text other people wrote, and a thread is made of that
text. If a message could carry authority, whoever wrote it, or injected
text that made an agent write it, would hold every permission the
reader's agent holds. That is the reason for the ceiling. So nothing that
decides, reveals, breaks or cancels takes a message, or anything parsed
from one, as input. Append-only keeps on the record what an agent acted
on or a person agreed to. The one exception is redaction (item 7).

### 6. Delivery is flags, nothing live

An agent learns of a message through flags and nothing else. There is no
push and no real time: MCP is request and response, so an idle agent sees
a message on its next tool call, not instantly. Product copy says so
plainly. Left out on purpose: typing indicators, read receipts, presence,
reactions, edits, attachments, email notifications, cross-vault threads
and direct messages.

Why: the server cannot wake a sleeping agent (see
[Notifications](#notifications) and item 11 of [Claims and work
plans](#claims-and-work-plans)), so presence, typing and receipts would
show what nobody can know. Edits would rewrite what was said (item 5).
Direct messages and cross-vault threads are the private and cross-vault
channels items 1 and 2 rule out. The rest is principle 9: the smallest
version that holds the guarantees.

The log records `thread.open`, `thread.post`, `thread.resolve`,
`thread.reopen` and `thread.redact` with the thread's id and, where there
is one, the message's. It never carries a title, a message's text, an
anchor's path or a proposal's id. `list_flags` flags a log row's path to
whoever watches it and its proposal to that proposal's author, so a row
that carried either would tell people about a side thread not addressed to
them. The flag category for threads keys on the row's `detail.thread`
instead.

### 7. Redaction

A person can paste a secret into a thread, and append-only collides with
that. The owner, a person in the web UI (`require_human`), may redact a
message: its body is blanked and a log event records it. This is how
`erase_file` treats content. Messages are insert-only like
`file_versions` and `proposal_notes`, except for one operation that blanks
the text and stamps the row, and a trigger refuses any other change.
`delete_vault` stays the only path that deletes them. The redacted message
keeps its place, author, agent and time, and says which owner redacted it
and when. Only a message's body can be redacted, never a thread's title,
so secrets stay out of titles too. The docs warn that secrets belong in
variables, never in a thread, and that redaction cannot take back what an
agent or an export already read.

Why: the log holds no content ([Privacy, erasure and
compliance](#privacy-erasure-and-compliance)), so a message's text lives
in one row and blanking it removes it. A thread's log events, `thread.redact`
included, point at messages and never carry their text. Redaction is an
owner's, in person, for the reason erasing a file is: it destroys content
and cannot be undone. No agent redacts, an owner's own included.

### 8. Limits

A cap on a message's size, on threads per vault and on messages per vault,
refused the way plans and limits are today: SQLSTATE `RLP01`, naming the
vault, the limit and the usage, with nothing changed ([Plans and
limits](public/concepts/plans-and-limits.md)). The MCP server gets a
rate-limit bucket of its own for thread calls (`mcp/src/ratelimit.ts`),
next to the general per-token limit.

Starting points, not measurements: a message of at most 4,000 characters,
the same as a proposal comment (`REASON` in `mcp/src/tools-shared.ts`); a
title of at most 200 characters, the same as a step's; 1,000 threads and
10,000 messages in a vault, a redacted message counting like any other;
and 20 addressees. The posting bucket's size has no number yet.

Threads and messages are never deleted, so a vault at a limit stays at
it. Only the operator raises the number; the refusal says so and points at
**Ask for a bigger plan**, on **Plan and usage**. Nothing a member does
makes room.

Why: an agent calling a tool in a loop is what item 8 of [Claims and work
plans](#claims-and-work-plans) bounds for `request_work`, and the same two
mechanisms answer it here: a limit the database enforces and a rate the
MCP server enforces. No new mechanism.

### 9. References

A thread can be anchored to a task, a path or a proposal (item 1). A
message can cite them in plain text with three tokens:
`task:<plan file path>#<step key>`, `file:<path>` and
`proposal:<proposal id>`. A citation is stored as the text typed. The web
page links a token only when its target exists in this vault; any other
token stays text. Nothing on the server parses a citation into authority.
Erasing a file leaves the threads about it alone, since a path anchor is
only a path.

Why: a citation that confers nothing needs no validation, and one that
doesn't resolve is just text. It is item 5's reason again: words in a
thread point at things, and never act on them. A citation names a task by
what a person can read, the plan's path and the step's key, where the
anchor holds the step's id.

### 10. Export and deletion

`delete_vault` clears threads and their messages with the rest of the
vault, and the messages' table lets that one path through its append-only
triggers. Threads belong in the markdown export. Claims and steps are
state, not content, and are not exported (item 10 of [Claims and work
plans](#claims-and-work-plans)). A thread is what people wrote, so
principle 7 applies to it as it does to files.

Why: principle 7 covers anything people wrote, and deleting a vault is
erasure, so nothing of a vault is left behind or kept out of its export.

### What this doesn't settle

- **Limit numbers.** Every number in item 8 is a starting point, and the
  posting bucket's size has none. Whether message text counts toward a
  vault's storage is open (comments and review notes don't today).
- **The export format.** Where threads sit in the archive, and how an
  anchor to a task reads there, since tasks are not exported. Also whether
  threads reach the export in the same change as the feature. Today's
  export fixes its contents in one snapshot inside `export_vault` (files
  and a manifest, capped at 100 MiB of text, no proposals yet),
  so adding threads means changing that function and its hostile tests,
  and may be a change of its own. Until the export carries threads, the
  docs for Threads say that it does not.
- **Redaction of copies.** What becomes of a redacted message's text when
  someone quoted it into another message.
- **Unread markers.** Whether people get one.
- **How a person is told.** Flags reach connections. How a person learns
  that a thread is addressed to them, or that a vault-wide one opened, is
  open on purpose. Email is out (item 6); the rest is undecided.
- **Fit with Notifications.** A thread addressed to you reads like direct
  address, a category written for `to:` notes. Whether those notes stay,
  and how a vault-wide thread's flag fits the four categories, is open.
- **Left to the build.** What an anchor does when its plan is registered
  again, and whether a viewer who is the named owner of an anchored path
  may post, as they may comment on a proposal for that path
  ([path ownership](public/concepts/path-ownership.md)).

## Links

A vault can hold links to other remote MCP servers (Stripe, Linear,
Supabase, a client's own server), each with the credential to reach it. A
member's agent connects to Reliquary once, and sees each link's tools
as `<link>.<tool>`. Reliquary calls the upstream server with the
vault's credential. The agent never has the credential.

This is how a team shares a platform account without sharing its key. It
is also how routines reach third-party data, so there is no separate
connector system. (Not to be confused with an [agent connection](#concepts):
a link is Reliquary reaching an upstream server, a connection is a client
reaching Reliquary.)

- **Grants per link and role.** Each link has a tool
  allowlist. Tools that write or send are off until an owner enables them,
  per role.
- **Credentials** are stored like environment variables (secret store,
  access log) and attached at egress. They never appear in tool results,
  logs or errors. Reliquary is a separate MCP client to the upstream server
  with its own credential, so there is no token passthrough.
- **Every proxied call is logged:** who, which agent, which tool, the
  outcome and size. Arguments and results are not stored by default, only
  their hashes.
- **Remote servers only.** Hosted Reliquary can't run a server that lives
  on someone's laptop (stdio MCP). Upstream URLs must be public HTTPS: no
  private or link-local addresses, and redirects are re-checked (SSRF).
  A URL is a host and a path only, with no userinfo, query or fragment
  (`20261009120041_link_url_shape.sql`): members, agents and the log all
  see it, so a credential must never ride in it.
- **What the gate doesn't cover:** upstream data isn't vault context. A
  member granted a link sees whatever that upstream account returns.
  The link's grant is the control, so grant accordingly.
- **Shared credentials only in v1** (API keys, service accounts).
  Per-member OAuth to upstream ("my Gmail") comes later.

### Implementation plan (schema and discovery)

Written 2026-09-28, before milestone 3 started (milestone 2's week of real
use had not finished); built since. Renamed the entity to
**link** on 2026-09-28, before any of this was built: "connection" was
already taken (the Connections page, [agent connection](#concepts) above),
and the two meant opposite directions (a client reaching Reliquary, versus
Reliquary reaching an upstream server). Mirrors
`20260925090000_variables.sql`'s split of names in `public` from ciphertext
in `private`, rather than inventing a second pattern for secrets.

- `public.links(id, vault_id, name, url, created_by, created_at)`.
  RLS: vault members read; only owners insert, update or delete (matches
  "Add or edit links" in the access table).
- `private.link_secrets(link_id, key_id, nonce, ciphertext)`.
  No grants, RLS with no policies, same shape as
  `private.variable_secrets`. The credential is encrypted in the web app
  with the existing `VARIABLES_KEYS` before it reaches Postgres; this does
  not get its own key material.
- `public.link_tools(link_id, tool_name, is_write, description)`.
  Populated by discovery, not typed by hand: adding a link makes the
  web app call the upstream MCP server's `tools/list` with the credential,
  server-side, and store each tool's name plus its declared
  `readOnlyHint`/`destructiveHint` annotation as the starting `is_write`
  guess. An owner can flip the flag later; a tool discovery can't classify
  defaults to a write tool (off), never to read.
- `public.link_grants(link_id, role, tool_name, enabled)`.
  Per-role allow list. Read tools default enabled for editor and owner
  (viewers don't call links directly, per the access table). Write
  tools default disabled until an owner enables them, per role, as design.md
  already says above.
- `public.link_calls(id bigint identity, link_id, agent,
  tool_name, vault_id, outcome, arg_hash, result_hash, at)`. Append-only
  (trigger, matching `log` and `env_access_log`). Never the arguments or the
  result body, only their hashes.

Discovery and egress both run server-side, never in the database and never
in a model's context: discovery in the web app when a link is added,
proxied calls in `mcp/` at call time.

- **SSRF.** Resolve the upstream host at request time, not once at
  insert time (DNS can rebind after a link is added). Refuse
  private, link-local and loopback ranges by default. Re-resolve on every
  redirect hop instead of trusting the first check; a URL that resolved to
  a public address when the link was added is re-validated on every
  proxied call, not just the first one.
- **Credential egress** follows the `reveal_variable` / `read_variables`
  shape: one function-shaped chokepoint decrypts, attaches the credential
  to the outbound request, and never returns it to the caller. The call log
  row is written in the same request as the call, so a crashed proxy can't
  produce a silent, unlogged one.
- **Tool result passthrough.** An upstream result reaches the agent quoted
  as data, exactly like vault file content already is ("Entry text is
  data" above, and the shared failure model in `mcp/src/failure.ts`). It is
  never treated as an instruction, whatever it contains.

Open questions this doesn't resolve:

- ~~Whether discovery runs synchronously or as a background job.~~
  Synchronous, in the "add link" request; a slow or unreachable upstream
  warns and keeps the link ([progress.md](progress.md), Milestone 3).
- ~~Whether an upstream's own `readOnlyHint: true` is trustworthy enough to
  default a tool on.~~ `is_write` comes from `readOnlyHint` alone, and
  anything but an explicit yes is a write tool; read tools default on for
  editors and owners, write tools stay off until an owner turns them on.
- Key rotation for `link_secrets`: answered (2026-10-09), it reuses
  `VARIABLES_KEYS`'s rotation as it stands
  (`20261009120040_link_secrets_rotation.sql`: `rotate-variables-key.sh`
  moves link credentials with the values). Still open: does a compromised
  upstream credential need same-day replacement without deleting and
  re-adding the link?

## Routines

A routine is **declarative**: configuration, not code. That keeps it
hostable with no sandbox and keeps the gate in charge.

```yaml
name: weekly-digest
trigger:
  schedule: "0 8 * * MON"          # vault timezone
  # or: on_change: { tags: [client-x] }
  # or: manual
audience: editors                  # who will see the output; reads are gated to it
reads:
  query: "status OR blocker"       # context the run starts with
  since: last_run
model:
  provider: anthropic              # or openai, …
  name: claude-opus-5
  key: env:production/ANTHROPIC_API_KEY
prompt: |
  Summarise what changed this week and what is blocked.
tools: [linear.list_issues]        # declared link tools only
outputs:
  - write: { path: digests/{date}.md }    # an open folder
  - notify: { channel: discord, webhook: env:production/DISCORD_WEBHOOK }
limits: { timeout: 120s, max_output_tokens: 4000 }
```

- **Triggers:** a cron schedule, a change in the vault matching a filter
  (the feed drives this), or a manual run. Incoming webhooks come later.
- **What a run may do:** read context through the gate as its audience,
  call the model with the vault's key, use Reliquary's own tools (search,
  write open files, propose), and call the link tools it declares. It
  **may not** run code, touch git, or reach anything it didn't declare.
- **Outputs are artifacts:** open-file writes, proposals, notifications, or
  a declared link call. A run without one is a failure. Canon never
  comes straight from a routine; that takes people.
- **Secrets in routines** are resolved server-side at egress (the model key,
  a webhook URL) and never placed in the prompt.
- **Runtime:** `pg_cron` enqueues due runs (`pgmq`). A serverless function
  claims a run, executes it, and writes the artifact and status. No worker
  VMs.
- **Watchdog,** inside the database (carried from v2):
  - `queued` runs older than 15 minutes become `missed`;
  - running runs past their timeout become `timed_out`;
  - every `failed`, `missed` or `timed_out` run notifies the routine's
    owner;
  - an external heartbeat covers Reliquary itself going quiet.
- **Run log** (`routine_runs`) is append-only: `queued`, `running`, `ok`,
  `failed`, `skipped`, `missed`, `timed_out`, plus the artifact.

Third-party data comes through [links](#links).
Routines needing real code or repo access are a later decision (a
sandboxed runner). Until then, those stay in each member's own tooling and
talk to Reliquary over MCP.

## Environment variables

Shared credentials, so a team and their agents build with the same
accounts.

- Each vault has **environments** (`development`, `preview`, `production`,
  custom). A variable has a name, an encrypted value, the environments it
  belongs to, and who may use it.
- **Grants** go per member, per environment. For example, an editor gets
  `development` and `preview` but not `production`.
- **Getting values onto a machine:**
  - `reliquary run --env development -- <cmd>` injects variables into one
    process and writes nothing to disk. This is the preferred path.
  - `reliquary env pull --env development` writes `.env`, refuses unless
    `.env` is gitignored, and never prints values.
- **Getting values in:** set one on the Variables page, paste a whole
  `.env` there (previewed by name, never by value), or `reliquary env push`
  from a project, which an agent may run: a push is only a pending import
  until a person applies it in the web UI (docs/variables.md, Imports).
- **Every** read, grant, revoke, rotation and reveal lands in
  `env_access_log`, which is append-only. Change events carry the name and
  action, never the value.
- **Rotation:** set a new value, see who pulled the old one since when, and
  revoke their access.

**Stated plainly, in the product too:**

- **Agents can read what reaches them.** An agent that can run shell
  commands in a process or folder holding a variable can read that
  variable. `run` limits exposure to one process; it does not stop that
  process. Prefer scoped, short-lived provider credentials where the
  provider offers them. A credential-injecting proxy (the Infisical Agent
  Vault pattern) is the stronger design for a later milestone.
- **The hosted operator can decrypt.** Values are encrypted at rest by
  the web app (AES-256-GCM, a key the database never sees), and their
  ciphertext leaves the database only through a `security definer`
  function that checks the grant and writes the log in one transaction
  (docs/variables.md). An operator with the database and the web app's
  environment could still decrypt them. Teams that need otherwise get
  client-side encryption (per-member `age` keys) as a separate feature.

## Continuity

"If I get hit by a bus, my team and their agents carry on":

- **Two owners are recommended.** The UI warns when a vault has one.
- **Emergency access.** An owner names a trusted member. That member can
  request owner access; it is granted automatically after a waiting period
  (e.g. 7 days) unless an owner declines. Every step is logged. Same
  pattern as Bitwarden and 1Password emergency access.
- **Agents keep working.** Service agents and routines belong to the vault,
  not a person. A departed member's agent connections die with their
  membership, but vault routines and service agents continue.
- **The vault outlives Reliquary.** Export and the git mirror mean the
  context never depends on the hosted service existing. Variables export
  encrypted to the owners' keys.

## Client engagements

Today a client emails passwords, API keys and project context. v3 replaces
that with a vault per engagement:

- **Invite, no setup.** The client gets an email invite to the engagement
  vault as an `editor` or `viewer`. Their whole product is the web UI (on a
  phone too) and, if they use an AI tool, the MCP URL.
- **Credential requests.** The consultant asks for named variables ("Stripe
  secret key, production"). The client fills a form that writes straight
  into the environment. Values never travel by email or chat. The request,
  the fill and every later use are in the access log the client can see.
- **Write-only by default.** Whoever *requests* a variable can use it
  through `run` or `pull` without being able to reveal it in the UI, unless
  the client grants reveal. The client decides.
- **Context intake.** A "tell us about the project" box and document
  uploads arrive as proposals the consultant reviews, so the client never
  has to learn the difference between open and canon.
- **Offboarding.** Closing an engagement:
  - revokes every consultant grant and agent connection;
  - lists which credentials were used, so the client knows what to rotate;
  - exports the vault to the client;
  - then deletes it on a set schedule ([erasure](#privacy-erasure-and-compliance)).
- **The trust model in the client's words:** the invite page says who can
  see what, that Reliquary's operator can technically decrypt values, and
  where the data is hosted (EU).

## Git mirror and export

- **Export:** the whole vault's context as markdown files plus a log file,
  from the UI or `reliquary export`. Available on every plan.
  - Built (web): an owner, in person, downloads a `.tar.gz` from the vault's
    Settings: every live file's current text under `files/`, and
    `reliquary-export.json` with the vault, its default policy and rules,
    and each file's SHA-256, size and last write. Variable values are never
    exported, only names and the environments that have one. It streams,
    a page of files per short transaction, is capped at 100 MiB of text,
    is `no-store`, and is logged as `vault.export`. Not yet: the log file,
    earlier versions, proposals, and `reliquary export`.
- **Git mirror (optional per vault):**
  - every canon change becomes a commit to a configured remote;
  - commits are authored by the person who approved or wrote it, with the
    agent as a co-author trailer;
  - Reliquary stays the writer of record: the mirror is one-way by default;
  - two-way is opt-in, and then pushes to the mirror arrive as proposals,
    never as direct writes.
- **AIS-OS** consumes a vault the way v2 intended: a mirror or
  `reliquary feed pull` into a mapped folder, and proposals back up.

## Privacy, erasure and compliance

**Target:** GDPR-ready from milestone 1, and a SOC 2 Type II report when
paying clients ask for it. Until an auditor has signed a report, the product
never says "SOC 2 compliant". It lists the controls it actually has.

**Erasure without breaking append-only.** The log is never edited, but
people have a right to be forgotten. So the log holds no content at all,
only events that point at versions. Content lives in `file_versions`,
which is insert-only except for one operation: erasure blanks a version's
text and stamps it. A trigger enforces that no other change is possible.

- The log keeps its sequence; the content is gone.
- Backups still hold it until they age out, which the privacy policy states.
- Deleting a vault erases everything in it at once (below). The export
  window is before, not after: the delete page offers export first.
- Per-file encryption keys (crypto-shredding) remain an option if backups
  must forget immediately. Lean v1 doesn't need them.

**Deleting a vault.** Immediate and permanent, by one database function,
`delete_vault`: an owner, in person, with the vault's name typed (the
database checks the name too, so no surface can skip it). It deletes the
vault row, and on delete cascade everything in it: files and every version,
proposals, approvals, notes and comments, rules, members, the log, the
variables access log, variables and their ciphertexts. Tokens whose only
vault it was are revoked; tokens that reach other vaults keep those. What
remains is one row in `private.vault_deletions`: the vault id, who deleted
it, when, and counts, with no name, path or text.

The other members are told, once: each gets a row in
`private.vault_deletion_notices` (the vault's name, who deleted it, when),
shown on their Home page and deleted as it is shown, or unseen after 30
days. The name is kept there on purpose: every recipient could read it the
moment before, and "a vault you were in" tells someone in several vaults
nothing. It goes to nobody else, never into `vault_deletions`, and the
delete page tells the owner before they confirm
(`20260925160000_membership_polish.sql`).

Why not a soft delete with a purge later: every policy and function would
have to learn a "deleted" state, the data would sit in the live database
for the whole window, and the purge would be a job someone must remember to
run (and that the product must not depend on a member running). Immediate
deletion is simpler, is erasure in the GDPR sense the moment it returns,
and leaves nothing to guard. The cost is that a mistake can't be undone
from the product; the typed name, the owner-only in-person rule and the
export offered first are the guard, and backups (which age out) are the
operator's last resort.

The log, approvals and `env_access_log` are append-only and `file_versions`
and `proposal_notes` erase-only by trigger. `delete_vault` is the one
sanctioned path around them: it writes its `vault_deletions` row with the
current transaction id first, and the triggers allow a `DELETE` only of a
row whose vault has such a row in the same transaction. Nothing else can
write that table, a row from another transaction unlocks nothing, and
`TRUNCATE` is always refused, so outside a deletion append-only holds as
before, even for the table owner.

**Deleting an account.** Immediate, by one database function,
`delete_account`: the person, in person (no agent or token of any kind),
with their email address typed (checked by the database too). It is
refused while they are the only owner of a vault, naming those vaults: a
vault always keeps an owner, so they make someone else an owner or delete
the vault first. Then, in one transaction: they leave every vault (a
`member.leave` log entry each, marked `account_deleted`); vaults they
created count against the longest-standing remaining owner; every
connection is deleted; invites they made that are waiting are withdrawn,
and invites they accepted are deleted (the only rows of Reliquary's own
that tied the account to an address); their display name, plan, admission,
snoozes, notices, sign-out cutoff and unapplied pasted imports are deleted;
and the `auth.users` row itself, so Supabase Auth forgets the address and
every session. A row in `private.deleted_accounts` keeps the id and when;
`check_session` refuses that id from then on and `co_member_people` names
it "a deleted account" (`20260926140200_delete_account.sql`).

What they wrote stays: versions, proposals, approvals, comments, notes and
both logs belong to the vaults (the owner is the controller), and hold only
the account id, which nothing maps back to an address any more. The log is
not touched, so this needs no path around append-only. To remove text they
wrote, it is erased like any other (above), before or after.

The Auth user is deleted from the database, not through Supabase's admin
API: that needs the project's secret key, which the web app never holds.
The function's owner (the migration role) deletes the `auth.users` row, and
Auth's own tables (identities, sessions, refresh tokens) follow by cascade.
If that privilege were ever missing, the whole deletion fails and nothing
changes. Invites other people made out to the address stay theirs, and a
new account with that address later starts fresh.

**Sessions.** Signing out everywhere revokes every refresh token of the
account at Supabase Auth, then records a cutoff in
`private.session_cutoffs`; the web app runs `check_session` with the
claims (now including the JWT's `iat`) at the start of every transaction,
so access tokens already handed out stop working at once rather than
within the hour (`20260926140100_sign_out_everywhere.sql`). Connections are
not sessions and are revoked separately.

**GDPR, from the start:**

- **Hosting:** EU region (Supabase `eu-central-1`) for the hosted instance.
- **Roles:** Reliquary is a processor; the vault owner is the controller.
  A standard data processing agreement (DPA) is published.
- **Sub-processor list:** Supabase and the web host. Model providers are
  chosen and keyed by the vault owner, so they process under the owner's
  own agreement with them. The UI shows which provider each routine sends
  data to.
- **Rights:** export (portability) and crypto-shred erasure; retention per
  vault; open folders can expire.
- **Operations:** a breach runbook with 72-hour notification, a record of
  processing activities, and a plain privacy policy.

**Built now so SOC 2 is cheaper later.** Most of what auditors ask for is
already a design principle:

- access enforced in the database;
- least privilege and the delegation ceiling;
- append-only audit logs for context, variables and routines;
- encryption at rest;
- hostile tests on every push, as evidence that controls work;
- change management through reviewed commits.

What's missing is organisational: written policies, vendor reviews, access
reviews, backups with tested restores, incident drills, and an auditor. Do
that work when a client requires it, with a compliance platform; in the
meantime inherit the sub-processors' own SOC 2 reports.

## Architecture

As built, 2026-10-09. Two small TypeScript servers over one Postgres; no
framework.

- **Postgres 17** holds every rule as RLS or a trigger, and every mutation
  as a `security definer` function with a pinned `search_path`. The web
  app, the MCP server and the operator connect as separate roles
  (`reliquary_web`, `reliquary_mcp`, `reliquary_ops`). `pg_cron` runs
  housekeeping where it is installed (pruning, expired imports, a storage
  drift check). Hosted on Supabase; self-hosted as plain Postgres in
  `deploy/compose`.
- **Auth** is Supabase Auth (email sign-in codes; the web app verifies its
  JWTs against the project's JWKS). The web app is also the OAuth
  authorization server for MCP clients and the CLI (`web/src/oauth.ts`):
  Supabase's OAuth server can't bind tokens to the MCP resource
  (docs/research/hosting.md).
- **`web/`** is a Node `http` server: the server-rendered UI with no
  client-side script, the OAuth server, the environment API
  (`web/src/envapi.ts`) and an internal endpoint for link calls. It alone
  holds `VARIABLES_KEYS` and encrypts variable values and link credentials
  (AES-256-GCM, `web/src/secrets.ts`; docs/variables.md).
- **`mcp/`** is a separate Node `http` server using the MCP SDK: the
  stateless remote endpoint at `/mcp`. It refuses to start with the
  variables key, so it can never decrypt anything; link calls go through
  the web app's internal endpoint with a shared secret.
- **`cli/`** is the `reliquary` binary (Node, no runtime dependencies).
- **Hosting:** two Vercel projects (`web`, `mcp`) and a Supabase project, or
  `deploy/compose` for self-hosting. No customer-side infrastructure.
- **Multi-tenant:** vaults are the tenancy boundary, and RLS enforces it.
- **Not built, and not in use anywhere:** `pgmq`, `pg_net`, Edge Functions
  and Supabase Vault. They belonged to the routines design (Routines,
  above) and to the first secret-store recommendation; routines are
  unbuilt, and variables use the web app's own keys instead.

## Data model

As built, 2026-10-09; the migrations in `supabase/migrations/` are the
schema. Names in `public` are readable through RLS; `private` holds
ciphertext, counters and operator-only state, and is closed to the signed-in
API role.

- **Vaults and people.** `vaults`, `vault_members(role)`, `profiles`,
  `access_tokens` (personal tokens, OAuth grants and CLI grants, one row per
  connection), `private.vault_invites`, `private.admissions`,
  `private.deleted_accounts`, `private.vault_deletions` (the record
  `delete_vault` leaves).
- **Files and review.** `files`, `file_versions` (the full text of every
  version), `path_policies(path, policy, quorum)`, `path_owners`,
  `proposals`, `approvals`, `proposal_notes`, `review_snoozes`, and
  `log(seq, vault_id, at, actor, agent, event, path, version_id,
  proposal_id, detail)`: append-only, the feed.
- **Coordination.** `path_claims`, `claim_rules`, `work_plans`,
  `work_plan_steps`, `work_plan_step_blockers`, `work_plan_step_cites`,
  `threads`, `thread_addressees`, `thread_messages`, `subscriptions`,
  `flag_watermarks`.
- **Variables.** `environments`, `variables`, `variable_values`,
  `private.variable_secrets` (ciphertext), `env_imports`,
  `private.env_import_secrets`, `env_access_log` (append-only).
- **Links.** `links`, `link_tools`, `link_grants`, `private.link_secrets`
  (ciphertext), `link_calls` (append-only, outlives a deleted link).
- **Plans and limits** (`20260925230000_plans.sql`): `private.plans`,
  `private.vault_tiers`, `private.account_plans`,
  `private.vault_tier_overrides` and `private.vault_storage` (bytes per
  vault, kept by triggers: every file version, variable ciphertext and
  waiting import). Only the operator changes them; a smaller plan never
  deletes, it makes an over-limit vault read-mostly.
- **Operations.** `feedback`, `welcome_seen`, `private.rate_limits` (counters
  under a keyed hash), `private.vault_exports`, `private.oauth_codes`,
  `private.oauth_tokens`, `private.session_cutoffs`, `private.settings`.
- **Designed, not built:** `routines` and `routine_runs`, service agents and
  their grants, `emergency_access`, `git_mirrors`, per-member
  `variable_grants`, and sessions minted for headless agents
  (`spikes/gate/`).

## Hostile tests

Every one runs on every push. Carried from v2 and the spike:

- a session for vault A reading vault B;
- an agent approving a proposal;
- anyone editing or deleting a `log`, `routine_runs` or `env_access_log`
  row;
- any MCP tool, log line, change event or error containing a variable's
  value;
- forged, replayed or expired sessions;
- revocation taking effect on the next query.

New in v3:

- **Delegation ceiling:** a member's agent attempting each human-present
  action.
- **Routine audience:** a routine declaring `audience: editors` never reads
  a file whose audience excludes some editors; its output inherits no wider
  audience than its reads.
- **Routine escape:** a routine attempting an undeclared notify target or
  link tool, a
  code or git action, or putting an `env:` reference into its prompt text.
- **Environment grants:** an editor granted `development` pulling
  `production`; a revoked member's next pull failing; a service agent
  revealing a value.
- **Emergency access:** granted only after the wait, and cancelled by any
  owner's decline.
- **Policies:** an agent writing a canon file directly; a canon change
  landing one approval short of quorum; an agent's approval counting; a
  proposer's agent approving for them.
- **Links:** a credential in any tool result, log or error; a tool
  outside the allowlist; a write tool before an owner enabled it; an
  upstream URL on a private address or redirecting to one; a revoked
  member's agent calling a link.
- **Client engagements:** a requester revealing a variable the client
  didn't grant reveal on; a closed engagement's consultant or agent reading
  anything.
- **Erasure:** after crypto-shredding, no query, export, feed, or log read
  returns the content, while the log keeps its sequence.
- **Git mirror:** a push to a one-way mirror changing nothing; on a two-way
  mirror, a push only ever producing a proposal.
- **Plans:** a person or their agent reading or changing a plan, tier or
  counter; a write, variable, import, invite or vault past its limit; a
  downgrade deleting anything.
- **Threads:** a session for vault A reading or posting in a thread of
  vault B; a viewer, or a read-only connection, posting; a message
  changed or deleted by anyone, an owner included, except by redaction;
  a redaction by an agent, a token or anyone but an owner in person; a
  redacted body coming back from any read, feed, flag or export; a
  message approving, rejecting, revealing, breaking a claim or
  cancelling or skipping a step, however it is worded; a side thread
  hidden from a member it isn't addressed to (it must stay readable to
  all), or a flag about one reaching a member it isn't addressed to; a
  vault-wide thread that skips a member's connection when flagging; a
  post in a resolved thread going through; an addressee, an anchor or a
  title changed after a thread opens; an anchor in another vault; a post
  past a limit going through, or a refusal that changes anything; a
  vault's deletion leaving a thread or a message behind.

## Build order

Each milestone ends in something checkable. The next starts only after the
previous check has held for a week of real use.

| # | Milestone | Done when |
|---|---|---|
| 1 | **Core, MCP and UI.** Vaults, files and folders, canon/open policies with quorum, log, gate, remote MCP with OAuth, web UI for review, plain export | **Done, 2026-09-29.** Andrés uses one vault from ChatGPT, Claude Code and Hermes for a week. Each sees the same files; canon changes are approved in the browser; hostile tests green |
| 2 | **Environment variables** (reordered 2026-09-24: the owner's `.env` need comes first, and links reuse its secret store) | **Done, 2026-09-29.** Andrés's projects run with `reliquary run` and no local `.env` for a week; an agent over MCP never sees a value; every read is in the access log |
| 3 | **Links** (credentials from the same store) | One upstream MCP (e.g. Linear) is used from all three clients through Reliquary for a week, with the credential never leaving Reliquary |
| 4 | **Routines** (can use links) | A scheduled routine and a change-triggered routine run for 7 days with every personal machine off, zero missed runs, and every failure notified |
| 5 | **Team and clients.** Second person, quorum above 1, per-member variable grants, credential requests, emergency access | A teammate connects their own client, pulls the same `development` variables, and loses them on revoke; a real client fills a credential request instead of emailing it; the access logs show all of it |
| 6 | **Git mirror, version history view** | A one-way mirror stays in sync for a week; a file is restored from its history |
| 7 | **Chat surfaces** | The Telegram pilot runs on the production gate for a real group |

[Path ownership](#path-ownership) and [Notifications](#notifications)
aren't a numbered milestone of their own: they're being built alongside
milestone 3 (owner's decision, 2026-09-28, same call as starting Links
early), not after it. Path ownership touches the same core `write_file`
/ `propose` / `decide` functions every other milestone depends on, so
treat it with at least as much care as core schema work, not less because
it rode in beside a smaller feature.

[Threads](#threads), the audience split in the web UI ([Who each surface is
for](#who-each-surface-is-for)) and the Tasks view with its MCP step tools
aren't a numbered milestone either. They start now, on the owner's
decision of 2026-10-02: a deliberate, logged exception to working on one
milestone at a time ([AGENTS.md](../AGENTS.md#build-order),
[progress.md](progress.md#decisions)). Their designs were written before
they were built, as the claims section was.

## Open decisions

1. ~~Agent writes: direct or proposals?~~ Decided: per file or folder
   policy (canon or open), with a quorum for canon.
2. ~~"Vault" or "space"?~~ Decided: **vault** is the container. The
   encryption layer is the **secret store**, and a **link** is an
   upstream MCP (renamed 2026-09-28 from "connection", which the Connections
   page already meant).
3. ~~OAuth authorization server.~~ Decided in milestone 1: a small one in the
   web app (`web/src/oauth.ts`), because Supabase's OAuth server can't bind
   tokens to the MCP resource (docs/research/hosting.md). Supabase Auth signs
   people in.
4. ~~Variable storage.~~ Decided in milestone 2: the web app encrypts values
   with AES-256-GCM under its own keys (`VARIABLES_KEYS`) and Postgres holds
   only ciphertext; neither Supabase Vault nor Infisical is used. The operator
   can still decrypt, as docs/variables.md says.
5. **Hosting model:** multi-tenant, or an instance per customer? v2 left
   this to later. v3 assumes multi-tenant with a self-host path.
6. **Name**, checked 2026-09-24, and to finish before any client material:
   - npm: `reliquary` is taken, by a dormant secrets-management package
     (last published 2022). **Andrés holds the `@reliquary-ai` scope**:
     packages are `@reliquary-ai/cli`, `@reliquary-ai/mcp`, and so on.
   - `reliquary-ai.com`, `.dev`, `.app` and `.io` looked unregistered on
     2026-09-24. Worth registering to match the scope.
   - Domains: `reliquary.com`, `.dev`, `.app` and `getreliquary.com` are
     registered with no live site; `reliquary.ai` is for sale; `reliquary.io`
     looks unregistered.
   - Trademarks: not yet searched (USPTO, EUIPO).

## Where it falls flat, and what scales later

Built lean on purpose. Where each part will strain, and the signal that
says it's time:

| Part | Lean v1 | Falls flat when | Then |
|---|---|---|---|
| Search | Postgres full text | Questions don't share words with the answer | Embeddings with pgvector, iterative scans under RLS |
| Gate cost | Per-query helpers (p95 < 6 ms at 200k rows) | A vault passes millions of files | Combined indexes, partitioning by vault |
| Quorum | Count of distinct approvers | Teams want "one from legal and one from eng" | Approver groups per folder |
| Routines | One model call, Edge Function time limits | Multi-step agent work, long runs | A worker queue, or Managed Agents, per vault |
| Links | Shared credentials, remote MCP only | People want their own Gmail or calendar, or local tools | Per-member upstream OAuth; a small local relay for stdio servers |
| Link proxy | Synchronous pass-through | Long or streaming tool calls | Streaming proxy with its own timeouts |
| Secret store | App-held keys (AES-256-GCM), operator can decrypt | A client needs zero-knowledge | Client-side encryption with per-member keys |
| Version history | Every version stored in full | Storage per vault gets large | Compress or snapshot old versions |
| Multi-tenant | One Supabase project | Noisy neighbours, data residency asks | Per-region or per-customer projects |
| Compliance | Designed-in controls, no audit | A client requires a SOC 2 report | Compliance platform plus auditor |

The big risk isn't technical. It's **approval fatigue**: canon folders with
nobody approving. Watch the proposal queue's age from milestone 1, and
default more folders to open if proposals sit unreviewed.

## Out of scope

- Andrés's personal AIS-OS routines. They consume Reliquary; they aren't
  part of it.
- Routines that run arbitrary code, touch git, or pull third-party data,
  until a later decision on connectors or a sandbox.
- Real-time collaboration and live cursors.
- Client-side (end-to-end) encrypted variables, as a later separate
  feature.
- A Reliquary-hosted model. Every model call uses the vault's own key.
- Chat features around Threads: typing indicators, read receipts,
  presence, reactions, edits, attachments, email notifications,
  cross-vault threads and direct messages ([Threads](#threads), item 6).
