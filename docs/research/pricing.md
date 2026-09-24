# Pricing and unit economics

2026-09-24 · Status: RESEARCH, working notes

## Direction (Andrés)

- Free for 1–10 people.
- Charge larger teams, and charge for a better experience.
- $15/seat (Basic Memory) is too much for the market Reliquary is for.
- There is a minimum bar Andrés needs for his own use. The free tier should
  clear it without being so generous that it isn't worth offering paid.

## Why a big free tier is affordable

Bring-your-own-model means Reliquary never pays for inference, which is the
cost that sinks most AI products' free tiers. What's left is Postgres
storage, compute and egress.

- Context is small. Text entries run roughly 1 KB each, so a 10-person org
  with 10,000 entries is about 10 MB.
- The gate spike answers in about 1–5 ms per query at 200k entries
  ([spikes/gate](../../spikes/gate/README.md)), so one database can serve
  many small orgs.
- One multi-tenant Supabase Pro project (from $25/mo; check current limits)
  should carry hundreds of free orgs. At that point the cost per free org
  is cents a month. Connection limits and support time bind before
  storage.
- Embeddings, if added, are an inference cost. They go on the org's key
  like everything else, or on a paid plan.

The real cost of free users is **support and abuse**, not infrastructure.

## Ads: recommend against

- **They contradict the pitch.** The dashboard shows confidential context.
  Third-party ad scripts on those pages are the kind of exfiltration path
  the gate exists to prevent, and a security reviewer would flag them on
  sight.
- **Consent overhead.** EU users would need a consent banner and ad-network
  data processing agreements. That is real work for a solo founder.
- **The revenue is negligible.** A dashboard used by 10 people a few times
  a week earns cents per month at typical CPMs.

The ad-shaped thing that does work is **attribution**: a small "via
Reliquary" line on bot replies and exported `AGENTS.md` files on the free
tier, removable on paid. It costs nothing, leaks nothing, and every group
chat reply shows it to people who might want one. Tailscale grew the same
way, through people bringing it to work.

## Sketch

| | Free | Team | Business |
|---|---|---|---|
| Humans | 1–10 | 11+ | any |
| Agents / bots | unlimited | unlimited | unlimited |
| The gate, hostile-tested RLS, approvals, append-only log | yes | yes | yes |
| Model | bring your own | bring your own | bring your own |
| Spaces | a few (e.g. 5) | unlimited | unlimited |
| Log history visible | 90 days (kept, not deleted) | 1 year | unlimited + export/streaming |
| Channel bots | self-hosted adapter | hosted Telegram/Discord/Slack adapters | + WhatsApp via official business account |
| "via Reliquary" attribution | on | off | off |
| SSO / SCIM | – | – | yes |
| Support | community | email | priority |
| Price (to test) | $0 | ~$4/human/mo, or flat ~$29/mo up to 25 | quote |

Principles behind it:

- **Never paywall security.** The gate, approvals and the log are the
  product and the proof. Paywalling them would make the free tier the
  insecure one.
- **Charge per human, agents free.** Agents are the usage you want to grow
  (Doppler's model).
- **Flat team pricing may beat per-seat** for communities and volunteer
  orgs, whose headcount changes weekly.
- **Self-hosting stays free forever** (open core, Plausible-style). It
  builds trust with the audience that cares about a deterministic gate.
- **"Higher quality" means hosted convenience,** not better security:
  managed channel adapters, backups, longer history, hosted search.

## Open questions

- **Andrés's minimum bar.** What must work for his own use (spaces, sync,
  a Telegram or Discord bot?), so the free tier covers it and nothing more
  is promised.
- **The 10-human line.** Is it firm, or can a conference community of 60
  lurkers and 8 organisers be free? One option: count only humans who
  approve or propose; readers are free.
- **Test prices** in the five discovery conversations, not before.
