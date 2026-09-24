# Landscape and SWOT

2026-09-24 · Status: RESEARCH · Companion to
[org-chatbot-gate.md](org-chatbot-gate.md)

Is Reliquary worth building, and where should it focus? This note is based
on four research passes, all checked against web sources on 2026-09-24:

- permission-aware enterprise AI;
- AI memory layers;
- group-chat agents and authorization infrastructure;
- infrastructure analogs and business model.

Claims marked *(unverified)* came only from third-party sources. Prices
change; re-check before quoting any of them.

## The short answer

**Yes, but a narrower product than the design describes.** The part of
Reliquary nobody else offers is this:

> Shared context that **people approve**, kept in an **append-only log**,
> and served to any model through a **database-enforced gate** that filters
> on **who will read the answer**.

Every product found writes memory automatically. None filters on the
audience, meaning the intersection of everyone who will see a reply, rather
than the asker alone. None is open, bring-your-own-model and cheap at once.

The other two pillars should shrink. Routines and secrets solve Andrés's
real problems, but funded tools already do both well, and neither sets
Reliquary apart.

Candidate one-liner: **"The permission layer for shared AI context.
Humans approve, the database enforces, bring any model."**

## Landscape map

| Category | Players | What they cover | What they miss |
|---|---|---|---|
| Enterprise AI search | Glean, M365 Copilot, Gemini Enterprise, ChatGPT company knowledge, Rovo, Credal, Guru | Filter each asker's results by the permissions in the source apps | Enterprise pricing (Glean reportedly has a 100-seat minimum). Closed source. Writes are not human-approved. Group-chat handling is coarse (below) |
| Team knowledge + AI | Notion AI/MCP, Dust, Onyx, Slack AI | Workspaces or spaces, agents, Slack bots | Onyx (MIT) keeps permission sync and auditing in the paid Enterprise edition. Dust's free tier is 500 credits. No approval queue |
| AI memory layers | Mem0, Zep/Graphiti, Letta, Supermemory, Cognee, LangMem | Memory for agents, SDKs, benchmarks | Written automatically. Roles and audit logs sit behind $125–$399/mo or Enterprise. Mostly one user per memory |
| Closest small-team rival | **Basic Memory** (Teams launched 2026-05-31) | Markdown, native MCP, Admin/Editor/Viewer per project, version history, $15/seat | Agents write directly with no approvals. Permissions only per project. No change feed |
| Closest enterprise rival | **Sentra** | Org memory with permissions checked for each asker, over MCP and REST | Closed source, enterprise only, no approval step mentioned |
| Big labs | **Claude Tag** (Slack, launched 2026-06-23), Claude Managed Agents memory, Claude Code Routines, ChatGPT shared projects | Channel memory, versioned stores with redaction, scheduled cloud runs | Locked to one vendor. Claude Tag uses one admin-set credential per channel, not the asker's own access. Memory is not human-approved |
| Chat agents | Lindy, Poke (acquired by Cognition), OpenClaw | Bots in Slack, iMessage and WhatsApp | OpenClaw limits *tools* per sender but not *data*. None does per-asker data gating |
| Authorization engines | OpenFGA, SpiceDB, Cerbos, Permit.io (MCP gateway) | Relationship- or policy-based checks, retrieval-filtering guides | They check one subject at a time. None ships "who in this chat may see this answer" |

**How the incumbents handle a mixed-access group chat today:**

- **Glean** "Public Mode" answers in the channel using only content that is
  widely shared across the org, and offers a private follow-up.
- **Copilot in Teams** shows the asker a preview, and the asker decides
  whether to share it. A human click, not a policy, is the gate.
- **Claude Tag** acts with credentials an admin assigned to the channel, so
  anyone who joins the channel inherits that access.
- **Everyone else** answers only the asker, or ignores the problem.

That is the gap.

## SWOT

### Strengths

- **Human approval plus an append-only history.** No competitor has an
  approval queue for agent writes. Guru's expert verification is the
  nearest analogue.
- **Access checked before retrieval, inside the database.** Row-level
  security (RLS) filters rows before the model sees anything, in the same
  transaction, with no second system to keep in sync. The hostile test
  suite makes the claim checkable, which a prompt-based guardrail never
  is.
- **The audience-aware gate design** ([org-chatbot-gate.md](org-chatbot-gate.md)).
  Nobody computes what the whole audience may see.
- **A pull change feed with a cursor.** Nobody else offers one; the nearest
  are Zep's webhooks and Basic Memory's activity feed.
- **Fits the MCP authorization spec (2026-07-28).** The spec requires a
  resource server that checks each token's audience and never passes tokens
  through, which is the shape Reliquary wants anyway.
- **Cheap stack, dogfooded, prior prototype.** CommonThread already proved
  the propose, approve and log loop.

### Weaknesses

- **Solo founder with no enterprise credentials.** No SOC 2, SSO or SCIM,
  and the operator can read every secret. Security buyers check these
  first.
- **Three pillars.** Routines and secrets are the least differentiated work
  and come first in the build order.
- **The core is copyable.** RLS on Supabase is not a moat. The defensible
  parts are the gate semantics, the hostile tests, and trust earned over
  time.
- **Cold start.** Incumbents index 100+ existing sources. Reliquary asks
  people to curate and approve context, which costs effort before it pays
  back.
- **Approval fatigue.** Reliquary only has approved "canon" memory. Without
  the automatic chat-memory tier, the queue either gets rubber-stamped or
  gets ignored.
- **Design gaps found in red-teaming:**
  - Agent tokens would query with the service role and bypass RLS unless
    per-request JWTs are minted.
  - An append-only log conflicts with erasure requests.
  - A plaintext `.env` can be read by any coding agent in that directory,
    which weakens "secrets never reach a model."
  - Routines are Claude-only.

### Opportunities

- **Teams too small for enterprise tools.** Glean's reported seat minimum,
  and roles plus audit logs sitting behind paid tiers everywhere, leave
  small teams unserved: agencies, nonprofits, communities, event crews.
- **Oversharing incidents make the pitch for you:**
  - EchoLeak (Copilot, CVE-2025-32711);
  - GeminiJack (Gemini Enterprise);
  - CW1226324 (Copilot summarised confidential-labelled mail);
  - Slack AI and Notion prompt-injection exfiltration.

  "The model can't leak what it never saw" answers a documented pain.
- **Chat channels beyond Slack.** Telegram and Discord have free, permitted
  bot APIs. Community and event organisations (the Nando case) have nobody
  serving them.
- **Be the layer other bots plug into.** OpenClaw-style assistants,
  LangGraph apps and Slack apps can all call one MCP URL for gated context.
  Frameworks become distribution rather than competition.
- **Borrow instead of build:**
  - Graphiti's valid-from/valid-to timestamps for time-aware facts;
  - Infisical (MIT) or 1Password as the secrets backend;
  - Infisical Agent Vault (research preview) as a proxy that injects
    credentials so agents never see secret values;
  - healthchecks.io as the external watchdog.
- **Open-core model.** Take Tailscale's split between control plane and
  data plane (Reliquary holds the policy and log; users bring model, keys
  and compute), but with a fully open core in the Plausible style:
  - charge per human, with agents free (as Doppler does);
  - put SSO and log retention or streaming on paid plans;
  - make the free tier 3–6 humans with unlimited agents. Tailscale Personal
    allows 6 users.

### Threats

- **Anthropic is shipping adjacent features monthly:**
  - Claude Tag for shared channel memory;
  - Managed Agents memory: immutable versions, redaction, read-only stores;
  - Routines for scheduled cloud runs;
  - shared memory in Claude Code Projects.

  Per-asker filtering and approvals are an obvious next step for them.
  Reliquary's defence is vendor neutrality and channels outside Slack.
- **Basic Memory** could add approvals and finer permissions cheaply; it
  has most of the rest.
- **Moves down-market:** Sentra, and Glean-style vendors, could come after
  small teams.
- **Bundling:** Slack AI, Rovo, Copilot Business and ChatGPT company
  knowledge come with tools teams already pay for. "Good enough" beats
  "correct."
- **Channel platform risk:**
  - The WhatsApp Groups API caps groups at 8 participants and requires an
    Official Business Account.
  - Since 2026-01-15, Meta's terms bar AI providers whose main function is
    AI. The EU exemption is still unsettled.
  - WhatsApp bills group replies per recipient, and service messages
    become billable on 2026-10-01.
  - Unofficial libraries get numbers banned.
  - Slack's Real-time Search API forbids storing its results.
- **Anthropic's terms:**
  - A hosted service may not store or route users' Claude subscription
    credentials.
  - The sanctioned path for unattended runs is `claude setup-token`, which
    can't load claude.ai connectors.
  - The design's "full `/login` on the VPS" is a grey area even for
    personal use; confirm before milestone 1 depends on it.
  - Productized, workers must be user-run with their own credentials or
    API keys. That makes bring-your-own-model a requirement, not just a
    preference.
- **Prompt injection inside the permitted scope.** RLS limits what the
  model sees, not what it does with its tools. Buyers judge the whole
  system, so the product has to limit outbound tools too.
- **Ecosystem churn.** Letta deprecated its shared blocks, OpenMemory's
  extension was archived, and Aserto shut down. A solo founder can't
  follow every shift.

## What this changes

### Build / buy / integrate

| Pillar | Decision | Why |
|---|---|---|
| Spaces, proposals, log, feed, gate | **Build** | This is the product |
| Chat-memory tier (automatic, attributed, expiring) | **Build**, small | Without it the approval queue fails in chat |
| Routines | **Build thin** (queue and run log in Postgres; any runner is a client), **buy** alerting (healthchecks.io) | It meets a real personal need, but don't productize workers |
| Secrets | **Integrate** (Infisical self-hosted or 1Password) | Reliquary adds space-scoped grants and an access log; the backend holds the values |
| Authorization engine | **Keep RLS**; store relationship tuples in Postgres | Revisit OpenFGA/SpiceDB only for objects outside Postgres |
| Channels | **Telegram or Discord first**, Slack second, WhatsApp only through an official business account | Platform rules, above |

### Suggested design changes (not yet applied to `design.md`)

1. Agent and bot calls mint a short-lived JWT per request that carries both
   identities: the agent (an RFC 8693 `act` claim) and the audience. RLS
   checks both. The service role is never used for reads.
2. Entries and captured facts carry an `audience`. Retrieval takes an
   audience, not only a space.
3. Facts get valid-from/valid-to times (Graphiti-style). Retractions are
   human-legible events with a reason.
4. Erasure by crypto-shredding: a per-entry key is deleted and a tombstone
   event is kept.
5. `secrets` becomes a grant-and-audit layer over an external backend.
6. Routines describe what they need in terms of Reliquary context, not
   Claude connectors, so any runner can execute them.

### Build order question for Andrés

Milestone 1 (routines) fixes a real pain today and should stay, but kept
thin. The riskiest assumption in the product thesis is the gate: can
audience-intersection RLS be correct, fast and understandable? Nothing in
the current order tests it until milestone 3 or later. Consider a
throwaway **gate spike** in parallel: a schema for spaces, members and
audience, plus the hostile tests from the gate doc, run against local
Supabase. It is small, and it checks the claim everything else depends
on.

## Kill or pivot signals

Stop or narrow if any of these hold:

- **Anthropic** ships per-asker or audience filtering plus approval queues
  in Claude Tag across more than Slack, *and* opens it to other models.
  (The first part is likely; the second is the question.)
- **No approvers.** Five conversations with small organisations turn up
  nobody willing to approve proposals, even with batching. That would mean
  "a human makes it true" is a founder value, not a buyer value.
- **The gate spike fails.** Intersection RLS can't meet about 200 ms p95 on
  realistic sizes, or the rules are too subtle to explain to an admin.
- **Basic Memory ships** approvals plus finer permissions. Reliquary would
  then compete on the gate alone.

## Next research steps

1. **Nando teardown.** Talk to whoever built it: stack, cost, what broke,
   whether memory was ever wrong or manipulated, how they got around
   WhatsApp limits.
2. **Five discovery conversations** with small organisations: an agency
   client, a volunteer group, an event organiser, a startup team, an AI
   Founding Table member. Test whether approvals are wanted and whether
   mixed-access groups really come up.
3. **Gate spike** (above).
4. **Anthropic terms check** for the milestone-1 worker login. Read the
   current Consumer Terms and the Claude Code legal page directly.
5. **Name check** (already an open question in the design).

## Sources

### Enterprise AI

- Glean:
  [MCP security](https://docs.glean.com/administration/platform/mcp/security),
  [Public Mode](https://docs.glean.com/administration/platform/embedded-integrations/slackbot/public-mode-glean-slack-channel),
  [human-in-the-loop](https://docs.glean.com/tools/human-in-the-loop-experience-for-tools),
  [pricing *(unverified)*](https://www.gosearch.ai/blog/glean-pricing-explained/)
- Microsoft:
  [Copilot in Teams chats](https://support.microsoft.com/en-us/office/copilot-in-teams-chats-2c613de4-cd26-4ae3-9e4b-6905d745d991),
  [EchoLeak](https://arxiv.org/abs/2509.10540),
  [CW1226324](https://www.bleepingcomputer.com/news/microsoft/microsoft-says-bug-causes-copilot-to-summarize-confidential-emails/)
- Notion:
  [custom agents](https://www.notion.com/help/custom-agents),
  [PromptArmor](https://www.promptarmor.com/resources/notion-ai-unpatched-data-exfiltration)
- Dust:
  [pricing](https://dust.tt/home/pricing),
  [access controls](https://docs.dust.tt/docs/access-controls-and-permissions)
- Onyx: [pricing](https://onyx.app/pricing)
- Slack AI:
  [PromptArmor](https://www.promptarmor.com/resources/data-exfiltration-from-slack-ai-via-indirect-prompt-injection)
- Gemini: [GeminiJack](https://noma.security/blog/geminijack-google-gemini-zero-click-vulnerability/)
- OpenAI: [ChatGPT company knowledge](https://openai.com/index/introducing-company-knowledge/)

### Memory layers

- [Mem0](https://mem0.ai/pricing)
- [Zep](https://www.getzep.com/pricing) and [Graphiti](https://github.com/getzep/graphiti)
- [Letta shared memory](https://docs.letta.com/v1-sdk/memory/shared-memory)
- [Supermemory](https://supermemory.ai/pricing/)
- [Cognee](https://www.cognee.ai/pricing)
- [Basic Memory Teams](https://basicmemory.com/blog/basic-memory-teams-launch)
- [Sentra](https://www.sentra.app/)
- [Claude Tag](https://www.anthropic.com/news/introducing-claude-tag)
- [Cloudflare Agent Memory](https://blog.cloudflare.com/introducing-agent-memory/)

### Chat channels and authorization

- WhatsApp:
  [Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups),
  [group pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/pricing/),
  [service-message pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages),
  [AI-provider pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers),
  [TechCrunch on the chatbot ban](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform)
- [Telegram bot features](https://core.telegram.org/bots/features)
- [Slack Real-time Search API](https://docs.slack.dev/apis/web-api/real-time-search-api/)
- [Tenable on Claude Tag's access model](https://www.tenable.com/blog/claude-tag-slack-access-model)
- [OpenClaw groups](https://docs.openclaw.ai/channels/groups)
- [OpenFGA RAG authorization](https://openfga.dev/docs/modeling/agents/rag-authorization)
- [AuthZed secure RAG pipelines](https://authzed.com/docs/spicedb/ops/secure-rag-pipelines)
- [Permit MCP Gateway](https://docs.permit.io/permit-mcp-gateway/overview/)
- [Supabase RAG with permissions](https://supabase.com/docs/guides/ai/rag-with-permissions)
- [MCP authorization spec 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

### Infrastructure and business model

- Tailscale:
  [pricing](https://tailscale.com/pricing),
  [grants](https://tailscale.com/kb/1324/grants),
  [Series C](https://tailscale.com/blog/series-c)
- Claude Code:
  [Routines](https://code.claude.com/docs/en/routines),
  [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance),
  [authentication](https://code.claude.com/docs/en/authentication)
- [Anthropic Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
- Infisical:
  [pricing](https://infisical.com/pricing),
  [Agent Vault](https://infisical.com/blog/agent-vault-the-open-source-credential-proxy-and-vault-for-agents)
- [Doppler pricing](https://www.doppler.com/pricing)
- [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/)
- [1Password for agentic AI](https://1password.com/solutions/agentic-ai)
- [healthchecks.io pricing](https://healthchecks.io/pricing/)
