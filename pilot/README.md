# Pilot: Telegram bot on the audience gate

The quickest usable Reliquary: a Telegram bot that answers from shared
context, remembers things said in a group, and only ever uses what
**everyone who will read the reply** may see. Postgres and the bot run in
two containers. It uses long polling, so it needs no domain, TLS or open
port.

Not the product. It is the gate spike (`spikes/gate/`) plus what a live bot
needs, to learn from real use. The real schema starts fresh in
`supabase/migrations/`.

## Setup (about 10 minutes)

Needs podman or docker, and an Anthropic API key (not a Claude
subscription login; see `docs/research/landscape-swot.md`).

1. **Create the bot.** In Telegram, message @BotFather: `/newbot`, pick a
   name and username, and copy the token. Leave privacy mode on (the
   default). The bot then only sees commands, mentions and replies to it,
   never the rest of the conversation.
2. **Initialise.** `./run.sh init` creates the database, roles, image and
   the bot's Reliquary token. It writes `pilot/.env` and
   `pilot/.env.admin`, which are gitignored and mode 600.
3. **Add your keys.** Put `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY` in
   `pilot/.env`, then run `./run.sh start`.
4. **Set up a space and yourself:**
   ```bash
   ./run.sh admin add-space team
   ./run.sh admin add-space public --public
   ./run.sh admin grant team --capture
   ./run.sh admin grant public
   ./run.sh admin add-member "Andrés"
   ./run.sh admin join team "Andrés" --role owner
   ./run.sh admin link-code "Andrés"      # then DM the bot: /link <code>
   ./run.sh admin add-entry team "Standup" "Standup is at 10:00 in room B"
   ```
5. **Add the bot to a group and make it an admin.** It needs no admin
   rights; admin status is what lets it verify who is in the group. Mention
   it once, then bind the group to a space:
   ```bash
   ./run.sh admin chats                   # find the group's title or id
   ./run.sh admin bind "My group" team
   ```
6. In the group, send `/status`. It says what the bot can use and why.

For each person: `add-member`, `join`, `link-code`, and they DM `/link <code>`.

## Using it

| In a group | In a DM |
|---|---|
| Mention it, reply to it, or `/ask ...` | Just talk |
| `/remember <text>`: a note for the people in the group, 30 days | Uses everything you may see |
| `/status`: what it can see here, and why | `/link <code>` |

## The rules it runs by

- **Groups get the intersection.** A group sees its bound space only if
  every member is known, linked and in that space. Telegram can't list a
  group's members, only count them, so any member the bot can't account
  for (someone who hasn't linked, or a lurker it can't verify) drops the
  group to public spaces. `/status` explains which.
- **Notes remember who heard them.** `/remember` records the people present.
  It comes back only where the audience is a subset of them: in that group,
  or in the DM of someone who was there. It is refused if the bot can't
  account for everyone present.
- **History resets when the audience changes.** Someone joins or leaves,
  and the bot's conversation memory for that chat starts over.
- **Identity only comes from Telegram.** The adapter pulls updates from
  Telegram, issues a single-use ticket per message, and the bot trades it
  for a 5-minute session (see `spikes/gate/README.md`). Nothing typed in a
  message changes what the bot can see.
- **Logs** carry chat IDs and counts, never message text, entries or
  tokens (checked by the smoke test).

## Checks

```bash
./run.sh test     # 63 spike + 38 pilot hostile tests, throwaway container
./run.sh smoke    # 18 end-to-end checks: real bot code, fake Telegram and model
```

## Commands

`./run.sh init | start | stop | logs | status | admin ... | smoke | test`

Data lives in the `reliquary-pgdata` volume and survives `stop`. There are
no backups yet.

## Known limits

- **One process.** Adapter, minter and bot share it, each with its own
  database role. That catches bugs, but it is not a trust boundary until
  the adapter runs separately.
- **Membership freshness.** Checked every 5 minutes, immediately on
  join/leave messages, and whenever someone uses `/remember`. A member who
  leaves without Telegram telling the bot is caught on the next check.
- **New joiners can scroll up** and read earlier answers if the group shows
  history to new members. Turn that off in the group settings for private
  groups.
- **Search is full-text only** (no embeddings), plus the 8 newest entries.
- **Only `/remember` writes.** Canon is added with `admin add-entry`; there
  is no proposal queue or dashboard yet.
- **No web search.** Outbound tools can leak context into their queries
  (see `docs/research/org-chatbot-gate.md`), so they wait for a
  per-space switch.
