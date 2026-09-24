# Gate spike

Throwaway. Tests one claim from
[docs/research/org-chatbot-gate.md](../../docs/research/org-chatbot-gate.md):
that audience-aware read access can be enforced by Postgres RLS so that it
is correct, fast and explainable. None of this is a migration; the real
schema starts fresh in `supabase/migrations/`.

```bash
./run.sh          # hostile tests
./run.sh bench    # tests, then the latency benchmark
```

Needs podman or docker. Runs `postgres:17` with no network and removes the
container afterwards.

## The rule

An entry is readable only if:

1. the agent token has read on its space; and
2. **everyone who will read the reply** belongs to that space (or the space
   is public); and
3. if the entry has an `audience` (the people it was said to), everyone who
   will read the reply is in it; and
4. in a group chat, the space is the chat's bound space or a public one.

"Everyone who will read the reply" is the chat's participant list, resolved
inside the database from the claims `{token, chat, asker}`. The asker must
be a participant. Any unlinked participant, or a participant list older than
10 minutes, drops the chat to public-only. Missing or bad claims return
nothing.

The model only ever receives rows that pass the rule.

## Results (2026-09-24)

**Hostile tests: 29/29 pass.** They cover DMs, groups, a lower-clearance
member narrowing a group, remarks scoped to where they were said, unlinked
senders, stale membership, forged claims, token scope, forbidden and missing
IDs looking identical, privilege escapes, and immediate revocation.

**Mutation check.** Removing the audience clause fails 12 tests. Removing
the group-to-space binding fails 1. The tests can fail.

**Latency.** 200k entries, 500 spaces, 5k members, 400 groups of 5–40
people. Plain Postgres 17 in a container on a laptop, warm cache, no
PostgREST or network in the path.

| Query | p50 ms | p95 ms |
|---|---|---|
| Full-text search, top 20, DM | 4.3 | 4.6 |
| Full-text search, top 20, group | 1.4 | 1.6 |
| Count all visible, DM | 4.1 | 4.5 |
| Count all visible, group | 1.3 | 1.5 |

The target was 200 ms p95. The helpers run once per query (two InitPlans in
the plan), and access narrows through the `space_id` index first.

## What this does not prove

- **Signed claims.** Here they are set with `set_config`. In production
  PostgREST verifies a JWT and sets them, and agents never get a SQL
  connection. The minting endpoint (agent token hash + channel webhook
  identity → short-lived JWT) is its own hostile-test target.
- **Membership freshness.** The 10-minute rule assumes the channel adapter
  writes `chat_participants` and `members_synced_at` from membership events.
  That adapter is where a real leak would come from.
- **Writes.** Proposals, approvals and chat-memory capture aren't here.
  Captured facts must get `audience` = the chat's participants at capture
  time, set by the database, not the bot.
- **Scale shape.** Access narrows by space first, then filters. A single
  space with millions of entries needs a combined index (for example
  `space_id` + `tsv`) or partitioning. Embeddings would need pgvector
  iterative scans.
- **Explainability to admins.** The rule is four lines, but "why can't the
  bot tell our group X?" needs a debug view: which participant or which rule
  narrowed it. Worth building early; it doubles as the support tool.
