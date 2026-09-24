# Reliquary v3: design

2026-09-24 · Status: DRAFT, replaces v2 (commit `4b11c25`)

A shared vault of context, automations and credentials that people and any
agent can use, with no machine of anyone's that has to stay on.

The research behind this draft is in `docs/research/`
([landscape-swot](research/landscape-swot.md),
[org-chatbot-gate](research/org-chatbot-gate.md),
[pricing](research/pricing.md)). The gate it relies on is proven in
`spikes/gate/`; `pilot/` is a working Telegram surface on the same gate.

## Contents

1. [What changed from v2](#what-changed-from-v2)
2. [What it is](#what-it-is)
3. [Principles](#principles)
4. [Concepts](#concepts)
5. [Identity and permissions](#identity-and-permissions)
6. [Access surfaces](#access-surfaces)
7. [Context](#context)
8. [Routines](#routines)
9. [Environment variables](#environment-variables)
10. [Continuity](#continuity)
11. [Git mirror and export](#git-mirror-and-export)
12. [Architecture](#architecture)
13. [Data model](#data-model)
14. [Hostile tests](#hostile-tests)
15. [Build order](#build-order)
16. [Open decisions](#open-decisions)
17. [Out of scope](#out-of-scope)

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
 Hermes (Nous) ───────┤       ├──────▶ │ context   entries, notes, log    │
 scripts, CI ─────────┘       │  gate  │ routines  automations on context │
 browser ──────── web UI ─────┤        │ env       shared variables        │
 terminal ─────── CLI ────────┘        │ members   people and agents      │
                                       └──────────────┬───────────────────┘
                                                      └──▶ optional git mirror
```

Three jobs:

1. **Share context across people and whatever agent each one uses.** A
   ChatGPT user and a Claude Code user read and propose to the same
   approved context.
2. **Automate on that context without anyone's machine.** A routine runs on
   a schedule or on a change, reads through the gate, and produces an
   artifact.
3. **Build with the same accounts, and survive losing a person.** Shared
   variables, access logs, and emergency access mean the team and their
   agents can carry on.

## Principles

1. **Any agent, any model.** One MCP URL for every client. Routines run on
   the vault's own model key. No feature requires a specific vendor.
2. **The database enforces access.** Every rule in the access table is RLS
   or a trigger, and every rule has a hostile test.
3. **Your agent is you, minus a few things.** An agent connected by a person
   acts with that person's permissions, except the actions that need the
   person present ([Identity and permissions](#identity-and-permissions)).
4. **Nothing becomes canon without a person.** Agents and routines write
   notes or proposals. People approve, or write canon themselves.
5. **Secret values never enter model context.** Not through MCP, logs,
   change events, errors, or routine prompts. Where a value must reach a
   process, say plainly what that process can do with it.
6. **Verify the artifact.** A routine run is only `ok` when it reports what
   it produced.
7. **Your data can leave.** Export and git mirror from day one; self-hosting
   stays possible. A vault must outlive any one person, Reliquary included.
8. **Nobody's machine has to stay on.** Nothing a vault needs runs on a
   member's laptop.

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
- **Entry.** A unit of context. Two kinds:
  - **canon:** approved, presented as fact;
  - **note:** attributed and unconfirmed, can expire. This is where chat
    remarks and routine observations land.
- **Proposal.** A suggested new entry, edit, or retraction, waiting for a
  person to approve it.
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
| Write notes | yes | yes | no | if granted |
| Propose | yes | yes | no | if granted |
| Write canon directly | yes | yes | no | never |
| Approve or reject proposals | yes | yes | no | never |
| Create and edit routines | yes | yes | no | never |
| Use environment variables (pull, run) | if granted | if granted | no | if granted, per environment |
| Reveal a variable's value in the UI | if granted | if granted | no | never |
| Manage members, grants, emergency access | yes | no | no | never |
| Export, configure git mirror | yes | no | no | never |

### Delegation: agents act as their person, with a ceiling

When Andrés's Claude Code calls Reliquary, the session carries two
identities: the agent and the person it acts for (an RFC 8693 `act` claim).
RLS checks both.

The agent gets the person's permissions **except** these, which need the
person present in the web UI:

- approving or rejecting proposals;
- revealing a variable's value;
- managing members, grants or emergency access;
- deleting a vault or exporting it.

**Why the ceiling:** an agent reads text other people wrote. Prompt
injection turns any permission the agent holds into a permission the
injected text holds. The ceiling keeps the few irreversible or
trust-granting actions behind a human click. Everything else, including
writing canon where the person may, is open to their agent. Each vault
chooses whether its agents write canon directly or as proposals; see
[Open decisions](#open-decisions).

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
under 6 ms at 200k entries.

## Access surfaces

- **Remote MCP.** One URL per vault, with OAuth 2.1 as the MCP authorization
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
| `search_context` | Full text first; embeddings when it proves too weak |
| `read_entry` | Entry text returned as quoted data with author and approval date |
| `changes_since` | The feed: events after a cursor, oldest first |
| `write_note` | Attributed, optionally expiring |
| `propose` | New entry, edit or retraction, with a reason |
| `write_entry` | Direct canon write, only where the person and vault allow it |
| `list_proposals` | Pending and recent |
| `list_routines`, `routine_runs` | Status and artifacts |
| `list_env` | Variable names and which environments they are in. **Never values** |

No MCP tool returns a variable's value, on any scope.

## Context

- **Entries** are markdown with a title, tags and an optional `path` (used
  by the git mirror). They carry `valid_from` / `valid_to`, so facts can
  expire or be superseded without deletion. Retractions are events with a
  reason.
- **Canon** is written by a person (or their agent where the vault allows
  it) or promoted from a proposal. **Notes** are attributed, labelled
  unconfirmed, and may expire. Promoting a note to canon is a proposal.
- **The feed** has one call, `changes_since(vault, cursor)`, the same over
  MCP, REST and CLI. Deletions and retractions appear as events, never as
  gaps.
- **Entry text is data.** Every surface wraps it as quoted content with
  author and date. Proposals that address an AI system are flagged in
  review.

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
outputs:
  - note: { tags: [digest], expires: 30d }
  - notify: { channel: discord, webhook: env:production/DISCORD_WEBHOOK }
limits: { timeout: 120s, max_output_tokens: 4000 }
```

- **Triggers:** a cron schedule, a change in the vault matching a filter
  (the feed drives this), or a manual run. Incoming webhooks come later.
- **What a run may do:** read context through the gate as its audience,
  call the model with the vault's key, and use Reliquary's own tools
  (search, note, propose). It **may not** run code, touch git, or make
  arbitrary HTTP calls. Outbound calls are only the declared notify targets.
- **Outputs are artifacts:** notes, proposals, notifications. A run without
  one is a failure. Canon never comes straight from a routine; that takes a
  person.
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

Routines needing real code, repo access or third-party data (Gmail,
calendars) are a later decision: connectors, or a sandboxed runner. Until
then, those stay in each member's own tooling and talk to Reliquary over
MCP.

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
- **The hosted operator can decrypt.** Values are encrypted at rest and
  decrypted only inside a `security definer` function that checks the
  grant and writes the log in one transaction. An operator with database
  access could still decrypt them. Teams that need otherwise get
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

## Git mirror and export

- **Export:** the whole vault's context as markdown files plus a log file,
  from the UI or `reliquary export`. Available on every plan.
- **Git mirror (optional per vault):**
  - every canon change becomes a commit to a configured remote;
  - commits are authored by the person who approved or wrote it, with the
    agent as a co-author trailer;
  - Reliquary stays the writer of record: the mirror is one-way by default;
  - two-way is opt-in, and then pushes to the mirror arrive as proposals,
    never as direct writes.
- **AIS-OS** consumes a vault the way v2 intended: a mirror or
  `reliquary feed pull` into a mapped folder, and proposals back up.

## Architecture

- **Supabase:**
  - Postgres with RLS for every rule;
  - Auth for accounts;
  - Vault for variable encryption;
  - `pg_cron`, `pgmq` and `pg_net` for routines and notifications;
  - Edge Functions as the routine runtime.
- **Next.js:** web UI, the remote MCP endpoint, REST, and OAuth
  authorization-server duties (unless Supabase Auth covers the MCP spec's
  needs; decide in milestone 1).
- **CLI:** a small binary (`reliquary`), for env and feed.
- **No customer-side infrastructure.** Self-hosting is the same stack on a
  customer's own Supabase.
- **Multi-tenant** hosted instance: vaults are the tenancy boundary, and RLS
  enforces it.

## Data model

Carried from the spike and CommonThread, renamed where needed:

- `accounts`, `vaults`, `vault_members(role)`, `emergency_access`.
- `agent_connections` (OAuth clients a member authorised: client name,
  scopes, revoked_at).
- `service_agents`, `service_agent_grants`.
- `sessions` (minted: vault, acting member or service agent, agent identity,
  audience, expiry).
- `entries(kind, title, body, tags, path, audience, author, approved_by,
  valid_from, valid_to)`, `proposals`.
- `log(seq bigint identity, vault_id, event, actor, agent, origin, at)`:
  append-only, the feed.
- `routines(config jsonb, enabled, owner)`, `routine_runs` (append-only
  history).
- `environments`, `variables(name, vault_secret_id, environments[])`,
  `variable_grants`, `env_access_log` (append-only).
- `git_mirrors(remote, direction, last_pushed_seq)`.

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
  an entry a viewer-only note restricts; its output inherits no wider
  audience than its reads.
- **Routine escape:** a routine attempting an undeclared notify target, a
  code or git action, or putting an `env:` reference into its prompt text.
- **Environment grants:** an editor granted `development` pulling
  `production`; a revoked member's next pull failing; a service agent
  revealing a value.
- **Emergency access:** granted only after the wait, and cancelled by any
  owner's decline.
- **Git mirror:** a push to a one-way mirror changing nothing; on a two-way
  mirror, a push only ever producing a proposal.

## Build order

Each milestone ends in something checkable. The next starts only after the
previous check has held for a week of real use.

| # | Milestone | Done when |
|---|---|---|
| 1 | **Core, MCP and UI.** Vaults, entries, notes, proposals, log, gate, remote MCP with OAuth, web UI for review | Andrés uses one vault from ChatGPT, Claude Code and Hermes for a week. Each sees the same context; proposals are approved in the browser; hostile tests green |
| 2 | **Routines.** Declarative runs on the vault's key, watchdog, run log | A scheduled routine and a change-triggered routine run for 7 days with every personal machine off, zero missed runs, and every failure notified |
| 3 | **Second person and environment variables** | A teammate connects their own client, pulls the same `development` variables, and loses them on revoke; the access log shows all of it; emergency access tested end to end |
| 4 | **Export and git mirror** | A vault round-trips through export, and a one-way mirror stays in sync for a week |
| 5 | **Chat surfaces** | The Telegram pilot runs on the production gate for a real group |

## Open decisions

1. **Agent writes: direct canon or proposals by default?**
   *Recommendation:* direct in single-member vaults, proposals in shared
   vaults, switchable per vault. Approving stays human-present either way.
2. **"Vault" or "space".** "Vault" matches how Andrés talks about it, but
   collides with Supabase Vault and 1Password vaults in docs.
   *Recommendation:* use vault in the product, and say "secret store" for
   the encryption layer.
3. **OAuth authorization server:** Supabase Auth, if it meets the MCP spec
   (resource indicators, client ID metadata documents); otherwise a small
   one in Next.js. Decide in milestone 1.
4. **Variable storage:** Supabase Vault (simplest, operator can decrypt) or
   Infisical as a backend (more mature, another service).
   *Recommendation:* Supabase Vault for milestone 3, behind an interface.
5. **Hosting model:** multi-tenant, or an instance per customer? v2 left
   this to later. v3 assumes multi-tenant with a self-host path.
6. **Name:** check npm, domains and trademarks before any client material.

## Out of scope

- Andrés's personal AIS-OS routines. They consume Reliquary; they aren't
  part of it.
- Routines that run arbitrary code, touch git, or pull third-party data,
  until a later decision on connectors or a sandbox.
- Real-time collaboration and live cursors.
- Client-side (end-to-end) encrypted variables, as a later separate
  feature.
- A Reliquary-hosted model. Every model call uses the vault's own key.
