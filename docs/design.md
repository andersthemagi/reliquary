# Reliquary v2: design

2026-09-24 · Status: DRAFT, nothing built yet

This file is the canonical design. Paths like `routines/local/`, `pulse` and
`AGENTS.md` refer to the first consumer, Andrés's AIS-OS repo
(`andersthemagi/repositio-arcanum`), which keeps a short page on its side of
the contract at `strategy/reliquary-v2.md`.

## Contents

1. [Why](#why)
2. [Principles](#principles)
3. [Who owns what](#who-owns-what)
4. [Architecture](#architecture)
5. [Data model](#data-model)
6. [Update feed and sync](#update-feed-and-sync)
7. [Secrets](#secrets)
8. [Routines](#routines)
9. [Access control](#access-control)
10. [MCP tools](#mcp-tools)
11. [Using it without an OS](#using-it-without-an-os)
12. [Build order](#build-order)
13. [Open questions](#open-questions)
14. [Out of scope](#out-of-scope)

## Why

Three problems, one system.

- **Routines depend on one laptop.** All thirteen routines are Claude desktop
  scheduled tasks on the MacBook. Lid closed means nothing runs, and the only
  detector that survives that (`health-check.sh` under launchd) lives on the
  same machine.
- **Context can't be shared in slices.** This repo is the context layer and
  git syncs it between devices well. But git access is all or nothing, so
  sharing one client's or one group's context means a separate repo and a
  hand-kept private/neutral split, which is what AI Founding Table does today
  (`shared/aft-collab/` vs `strategy/aift-collab-ops.md`).
- **Secrets move by chat and email.** No shared place, no audit trail, no
  revoke.

CommonThread (repo `commonthread-project-brain`, prototyped 2026-09-23 via
Stripe Projects) proved the core loop: plain-language context, agents
propose, humans approve, append-only log, served over MCP. v2 is a rebuild
around all three problems, not an extension of that prototype.

## Principles

1. **AIS-OS first.** This repo stays the source of truth for everything that
   is Andrés's own. Reliquary holds only what must live off-device: shared
   spaces, secrets, routine state. When in doubt, it stays in the repo.
2. **Standalone for people without an OS.** A client or volunteer gets a web
   dashboard and one MCP URL. For them that is the whole product.
3. **Pull, not push.** Every consumer asks "what changed since cursor N".
   Offline devices catch up on their next pull. Webhooks may come later as a
   hint to pull sooner, never as the delivery mechanism.
4. **One fact, one owner.** Same rule as `AGENTS.md`. No record is editable in
   two places; each kind of data has exactly one writer of record.
5. **Nothing becomes true without a human.** Agents and routines propose.
   People approve. Carried over from CommonThread unchanged.
6. **Secrets never enter model context.** Not through MCP, not through
   logs, not through the change feed.
7. **Verify the artifact, not the intention.** A run is only "ok" when it
   reports what it produced. Silence is a failure state, not a quiet day.
8. **Private stays private by default.** Nothing leaves this repo for a
   shared space unless its file is explicitly mapped to one. Money, vendor
   contacts and notes on named people stay out, the rule AFT already follows.

## Who owns what

| Data | Owner (writer of record) | Others |
|---|---|---|
| Tasks, journal, decisions, pipeline, finances, voice, skills | This repo | Never synced out |
| A shared space's approved context | Reliquary | Mirrored read-only into the repo |
| This repo's contributions to a shared space | This repo | Sent to Reliquary as proposals |
| Secrets | Reliquary | Pulled into `.env` by the CLI, never committed |
| Routine prompts | This repo (`routines/local/*.md`) | Workers read them from their clone |
| Schedules, job queue, run log | Reliquary | Mirrored into `routines/index.md` weekly |
| Routine outputs (commits) | This repo | Run log stores the commit SHA only |

## Architecture

```
            ┌──────────────── Reliquary (Supabase + Next.js) ────────────────┐
            │ spaces · entries · proposals · change feed · secrets (Vault)   │
            │ routines · job queue (pgmq) · run log · watchdog (pg_cron)     │
            │ dashboard · MCP endpoint · REST API · Discord alerts (pg_net)  │
            └───────▲──────────────▲────────────────▲───────────────▲────────┘
                    │ pull feed,   │ claim job,     │ MCP           │ web
                    │ propose      │ report run     │               │
         ┌──────────┴───┐   ┌──────┴────────┐  ┌────┴─────────┐  ┌──┴──────────┐
         │ AIS-OS clones│   │ Workers (VPS) │  │ Collaborators'│  │ Clients and │
         │ Mac, Linux,  │   │ claude -p on  │  │ agents: Cursor│  │ volunteers  │
         │ VPS          │   │ subscription  │  │ Lovable, etc. │  │ (no OS)     │
         └──────────────┘   └───────────────┘  └──────────────┘  └─────────────┘
```

- **Reliquary server:** Supabase for data, auth, Vault, `pg_cron`, `pgmq` and
  `pg_net`. Next.js for dashboard, MCP and REST, same stack as CommonThread.
  One Supabase project for Andrés's own operations; client instances come
  later and are a separate question (see open questions).
- **Workers:** a small runner on a Hetzner VPS that claims jobs, runs
  `claude -p` on the subscription, reports back. Stateless apart from its
  repo clones. Add workers to scale; replace a broken one, don't repair it.
- **Collectors (milestone 5):** plain scripts with their own API tokens that
  pull Gmail, Calendar, Granola and Contra. They replace claude.ai connectors
  in unattended runs, the part of the stack nobody has made reliable
  headless (claude-code issues #79685, #96106).
- **CLI (`reliquary`):** `feed pull`, `propose`, `env pull`. Used by the
  AIS-OS sync routine and by people who want secrets in their `.env`.

## Data model

Carried from CommonThread: `projects` (renamed `spaces`), `project_members`,
`context_entries`, `context_proposals`, `change_events`, `agent_tokens`, the
RLS helpers, the append-only trigger, the proposal-review trigger.

New or changed:

- `change_events.seq bigint generated always as identity`: the feed cursor.
  Monotonic, gap-tolerant, never reused. `origin` column names the writer
  (`dashboard`, `mcp:<token>`, `sync:<device>`, `routine:<name>`) so sync
  can skip its own echoes.
- `context_entries.source_path`: the repo file an entry mirrors, if any.
- `secrets(id, space_id, name, vault_secret_id, created_by, rotated_at)`:
  metadata only; the value lives in Supabase Vault.
- `secret_grants(secret_id, member_id, granted_by, revoked_at)`.
- `secret_access_log(secret_id, member_id, action, at, client)`: append-only.
- `routines(id, name, prompt_path, schedule_cron, timezone, needs[],
  timeout_s, enabled, owner)`. `needs[]` lists required connectors or
  collectors, checked before a run starts.
- `routine_runs(id, routine_id, scheduled_for, claimed_by, started_at,
  finished_at, status, exit_code, artifact jsonb, error)`. `status` is one
  of `queued`, `running`, `ok`, `failed`, `skipped`, `missed`, `timed_out`.
  `artifact` holds what the run produced (commit SHA, files touched, Discord
  2xx), because a green exit code proves nothing.
- `workers(id, host, last_heartbeat, version)`.

## Update feed and sync

**Protocol.** One call: `changes_since(space, cursor)` returns events with
`seq > cursor`, oldest first, capped at 500, plus the new cursor. Same shape
over MCP, REST and the CLI. Consumers store the cursor themselves. Deleted
or retracted entries appear as events, never as gaps.

**AIS-OS side.** A `reliquary-sync` step, run by `pulse` every 2h and on
demand:

1. `git pull`, then for each mapped space, `reliquary feed pull` from the
   stored cursor (kept in `.git/reliquary-cursors`, per clone, never
   committed).
2. Write approved entries into the mapped folder as read-only mirrors with a
   header naming the entry id. Commit as the sync step.
3. For repo files mapped to a space that changed since the last push, send
   the diff as a proposal, never as a direct write. It shows up in the
   space's approval queue like any agent's proposal.
4. Skip events whose `origin` is this device.

**Mapping.** A committed file, `reliquary.map.yml`, lists which repo paths
map to which space, in which direction. Anything unlisted never leaves the
repo. That file is the whole privacy boundary on the AIS-OS side, so the
pre-commit hook lints it: a mapped path under `finances/`, `context/`,
`decisions/` or `pipeline/` fails the commit.

**Conflicts.** Reliquary owns approved shared context, so on conflict the
approved entry wins and the repo mirror is overwritten. The repo's version
is not lost: it goes up as a proposal and waits for review.

## Secrets

**Rules.**

- MCP read tools never return secret values. No tool does. An agent sees
  that a secret named `STRIPE_SECRET_KEY` exists in a space, nothing more.
- Values reach a machine only through `reliquary env pull`, which writes
  `.env` and never prints to stdout. The CLI refuses to write inside a path
  git tracks unless `.env` is gitignored.
- Every read, grant, revoke and rotation lands in `secret_access_log`.
- Grants are per secret, per person. Revoking a member revokes their grants.
- Change events for secrets carry the name and action, never the value.

**Storage.** Supabase Vault, decrypted only inside a `security definer`
function that checks the grant and writes the access log in the same
transaction.

**Trust model, said plainly to clients:** the operator (Andrés) could read
any secret stored this way. That is fine where clients already trust Red
Mage with their accounts, which is every current engagement. If a client
needs secrets the operator cannot read, that is client-side encryption
(`age` keys per member), a separate milestone, not a patch to this one.

**Until milestone 3 ships:** share secrets with a 1Password or Bitwarden
shared vault. Not through Reliquary context, not through chat.

## Routines

**Scheduling.** `pg_cron` runs one tick a minute: for each enabled routine
due now, enqueue a job in `pgmq` and insert a `routine_runs` row as
`queued`. Schedules are cron expressions in `Europe/Madrid`.

**Claiming.** Workers poll every 30s, read one message with a visibility
timeout equal to the routine's `timeout_s`, mark the run `running`, and
heartbeat every minute. A worker that dies leaves the message to reappear;
a second worker picks it up. At most one run per routine at a time, enforced
by a partial unique index on `routine_runs (routine_id) where status =
'running'`.

**Running.** The worker:

1. `git pull` in its clone. Takes the repo write-lock
   (`scripts/acquire-lock.sh`) exactly as a desktop routine does today.
2. Preflight: checks every item in `needs[]` is reachable. Any missing
   means the run is `skipped` with the reason, and Discord hears about it.
   This is the fix for connectors silently loading with zero tools.
3. `claude -p "$(cat routines/local/<name>.md)" --permission-mode auto
   --permission-prompts none --output-format json`, under `timeout`.
   Never `--bare`: that skips the hooks and skills the routine relies on.
4. Reports `artifact` and `status`, releases the lock.

**Watchdog.** A second `pg_cron` job every 5 minutes, inside the database,
independent of any worker:

- a `queued` run older than 15 minutes becomes `missed`;
- a `running` run past its timeout becomes `timed_out`;
- no worker heartbeat for 10 minutes;
- any `failed`, `missed`, `timed_out` or `skipped` since the last check.

Each posts to Discord via `pg_net`. A free healthchecks.io check pinged by
the watchdog covers the last gap: Supabase itself going quiet.

**Auth on workers.** A full `/login` (not `setup-token`, which cannot load
claude.ai connectors). The worker reports the login's expiry in its
heartbeat and the watchdog warns 7 days out.

**Migration.** One routine at a time. Each move disables the desktop
scheduled task the same day, because both surfaces firing is a double
run. `autopush` does not move: workers commit and push their own work.
`token-usage-weekly` stays on the Mac: it writes to `~/token-dashboard`.

## Access control

Roles per space: `owner`, `collaborator`, `viewer`, `agent`.

| Action | owner | collaborator | viewer | agent |
|---|---|---|---|---|
| Read approved context | yes | yes | yes | if token has `read` |
| Propose | yes | yes | no | if token has `propose` |
| Approve or reject | yes | yes | no | never |
| Add context directly | yes | yes | no | if token has `write` |
| Manage members and tokens | yes | no | no | never |
| Read a secret | if granted | if granted | never | never |

Agent tokens stay hashed, scoped and individually revocable, as in
CommonThread. Every guarantee in this table is enforced by RLS or a
trigger, not by the API layer, and each one has a hostile test (a token for
space A reading space B, an agent approving its own proposal, anyone
editing a `change_events` row, an agent calling the secret function) that
runs on every push.

## MCP tools

| Tool | Scope | Notes |
|---|---|---|
| `read_context` | read | Approved entries, filterable by tag and path |
| `search_context` | read | Full text first; embeddings only if FTS proves too weak |
| `changes_since` | read | The feed |
| `propose_change` | propose | New entry, edit or retraction, with a reason |
| `list_proposals` | read | Pending and recent |
| `list_secrets` | read | Names and metadata only |
| `routine_status` | read | Last run per routine, owner only |

Tool results wrap entry text as quoted data with the author and approval
date, so an entry that reads like an instruction is presented as content,
not as a command. Proposals that address an AI system get flagged in the
review queue, the same check `check-ingest-safety.py` does for this repo.

## Using it without an OS

1. Owner invites by email and picks a role.
2. The invite lands on the dashboard: the space's context, the approval
   queue, and a "Connect your AI tool" panel with a copy-paste MCP URL and a
   token scoped `read,propose`.
3. Plain-language intake: one box, "tell us something about this project",
   which becomes a proposal like any other.
4. Export: approved context as an `AGENTS.md` for tools without MCP.

No CLI, no git, no repo. That path has to work for a volunteer on a phone.

## Build order

Each milestone ends in something checkable. The next one does not start
until the previous one's check has held for a week of real use.

| # | Milestone | Done when |
|---|---|---|
| 1 | Routines: schema, queue, watchdog, one worker on the VPS | 3 routines (`nightly`, `luma-signup-conflict-check`, `watchdog`) run only on the VPS for 7 days with zero missed runs and every failure reaching Discord |
| 2 | All routines moved | Every routine but `token-usage-weekly` runs on the VPS; no desktop scheduled task left enabled for them |
| 3 | Spaces, feed, sync | AI Founding Table is a space; a change approved in the dashboard shows up in this repo within one `pulse`, and a repo edit shows up as a proposal |
| 4 | Secrets | Two people pull the same secret into `.env`; revoking one blocks their next pull; the access log shows all three events |
| 5 | Collectors | Granola via its own token for `post-call-watcher`; the routine's `needs[]` no longer lists a claude.ai connector |
| 6 | No-OS onboarding, first client pilot | A client adds and approves context without being walked through it |

## Open questions

- **Client instances:** one multi-tenant Reliquary with spaces per client,
  or one instance per client provisioned through Stripe Projects? The
  former is simpler to run; the latter is the productizable Launch Kit and
  gives the client their own billing. Decide at milestone 6, not before.
- **Supabase plan:** free projects pause after inactivity. Worker polling
  should keep it awake, but routines are the one thing that cannot pause.
  Pro plan ($25/mo) from milestone 1 is probably right.
- **Does `pulse` own sync, or a new `reliquary-sync` routine?** `pulse` owns
  `tasks/` today, and sync writes mirrored folders, not tasks, so a
  separate routine may keep ownership clean.
- **Name:** "Reliquary" is a common word; check npm, domains and software
  trademarks before it appears in client material. "Red Mage Reliquary" is
  safe internally either way.

## Out of scope

- Replacing this repo, or syncing all of it anywhere.
- Real-time collaboration or live cursors.
- Running models other than Claude on workers. Possible later, since
  routines are plain prompts, but not designed for now.
- End-to-end encrypted secrets (see [Secrets](#secrets)).
- Anything that makes Reliquary depend on the MacBook.
