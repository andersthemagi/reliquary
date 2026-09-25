# Storage, unit costs and add-ons

2026-09-25 · Status: RESEARCH · Companions:
[positioning.md](positioning.md) (section 5, Pricing),
[hosting.md](hosting.md) (section 9, Costs),
`supabase/migrations/20260925230000_plans.sql` (what storage counts),
[docs/public/concepts/plans-and-limits.md](../public/concepts/plans-and-limits.md)

The owner's goal: know how much space vaults really need, and offer add-ons
"at a decent margin to at cost, without taking advantage of people's
generosity". This note sizes vaults (with a measurement on our own schema),
prices what they cost us, proposes a price sheet and a fairness policy, and
covers self-host licensing.

Prices were checked on 2026-09-25 on the vendor's page unless marked.
*(unverified)* marks figures from search snippets, third parties or my own
estimates. Not legal or tax advice.

## 0. Answers in one table

| Question | Answer |
|---|---|
| How big is a vault? | Text is small; **history is what grows**. Measured on our schema: small ~6 MB after a year, typical ~60 MB, heavy (many agents, big documents) ~0.9 GB counted. |
| Disk per counted byte | **Measured 1.3x to 1.7x**, up to ~2x when every write goes through a proposal. The 3x in positioning.md is too conservative; use **1.6x** for planning. |
| Are 100 MB / 1 GB / 5 GB right? | Yes. Free lasts years for small and typical vaults and about 5 weeks for a heavy one, which is the right upgrade trigger. Alpha 1 GB lasts a heavy vault about a year. Pro 5 GB lasts it five years or more. |
| What a vault costs us | Disk: about **$0.25 per counted GB-month**, all in. Typical vault: about 2 cents a month. Full Pro vault: about $1.25 a month plus its share of a compute step. |
| What an active person costs us | About **1 cent a month** in Vercel, email and egress. People are not a cost driver; connections and support are. |
| Fixed monthly | **~$50** at launch (Supabase Pro, Vercel Pro, domain, free email), $60 to $80 with staging and paid email, ~$180 with PITR. |
| Payment fees on $9 | $0.50 (Stripe direct, but VAT filing is ours) to $1.13 (Polar or Lemon Squeezy as merchant of record). Paddle asks for custom pricing below $10. |
| Add-on principle | Storage at about 1.5x to 2x all-in cost; everything on one subscription so the fixed fee is paid once; hard caps with warnings, never surprise bills; downgrades never delete. |
| Self-host | Server under **FSL-1.1-Apache-2.0** when opened: free for any internal use, paid only for hosting it for others (a partner license) and for support. |

## 1. How big vaults get

### What we store, and what counts

From the migrations:

- `file_versions`: the **full text of every version** (no deltas), insert-only
  except erasure, 1 MiB per version at most. This is what counts.
- `body_tsv`: search words, kept **for current versions only**
  (`20260925150000_efficiency_3.sql`); history has none.
- `proposals.body`: the proposed text, kept after it is applied. **Not
  counted.**
- `log`, `env_access_log`, `proposal_notes`, `routine_runs` (later):
  append-only, **not counted**.
- `private.variable_secrets`, `private.env_import_secrets`: ciphertext,
  counted. Tiny.

### Comparable data

| Source | Size | Notes |
|---|---|---|
| Obsidian forum, "How many notes do you have?" | 265 to 47,000 notes; one 5,500-note vault is 225 MB with attachments; 18,413 notes hold 3.2 million words (~20 MB of text) | [forum](https://forum.obsidian.md/t/how-many-notes-do-you-have/36987). Text alone is roughly 1 KB per 150 words; attachments dominate every large vault. |
| Obsidian vault with attachments | 6.87 GB for 2,809 notes and 4,016 attachments | same thread; binaries, which we don't store |
| Obsidian Sync | Standard 1 GB, 1 month history; Plus 10 GB (to 100 GB), 12 months history | [plans](https://obsidian.md/help/sync/plans). 1 GB is their entry tier *with* attachments. |
| Notion export | exports above ~500 MB tend to time out | [raccoon.page](https://raccoon.page/blog/notion-export-limitations/) *(unverified)*; again mostly files |
| Basic Memory Cloud | "Unlimited notes and version history (fair use)", $15 a seat | [pricing](https://basicmemory.com/pricing); no published cap |
| `.env` files | no survey found; examples run from a few to a few dozen variables | assume 20 to 60 variables across 2 to 4 environments |
| **This repository** (agents writing design docs, 2026-09-24 to 25) | 64 Markdown files, 615 KB now; **253 versions totalling 5.4 MB** in two days; `AGENTS.md` has 30 versions, `design.md` 13 | measured with `git log --raw`; a heavy, agent-driven vault writes about **2.7 MB a day** with full-copy history |
| This project's Claude memory | 8.5 KB, 6 files | an agent's own memory is tiny |

The pattern: current text is small at every scale. What grows is **history
of documents that agents rewrite often**, because each version is a full
copy. A 20 KB document rewritten 20 times a day adds 400 KB a day.

### Measured: disk per counted byte

I applied every migration to a throwaway Postgres 17 (default `pglz` TOAST
compression, as Supabase) and replayed this repository's 253 Markdown
versions into 20 vaults through the real tables and triggers: each version as
a file write, an applied proposal carrying the same text, and three log
events (open, approve, write). Then a second vault of 5,000 small notes
(0.7 to 1.3 KB) with three versions each.

| Measure | Result |
|---|---|
| Counted (`private.vault_storage`) | 108.2 MB |
| `file_versions` on disk, after vacuum | 71.3 MB (**0.66x**): text over 2 KB compresses to ~47% (>8 KB) or ~62% (2 to 8 KB) |
| Same, before vacuum full | 144.6 MB (**1.34x**): dead space from search words set then cleared on each new version; autovacuum reuses it, so budget it |
| Small notes (<2 KB, not compressed) | rows ~**1.45x** counted before indexes; search words of current versions ~1.4x their text |
| `proposals` (not counted) | 55 to 58 MB, **~0.55x** counted, when every write goes through a proposal |
| `log` | **~356 bytes per event** with indexes (~300 after vacuum) |
| Whole database for this corpus | 149 MB, of which ~7.5 MB is an empty database |

So, on-disk bytes per counted byte:

| Vault shape | Multiplier |
|---|---|
| Large documents, direct writes | ~1.0 to 1.35 |
| Many small notes | ~1.6 to 1.7 (row and index overhead, no compression) |
| Canon-heavy, every write a proposal, plus log | ~1.9 to 2.0 |
| **Planning figure** | **1.6** |

Two cheap wins show up: an applied proposal stores its text a second time
(the version holds the same text unless it was edited on approval), and
counting compressed size would be fairer to people with large documents.
Both are open questions below, not recommendations to change now.

### The model

Counted bytes after *t* months:

```
counted(t) = F * S                      # current text: files x average size
           + W * D * V * t              # history: writes/day x days/month x bytes/version
           + E * N * (v + 16)           # variables: environments x names x value bytes
disk(t)    = m * counted(t)             # m: 1.6 planning, 2.0 canon-heavy
           + L * D * t * 356            # log events/day, not counted
           + A * D * t * 500            # env reads/day (reliquary run, CI), not counted, estimate
```

| Parameter | Small (1 to 2 people, 1 agent) | Typical (5 people, 3 to 5 agents) | Heavy (10+ people, 10 agents and routines) |
|---|---|---|---|
| F files x S size | 300 x 3 KB = 1 MB | 1,000 x 5 KB = 5 MB | 2,000 x 10 KB = 20 MB |
| W writes a day x V bytes | 5 x 3 KB | 30 x 5 KB | 200 x 12 KB (this repo: ~126 x 21 KB) |
| D days a month | 30 | 30 | 30 |
| L log events a day | 10 | 70 | 600 |
| A env reads a day | 5 | 50 | 500 |
| **Counted, per month** | +0.45 MB | +4.5 MB | +72 MB |
| **Counted, after a year** | **~6.4 MB** | **~60 MB** | **~0.9 GB** |
| Disk after a year (m = 1.6, plus log and env reads) | ~12 MB | ~115 MB | ~1.6 GB |
| Free 100 MB lasts | decades | **~21 months** | **~5 weeks** |
| Alpha 1 GB lasts | decades | ~18 years | **~13 months** |
| Pro 5 GB lasts | decades | decades | **~5.5 years** |

Variables are negligible: 3 environments x 40 names x ~80 bytes is ~10 KB
counted. Their access log is not: a CI pipeline running `reliquary run` 500
times a day writes ~90 MB a year of `env_access_log` that no limit counts
*(row size estimated from the columns: a read naming 20 variables is
400 to 700 bytes)*.

### Verdict on the limits

- **Free 100 MB is right.** Small and typical vaults never feel it; a heavy
  agent vault hits it in weeks, which is exactly the vault that should pay.
  The warning should come early (see the fairness policy).
- **Alpha tester 1 GB is right.** About a year of heavy use; alpha testers
  are the heavy users we want data from.
- **Pro 5 GB is generous**, and that is fine: a full one costs us about $1.25
  a month in disk. It could be 2 GB without anyone noticing, but 5 GB makes
  "you won't run out" true, which is worth more than the dollar.
- Keep the **1 MiB per version** ceiling: it bounds the worst writer (an
  agent in a loop rewriting a 1 MB file) at the storage trigger, not the
  bill.

### When pruning or cold storage would matter

Not for vault limits: counted history is already the product (people pay
for more, or erase). It matters for **our disk and compute**, and only at
fleet scale:

| Trigger | Why | Action |
|---|---|---|
| Fleet database passes **~8 GB** | Supabase Pro includes 8 GB disk per project; beyond it $0.125 per GB-month | none; overage is cheap |
| Database passes **~10 GB** | Micro compute's documented max database size is 10 GB, Small 50 GB, Medium 100 GB ([compute docs](https://supabase.com/docs/guides/platform/compute-and-disk); *table as fetched, confirm on the dashboard*) | move to Small (+$5 a month net of the credit) |
| Database passes **~50 GB** | next compute step is Medium, +$45 a month | only then consider cold storage |
| Any heavy vault's `log` or `env_access_log` passes ~1 GB | uncounted growth | aggregate repeated env reads into one row per token per hour *(design change)* |

Cold storage, when it comes: superseded versions older than a year move from
Postgres to object storage (Supabase Storage is **$0.0213 per GB-month**
past 100 GB included, about a sixth of disk) and stay readable through the
history view and export. That changes the "insert-only" shape of
`file_versions`, so it is a design decision, not a patch. Disk never
shrinks on Supabase (you "can increase disk size but cannot decrease it"),
so erasing frees a customer's quota but not our provisioned disk.

## 2. Our real unit costs

### Supabase

| Item | Price | Source |
|---|---|---|
| Pro plan | $25 a month, includes $10 compute credit (one Micro) | [pricing](https://supabase.com/pricing) |
| Compute | Micro $10 (1 GB RAM, 60 direct connections, 200 pooler clients), Small $15 (2 GB, 90, 400), Medium $60 (4 GB, 120, 600), Large $110 | [compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk) |
| Disk (gp3) | 8 GB included per project, then **$0.125 per GB-month**, billed hourly; io2 $0.195 from the first GB | [disk size](https://supabase.com/docs/guides/platform/manage-your-usage/disk-size) |
| Egress | 250 GB included, then $0.09 per GB | [pricing](https://supabase.com/pricing) |
| File storage | 100 GB included, then $0.0213 per GB | [pricing](https://supabase.com/pricing) |
| Backups | daily, kept 7 days on Pro (14 on Team), included | [pricing](https://supabase.com/pricing) |
| PITR | $100 a month per 7 days of retention | [pricing](https://supabase.com/pricing) |
| Custom domain | $10 a month per project | [pricing](https://supabase.com/pricing) |
| Log drain | $60 a month per drain plus usage | [pricing](https://supabase.com/pricing) |
| Auth MAU | 100,000 included, then $0.00325 | [pricing](https://supabase.com/pricing) |
| Team plan | from $599 a month (SOC 2, 14-day backups) | [pricing](https://supabase.com/pricing) |

Correction to positioning.md: Small is $15 in total, so moving from Micro to
Small costs **$5 more**, not $15, because the $10 credit still applies.

### Vercel

| Item | Price |
|---|---|
| Pro | $20 a month per deploying seat, with $20 of usage credit |
| Function invocations | from $0.60 per million |
| Active CPU | from $0.128 an hour |
| Provisioned memory | from $0.0106 per GB-hour |
| Fast data transfer | 1 TB a month included, then from $0.15 per GB |
| Edge requests | 10M a month included, then from $2 per million |

Source: [vercel.com/pricing](https://vercel.com/pricing).

One MCP tool call or page view is one invocation of roughly 50 to 150 ms of
CPU and 0.3 s of 1 GB memory *(estimate; measure with Vercel Observability
once live)*: $0.0000006 + ~$0.000004 + ~$0.000003, so **about $8 per
million requests**, and the first ~$20 a month is covered by the seat's
credit.

### Email

| Sender | Price | Notes |
|---|---|---|
| Resend | Free: 3,000 a month, 100 a day. Pro: $20 for 50,000, then $0.90 per 1,000 | [pricing](https://resend.com/pricing); US company |
| Scaleway Transactional Email (EU) | 300 a month free, then about **€0.25 per 1,000** | [ahasend roundup](https://ahasend.com/blog/best-european-email-apis-2026) *(unverified)*; French, EU-hosted, pay per use |
| Brevo (EU) | from about $9 a month for 5,000 | same roundup *(unverified)* |

Sign-in links, invites and limit warnings are a few emails per person a
month. Scaleway at pay-per-use is the EU choice that stays near zero; Resend
Free is fine until the 100-a-day cap bites.

### Payments

| Processor | Fee | On a $9 charge | On $90 a year | VAT |
|---|---|---|---|---|
| Stripe direct (EEA card) | 1.5% + €0.25, plus Billing 0.7%, plus Tax Basic 0.5% | ~$0.52 | ~$2.70 | **ours**: register for EU OSS and file quarterly; UK, US states and others by threshold |
| Stripe Managed Payments (merchant of record) | Stripe's rate plus 3.5% | ~$0.84 | ~$5.90 | handled *(unverified total; third-party write-ups say 6.4% plus $0.30 all in)* |
| Paddle | 5% + $0.50 | $0.95 | $5.00 | handled; **"products under $10 ... contact us for custom pricing"** |
| Polar | 5% + $0.50, +1.5% international cards, +0.5% subscriptions | ~$1.13 | ~$6.80 | handled |
| Lemon Squeezy | 5% + $0.50, +1.5% international, +0.5% subscriptions | ~$1.13 | ~$6.80 | handled *(extras unverified)* |

Sources: [Stripe IE](https://stripe.com/ie/pricing), [Paddle](https://www.paddle.com/pricing),
[Polar](https://polar.sh/resources/pricing), [Lemon Squeezy via Swell](https://www.swell.is/content/lemon-squeezy-pricing),
[Stripe Managed Payments via Dodo](https://dodopayments.com/blogs/stripe-managed-payments-fees-explained).

Consequences for pricing:

- The fixed fee is 5 to 6% of a $9 charge. **Put every add-on on the same
  subscription** so it is charged once a month, and **offer annual billing**
  ($90 a year pays the fixed fee once).
- A separate $2 add-on charged on its own would lose 30% to fees. Never sell
  one that way.
- A merchant of record costs about $0.60 more per $9 than Stripe direct, and
  saves VAT registration and filing in every country. For a solo EU seller,
  worth it until revenue justifies an accountant.

### Fixed monthly costs

| Stage | Items | Monthly |
|---|---|---|
| Launch | Supabase Pro $25 (Micro covered), Vercel Pro $20, domain ~$2, email free or Scaleway pay-per-use | **~$47 to $50** |
| Careful | + staging project on Micro $10, + Resend Pro $20 or Brevo | ~$60 to $80 |
| First real scale | + Small compute $5, + disk overage (a few dollars) | ~$65 to $90 |
| With PITR | + $100 for 7 days | ~$165 to $190 |

### Per vault and per person

`cost_vault_month = counted_GB * m * h * 0.125 + compute_share`, with m = 1.6
and h = 1.25 (headroom: disk is provisioned ahead of use and never shrinks).
That is **$0.25 per counted GB-month** before compute.

| Vault | Counted | Disk cost a month | With a compute share (~$0.10 per counted GB) |
|---|---|---|---|
| Small, after a year | 6.4 MB | $0.0016 | $0.002 |
| Typical, after a year | 60 MB | $0.015 | $0.02 |
| Heavy, after a year | 0.9 GB | $0.23 | $0.32 |
| Full Free vault | 100 MB | $0.025 | $0.035 |
| Full Alpha vault | 1 GB | $0.25 | $0.35 |
| Full Pro vault | 5 GB | $1.25 | $1.75 |

The compute share is the Micro to Small step ($5 for 40 GB more headroom,
~$0.13 per disk GB) rounded; Medium's step is load-driven more than
size-driven, so it belongs in fixed costs.

Per active person a month (an agent making ~50 tool calls a working day, a
person viewing ~15 pages): ~1,500 invocations (~$0.012), ~4 emails
(~$0.001), ~20 MB egress (inside 250 GB). **About one cent.** The binding
limits are the pooler's 200 clients on Micro and founder support time, not
money.

## 3. Add-ons at a decent margin to at cost

### Benchmarks

| Vendor | What | Price | Per GB or unit |
|---|---|---|---|
| Supabase | extra disk | $0.125 per GB-month | raw provider disk |
| GitHub | Git LFS past the free 10 GB | $0.07 per GiB-month storage, $0.0875 per GiB transfer ([docs](https://docs.github.com/billing/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage) *(via search)*) | object storage |
| Obsidian Sync | Plus 10 GB to 100 GB | $8 to $16 a month annual *(unverified, third-party)* | ~$0.09 per extra GB |
| Notion | history | Free 7 days, Plus 30, Business 90, Enterprise unlimited *(unverified, third-party)* | history is a tier lever |
| Doppler | secrets | Developer free for 3 users then $8, Team $21 a user; agents free | per person ([pricing](https://www.doppler.com/pricing)) |
| Infisical | secrets | Pro $20 to $23 per identity, Advanced $40 to $46; versioning and PITR only on paid | per identity ([pricing](https://infisical.com/pricing)) |
| Basic Memory | agent memory | $15 a seat, unlimited notes and history (fair use) | per person |
| Supabase | PITR | $100 per 7 days per project | project-wide |

Two observations. Nobody sells text storage cheaply because nobody needs to:
every GB price above is for binaries. And history is the lever Notion and
Obsidian use to push upgrades; **we keep all history on every plan**, which
is a differentiator worth saying out loud rather than a thing to sell.

### Principles

1. **Price where the cost is.** Storage and dedicated infrastructure carry a
   price; people and agents mostly don't, because they cost about a cent.
2. **Storage at about 1.5x to 2x all-in cost** when full. Most buyers use
   half of what they buy, so the realised margin is higher; that pays for
   the unused headroom and for the free tier.
3. **One subscription, one charge.** Add-ons ride on the vault's or
   account's subscription; annual at ten months' price.
4. **Hard caps with warnings, never overage bills.** At 80% and 95% the
   owner gets an email and a banner; at 100% the vault becomes read-mostly
   (as built). No metered overage, no automatic upgrades.
5. **Downgrades never delete** (as built). Cancelling an add-on leaves the
   vault over its limit and read-mostly until the owner erases or buys again.
6. **Never paywall safety**: the gate, approvals, the log, export, erasure,
   history and "values never reach a model" stay on every plan.
7. **Support time is priced as time**, not hidden in a margin.

### The menu

Net is after a merchant of record at ~7% + $0.50 per monthly charge, with the
fixed fee counted once per subscription (so it is shown on the base line
only).

| Item | Price | Our cost | Margin | Notes |
|---|---|---|---|---|
| **Pro vault** | **$9 a month or $90 a year** | typical Pro use (1 GB) ~$0.35; full ~$1.75; fees ~$1.13 | ~$6 to $7.50 a month (**4x to 20x** on infrastructure) | 50 people, 5 GB. This carries the fixed costs and founder time. |
| **Storage pack** | **+5 GB for $2.50 a month** ($25 a year) | $1.25 disk + ~$0.50 compute share when full, fees ~$0.18 | **~1.3x full, ~2.6x at half use** | any vault, stackable to 50 GB; $0.50 per GB is 4x Supabase's raw disk but under 2x our all-in cost |
| **People pack** | **+25 people on a Pro vault for $2 a month** | ~$0.25 (usage and support) | mostly margin; priced low on purpose | or raise Pro to 100 people and skip this; see open questions |
| **Studio bundle** (agencies) | **5 Pro vaults for $39 a month** ($390 a year), extra Pro vaults at $8 | as five Pro vaults | ~13% off the single price | matches ICP 1: one bill across client vaults |
| **Priority support** | **$29 a month per account** | ~30 to 60 minutes of founder time | time-priced | next-business-day answer, one 30-minute call a month |
| **Dedicated database** (later) | **$49 a month** | Supabase Micro $10 (Small $15) + ~1 hour of operations a month | ~2x on infrastructure plus ops | own project, choice of region, own backups; for compliance-driven clients. Needs multi-project routing, not built. |
| **History** | **free, all versions kept on every plan** | counted in storage already | n/a | owners can erase; an optional owner-run "thin history older than N months" is a later feature |
| **PITR** | not sold per vault | $100 a month, project-wide | n/a | buy it for everyone at ~25 Pro vaults (about $200 MRR) |

What not to sell: seats, agents, MCP clients, tokens, API calls, log
retention, export or erasure. All cost next to nothing, and charging for
them contradicts the pitch.

### Fairness policy (publishable draft)

> **What we charge for and why**
>
> Reliquary never runs a model for you, so the things that cost us money
> are small: storing your vault's text and history, and keeping the service
> running. We charge for those, and for our time.
>
> - **Free covers real use.** Five vaults, ten people each, 100 MB each.
>   Most teams never outgrow it.
> - **We charge by vault, not by head.** Agents, tokens and MCP clients are
>   never counted. Upgrade only the vault that grows.
> - **Storage is priced near cost.** We aim for about 1.5 to 2 times what a
>   full gigabyte costs us to keep, backed up, in Postgres. We publish that
>   cost and update it when our providers change prices.
> - **No surprise bills.** There is no overage billing. We warn you at 80%
>   and 95%; at 100% the vault stops accepting new text until you erase
>   something or add space. Reading, exporting, reviewing and deleting keep
>   working.
> - **Nothing is deleted when you pay less.** Cancel or downgrade and your
>   vault stays whole; it becomes read-mostly until it fits.
> - **History is yours on every plan.** We keep every version until you
>   erase it. We don't sell longer history.
> - **Safety is never a paid feature.** The gate, approvals, the log,
>   export, erasure and "secret values never reach a model" are in every
>   plan.
> - **Your data can leave.** Export is free and unlimited, and the server
>   can be self-hosted.
> - **Support time is priced as time.** Priority support is a separate,
>   optional line, so the base price doesn't hide it.

## 4. Self-host licensing economics

### What comparable products do

| Product | Server license | Free self-host | Paid self-host |
|---|---|---|---|
| Sentry | FSL-1.1-Apache-2.0 (converts to Apache 2.0 after two years) | yes, for any use except a competing commercial offering | none sold; revenue is the hosted service ([licensing](https://open.sentry.io/licensing)) |
| Supabase | Apache 2.0 | yes, all of it | none; revenue is the hosted platform |
| n8n | Sustainable Use License (internal business use only) | Community edition | Business **€667 a month** annual, self-host only; Enterprise custom ([pricing](https://n8n.io/pricing/)) |
| GitLab | MIT core, proprietary EE | Free tier | Premium **$29 a user a month**, self-managed at the same list price *(third-party)* |
| Infisical | MIT core, EE directory | core, 5 identities on cloud free | Pro $20 to $23 per identity; self-host enterprise by quote ([pricing](https://infisical.com/pricing)) |
| Langfuse | MIT, with enterprise add-ons | all core features, unlimited | Enterprise self-host by quote ([self-host pricing](https://langfuse.com/pricing-self-host)) |
| Directus | BSL 1.1 | Core free; **all of it free under $5M revenue and 50 staff** | Team $499 a month; Enterprise custom ([pricing](https://directus.com/pricing)) |
| Outline | BSL 1.1 (no hosting for others) | yes | enterprise by quote *(unverified)* |
| Mattermost | open core | Team edition | Professional $10 a user a month *(third-party)* |
| Basic Memory | AGPL-3.0 | yes | cloud only, $15 a seat |
| Plausible | AGPL-3.0 Community Edition | yes, no fee at any traffic | cloud only |

Three models: **fully open, earn on hosting** (Supabase, Plausible,
Sentry under FSL); **source-available, free internally, paid to host for
others** (n8n, Outline, Directus above a size); **open core with licensed
enterprise features** (GitLab, Infisical, Langfuse). Per-seat self-host
licenses only work with a sales team.

### Recommendation for Reliquary

- **CLI: MIT** (as today).
- **Server (web, MCP, migrations): FSL-1.1-Apache-2.0** when the source
  opens, as positioning.md already suggests. It fits the trust argument
  (read the code that guards your secrets), allows **any internal use,
  including commercial**, forbids only a competing hosted service, and
  becomes Apache 2.0 after two years, so nobody is locked in.
- **No feature gating in the self-hosted build.** Open core means two
  codebases' worth of tests for one founder, and the hostile tests are the
  product. Everything the hosted service does, the self-hosted one does.

What is free and what is paid:

| Use | License | Price |
|---|---|---|
| A person, team or company running it for itself, any size | FSL, free | $0 |
| Evaluation, research, education, contributions | FSL, free | $0 |
| **An agency or MSP hosting it for its clients** (a competing use under FSL) | **Partner license** | **$5 per client vault a month, minimum $50 a month**, or included in any Studio bundle for vaults it hosts itself. About half the Pro price, since they run the infrastructure. |
| A company wanting support, security advisories ahead of disclosure, and help upgrading | **Self-host support** | **$150 a month or $1,500 a year** up to 50 people; above that from **$5,000 a year**, by agreement |
| Running it as a public competing service | not licensed | ask; default no |

These prices are deliberately below n8n and Directus: Reliquary is smaller,
and the goal is trust and agency distribution, not license revenue. Expect
the partner license to earn more than support.

## 5. Recommended price sheet

| Line | Price | Includes |
|---|---|---|
| **Free** | $0 | 5 vaults, 10 people and 100 MB per vault, full history, every safety feature, export |
| **Alpha tester** | $0, by invitation | 25 vaults, 25 people and 1 GB per vault |
| **Pro vault** | $9 a month or $90 a year | 50 people, 5 GB, on one vault |
| **Studio bundle** | $39 a month or $390 a year | 5 Pro vaults; more at $8 each |
| **Storage pack** | $2.50 a month or $25 a year | +5 GB on one vault, stackable to 50 GB |
| **People pack** | $2 a month | +25 people on a Pro vault |
| **Priority support** | $29 a month | per account |
| **Dedicated database** (later) | $49 a month | own Supabase project and region |
| **Self-host** | $0 | FSL, any internal use |
| **Self-host support** | $1,500 a year (to 50 people), from $5,000 above | support and advisories |
| **Partner license** | $5 per hosted client vault a month, $50 minimum | hosting Reliquary for clients |

## 6. A model to tweak

Inputs (defaults in brackets):

```
disk_price      = 0.125   # $ per GB-month, Supabase gp3
m               = 1.6     # disk bytes per counted byte (1.3 to 2.0 measured)
h               = 1.25    # provisioned headroom; disk never shrinks
compute_per_gb  = 0.10    # $ per counted GB-month, the Small step amortised
fee_pct, fee_fix = 0.07, 0.50   # merchant of record per charge
fixed           = 50      # $ a month (80 careful, 180 with PITR)
```

Formulas:

```
cost_per_counted_gb = disk_price * m * h + compute_per_gb          # ~0.35
vault_cost(GB)      = GB * cost_per_counted_gb
net(price)          = price * (1 - fee_pct) - fee_fix               # per charge
margin(price, GB)   = net(price) - vault_cost(GB)
storage_pack_price  = pack_GB * cost_per_counted_gb * target_markup # 5 * 0.35 * 1.5 = 2.63
breakeven_pro       = fixed / margin(9, typical_GB)                 # 50 / 7.5 = ~7 vaults
fleet_disk_GB       = m * (n_free * avg_free_GB + n_pro * avg_pro_GB) + log_GB
compute_step        = Micro if fleet_disk_GB < 10, Small if < 50, Medium if < 100
months_to_fill(lim) = (lim - F*S) / (W * D * V)
```

Worked example: 1,000 free vaults (80% idle at 2 MB, 20% typical at 60 MB a
year) and 30 Pro vaults at 1 GB. Counted after a year: 1.6 + 12 + 30 = ~44
GB; on disk ~70 GB. That is past Small's 50 GB, so Medium ($60, +$50 over
the credit) plus ~62 GB of disk overage (~$8): about **$85 a month** in
database including the $25 plan, against 30 x ~$7.50 = **$225** of Pro
margin. Free vaults are ~30% of the counted bytes, so they cost about $18 a
month of that, what two or three Pro vaults earn. At that point cold storage
for history older than a year (section 1) is worth building.

## 7. Open questions

1. **Count stored bytes or raw bytes?** Raw is predictable (a person can add
   up their files); compressed is fairer to large documents (about half).
   Recommend keeping raw, with limits set knowing disk is ~1.6x raw.
2. **Store an applied proposal's text once.** When a proposal is applied
   unchanged, its body duplicates the version. Pointing to the version would
   save ~0.5x counted on disk for canon-heavy vaults. A migration, not a
   pricing change.
3. **Aggregate `env_access_log` reads** from CI (one row per token per hour
   with a count), so a busy pipeline doesn't write 100 MB a year uncounted.
   It is append-only by guardrail, so this changes what a row means, not
   whether rows change.
4. **People pack or bigger Pro?** Raising Pro to 100 people costs almost
   nothing and removes a line from the price sheet.
5. **Merchant of record choice.** Paddle wants custom pricing under $10;
   Polar and Lemon Squeezy add international and subscription surcharges;
   Stripe direct is cheapest but makes VAT ours. Ask Paddle for a $9 quote,
   or price Pro at $10.
6. **Cold storage for history** once the database passes ~50 GB: a design
   decision because `file_versions` is insert-only.
7. **Micro's 10 GB database ceiling** is from the compute table as fetched;
   confirm on the Supabase dashboard before relying on it.
8. **Measure on the hosted database** once there are real vaults:
   `pg_total_relation_size` per table against `private.vault_storage`, to
   replace the replayed corpus with real m.
9. **Partner license terms** (what counts as "hosting for clients" when an
   agency invites clients into its own hosted vaults) need a lawyer before
   opening the source.

## Sources

Checked 2026-09-25.

- Supabase: [pricing](https://supabase.com/pricing), [compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk), [disk size](https://supabase.com/docs/guides/platform/manage-your-usage/disk-size), [license](https://github.com/supabase/supabase/blob/master/LICENSE)
- Vercel: [pricing](https://vercel.com/pricing)
- Email: [Resend](https://resend.com/pricing), [European email APIs 2026 (AhaSend)](https://ahasend.com/blog/best-european-email-apis-2026)
- Payments: [Stripe Ireland](https://stripe.com/ie/pricing), [Paddle](https://www.paddle.com/pricing), [Polar](https://polar.sh/resources/pricing), [Lemon Squeezy fees (Swell)](https://www.swell.is/content/lemon-squeezy-pricing), [Stripe Managed Payments fees (Dodo)](https://dodopayments.com/blogs/stripe-managed-payments-fees-explained)
- Postgres compression: [pglz vs LZ4 (Tiger Data)](https://www.tigerdata.com/blog/optimizing-postgresql-performance-compression-pglz-vs-lz4), [default_toast_compression (The Build)](https://thebuild.com/blog/all-your-gucs-in-a-row-defaulttoastcompression/)
- Vault sizes: [Obsidian forum, note counts](https://forum.obsidian.md/t/how-many-notes-do-you-have/36987), [Obsidian Sync plans](https://obsidian.md/help/sync/plans), [Obsidian pricing](https://obsidian.md/pricing), [Notion export limits (Raccoon Page)](https://raccoon.page/blog/notion-export-limitations/), [Basic Memory pricing](https://basicmemory.com/pricing)
- Storage and seat benchmarks: [GitHub LFS billing](https://docs.github.com/billing/managing-billing-for-git-large-file-storage/about-billing-for-git-large-file-storage), [Doppler](https://www.doppler.com/pricing), [Infisical](https://infisical.com/pricing), [Notion pricing (Automation Atlas)](https://automationatlas.io/answers/notion-pricing-explained-2026/), [Obsidian Sync Plus storage (eesel)](https://www.eesel.ai/blog/obsidian-pricing)
- Licensing: [Sentry licensing](https://open.sentry.io/licensing), [FSL announcement](https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/), [n8n pricing](https://n8n.io/pricing/), [n8n Sustainable Use License](https://docs.n8n.io/sustainable-use-license/), [Directus pricing](https://directus.com/pricing), [Langfuse self-host pricing](https://langfuse.com/pricing-self-host), [Outline license restrictions](https://docs.getoutline.com/s/hosting/doc/license-restrictions-f9aq6uEL3H), [GitLab pricing (costbench)](https://costbench.com/software/developer-tools/gitlab/), [Mattermost license (opsily)](https://opsily.com/blog/mattermost-license), [Plausible CE](https://plausible.io/blog/community-edition)
- Measurement: this repository's `git log` (253 Markdown versions) replayed into every migration in `supabase/migrations/` on `postgres:17`, 2026-09-25.
