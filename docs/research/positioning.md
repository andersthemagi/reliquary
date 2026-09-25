# Positioning, pricing and go-to-market

2026-09-24 · Status: RESEARCH, recommendations for Andrés · Builds on
[landscape-swot.md](landscape-swot.md), [pricing.md](pricing.md) and
[org-chatbot-gate.md](org-chatbot-gate.md)

How to sell Reliquary as **Reliquary by Red Mage** at
`reliquary.redmage.cc`: what to say, to whom, for how much, and what must
exist before the first invoice. Market facts were checked on the web on
2026-09-24. Claims marked *(unverified)* came from third-party write-ups,
not the vendor. Prices change; re-check before quoting.

## 1. Positioning

**One sentence:**

> Reliquary is one shared vault of context and credentials for the people
> and AI agents on a project: every agent, from any vendor, reads the same
> approved context over one MCP URL, proposes changes a person approves,
> and uses secrets it never sees.

**Tagline options:**

| Tagline | Leans on |
|---|---|
| Shared context your agents can't make up. | canon needs a person |
| One vault. Every agent. A person signs off. | vendor-agnostic plus approvals |
| Your agents propose. You approve. | the proposal loop, simplest |
| Context and keys for the whole team, and every agent they use. | the two halves in one place |
| Stop emailing API keys. Stop re-explaining the project. | client work (ICP 1) |
| The vault for client work with AI. | agency angle, shortest |

Recommendation: lead with **"Your agents propose. You approve."** as the
headline and **"Stop emailing API keys. Stop re-explaining the project."**
as the agency subhead. Keep "permission layer" and "gate" language for
technical pages; buyers in the first segments don't use those words.

**What Reliquary is not** (say it on the page, it filters leads): not an
AI model or chatbot, not enterprise search over your Drive and Slack, not
an automatic memory that writes itself.

## 2. The feature set, as customer jobs

Status as of 2026-09-24 (AGENTS.md "Done so far", git log).

| Job the customer is doing | How Reliquary does it | Status |
|---|---|---|
| "Give Claude, ChatGPT, Cursor and Claude Code the same project context" | Vaults of markdown files over one remote MCP URL and the web UI | **Built** |
| "Connect my AI tool without pasting secrets" | OAuth 2.1 connectors for Claude.ai, ChatGPT and Claude Code; scoped, expiring, revocable tokens for headless agents | **Built** |
| "Let agents help without letting them rewrite the truth" | Canon and open policies per folder; canon changes only by proposal, approved by a quorum of people | **Built** |
| "Review what agents suggest, like a pull request" | Review inbox, proposal pages with diff, threads, approve / request changes / reject / edit and approve | **Built** |
| "Agents act for me but can't do the dangerous things" | Agent is its person minus a ceiling (no approving, rules, members, reveal), enforced in Postgres RLS with hostile tests | **Built** |
| "Know who (and which agent) changed what" | Append-only activity log, per-file history, `changes_since` feed | **Built** |
| "Find it" | Full-text search over MCP and web | **Built** |
| "Stop keeping `.env` files on every machine" | Encrypted variables per environment, `reliquary run` and `env pull`, access log, values never over MCP | **Built** |
| "Let an agent add a variable without seeing others" | `reliquary env push` landing as a change a person approves | **Next** |
| "Bring a teammate in" | Invites and member management in the web UI (a parity gap today) | **Next** (needed before selling) |
| "Take my data with me" | Plain export of a vault | **Next** (milestone 1 promise, not built) |
| "Share a Linear or Stripe account's tools, not its key" | Shared connections: MCP gateway with vault-held credentials, per-role tool allowlists | **Later** (milestone 3) |
| "Run a weekly digest or triage without my laptop on" | Declarative routines on the vault's own model key, artifact required | **Later** (milestone 4) |
| "Get credentials from a client without email" | Credential requests, client guests, write-only variables, offboarding report | **Later** (milestone 5) |
| "Survive losing a person" | Two owners, emergency access | **Later** (milestone 5) |
| "Keep a git copy" | One-way git mirror, version history view and restore | **Later** (milestone 6) |
| "A bot in our group chat that doesn't overshare" | Audience-intersection gate on Telegram (`pilot/`) | **Later** (milestone 7) |
| "Our IT needs SSO and a SOC 2 report" | SSO, SCIM, audit report | **Later**, on demand |

## 3. Differentiators, honestly

### The market in one table

| Category | Players (price checked 2026-09-24) | Who buys | How they sell | What they don't do that Reliquary does |
|---|---|---|---|---|
| Agent memory APIs | Mem0 (free, $19, $249/mo), Zep (free, $125, $375/mo), Supermemory (free, $19, $100, $399/mo), Letta (free, $20/mo, Teams $20/seat) | Developers building AI products | PLG, usage credits, open source, benchmarks | Memory is written automatically by the model; no human approval; built for an app's end users, not a team's shared truth; roles and audit on top tiers |
| Team knowledge over MCP | **Basic Memory** ($15/seat Team, $30/seat Business, AGPL self-host), Hjarni (free to 25 notes, then per seat *(unverified)*), Notion (Business €19.50/seat for Notion Agent) | Small teams, individual power users | PLG, Discord, open source | Agents write directly; no quorum; no secrets; Basic Memory only has project-level roles and is designing read-only notes ([issue #993](https://github.com/basicmachines-co/basic-memory/issues/993)) |
| Vendor memory | Claude memory (all plans, chat and Cowork share it since 2026-08-25), Claude and ChatGPT Projects (shared on Team plans), Claude Tag | Everyone already paying the lab | Bundled | Per person or per project, one vendor, no approval step. Third-party write-ups say no team-wide memory as of 2026-08 *(unverified)* |
| Secret managers | Doppler (free to 3 users, $8 each after; Team $21/user), Infisical (free to 5 identities; Pro $20 to $23/identity), 1Password (Business ~$7.99/user *(unverified)*; Environments with an MCP server that returns no values), dotenvx Armor ($5 solo, $20 for 3, $90 for 10), Vercel env (included with hosting) | Dev teams, platform and security leads | PLG plus sales-led enterprise; SSO and longer audit logs gate tiers | No shared context; no client-facing vault; approvals (Doppler Change Requests, Infisical approval workflows) sit on Team or Enterprise |
| MCP gateways | Composio (free 100k calls, $29/mo), Arcade (free 2k calls, $25/mo plus usage; bought Smithery 2026-08-05), Docker MCP Gateway (MIT, free), Cloudflare MCP server portals (Cloudflare One, 50 free seats) | Platform teams, agent builders | Usage-based, registry reach, enterprise security | No context, no approvals of content; built for tool calls |
| Agent governance | LangGraph interrupts (open source; LangSmith Plus $39/seat), HumanLayer (pivoted to a multiplayer coding-agent IDE, $100/user Pro) | Teams building their own agents | Framework adoption, then platform seats | You write code to get approvals; approvals are of actions in your app, not a shared record |

### What only Reliquary does (today, as far as found)

1. **Human-approved canon with a quorum, over MCP, for any vendor's agent.**
   Nobody else found has an approval queue on agent writes to shared
   context. This is the headline.
2. **The agent ceiling enforced in the database, with hostile tests on
   every push.** Competitors enforce roles in the API, if at all. The
   tests make the claim checkable, which matters to the security-minded
   agency client.
3. **Context and credentials in one vault per project or client.** Secret
   managers don't hold context; memory tools don't hold secrets. A client
   engagement needs both, with one invite and one access log.
4. **Cheap, EU-hosted, bring your own model.** No inference cost to pass
   on, so small teams pay little. EU hosting (Supabase `eu-central-1`,
   Vercel `fra1`) is a real point for European clients.

### Table stakes (don't lead with these; competitors have them)

- A remote MCP server with OAuth. Basic Memory, Notion, 1Password,
  Composio and many others ship one.
- Markdown files, full-text search, version history, export.
- "Agents never see secret values": 1Password's Environments MCP server,
  Infisical Agent Vault and Doppler all say it. Reliquary does it well, but
  it is not unique.
- Per-seat roles, audit logs, SSO (the last one Reliquary lacks).

### Where competitors are ahead

- Automatic capture. Every memory tool learns without anyone curating;
  Reliquary asks people to approve, which costs effort up front
  (approval fatigue is the named risk in the design).
- Integrations and indexing of existing sources (Notion, Glean-style
  tools).
- Trust credentials: SOC 2 reports, SSO, funded companies. A solo founder
  starts behind.

## 4. Ideal customer profiles, ranked

### ICP 1: small AI-native agencies and consultancies doing client work

2 to 15 people, dev, automation or AI studios; freelancers who subcontract.
Red Mage itself is one.

| | |
|---|---|
| Pains | Clients send API keys by email or chat. Each person has the project context in their own Claude Project or ChatGPT chat, so it drifts. Contractors come and go with keys on their laptops. Offboarding a client means guessing what to rotate. Client security questionnaires ask where credentials live |
| Triggers | A new engagement kickoff; a client's security questionnaire or DPA request; a subcontractor joining or leaving; a leaked key or an agent committing a `.env`; a client asking "which AI tools see our data?" |
| Why Reliquary | One vault per client: context the whole team's agents read, approvals on anything that becomes fact, credentials used through `reliquary run`, one log to show the client. EU hosting helps with EU clients |
| Willingness to pay | Highest. The cost goes into the engagement; a flat fee under $50/mo is noise against one client invoice |
| Where they are | Andrés's own network and Red Mage clients; AI Founding Table and the Claude Community House crowd; Contra and freelancer communities; LinkedIn agency owners; Latent Space and MCP Discords; r/ClaudeAI, r/ChatGPTCoding |
| Honest gap | The client-facing half (credential requests, client guests, offboarding) is milestone 5. Sell it today as a Red Mage-assisted setup, and build the rest from what these customers ask for |

### ICP 2: solo builders with several agents and machines

Developers and indie hackers using Claude Code, Cursor, ChatGPT and
Hermes across a laptop, a desktop and a server. Andrés is the reference
customer.

| | |
|---|---|
| Pains | `CLAUDE.md`, `AGENTS.md` and notes drift between tools and machines. `.env` files sit in every repo where any coding agent can read them. Vendor memory doesn't follow them to the next tool |
| Triggers | Adding a second AI tool or a second machine; an agent printing a secret in a transcript; starting a new side project |
| Why Reliquary | Everything they need is built today: one URL for every client, canon they approve, `reliquary run` instead of `.env` |
| Willingness to pay | Low ($0 to $10/mo). Worth it for word of mouth, content and bug reports, not revenue |
| Where they are | X/Bluesky build-in-public, Hacker News, r/ClaudeAI, r/cursor, Claude Code and MCP Discords, Indie Hackers, MCP registries |

### ICP 3: small product teams using mixed AI tools

3 to 20 people at a startup where some use Claude, some ChatGPT, some
Cursor.

| | |
|---|---|
| Pains | No shared, trusted context across tools; agents write docs nobody reviewed; secrets in Slack DMs |
| Triggers | Onboarding a new engineer; an agent acting on stale docs; a first security review from a customer |
| Why Reliquary | Same as ICP 1 without the client angle |
| Willingness to pay | Medium, but they soon ask for SSO, Slack integration and a SOC 2 report |
| Where they are | Founder communities, YC-style networks, the same Discords |
| Why third | Bigger asks, longer sales, and Basic Memory, Notion and the labs compete hardest here |

### Disqualifiers (say no, kindly)

- Needs SSO/SCIM or a SOC 2 Type II report before signing.
- More than about 30 people, or procurement and security review as a
  process.
- Wants Reliquary to supply the model, or has no API key or subscription
  of their own.
- Wants search over existing Drive, Slack and email rather than curated
  context.
- Regulated data (health, payment card data) or US-only residency.
- Needs local stdio MCP tools proxied, or agents that approve their own
  changes.
- Happy on one vendor with Claude or ChatGPT Projects and no secrets
  problem.

## 5. Pricing recommendation

### Costs

Checked 2026-09-24 ([Supabase](https://supabase.com/pricing),
[Vercel](https://vercel.com/pricing), [Resend](https://resend.com/pricing)).

| Item | Monthly | Notes |
|---|---|---|
| Supabase Pro | $25 | includes $10 compute credit, which covers one Micro; daily backups kept 7 days; 8 GB disk, 250 GB egress |
| Second Supabase project (staging) | $10 | Micro compute; optional but wise before client data |
| Vercel Pro | $20 | per deploying seat, with $20 usage credit (per seat: *unverified*, third-party); Hobby is non-commercial |
| Transactional email (Resend) | $0 to $20 | free is 3,000/mo capped at 100/day; Pro $20 once invites and OTP pass that |
| Domain, status page, uptime check | ~$0 to $5 | subdomain of `redmage.cc`; free tiers of a status page and healthchecks.io |
| **Fixed total** | **~$60 to $80** | before PITR ($100/mo per 7 days), which can wait |
| Payments | 5% + $0.50 per charge | a merchant of record (Paddle or Polar) handles EU VAT, worth it for a solo EU seller; Stripe is cheaper but leaves VAT filing to Andrés |

Marginal cost of a free vault is cents: text is ~1 KB per file, no
inference, and the gate spike answers in single-digit milliseconds. The
real cost of free users is support time and connection limits.

### What competitors charge a 5-person team

| Product | 5 people, monthly |
|---|---|
| Basic Memory Team | $75 |
| Letta Teams Pro | $100 |
| Doppler Team | $105 (Developer: $16) |
| Infisical Pro | $100 to $115 |
| Notion Business | ~€98 |
| dotenvx Armor | $90 (Business, up to 10) |
| Composio or Arcade | $25 to $29 plus usage |

### The model (owner's decision, 2026-09-25; built)

Supabase-style: an **account plan** limits how many vaults a person owns,
and each **vault has a tier** that limits its people and storage. A vault
can be upgraded on its own, so an agency pays for the one busy client
vault, not for every person. Agents, MCP clients and tokens are never
counted. Never paywall the gate, approvals, the log, export or "values
never reach a model".

| | Free (default) | Alpha tester (by invitation) | Pro vault (an upgrade, coming) |
|---|---|---|---|
| Vaults owned | 5 | 25 | (per vault) |
| People per vault (members plus invites waiting) | 10 | 25 | 50 |
| Storage per vault | 100 MB | 1 GB | 5 GB |
| Price | $0 | $0, granted by hand | suggested **$9 a month per vault** once billing exists |

How it is built (`supabase/migrations/20260925230000_plans.sql`): the
numbers are rows in `private.plans` and `private.vault_tiers`, so they
change without a release; the operator grants plans and tiers with
`scripts/plan.sh`; every limit is enforced in the database, and a smaller
plan never deletes anything (an over-limit vault becomes read-mostly).
Storage counts every file version (history takes the same space as the
current text), variable ciphertext and imports waiting; erasing frees it,
deleting doesn't.

Why vaults and storage, not seats: the earlier table charged per workspace
with a people cap (Free up to 3 people), which gives away the segment most
likely to pay only if they stay small. Counting vaults and storage instead
keeps small teams free, puts the price where the cost is (a big vault is
the only thing that costs us anything), and lets an agency upgrade the one
client vault that grows. The Studio-style flat plan (people, client
guests, a signed DPA, support) can still come later as an account plan;
it doesn't need a new model.

### Economics

Prices checked 2026-09-25 unless marked; see Sources.

| Item | Price | Notes |
|---|---|---|
| Supabase Pro | $25/month per organisation | includes $10 compute credit (one Micro) and **8 GB disk per project**; disk beyond that **$0.125 per GB-month** (gp3) ([disk docs](https://supabase.com/docs/guides/platform/manage-your-usage/disk-size)) |
| Supabase egress | 250 GB included, then about $0.09/GB | *unverified today; from the 2026-09-24 check* |
| Vercel Pro | $20/month per deploying seat, $20 usage credit | functions: 1M invocations included, then from $0.60 per million; Active CPU from $0.128 an hour ([pricing](https://vercel.com/pricing)) |

What a vault costs in disk. Postgres keeps more than the counted bytes:
each file version also stores its search words (`body_tsv`, about as large
as the text), plus row and index overhead and dead rows until vacuum. Call
it **about 3x** the counted bytes (*an estimate; measure it on the hosted
database with `pg_total_relation_size` once there are real vaults*).

| Vault | Counted | On disk (x3) | Monthly disk cost past the 8 GB included |
|---|---|---|---|
| Typical (a few hundred notes, some variables) | ~1 MB | ~3 MB | ~$0.0004 |
| A full Free vault | 100 MB | ~300 MB | ~$0.04 |
| A full Alpha tester vault | 1 GB | ~3 GB | ~$0.38 |
| A full Pro vault | 5 GB | ~15 GB | ~$1.88 |

The included 8 GB holds about 26 full Free vaults, or several thousand
typical ones, before any overage. Compute is the larger risk than disk:
a Micro (1 GB RAM) is fine for text vaults into the thousands, and the next
size (Small) is about $15 a month more (*unverified*). Vercel functions are
negligible: a tool call is one short invocation, and 1M invocations (about
33,000 calls a day) are included in the seat, the next million at $0.60.
Egress is text; 250 GB is far away.

Break-even for a Pro vault at $9 a month: net after a merchant of record
(5% + $0.50) is **$8.05**. A full Pro vault's worst-case disk is ~$1.90,
so each one clears its own cost by ~$6 even full, and far more at typical
use. Fixed costs are ~$60 to $80 a month (the costs table above), so
**8 to 10 Pro vaults** cover the infrastructure; the rest is founder time.
Free vaults cost cents; their real cost is support and connection limits,
which the vault and people caps also bound.

| Target | Needs (at $8.05 net per Pro vault) |
|---|---|
| Cover $60/mo fixed costs | 8 Pro vaults |
| Cover $80/mo (Resend Pro) | 10 |
| Cover $180/mo (plus PITR) | 23 |
| $1,000 MRR | ~125, or fewer with a flat Studio-style plan on top |

Offer the first 10 agencies a Pro vault free for a year in exchange for a
weekly feedback call and a case study; count Red Mage services revenue
(section 6) alongside subscriptions, because early on the setup offer will
earn more than the upgrades.

### Licensing

- **The CLI is MIT** (already published under it): people run it on their
  machines and in CI, and should be able to read and vendor it.
- **The server (web app, MCP endpoint, migrations) stays proprietary while
  the repository is private.** There's nothing to license yet.
- If the source is ever opened, consider the **Functional Source License**
  (FSL: source-available, no competing hosted service, converting to
  Apache 2.0 or MIT after two years) with a **commercial license** for
  anyone who wants to run it as a service. It keeps "read the code that
  guards your secrets" (a trust argument for this product) without handing
  a host the business. *Not legal advice; decide with a lawyer before
  opening anything.*

## 6. Go-to-market for a solo founder

### First 10 customers

| Week | Do | Goal |
|---|---|---|
| 0 | Finish the must-haves in section 8. Run Red Mage's own client work in Reliquary for a week | a real reference case |
| 1 | List 30 people from Andrés's network: past Red Mage clients, agency owners, AI Founding Table, Claude Community House attendees. Send a personal note, not a launch post | 15 calls booked |
| 1 to 3 | 20-minute discovery calls: "how do clients send you credentials today?", "where does your project context live?", "who would approve?" Show the demo only if the pain is real. Test the price table | 5 design partners |
| 2 to 4 | Onboard each partner by hand: create their first client vault with them, connect two of their AI tools, move one `.env` into `reliquary run` | activation, not signups |
| 3 | **"Run your next client engagement on Reliquary"**: a Red Mage services offer. Fixed-price setup (e.g. a half day: vault structure, canon rules, connecting the team's agents, moving the client's credentials in) plus a Pro vault for the client, free for the first year | 2 to 3 paid setups |
| 4 onward | Build in public weekly; ask each partner for one intro to another agency | 10 paying workspaces by week 8 |

### Channels, ranked for a solo founder

1. **Founder-led outreach in Andrés's network.** Highest conversion, and
   the only channel that works before the product is polished.
2. **Red Mage services.** Every engagement Red Mage runs uses Reliquary,
   and the client sees it. Clients who like the invite experience become
   leads for their own vendors.
3. **Build-in-public content.** Short posts and demos: "Your coding agent
   can read your `.env`. Here is the fix."; "63 hostile tests: how we check
   an agent can't approve its own change"; "One vault, four AI tools, the
   same answer". Post on X/Bluesky and LinkedIn; long form on the Red Mage
   blog.
4. **Claude and AI communities.** Claude Discord, r/ClaudeAI, MCP
   Discords, Latent Space. Answer questions about shared context and
   secrets; link only when asked.
5. **MCP directories.** List in the official MCP registry, PulseMCP, Glama
   and Smithery (now Arcade). Check the Claude and ChatGPT connector
   directories' submission rules *(requirements unverified)*.
6. **Show HN**, once invites, export and the legal pages exist. One shot;
   don't spend it early.

Skip for now: paid ads, conferences with booths, cold email at volume,
partnerships with the labs.

### Landing page outline for `reliquary.redmage.cc`

1. **Hero**
   - Headline: *Your agents propose. You approve.*
   - Sub: *One shared vault of context and credentials for your team and
     every AI tool you use. Claude, ChatGPT, Cursor and Claude Code read the
     same approved context. Secrets stay out of the chat.*
   - Buttons: *Start free* · *See a 3-minute demo*
   - Small print: *EU-hosted. Bring your own model. By Red Mage.*
2. **The problem, in three lines**
   - *Every person has their own AI memory, so the project's truth drifts.*
   - *Agents write things nobody checked, and the next agent believes them.*
   - *API keys travel by email and sit in `.env` files any agent can read.*
3. **How it works** (three steps with screenshots)
   - *Connect any AI tool with one URL.* Paste it in Claude, ChatGPT,
     Cursor or Claude Code and sign in.
   - *Agents read and propose.* Open folders take notes directly; canon
     folders change only when a person approves.
   - *Run with secrets, never show them.* `reliquary run -- npm start`
     puts variables into your process. No AI tool ever receives a value.
4. **For client work** (ICP 1 section)
   - *One vault per client. Invite the client, collect their keys without
     email, show them the access log, hand everything back when you're
     done.* Mark the not-yet-built parts "coming" honestly.
5. **What your agent can't do** (trust section)
   - *Approve its own change. Change the rules. Add people. Reveal a
     secret.* *Enforced in the database, not the prompt, and tested on
     every push.* Link to the hostile tests and the security page.
6. **Works with** logos-as-text: Claude, Claude Code, ChatGPT, Cursor,
   Hermes, any MCP client. (Use names, not brand logos, until usage terms
   are checked.)
7. **Pricing** (the table in section 5, short form).
8. **Security and privacy**: EU region, what's encrypted, *what the
   operator can technically decrypt* (said plainly), sub-processors, DPA,
   "we don't train on your data, and nobody at Red Mage reads it
   without your request", export any time.
9. **FAQ**: Is it a model? (no) Do I need to self-host? (no) Can I leave?
   (export) How is it different from Claude Projects or Basic Memory?
   (any vendor, approvals, secrets) Which provider sees my data? (the one
   you connect)
10. **Footer**: *Reliquary by Red Mage*, status page, terms, privacy,
    sub-processors, contact.

### Demo script (3 minutes)

| Time | Show | Say |
|---|---|---|
| 0:00 | A client vault "Acme rebuild" in the web UI: `brief.md` (canon), `notes/` (open) | "One vault per client. Canon is what we've agreed. Notes are scratch." |
| 0:20 | Claude Code: "what's the Acme deploy target?" It answers from `brief.md`, quoted with approver and date | "Claude Code reads the vault over MCP." |
| 0:45 | ChatGPT, same question, same answer | "So does ChatGPT, with the same context. No copy-pasting between tools." |
| 1:05 | Ask Claude Code to change the deploy target in the brief. It gets refused and files a proposal instead | "Agents can't rewrite canon. They propose." |
| 1:25 | Phone or browser: Review inbox, the diff, approve | "A person approves. Now every agent sees the change." |
| 1:45 | Activity log: the proposal, the approval, who and which agent | "Everything is logged, append-only." |
| 2:00 | Terminal: `reliquary run -- npm run dev` starts with the Stripe key; ask the agent for the key's value; `list_variables` shows names only | "Secrets go into the process, never into the chat." |
| 2:30 | Variables access log shows the read and the refused attempt | "And you can show the client exactly who used which key." |
| 2:45 | Pricing and "Start free" | "Free for small teams: 5 vaults, 10 people each. Upgrade the one client vault that grows." |

### Metrics

| Metric | Definition | Early target |
|---|---|---|
| Activation | New workspace creates a vault and connects 2 or more AI clients within 7 days | 40% |
| Second tool | Share of active vaults read by 2 or more client types (e.g. Claude and ChatGPT) in a week | the thesis metric; watch the trend |
| Weekly active vaults | A vault with an MCP read or a web visit that week | grows week over week |
| Proposal loop | Proposals approved per active vault per week, and median age of open proposals | age under 2 days; rising age means approval fatigue |
| Secrets adoption | Workspaces with a `reliquary run` or `env pull` in the week | 30% of active |
| Team spread | Workspaces with a second person | 30% of active |
| Conversion | Free to paid within 60 days; share of paid from the Red Mage offer | 5 to 10% |
| Retention | Paid logo churn per month | under 3% |
| Founder load | Support hours per week, incidents per month | under 4 h; 0 data incidents |

## 7. Risks and mitigations

| Risk | How likely | Mitigation |
|---|---|---|
| **Labs ship team memory.** Anthropic merged chat and Cowork memory on 2026-08-25 and ships adjacent features monthly; OpenAI and Anthropic already share Projects on team plans | High | Stay vendor-agnostic: the second-tool metric is the moat. Sell to people using two or more vendors. Lean on approvals and secrets, which labs have no reason to build for other vendors' agents |
| **Basic Memory adds approvals or read-only notes** (designing read-only notes now) | Medium | Move faster on the client-work kit and secrets, which they don't have. Price below them |
| **Secret managers add context**, or 1Password's Environments MCP grows | Low to medium | Position secrets as the companion to context, not the product. Offer an import from Doppler or 1Password later rather than fighting them |
| **Gateway consolidation** (Arcade bought Smithery; Composio, Cloudflare, Docker free or cheap) | High for milestone 3 | Keep shared connections narrow: vault-scoped credentials and grants, not a catalog. Don't compete on number of tools |
| **Trust bar.** A solo founder holding client credentials; the operator can decrypt; no SOC 2 | High | Say plainly what the operator can do. Publish the hostile tests, security page, sub-processors and DPA. Supabase Pro backups with a tested restore. Offer self-hosting for the cautious. Start SOC 2 only when a paying client requires it |
| **A security incident** | Low, catastrophic | Keep the guardrails in AGENTS.md; add rate limits and alerting on refused attempts; breach runbook with 72-hour notice; never ship a change that could route a value to a model |
| **Solo bandwidth**: support, on-call, sales and build at once | High | Limit the first cohort to 10. Studio support is next business day. A status page and uptime alerts. Say no to disqualified leads. Batch support on fixed days |
| **Approval fatigue** makes canon stale | Medium | Default more folders to open; show queue age; batch approve in the inbox |
| **Anthropic or OpenAI terms** change connector or subscription use | Medium | Bring-your-own-model and standard MCP only; no stored subscription credentials |
| **Pricing too low** to matter | Medium | Services revenue carries the first year; raise the Pro vault price, or add a flat Studio-style plan, after 20 paying customers |
| **Name and trademark** (npm `reliquary` taken; domains held by others) | Low to medium | Sell under "Reliquary by Red Mage" on `redmage.cc`; run a USPTO and EUIPO search before print or paid ads |

## 8. What to build or fix before selling

In priority order. Most are not milestone features; they are what a paying
customer assumes. Items 1 and 5 pull milestone-5 and milestone-1 work
forward, which is Andrés's call against the build order.

| # | Item | Why |
|---|---|---|
| 1 | **Invites and member management in the web UI** | No team or client can join without it (parity gap: `set_member` exists only in seeds) |
| 2 | **Supabase Pro and Vercel Pro** before any paying or client data; a tested restore from backup | Free Supabase has no backups and pauses; Vercel Hobby is non-commercial |
| 3 | **Email on the product domain**: custom SMTP from `reliquary.redmage.cc` with SPF, DKIM and DMARC | Sign-in OTP and invites must arrive and not look like phishing |
| 4 | **Terms, privacy policy, DPA, sub-processor list** (Supabase, Vercel, the email sender, the payment provider) and a security page | Every agency client will ask; GDPR needs them |
| 5 | **Vault export** (and delete vault, erase file in the web) | "Your data can leave" is a principle and a sales answer; erasure is a GDPR right |
| 6 | **Billing**: a workspace owner, plan limits enforced in the database, checkout through a merchant of record | Can't charge without it; limits must hold like any other rule |
| 7 | **Status page and uptime alerts** on web, MCP and the database keepalive | A solo operator needs to hear about outages first |
| 8 | **Onboarding**: a "client engagement" vault template, a first-run checklist, the Connect page tested with each client | Activation is the first metric |
| 9 | **Landing page and docs** at `reliquary.redmage.cc` | Section 6 outline |
| 10 | **Decide the token-revoke ceiling** (parity gap) and add rate limits on auth and MCP | Closes a grant-management gap before strangers use it |
| 11 | **Trademark search** | Before paid marketing |

## Sources

Memory and context:

- [Mem0 pricing](https://mem0.ai/pricing)
- [Zep pricing](https://www.getzep.com/pricing)
- [Letta pricing](https://docs.letta.com/letta-code/pricing)
- [Supermemory pricing](https://supermemory.ai/pricing/)
- [Basic Memory pricing](https://basicmemory.com/pricing),
  [Teams launch](https://basicmemory.com/blog/basic-memory-teams-launch),
  [read-only notes issue](https://github.com/basicmachines-co/basic-memory/issues/993)
- [Hjarni on Projects not scaling to teams](https://hjarni.com/blog/claude-and-chatgpt-projects-dont-scale-to-a-team) *(third party)*
- [Notion pricing](https://www.notion.com/pricing)
- [TechCrunch: Claude Cowork remembers chat](https://techcrunch.com/2026/08/25/claude-cowork-finally-remembers-what-you-told-the-app-in-chat/),
  [The Register](https://www.theregister.com/ai-and-ml/2026/08/25/claude-and-cowork-now-share-what-they-know-about-you/5292412)

Secrets:

- [Doppler pricing](https://www.doppler.com/pricing)
- [Infisical pricing](https://infisical.com/pricing)
- [1Password Environments](https://www.1password.dev/environments),
  [Environments MCP server on Cursor](https://1password.com/blog/the-1password-environments-mcp-server-is-now-on-cursor-marketplace),
  [Business price](https://costbench.com/software/secrets-management/1password-business/) *(third party)*
- [dotenvx pricing](https://dotenvx.com/pricing)

MCP gateways:

- [Composio pricing](https://composio.dev/pricing)
- [Arcade pricing](https://www.arcade.dev/pricing),
  [Smithery joins Arcade](https://www.arcade.dev/blog/smithery-joins-arcade/)
- [Docker MCP Gateway](https://github.com/docker/mcp-gateway),
  [docs](https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/)
- [Cloudflare MCP server portals](https://blog.cloudflare.com/zero-trust-mcp-server-portals/),
  [service tokens changelog](https://developers.cloudflare.com/changelog/post/2026-06-26-mcp-portal-service-tokens/)

Governance:

- [LangChain / LangSmith pricing](https://www.langchain.com/pricing)
- [HumanLayer](https://www.humanlayer.dev/)

Costs and payments:

- [Supabase pricing](https://supabase.com/pricing),
  [disk size and overage](https://supabase.com/docs/guides/platform/manage-your-usage/disk-size)
- [Functional Source License](https://fsl.software/)
- [Vercel pricing](https://vercel.com/pricing),
  [Pro plan docs](https://vercel.com/docs/plans/pro-plan),
  [per-seat breakdown](https://flexprice.io/blog/vercel-pricing-breakdown) *(third party)*
- [Resend pricing](https://resend.com/pricing)
- [Polar fees](https://polar.sh/docs/merchant-of-record/fees),
  [Paddle fees](https://www.stackscored.com/pricing/saas-billing/paddle/) *(third party)*
