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
inside the database from a minted session (below). The asker must be a
participant. Any unlinked participant, or a participant list older than 10
minutes, drops the chat to public-only. Missing or bad claims return
nothing.

The model only ever receives rows that pass the rule.

## Minting: who vouches for "Ana asked this in chat X"

If the bot says who is asking, a compromised or buggy bot can claim to be
anyone. In a DM that means getting that person's full access. So the bot
never says it. The platform does:

```
Telegram/Slack/Discord ──signed webhook──▶ adapter (verifies signature)
                                             │ app.issue_ticket(chat, bot, sender, msg)
                                             ▼
                                    ticket: single use, 2 min, bound to
                                    (bot, chat, sender)
                                             │ forwarded with the message
                                             ▼
bot ──token + ticket──▶ mint endpoint ── app.mint_session ──▶ session (5 min)
                                             │
bot ◀──── JWT { role: reliquary_agent, sid } ┘
bot ──JWT──▶ PostgREST/MCP ──▶ RLS resolves sid → bot, chat, asker → audience
```

- **Three roles, each limited to its own functions.** The adapter
  (`reliquary_adapter`) issues tickets and syncs membership. The mint
  endpoint (`reliquary_minter`) turns token + ticket into a session. The bot
  (`reliquary_agent`) reads entries through the gate. None can do another's
  job, and neither the adapter nor the minter can read entries.
- **The JWT carries only `sid`.** Access is not snapshotted into the token.
  Every query re-checks the session, the token (revoked or expired), the
  bot's install in the chat, the asker's membership and the audience. Any
  of these changing takes effect on the next query.
- **Refusals look the same.** Every failed mint returns zero rows. The
  cause (unknown token, replay, ticket for another bot, and so on) goes to
  `mint_log`, which is append-only and never stores a token.
- **Tokens are stored as SHA-256 only.** They are random and high-entropy,
  so a fast hash is enough; they aren't passwords.

## Results (2026-09-24)

**Hostile tests: 63/63 pass.**

- *Gate:* DMs, groups, a lower-clearance member narrowing a group, remarks
  scoped to where they were said, unlinked senders, stale membership, forged
  or random session IDs, the old claim shape, token scope, forbidden and
  missing IDs looking identical, privilege escapes, immediate revocation.
- *Minting:* replay, wrong or null token, a ticket presented by another bot,
  expired or unknown tickets, a sender outside the chat, revoked and expired
  tokens (at mint and on live sessions), removing the bot from a chat,
  session expiry, membership sync narrowing a live session, the mint log
  recording every refusal cause and never a token, the mint log rejecting
  update and delete (even by its owner), and each role unable to do
  another's job.

**Mutation check.** Each break was caught:

| Break | Result |
|---|---|
| Ignore entry audience | 12 tests fail |
| Ignore group-to-space binding | 1 fails |
| Accept tickets from another bot | 2 fail |
| Sessions ignore token revocation | 1 fails |
| Sessions ignore bot removal | 1 fails |
| Skip the replay check | The unique constraint on `sessions.ticket_id` stops it (second layer); the suite aborts |

**Latency.** 200k entries, 500 spaces, 5k members, 400 groups of 5–40
people. Plain Postgres 17 in a container on a laptop, warm cache, no
PostgREST or network in the path.

| Query | p50 ms | p95 ms |
|---|---|---|
| Full-text search, top 20, DM | 4.9 | 5.5 |
| Full-text search, top 20, group | 2.2 | 2.3 |
| Count all visible, DM | 4.6 | 5.8 |
| Count all visible, group | 2.0 | 2.2 |

Resolving the session on each query costs about 0.7 ms more than trusting
the claims.

The target was 200 ms p95. The helpers run once per query (two InitPlans in
the plan), and access narrows through the `space_id` index first.

## What this does not prove

- **JWT signing and the HTTP layer.** Claims are set with `set_config` here.
  In production the mint endpoint signs `{role, sid, exp}` and PostgREST
  verifies it; agents never get a SQL connection. The endpoint also needs
  rate limiting on failed mints, which `mint_log` can drive.
- **The adapter itself.** Tickets are only as true as the adapter's
  webhook signature check (Telegram secret-token header, Slack signing
  secret, Discord Ed25519) and its membership sync. That code is now where a
  real leak would come from, and it needs its own hostile tests: unsigned
  webhooks, replayed webhooks, and missed leave events.
- **Bots that own their own channel connection.** A third-party bot that
  talks to WhatsApp or Slack directly (as Nando did) can't get verified
  tickets, because Reliquary never sees the webhook. That needs an
  "asserted identity" mode: the bot vouches for the sender, the space must
  opt in to trusting that bot, and the audit log marks those sessions. It
  is weaker by design, and should be visibly so.
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
