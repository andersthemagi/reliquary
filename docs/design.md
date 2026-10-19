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
| 8 | [Search](#search) | Built: words and meaning (#207); the web app searches by words |
| 9 | [Path ownership](#path-ownership) | Built |
| 10 | [Notifications](#notifications) | Partly built: flags, watching and the MCP hint; not addressed notes, staleness or nudges |
| 11 | [Claims and work plans](#claims-and-work-plans) | Built, apart from the hosted load test (#82) |
| 12 | [Threads](#threads) | Built |
| 13 | [Links](#links) | Built |
| 14 | [Routines](#routines) | Designed, not built |
| 15 | [Environment variables](#environment-variables) | Built |
| 16 | [Encryption at rest: the content key](#encryption-at-rest-the-content-key) | In progress: the key set and envelope (#461); columns, search, references, backfill to come (#238) |
| 17 | [Continuity](#continuity) | Designed, not built |
| 18 | [Client engagements](#client-engagements) | Designed, not built |
| 19 | [Git mirror and export](#git-mirror-and-export) | Export built; the git mirror is designed |
| 20 | [Privacy, erasure and compliance](#privacy-erasure-and-compliance) | Erasure and deletion built; the rest designed |
| 21 | [Architecture](#architecture) | As built |
| 22 | [Data model](#data-model) | As built |
| 23 | [Hostile tests](#hostile-tests) | Built for what exists; the rest is the list to write |
| 24 | [Build order](#build-order) | Current |
| 25 | [Open decisions](#open-decisions) | Decided: 1 to 4; open: 5 and 6 |
| 26 | [Where it falls flat, and what scales later](#where-it-falls-flat-and-what-scales-later) | Reference |
| 27 | [Out of scope](#out-of-scope) | Reference |

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
  vault, Netlify-style, and a large part of the continuity story.
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
11. **Who someone is, apart from how they're shown.** Reliquary always
    holds one unique identity per person (a user id, reached through
    their account's email), and stores only that. How others see and
    reach them (display name, a short tag, email or not) is a choice made
    when a page or tool response is drawn: the person's, within what
    their vault requires. Changing it never rewrites a stored row. A
    display name is text people chose, never code or an instruction
    (owner's call, 2026-10-13; #347).
12. **Agents get the least about people that does the job.** Data that
    identifies a person (an email, a phone number, an address, anything
    a person could be contacted or traced by) never reaches an agent:
    an agent tells people apart by their user id, display name and short
    tag, and that is all it is given, whatever a person shows other
    people. Data an agent never touches can't leak through a prompt, a
    log or a model provider. Like a secret value (principle 5), the
    database withholds it from an agent session; a page, read by a
    person, may show it (owner's call, 2026-10-13; #347).

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
  `preview`, `production`, or custom), like Netlify's.
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
| See and clear searches that found nothing, set how long they are kept | yes, in person | no | no | never |

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
| `search` | Words and meaning together: full text, plus gte-small embeddings from an Edge Function in pgvector, blended by rank ([Search](#search)); words alone when the function is down, and the response says so |
| `read_file`, `list_files` | Text returned as quoted data with its policy, author and approvals |
| `related_files` | The files a path refers to and the files that refer to it, with each one's policy; kept from `[[path]]` and Markdown links when a file is saved, no model |
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

## Search

Designed 2026-10-17, before it was built (#207), on the owner's decision
of that day to build it ahead of milestone 3 (the decision log in
[progress.md](progress.md#decisions)). Search by words alone misses a
question that shares no words with its answer: "what are we charging"
never finds `decisions/pricing.md` if it says "seats" and "plans". So
`search` also ranks by meaning, gated exactly as reading a file is.

### 1. The model, and where it runs

**gte-small**, Supabase's built-in embedding model
(`Supabase.ai.Session('gte-small')`, 384 dimensions, mean-pooled and
normalised), in one Edge Function, `embed` (`supabase/functions/embed/`).
It runs in Supabase's edge runtime, inside the project that already holds
every vault's text: there is no third-party model provider and no API key
for one, and vault text only travels between Reliquary's own servers and
its own Supabase project, as it already does on every read. This is the
one model Reliquary runs itself, and it only turns text into numbers; the
[out of scope](#out-of-scope) line about a Reliquary-hosted model is about
models that write (routines use the vault's own key).

The function is **stateless**: text in, vectors out. It has no database
credentials and stores nothing.

- `POST` with `Authorization: Bearer <EMBED_SECRET>` and a JSON body
  `{"input": ["text", ...]}`: 1 to 16 strings of at most 2,000 characters.
- `200` with `{"embeddings": [[384 numbers], ...]}`, one per input, in
  order. `401` without the secret, `400` for any other body, `405` for
  another method, `503` when its own `EMBED_SECRET` isn't set. A refusal's
  answer says which, in words.
- It logs neither the input nor the secret.

**Why stateless**, rather than the usual Supabase pattern of a function
that drains a queue over its own database connection (pgmq, pg_cron and
pg_net calling it): no database role or password lives in the function,
no shared secret lives in the database for pg_net to send, and every rule
(the queue, the gate, the lifecycle) stays in Postgres and the MCP
server, which the default test suites run. A test double that keeps the
same HTTP contract stands in for the function in tests; only the vectors
differ.

### 2. Where vectors live

`public.file_embeddings(file_id, version_id, vault_id, chunk, line,
embedding vector(384))`, primary key `(file_id, chunk)`: one row per chunk
of a file's **current** version, none for older versions. pgvector, with
an HNSW index on cosine distance.

- **Read:** RLS, `vault_id in (select private.readable_vaults())`, the
  predicate `file_versions` uses: whoever may read the file may read its
  vectors, and nobody else. There is no write policy.
- **Write:** only `private.store_embeddings` (security definer), which
  stores a file's vectors only if the caller may read it, it isn't deleted
  and it is still at that version, holding a share lock on the file's row
  so a write, delete or erasure in flight finishes first (and then the
  store finds nothing to do).
- **Chunks:** a file's text split at line breaks into chunks of up to about
  1,200 characters (a longer line is cut), the first 8 chunks only (about
  10 KB). The rest of a longer file is found by its words. `line` is the
  chunk's first line, for the excerpt.
- **Lifecycle** (triggers): a write that makes a new current version, a
  delete and an erasure each remove the file's vectors; a live file is then
  queued for new ones. Erased text leaves no vector behind. `delete_vault`
  removes them with everything else (the foreign keys cascade). They don't
  count toward a vault's storage.

### 3. Kept current, with no member machine

`private.embedding_queue(file_id, vault_id, version_id, queued_at)`: one
row per file whose current version has no vectors yet, filled by the
trigger above (and, once, by the migration for every file that existed).

**`search` drains it, for the vault it searches.** Before ranking, the MCP
server takes up to 8 queued files of that vault
(`private.embedding_pending`, which returns nothing for a vault the caller
can't read), chunks them and sends their chunks in the **same** function
call as the query, at most 15 chunks beside it. It stores what comes back,
then ranks.

Why at search time: vectors are only ever used by search, so the vault
being searched is the one that needs them; nothing has to run between
searches, so there is no scheduler, no pg_cron job, no pg_net and no
worker, and nothing depends on a member's machine. A file whose vectors
aren't ready is still found by its words. `embedding_pending` takes no
locks: two searches that embed the same file at once store the same rows
(the store is an upsert), and a write never waits on a model call.

Where it falls flat: a vault that gains hundreds of files at once (an
import, a restore) catches up 15 chunks per search. When that shows, a
scheduled sweep (a Netlify scheduled function, or pg_cron with pg_net)
calls the same drain.

### 4. The query, and the ranking

The query is the first input of that call. Its vector goes to
`public.search(p_vault, p_query, p_limit, p_embedding, p_min_similarity)`,
which stays `security invoker`, so RLS gates both halves:

- **Words:** as before, the `tsvector` match and the path substring, ranked
  by `ts_rank`.
- **Meaning:** the vault's nearest chunks by cosine distance, of live files
  at their current version, the best chunk per file, kept only at a cosine
  similarity of at least `p_min_similarity` (the MCP server's
  `EMBED_MIN_SIMILARITY`, default 0.78: gte-small rates unrelated texts
  around 0.7, so a floor keeps "No matches." meaning something). The vault
  filter applies after the index's ordering, so the function sets
  `hnsw.iterative_scan = relaxed_order` and the index keeps scanning until
  enough of the vault's rows pass; the result is then sorted by distance.
- **Blend:** reciprocal rank fusion, `1 / (60 + position)` summed over the
  two lists. A file in both rises above a file in one. Ranks, not scores,
  are blended, because `ts_rank` and cosine aren't on one scale.

Without `p_embedding` (a server with no function) the result is what it
was, row for row. The MCP response keeps its shape;
a file found by meaning alone shows up to 3 lines from its best chunk.

### 5. When the function is down

A timeout (8 s), a refused connection, a non-200 answer or an answer that
isn't 384 numbers per text: `search` logs a failure with its reference
(`failure.ts`), answers from words alone, and its first line says so, with
the reference: "Search by meaning is unavailable right now (the embedding
function answered 503; ref 1a2b3c4d). These results match words only."
Queued files stay queued. The database work of the drain runs under a
savepoint, so a failure there can't take the search down with it.

A server with no `EMBED_URL` (a self-host that hasn't set it up) searches
by words, silently: that is a configuration, documented, not an outage.

### 6. Self-hosting

- Postgres needs **pgvector**: `deploy/compose` runs
  `pgvector/pgvector:0.8.2-pg17-trixie`, which is the official Postgres 17
  image with pgvector added (on Supabase it is a built-in extension). The
  migration creates the extension, so a database without it can't migrate.
- Search by meaning is optional. To have it, run the same function in
  Supabase's open-source edge runtime (`supabase/edge-runtime`, serving
  `supabase/functions`), with `EMBED_SECRET` set, and give the MCP server
  `EMBED_URL` and the same `EMBED_SECRET`. The runtime downloads the model
  on first use; no vault text goes with that download.

### 7. Encryption at rest (#238)

Vectors leak meaning: an embedding can be turned back into a close
paraphrase of its text (embedding inversion). So they are content, and
they get whatever content gets. Today file text is plaintext in
`file_versions`, and the vectors expose nothing the text beside them
doesn't. When #238 makes content ciphertext, cosine ranking can't run over
ciphertext in Postgres, so the vectors are encrypted under the same content
key and ranking by meaning moves to the MCP server: it decrypts the
searched vault's vectors and scores them in memory, the same move #238
makes for words, and the HNSW index goes. Until #238 lands this is a
recorded gap, not a decision to keep vectors in the clear; the design is
[Encryption at rest: the content key](#encryption-at-rest-the-content-key).

### What this doesn't settle

- Long files past their first 10 KB, and big imports, as above.
- Model changes: vectors of two models don't mix. Changing the model means
  queuing every file again (one `insert ... select` into the queue).

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
and phase 3 (work plans); waiting in line (item 11, CL-3.9, #74), its MCP
tools (#75), the view of who is waiting (#76) and review gates (#78) built
on 2026-10-13. Not built: the load test through the hosted path (CL-3.11,
#82). [progress.md](progress.md) has what shipped. Validated first in a throwaway
PostgreSQL 16 model, not Reliquary's schema and with no RLS: [spikes/claims/](../spikes/claims/README.md).
Twelve points, each with the reason it was decided that way, and a thirteenth added later.

### 1. Names

`work_plan`, `step` and `claim`, not `plan` (already a billing plan,
[Plans and limits](public/concepts/plans-and-limits.md)) or `task` (an
MCP-spec extension). Tools: `claim_path`, `renew_claim`, `release_claim`,
`list_claims`, `register_work_plan`, `work_plan_status`, `request_work`,
`leave_queue`, `my_places`, `claim_step`, `checkin_step`, `complete_step`,
`release_step`, and person-only `break_claim`, `cancel_step`, `skip_step`,
`reopen_step` and `approve_step`: the last five follow the same ceiling as
approving and revealing a secret, an agent's role never executes them. The
web app shows a step as a task (`docs/public/concepts/tasks.md`).

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

A registered plan only gains steps (issue #262, the owner's choice of
2026-10-13). Registering the path again from a newer version adds the
steps whose keys are new and keeps every registered step as it is, state
included; a registered step missing from the file, or with a different
title, gate, `blocked_by` or `cites`, is refused by name and nothing
changes. That one rule keeps the graph's invariants: no done or claimed
step gains a blocker, nothing held disappears, a new step can't block an
old one (so a cycle can only form among new steps, which the full-plan
check finds), and a new step's stored count is its blockers not yet done.
The plan records the version and who added steps last, and the log has
`work_plan.update`. Registering again from the version already registered
is refused; a newer version with no new steps is recorded, which is how
"changed since registered" is cleared after an edit that adds nothing.
New steps' counts and `complete_step`/`skip_step` serialize on one
advisory lock per plan (20261013160000_work_plan_gains_steps.sql says why).

### 7. Step states

Stored: `open`, `claimed`, `review` (awaiting review, since #78), `done`, `cancelled`. Computed, never stored,
so nothing can drift out of sync with the graph: `ready` (open, every
blocker done), `blocked` (open, a blocker not done yet),
`blocked_by_cancelled` (a blocker is cancelled, so it can never become
done). A cancelled step never counts as done: a step waiting on it
stays blocked forever unless a person cancels or skips it too, or
reopens the cancelled step (`reopen_step`, 2026-10-13, #327), matching the
spike's own finding that a cancelled blocker needs its own computed
state, not a silent pass-through. A step may carry `gate: review`, which
holds its dependents until a person approves it directly or its linked
proposal is applied, for a step whose output needs a person's judgement
before anything downstream should start, not just before it's marked
done. **As built (2026-10-13, #78;** `20261013233000_review_gate.sql`):
completing a gated step stores `review`; `approve_step` (on the ceiling)
or the linked proposal being applied makes it `done` and only then
decrements its dependents. The link is the completing agent's: it names
a proposal its own person made since claiming the step, still undecided,
and a trigger on the proposal reaching `applied` approves the step.

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
`work_plan.update`,
`step.claim`, `step.complete`, `step.release`, `step.cancel`,
`step.skip`, `step.approve`, `step.checkin`, `step.reopen`, `queue.join`,
`queue.leave`, `queue.expire`.

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

**As built (2026-10-13, #74;** `20261013170000_waiting_in_line.sql` to
`20261013170300_leave_queue.sql`). `request_work(vault, path)` and
`leave_queue(vault, path)`, executable by whoever can write the plan's
path, identity from the session as `claim_step` takes it. The rule, the
lapse of a place, the cheap refusal, the hint cap and the strikes are the
spike's, ported onto `work_plan_steps` and the claim rule's stored
waiting settings (item 3; with no rule, the Org preset: a place lives 6
hours, the longest hint is 1 hour, the minimum gap 15 minutes, one free
lapse, a 48 hour cooldown cap). Where it differs from the spike:

- **The answer to "too many places" is `refused`**, and the 3 places per
  person in a vault (item 8) is a constant, not a rule column.
- **Item 12a's "one way in" is the API role's, not a separate agent
  role:** agents and people share `authenticated`, which writes neither
  places nor strikes, and reads places (who is waiting) as it reads steps.
  `claim_step`, naming one step, stays executable by agents, and since
  #75 (`20261013220000_claim_step_follows_the_line.sql`) runs the same
  function as `request_work` (`private.take_step`, which no API role
  executes) with the pick narrowed to the named step: it is granted only
  what `request_work` would grant that caller at that moment, so it keeps
  the line, the caps and the cooldown, and a refusal takes no place.
- **A strike is counted when a lapsed step is handed on**, by
  `request_work` or, since #75, by `claim_step`.
- **Lock order.** `request_work` and `leave_queue` take the vault's row
  first (for key share), the order `post_message` uses, because they
  insert places and an insert has no row `delete_vault` could lock ahead
  of it; `delete_vault` is unchanged. One person's requests to a vault
  take turns on an advisory lock, so two at once leave one place. Other
  people's lapsed places and the step are taken with SKIP LOCKED.
- **Events:** `queue.join` when a place is taken, `queue.leave` when its
  holder leaves, and `queue.expire` when it ends without them, with the
  reason (`lapsed`, `plan_complete`, `cooling_down`), logged as the
  holder's. A grant ends the place silently; `step.claim` records the
  place and the ready count it was granted at.
- **Rate limits (item 8):** the per-token one is the MCP server's (#75,
  `mcp/src/ratelimit.ts`); the per-vault budget is the database's (#80,
  `20261013235000_vault_request_budget.sql`), so it holds whichever server
  calls: `take_step` counts each full evaluation (not a cheap refusal)
  against the vault, 300 a minute, the number the capacity model gives (a
  Pro vault's 50 people, one place each, at the 10 second floor), and over
  it answers `wait` with no place and the seconds until the vault's minute
  ends; `claim_step` refuses it as RLW06. The model:
  `docs/public/reference/limits.md`, "What asking for work costs".
- **One read for every line** (#79, `20261013230000_my_places.sql`):
  `my_places()` gives the caller's person, across the vaults the caller
  reads, each place's state as `request_work` would answer it (with
  `lapsed` for a place that ran out) and each step held, writing nothing
  (item 12d's cheap read, for every plan at once). Over MCP it counts only
  against the general tool call limit, not item 8's `request_work` one.
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

### 13. Planning fields

Added 2026-10-13 (owner's call, issue #334), so the Tasks page can read
like a task list a person plans around, not only a dependency graph.
Four optional lines per step in the `work_plan` block, each stored per
step at registration from the registered version, the same as `title`:
editing the file later changes none of them, consistent with item 6.

- `due: 2026-10-20`, a calendar date with no time or zone. The Tasks
  page sorts by it within each state, and says **Overdue** once the day
  has ended everywhere (UTC-12): the server can't know a viewer's zone
  without a script or a setting, so it is never early and at most a day
  late in the far east (as built, #374). Grouping by Overdue, Today and
  Upcoming waits for a viewer's zone. A date in the past is accepted: a
  plan written late is still a plan.
- `priority: 1` to `4`, 1 highest, Todoist's scale. It orders tasks
  within a group and is shown as a word with its colour, never colour
  alone.
- `notes: ...`, one line of plain text up to 2000 characters, half a
  proposal reason, because a step's notes are a pointer, and the plan
  file is where long text belongs. Shown to agents between markers as
  data, never as instructions, the same as `title` and a claim's label
  (item 12).
- `for: agents`, `for: people`, or a member's short tag (the first 8
  characters of their id, shown beside their name everywhere). The tag
  is resolved to the member's user id at registration, among this
  vault's members only, and refused, with the line, if it names none
  or more than one; the step stores the id. An email is refused on
  sight, by the parser and the database, with a message saying to use
  the tag, and neither looks the address up, so a refusal never says
  whether it belongs to a member (#378, principle 12). A page shows
  that member however people are shown everywhere else. A hint for who should pick the
  task up, and only a hint.

None of the four is an access rule or a claim rule. A step is claimable
exactly as items 3, 4 and 12(c) say, whatever its `for`, `due` or
`priority`: a hint that gated claims would be a second permission
system living in file text, and an agent could not tell it from a rule
it may break. A due date passing changes no state and starts no
routine. When waiting in line (item 11) is built, whether `priority`
orders which ready step a waiting agent is offered is its own decision,
not settled here.

Settled 2026-10-13 (owner's call): `for` names a member by something
unique, because a display name is not. It was their email until
2026-10-17 (#378): plan files are vault content agents read, so an
address in one reached a model, and resolving it told the agent
whether that address belonged to a member. Now it is the short tag.
Steps registered from an email keep working as stored, since the step
held the id and never the address; re-registering such a file is
refused until the line names the tag. What identifies a person (their
id) stays separate from how they are shown, so letting a person choose
how co-members see them is its own change and never touches a stored plan.

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
Threads in a vault's export built 2026-10-13 (#197). A thread is where people and their
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
- **The export format.** Settled when it was built (2026-10-13, #197,
  `20261013150000_export_threads.sql`): each thread is a Markdown file
  under `threads/`, numbered in the order threads opened, its messages
  quoted under headings the exporter writes, and the manifest lists each
  thread. A task anchor reads as `task:<plan path>#<step key>`, the
  citation item 9 uses, since tasks are not exported and the plan file
  is. `export_vault`'s one snapshot fixes the thread list and the latest
  message id; bodies are read as each page is served, so a redaction made
  mid-export wins, as erasure does for files. Thread text doesn't count
  toward the 100 MiB cap: item 8's limits bound it. Nothing imports an
  export yet, so no thread is restored from one.
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
  A vault-wide OAuth sign-in by an owner is designed below ([OAuth
  sign-in for a link](#oauth-sign-in-for-a-link-442)).
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
  moves link credentials with the values). A compromised upstream
  credential is replaced in place, without deleting and re-adding the
  link (2026-10-18, issue #439, `20261018120000_link_replace_credential.sql`).

### OAuth sign-in for a link (#442)

Written 2026-10-18 and approved by the owner 2026-10-19, with the
decisions at the end; not built yet. Many hosted MCP servers take only
OAuth, so today they can't be linked at all. This adds one more way to give a link its credential: an
owner signs Reliquary in to the upstream server once, in person, and the
whole vault then uses that one grant exactly as it uses a pasted key now.
It is still a shared credential (one upstream account for the vault).
Per-member OAuth ("my Gmail") stays later.

It follows the MCP authorization spec as it stands (2026-07-28):
protected resource metadata (RFC 9728) to find the authorization server,
authorization server metadata (RFC 8414, or OpenID Connect discovery),
the authorization code grant with PKCE S256, a `resource` parameter
(RFC 8707) on every authorization and token request, and the `iss` check
of RFC 9207. Reliquary is the OAuth client here, the mirror image of what
`web/src/oauth.ts` serves.

**Who authorizes.** An owner, signed in to the web app, on the link's
page. Connecting, reconnecting and disconnecting a sign-in are edits of
the link, and "add, edit or delete a link" is already on [the
ceiling](public/concepts/agents.md#the-ceiling), so no agent can do any of
them through any connection. The database enforces it the way it already
does for links: every function that starts, completes or removes a
sign-in calls `private.require_human()` and checks the owner role. When
built, the ceiling's line says so in words: "add, edit or delete a link,
sign it in to or out of its server, or set its tool grants". The consent
step says plainly that everyone granted the link's tools will act as the
upstream account the owner signs in with.

Refreshing a token is not an action anyone takes: Reliquary does it when
a granted call needs it, for whoever made the call, under the grants that
already allowed the call.

**The flow, end to end.**

1. The owner adds a link (or edits one) and leaves the credential empty.
   The web app sends an unauthenticated `initialize` to the URL. A `401`
   with a `Bearer` challenge offers **Sign in**; any other answer keeps
   today's paste-a-credential form.
2. Protected resource metadata: the `resource_metadata` URL from the
   challenge if there is one, else the well-known URL with the link's path
   inserted, else the one at the root (the spec's order). The document's
   `resource` must equal the link's URL exactly, and the metadata URL must
   be on the link's own origin. Anything else is refused, naming which.
3. Authorization server: the first entry of `authorization_servers`. Its
   metadata comes from the spec's well-known URLs in order; the document's
   `issuer` must be identical to the issuer used to build the URL. Refused
   unless `code_challenge_methods_supported` includes `S256`,
   `response_types_supported` includes `code`, and the authorization and
   token endpoints are https URLs with no userinfo or fragment.
4. Client identity: a Client ID Metadata Document that Reliquary serves
   itself at `<PUBLIC_URL>/links/oauth-client.json` (the same shape as the
   CLI's `/cli/oauth-client.json`), with `client_name` "Reliquary", one
   redirect URI, `<PUBLIC_URL>/links/oauth/callback`, `grant_types`
   `authorization_code` and `refresh_token`, and
   `token_endpoint_auth_method` `none` (a public client: there is no
   client secret to keep). It is used when the metadata has
   `client_id_metadata_document_supported: true`. A self-hosted
   deployment serves its own at its own `PUBLIC_URL`. Dynamic client
   registration (RFC 7591) is not built in this step: the spec deprecated
   it in 2026-07-28, and the servers we need first support the document
   (see the open questions). A server that offers neither is refused with
   that reason.
5. The owner sees a page naming the authorization server's host, the
   scopes and the warning above. **Continue** redirects the browser to the
   authorization endpoint with `response_type=code`, the client id, the
   redirect URI, a fresh `state` (32 random bytes), the S256
   `code_challenge`, `resource` (the link's URL) and `scope`.
6. A pending row records what the callback must match: the SHA-256 of
   `state`, the link, the owner, the issuer, the token endpoint, the
   resource and the sealed PKCE verifier. It lasts 10 minutes and is used
   once.
7. The callback (`GET /links/oauth/callback`) needs the same person signed
   in, still an owner of the vault, the link's URL unchanged since the
   pending row, and `iss` checked against the recorded issuer per the
   spec's table (rejected when the server advertises `iss` and leaves it
   out). Only then does the code go to the token endpoint, with the
   verifier, the redirect URI, the client id and `resource`.
8. The token response must be `token_type` Bearer (any case) with an
   `access_token`. Both tokens are sealed and stored, and discovery
   (`tools/list`) runs with the new access token exactly as it does after
   a pasted key.

**What is stored, and how it is sealed.**

- The access token goes in `private.link_secrets`, the row a pasted
  credential uses, sealed with `sealLink` as today. `begin_link_call`,
  `linkproxy.ts` and the egress path are unchanged for it.
- The refresh token goes in a new `private.link_refresh_secrets(link_id,
  key_id, nonce, ciphertext)`: no grants, RLS with no policies, reached
  only through functions granted to `reliquary_web`. It never reaches
  `mcp/`: `begin_link_call` doesn't return it, and the MCP role can't
  call the functions that do. Its additional authenticated data is
  `["reliquary.link.refresh.v1", vault_id, link_id]`, so it can't be
  opened as an access token, or as another link's, even in the same vault.
- The PKCE verifier in the pending row is sealed the same way, with its
  own AAD label.
- Non-secret state goes in `public.link_oauth(link_id, vault_id, issuer,
  token_endpoint, revocation_endpoint, client_id, resource, scope,
  expires_at, generation, refreshing_until, status, status_reason,
  connected_by, connected_at, refreshed_at)`. Vault members read it (the
  same RLS as `public.links`); only the functions below write it.
- Key rotation reuses `VARIABLES_KEYS` and `rotate-variables-key.sh`:
  `variable_key_ids`, `rekey_vaults` and `sealed_rows` gain the refresh
  tokens, and pending verifiers count while unexpired, like pending env
  imports. No new key material.
- `delete_vault` and deleting the link remove all of it. Disconnecting
  revokes the refresh token at the server's `revocation_endpoint`
  (RFC 7009, best effort, and the page says if it failed) and deletes the
  rows.

**Refresh.**

- Only the web app refreshes, since only it holds the keys. It happens
  inside `/internal/link-call` and discovery, lazily: before a call when
  `expires_at` is less than 60 seconds away, or once after the upstream
  answers `401` (an unauthorized call did nothing, so one retry is safe).
  There is no background job. A link nobody calls for longer than its
  refresh token lives will need reconnecting.
- For an OAuth link, `mcp/` sends the link id and the `generation` it was
  handed; the web app takes the URL from the database, not from the body,
  so a refreshed token can only go to the link's own URL, and a refresh
  token only to the recorded token endpoint.
- Parallel calls: refresh tokens rotate (OAuth 2.1 requires it for public
  clients), so two refreshes with the same token lose the grant, and some
  servers revoke the whole family when they see one reused. So there is
  one refresh at a time per link. `private.begin_link_refresh(link,
  generation)` sets `refreshing_until` (15 seconds) only if the generation
  still matches and no lease is live, and returns the sealed refresh token
  to the winner alone. The winner calls the token endpoint, then
  `private.finish_link_refresh` stores the new access token, the new
  refresh token (or keeps the old one if none came back) and the expiry,
  and bumps `generation`, in one statement, before the call goes on.
  Every other call waits up to 3 seconds for the generation to move, then
  reads the new access token; if it doesn't move, that call fails saying
  a refresh is in progress.
- A crash after the server rotated the token but before it was stored
  leaves the old refresh token, which the server will refuse. That shows
  as a lost sign-in (below), not a silent failure.

**Failure: a revoked or expired grant.**

- A token endpoint answering `invalid_grant`, a `401` straight after a
  successful refresh, an expired access token with no refresh token, or
  the server's metadata naming a different issuer at reconnect all set
  `status` to `needs_reconnect` with a fixed reason, and write a
  `link.signin_lost` event to the vault's log.
- The Links page shows the link as **Sign-in expired**, with the reason,
  when, and a **Reconnect** button for owners. Others see that an owner
  can fix it.
- The agent's call fails through the shared failure model: what (calling
  `<link>.<tool>`), where (the link), why ("this link's sign-in to
  mcp.linear.app was revoked or has expired; an owner can reconnect it on
  the Links page"), and a ref. The server's own `error_description` is
  never relayed: the server log keeps its error code only, and upstream
  text is data.
- Calls while `needs_reconnect` are refused in `begin_link_call` with no
  egress. `link_calls` gets a nullable `reason` column (fixed vocabulary,
  starting with `needs_reconnect`), so the call log tells a lost sign-in
  apart from a refused grant.
- A `403` with `insufficient_scope` fails the call naming the scopes the
  server asked for. Asking for more scope needs an owner to reconnect;
  Reliquary never steps up on its own.
- Reconnecting replaces the tokens in place: the link, its tools, grants
  and call log stay. For OAuth links this also answers the open question
  above about replacing a compromised credential the same day.

**SSRF, for every outbound request.** Every server-side fetch goes through
`netsafety.ts`'s `safeFetch`: https only, every resolved address public
and checked at connect time (no rebinding), no redirects, a timeout and a
byte cap. The protected resource metadata (its URL comes from the
upstream's own challenge, so it is someone else's choice), the
authorization server metadata, the token endpoint and the revocation
endpoint each get it: 5 seconds and 64 KB for metadata, 5 seconds and
16 KB for token responses, JSON only. The token and revocation endpoints
are re-checked on every request, not trusted from when the link was
connected. The authorization endpoint is never fetched by the server: the
owner's browser goes there, so its rules are the confirmation page naming
its host before the redirect, and an https URL with no userinfo or
fragment. Issuers, scopes and endpoint hosts shown to the owner are
escaped like any other upstream text. The loopback escape hatch for tests
is the existing `LINK_DISCOVERY_ALLOW_LOOPBACK`.

**Scopes.** The `scope` from the server's `401` challenge, else the
protected resource metadata's `scopes_supported`, else none, plus
`offline_access` when the authorization server lists it (some servers
only issue a refresh token for it). The granted scope is stored and
shown on the link. The scope is the upstream's coarse ceiling; the link's
per-role tool grants stay the control inside it.

**With a pasted credential, and with #441's header.** A link has one way
in: a pasted credential or a sign-in (`links.auth`, `credential` or
`oauth`). Switching is an owner's edit in person: signing in replaces a
pasted credential once the token exchange succeeds, and pasting one
disconnects the sign-in. An OAuth link always sends `Authorization:
Bearer <access token>`, as the spec requires, so #441's custom header
doesn't apply to it: a database check refuses a header other than
`Authorization` on an `oauth` link, and the form hides the field.

**What changes in the access table.** One row, and the ceiling's wording
above:

| Action | owner | editor | viewer | service agent |
|---|---|---|---|---|
| Sign a link in to or out of its server (OAuth) | yes, in person | no | no | never |

Who may call an OAuth link's tools doesn't change; it is the link's
grants, as for any link.

**Hostile tests it needs.**

- A member's agent, on any connection, an owner's included, starting,
  completing, reconnecting or disconnecting a sign-in; an editor or viewer
  in the web app doing any of them.
- A callback with another person's `state`, another vault's, an expired
  or reused one, or after the link's URL changed: refused, nothing stored,
  the code never sent.
- A callback whose `iss` differs from the recorded issuer, or is missing
  when the server advertises it: refused before the token request.
- Metadata whose `issuer` differs from the URL it came from, a resource
  metadata `resource` that isn't the link's URL or a metadata URL on
  another origin, and an authorization server without `S256`: refused
  before any redirect.
- Every one of the four fetched URLs on a private, loopback or link-local
  address, over plain http, or redirecting: refused.
- An access or refresh token in any MCP tool result, log line, change
  event, `link_calls` row, error or page: never.
- The MCP role selecting `link_refresh_secrets` or calling the refresh
  functions; `begin_link_call`'s output containing a refresh token.
- A refresh token sealed for link A, moved to link B in the same vault,
  failing to open.
- Ten parallel calls with an expired access token making exactly one
  token request (a fixture authorization server counts them).
- A refreshed token only ever sent to the link's URL from the database,
  and a refresh token only to the recorded token endpoint, whatever URL
  `mcp/` sends.
- An `invalid_grant` turning the link to `needs_reconnect`; the next call
  refused with no egress and logged with its reason.
- A `link_calls` row, or a `link.signin_lost` event, updated or deleted,
  except by `delete_vault`.
- `rotate-variables-key.sh` moving refresh tokens, and the server refusing
  to start when one names a key id it doesn't have.

The fixtures are a loopback MCP server, resource metadata and
authorization server, the way `web/test/discovery.test.mjs` serves an
upstream today. The public docs that change when it's built:
`docs/public/how-to/add-a-link.md`, `docs/public/concepts/links.md`, the
ceiling in `docs/public/concepts/agents.md`, and
`docs/public/reference/permissions.md`.

**What stays out.** Per-member OAuth ("my Gmail"). Dynamic client
registration and pasting a pre-registered client id and secret, until an
upstream we need requires them. A fallback for servers with no protected
resource metadata. Refreshing in the background. Asking for more scope
without a person. The `client_credentials` grant, `private_key_jwt`, and
enterprise-managed authorization (Linear and Notion advertise the
`jwt-bearer` grant for it).

Decided by the owner, 2026-10-19:

- **Client registration.** The client document only. Dynamic
  registration waits for an upstream we need that requires it.
- **Servers without protected resource metadata** (Atlassian, checked
  2026-10-18) stay on a pasted key; there is no fallback to the link's
  origin. Atlassian takes a service account's API key as a Bearer token
  once an org admin allows API tokens.
- **Linear, for milestone 3.** The week of real use runs on a pasted
  Linear API key; this is built after it.
- **When the owner who signed in goes.** Deleting their account
  disconnects every sign-in they made and revokes it upstream (RFC 7009,
  best effort). Leaving the vault or stepping down from owner keeps the
  sign-in, and the link shows owners a warning naming who signed it in
  until another owner reconnects or disconnects it.
- **A lost sign-in** also flags the vault's owners
  ([Notifications](#notifications)), beside the Links page, the log and
  the failing call.
- **Scope.** Reliquary requests what the server asks for; the owner
  doesn't pick a narrower set. Grants still decide which tools an agent
  can call.

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

## Encryption at rest: the content key

Designed 2026-10-19 (#238, part of #234), before it is built. Variable
values, link credentials and pending imports are already AES-256-GCM
ciphertext under `VARIABLES_KEYS`, keys the database never holds. Vault
content is not: file text, proposed text, notes, thread messages and the
search vectors sit in plaintext, so a leaked database, a stolen database
credential or a lost backup is a leak of every vault. This section makes
content ciphertext the same way, with the operator still able to decrypt
(level B of #234; zero-access for content was decided against on
2026-10-10, since hosted agents, search and routines read it server-side).

### 1. What is content

The columns that hold what people and agents write, and anything a
model's output can be turned back into:

| Column | Today | Becomes |
|---|---|---|
| `file_versions.body` | text | sealed |
| `proposals.body` | text | sealed |
| `proposal_notes.body` | text | sealed |
| `thread_messages.body` | text | sealed |
| `file_embeddings.embedding` | `vector(384)` | sealed (the 384 floats as bytes) |

Metadata stays plaintext: paths, names, authors, agents, timestamps,
statuses, proposal reasons, work plan step keys and titles (a plan's
outline, quoted from the file so the Tasks view and claims work in SQL),
and the log, which holds no content by design. Feedback messages and
invite addresses are not vault content and are #240's. The schema guard
(F799) gains a list of content columns: each must be `bytea`, and a
`text` column whose name is `body` or `message` outside that list fails
the test.

### 2. The envelope

One `bytea` column keeps every SQL path that copies, blanks, counts or
null-checks a body unchanged. A sealed body is
`NUL || key_id length (1) || key_id || nonce (12) || ciphertext || tag (16)`,
built by `sealBody()` in `content.ts` (the same file in `web/src` and
`mcp/src`) with the **vault id as the additional data** and nothing else.
Text can't start with a NUL byte, so the marker tells a sealed body from a
plaintext one during the backfill. The vault id alone, not the row, is deliberate:
`approve` copies a proposal's body into a new version in SQL, and
erasure and redaction set it null; neither needs the key. A body moved to
another vault fails to open, which is the hostile test. The key id is in
the envelope so rotation can find rows by their prefix; no second column.

Storage accounting (`octet_length(body)`) counts the envelope, about 40
bytes over the text; the 1 MiB check keeps its number. `thread_messages`'
`(body is null) = (redacted_at is not null)` is unchanged.

### 3. The key set

`CONTENT_KEYS`, the same `id:key` list, parser, rotation script and
`rekey.ts` path as `VARIABLES_KEYS`, and a separate set: a content key
opens no variable, and the rotation of one leaves the other alone. Both
servers hold it. The MCP server serves files, so it must decrypt them; it
keeps refusing to start with `VARIABLES_KEYS`, so it still can never open
a value. This widens nothing: the MCP server reads every body it serves
today. What changes is that a database alone, or a backup alone, opens
nothing.

Required on Netlify and when `SELF_HOSTED=1`, like the variables key;
refused if it equals a variables key. `deploy/setup.sh` generates it.

### 4. Search

Postgres can't match words or rank vectors it can't read, so both halves
of `search` move up into the server that holds the key:

- **Words:** `search()` keeps RLS and the path match, and returns the
  vault's live files with their current sealed bodies, newest first, up to
  a cap. The server opens each and matches words over its first 10 KB,
  the same slice meaning already covers; a longer file is found by its
  path and its head. Ranking is the same `ts_rank` idea done in the app
  (term frequency over the slice), blended with meaning by rank as today.
- **Meaning:** the vault's sealed vectors come back in the same call; the
  server opens them and scores cosine in memory. The HNSW index and
  `hnsw.iterative_scan` go; pgvector stays installed only because a
  migration created it.
- **The cap:** 2,000 files per search (20 MB of text to open and scan,
  tens of milliseconds of AES-GCM). A vault past it searches its newest
  2,000 and the first line says so. That is the new "falls flat" row.
- The web app's searches work the same way, words only, in `web/`.
- **Done when:** `search` returns what it returns today, row for row, for
  the existing test corpus, by both words and meaning.

### 5. Everything else that reads or parses a body

- **Reads:** `read_file`, diffs, the editor, proposals, threads, export,
  `changes_since` and the feed's excerpts open bodies in the app. One
  helper, `openBody(row, vaultId)`, so no caller handles an envelope.
- **References** (`[[path]]`, section Search): the trigger that parses a
  file's text in SQL goes. The server that writes a version already has
  the plaintext: it extracts the references and passes them as
  `p_references text[]` to the write and approve functions, which replace
  the file's rows. Paths are metadata; the hostile test is that an agent
  can't name a target its text doesn't contain (the function trusts the
  list, so the test checks the two servers, not SQL).
- **Embeddings:** computed from plaintext in the MCP server as now,
  sealed before `store_embeddings`.
- **Work plans:** parsed in the MCP server already; unchanged.
- **Erasure, redaction, `delete_vault`, export's byte counts:** unchanged
  in SQL.

### 6. Migration

1. The key set, `seal`/`open` for bodies, and the guard's content list,
   behind nothing: both servers can open a plaintext body (a row whose
   first byte isn't the envelope marker is plaintext), so reads work
   during the backfill.
2. `alter column body type bytea` per table, with the plaintext bytes
   kept as they are, and every function that writes a body sealing it.
3. The backfill: `rekey.ts` extended, run as `reliquary_ops` (the role
   that serves no requests), in batches, sealing each plaintext row in
   place and reporting counts only.
4. The plaintext read path is dropped only after `scripts/restore-test.sh`
   has restored an encrypted backup taken after the backfill, and the
   guard then fails on any unsealed row.

Each step is its own PR; the week-of-use gate holds between 3 and 4.

### Hostile tests

- No `public` or `private` column holds vault content as text (F799's
  content list, run on every push).
- A body sealed in vault A fails to open under vault B's id.
- `reliquary_web` and `reliquary_mcp` can't call the backfill.
- A search over a vault whose bodies are sealed returns the test corpus's
  results by words and by meaning.
- The MCP server refuses to start holding `VARIABLES_KEYS`, with
  `CONTENT_KEYS` set.

### What this doesn't settle

- A key per vault, dropped on delete, so backups forget at once (#239):
  it wraps per-vault keys under this key set and follows this.
- Feedback and invites (#240).
- The security page's table: every content row says "ciphertext" when
  step 4 lands, not before.

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
    Settings: every live file's current text under `files/`, each thread
    as Markdown under `threads/` ([Threads](#threads), item 10), and
    `reliquary-export.json` with the vault, its default policy and rules,
    each file's SHA-256, size and last write, and each thread. Variable values are never
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
with their email address typed (checked by the database too). Owning
vaults never refuses it (owner's call, 2026-10-13; #381). In one
transaction: a vault nobody else is in is erased with the account, by the
same `private.erase_vault` as `delete_vault`, leaving its
`vault_deletions` row; they leave every other vault (a `member.leave` log
entry each, marked `account_deleted`); a vault left with members but no
owner is **orphaned** (the entry is marked `orphaned`) and its waiting
invites are withdrawn; vaults they created count against the
longest-standing remaining owner; every
connection is deleted; invites they made that are waiting are withdrawn,
and invites they accepted are deleted (the only rows of Reliquary's own
that tied the account to an address); their display name, plan, admission,
snoozes, notices, sign-out cutoff and unapplied pasted imports are deleted;
and the `auth.users` row itself, so Supabase Auth forgets the address and
every session. A row in `private.deleted_accounts` keeps the id and when;
`check_session` refuses that id from then on and `co_member_people` names
it "a deleted account" (`20260926140200_delete_account.sql`).

An orphaned vault keeps working for its members as their roles allow;
what only an owner may do is refused because nobody holds the role. Any
member may take it (`take_vault`): the first becomes its owner, nobody
is made one without choosing it, and an agent or token can't (it charges
a plan, so it is on the ceiling). Taking it counts against the taker's
plan and is refused at their vault limit; `vaults.created_by` becomes the
taker, since it already means "counts against" everywhere (`create_vault`,
`my_plan`, `vault_limits`), so the vault takes its limits from their plan
from then on. Until taken it counts against the deleted account, whose
plan is gone, so it has the Free plan's limits: orphaning never holds a
vault outside a plan once it has an owner again. The last member of an
orphaned vault can't leave it, so no vault is left that nobody can reach
or delete (`20261014170000_orphaned_vaults.sql`).

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
  variables key, so it can never decrypt a value; link calls go through
  the web app's internal endpoint with a shared secret. (When #238 lands
  it holds `CONTENT_KEYS`, to open the files it serves.)
- **`cli/`** is the `reliquary` binary (Node, no runtime dependencies).
- **Hosting:** two Netlify sites (`web`, `mcp`) and a Supabase project, or
  `deploy/compose` for self-hosting. No customer-side infrastructure.
- **Multi-tenant:** vaults are the tenancy boundary, and RLS enforces it.
- **One Edge Function,** `embed`: gte-small text embeddings for search
  ([Search](#search)). Stateless, behind a shared secret
  (`EMBED_SECRET`), called only by the MCP server.
- **Not built, and not in use anywhere:** `pgmq`, `pg_net` and Supabase
  Vault. They belonged to the routines design (Routines,
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
  version), `file_embeddings` (vectors of each file's current version,
  [Search](#search)), `private.embedding_queue`, `path_policies(path, policy, quorum)`, `path_owners`,
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
- **Search:** a session for vault A getting a vector, a chunk or a hit by
  meaning from vault B; a vector for a deleted, erased or superseded
  version; storing vectors for a file the caller can't read; writing
  `file_embeddings` directly.
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
| Search | Postgres full text plus gte-small embeddings (pgvector, HNSW with iterative scans under RLS), blended by rank, embedded at search time | A vault gains hundreds of files at once, files matter past their first 10 KB, or one index over every vault gets slow | A scheduled sweep, more chunks per file, per-vault indexes or partitions |
| Search over ciphertext (#238) | The server opens a vault's newest 2,000 files and scores words and vectors in memory | A vault passes 2,000 files, or searches get frequent enough that opening 20 MB each time shows | An encrypted index kept by the server (a per-vault cache with a lease), or searchable encryption |
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
- A Reliquary-hosted model that writes. Every such call uses the vault's own
  key; the one model Reliquary runs is gte-small, for search
  ([Search](#search)).
- Chat features around Threads: typing indicators, read receipts,
  presence, reactions, edits, attachments, email notifications,
  cross-vault threads and direct messages ([Threads](#threads), item 6).
