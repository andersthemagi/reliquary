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
8. [Links](#links)
9. [Routines](#routines)
10. [Environment variables](#environment-variables)
11. [Continuity](#continuity)
12. [Client engagements](#client-engagements)
13. [Git mirror and export](#git-mirror-and-export)
14. [Privacy, erasure and compliance](#privacy-erasure-and-compliance)
15. [Architecture](#architecture)
16. [Data model](#data-model)
17. [Hostile tests](#hostile-tests)
18. [Build order](#build-order)
19. [Open decisions](#open-decisions)
20. [Where it falls flat, and what scales later](#where-it-falls-flat-and-what-scales-later)
21. [Out of scope](#out-of-scope)

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

The agent gets the person's permissions **except** these, which need the
person present in the web UI:

- approving or rejecting proposals;
- revealing a variable's value;
- managing members, grants or emergency access;
- deleting a vault or exporting it.

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
| `search` | Full text first; embeddings when it proves too weak |
| `read_file`, `list_files` | Text returned as quoted data with its policy, author and approvals |
| `changes_since` | The feed: events after a cursor, oldest first |
| `write_file` | Open files only; refused on canon files with a pointer to `propose` |
| `propose` | New file, edit, move or retraction of a canon file, with a reason |
| `list_proposals` | Pending and recent |
| `list_routines`, `routine_runs` | Status and artifacts |
| `list_variables` | Variable names and which environments they are in. **Never values** |
| `<link>.<tool>` | Each granted link's tools, proxied (see [Links](#links)) |

No MCP tool returns a variable's value or a link's credential, on any
scope.

## Context

- **Files** are markdown at a path, with optional tags. Folders exist as
  path prefixes, with a policy record where one is set.
- **Policy is inherited:** a file's own setting wins, then the nearest
  folder's, then the vault default (`open` for a one-person vault, `canon`
  for a shared one). Changing a policy is itself a logged event.
- **Moving an open file into canon** (for example, promoting a chat remark)
  is a proposal.
- **Every change is logged with its content diff.** That is enough to
  rebuild any past version. A version-history view and restore are a
  stretch goal on top of the log, not new storage.
- **The feed** has one call, `changes_since(vault, cursor)`, the same over
  MCP, REST and CLI. Deletions and retractions appear as events, never as
  gaps.
- **File text is data.** Every surface wraps it as quoted content with its
  policy, author and date. Proposals that address an AI system are flagged in
  review.

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
- **What the gate doesn't cover:** upstream data isn't vault context. A
  member granted a link sees whatever that upstream account returns.
  The link's grant is the control, so grant accordingly.
- **Shared credentials only in v1** (API keys, service accounts).
  Per-member OAuth to upstream ("my Gmail") comes later.

### Implementation plan (schema and discovery)

Written 2026-09-28, before milestone 3 starts (build order still applies:
milestone 2 needs its week of real use first). Renamed the entity to
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

- Whether discovery runs synchronously in the "add link" request (the
  upstream might be slow or unreachable) or as a background job with a
  `pending` state in the UI meanwhile.
- Whether an upstream's own `readOnlyHint: true` is trustworthy enough to
  default that tool on, or whether every newly discovered tool starts
  disabled regardless of what the upstream claims about itself.
- Key rotation for `link_secrets`: reuse `VARIABLES_KEYS`'s rotation
  script as it stands, or does a compromised upstream credential need
  same-day rotation independent of a vault's environment variable keys?

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

- **Supabase:**
  - Postgres with RLS for every rule;
  - Auth for accounts;
  - the web app encrypts variables (docs/variables.md);
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
- `files(path, body_encrypted, key_id, tags, audience, author,
  updated_at)`, `folder_policies(prefix, policy, quorum, expires_after)`,
  `proposals`, `approvals`.
- `links(name, url, credential_secret_id, tool_allowlist)`,
  `link_grants(role or member, tools)`, `link_calls` (append-only
  log).
- `log(seq bigint identity, vault_id, event, actor, agent, origin, at)`:
  append-only, the feed.
- `routines(config jsonb, enabled, owner)`, `routine_runs` (append-only
  history).
- `environments`, `variables(name, vault_secret_id, environments[])`,
  `variable_grants`, `env_access_log` (append-only).
- `git_mirrors(remote, direction, last_pushed_seq)`.
- Plans and limits (built, `20260925230000_plans.sql`): `plans` (vaults per
  account, people and storage per vault), `vault_tiers` (a per-vault
  override, `standard` meaning the plan's), `account_plans`,
  `vault_tier_overrides`, and `vault_storage` (bytes per vault, kept by
  triggers: every file version, variable ciphertext and waiting import).
  Only the operator changes them; a smaller plan never deletes, it makes an
  over-limit vault read-mostly.

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

## Build order

Each milestone ends in something checkable. The next starts only after the
previous check has held for a week of real use.

| # | Milestone | Done when |
|---|---|---|
| 1 | **Core, MCP and UI.** Vaults, files and folders, canon/open policies with quorum, log, gate, remote MCP with OAuth, web UI for review, plain export | Andrés uses one vault from ChatGPT, Claude Code and Hermes for a week. Each sees the same files; canon changes are approved in the browser; hostile tests green |
| 2 | **Environment variables** (reordered 2026-09-24: the owner's `.env` need comes first, and links reuse its secret store) | Andrés's projects run with `reliquary run` and no local `.env` for a week; an agent over MCP never sees a value; every read is in the access log |
| 3 | **Links** (credentials from the same store) | One upstream MCP (e.g. Linear) is used from all three clients through Reliquary for a week, with the credential never leaving Reliquary |
| 4 | **Routines** (can use links) | A scheduled routine and a change-triggered routine run for 7 days with every personal machine off, zero missed runs, and every failure notified |
| 5 | **Team and clients.** Second person, quorum above 1, per-member variable grants, credential requests, emergency access | A teammate connects their own client, pulls the same `development` variables, and loses them on revoke; a real client fills a credential request instead of emailing it; the access logs show all of it |
| 6 | **Git mirror, version history view** | A one-way mirror stays in sync for a week; a file is restored from its history |
| 7 | **Chat surfaces** | The Telegram pilot runs on the production gate for a real group |

## Open decisions

1. ~~Agent writes: direct or proposals?~~ Decided: per file or folder
   policy (canon or open), with a quorum for canon.
2. ~~"Vault" or "space"?~~ Decided: **vault** is the container. The
   encryption layer is the **secret store**, and a **link** is an
   upstream MCP (renamed 2026-09-28 from "connection", which the Connections
   page already meant).
3. **OAuth authorization server:** Supabase Auth, if it meets the MCP spec
   (resource indicators, client ID metadata documents); otherwise a small
   one in Next.js. Decide in milestone 1.
4. **Variable storage:** Supabase Vault (simplest, operator can decrypt) or
   Infisical as a backend (more mature, another service).
   *Recommendation:* Supabase Vault for milestone 3, behind an interface.
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
| Secret store | Supabase Vault, operator can decrypt | A client needs zero-knowledge | Client-side encryption with per-member keys |
| Version history | Rebuilt from the log's diffs | History views get slow | Periodic snapshots |
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
