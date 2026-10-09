// The landing page: what signed-out visitors see at `/` (signed-in people
// get Home). Kept to what is built today; later work is marked "coming".

import { appHref } from "./hosts.js";
import { html, preAlphaNote, type Raw, type Theme } from "./html.js";
import { OPERATOR, PRICING, requestAccessHref, sitePage } from "./site.js";

const cta = (where: string) => html`<div class="site-cta" aria-label="${where}">
  <a class="button primary" href="${appHref("/signin")}">Sign up</a>
  <a class="button" href="${requestAccessHref()}">Talk to us</a>
</div>`;

// A static picture of the product's core loop, drawn in HTML: an agent's
// proposal waiting for a person. Decorative; the steps below say the same.
// Its buttons are spans, hidden from assistive tech and inert, so nothing
// on it can be focused or mistaken for a control.
const proposalCard = html`<figure class="hero-card" aria-labelledby="hero-card-cap">
  <div class="hero-card-head">
    <span class="badge info">Open</span>
    <span class="hero-card-path">brief.md</span>
    <span class="policy canon badge">Canon</span>
  </div>
  <p class="hero-card-meta">Proposed by <strong>Claude Code</strong> for Ana · needs 1 approval</p>
  <div class="hero-diff" aria-hidden="true">
    <div class="del"><span>−</span>Deploy to: staging</div>
    <div class="add"><span>+</span>Deploy to: eu-production</div>
  </div>
  <div class="hero-card-actions" aria-hidden="true" inert>
    <span class="button primary">Approve</span>
    <span class="button">Request changes</span>
  </div>
  <figcaption id="hero-card-cap">An agent proposes a change to canon. It lands only when a person approves.</figcaption>
</figure>`;

const steps: Array<[string, Raw]> = [
  [
    "Connect any AI tool with one URL",
    html`Paste Reliquary's MCP (Model Context Protocol) URL into Claude, ChatGPT or Claude Code and sign in. Other MCP clients use a scoped, expiring token you can revoke.`,
  ],
  [
    "Agents read and propose",
    html`Open folders take notes directly. Canon folders change only when a person approves, with a quorum if you want one. Every change is in an append-only log.`,
  ],
  [
    "Run with secrets, never show them",
    html`<code>reliquary run --env development -- npm start</code> puts variables into one process. No AI tool ever receives a value.`,
  ],
];

const differentiators: Array<[string, string]> = [
  [
    "People sign off on what becomes fact",
    "Agents from any vendor read the same approved context over MCP and propose changes. A person, or a quorum of people, approves before anything becomes canon.",
  ],
  [
    "The limits live in the database",
    "An agent acts as its person, minus a ceiling: it can't approve, change the rules, add people or reveal a secret. Postgres row-level security enforces it, and hostile tests check it on every push.",
  ],
  [
    "Context and credentials in one vault",
    "Memory tools don't hold secrets and secret managers don't hold context. A project needs both, with one invite and one access log.",
  ],
  [
    "Never locked into one AI vendor",
    "Use whichever AI is best for the job today, and switch when a better one comes along. Reliquary holds no model of its own and resells no inference, so your provider is always your choice, not ours. Data sits in Frankfurt.",
  ],
];

const audiences: Array<[string, string]> = [
  [
    "Agencies and consultancies",
    "One vault per client: everyone on your team only sees what they're scoped to, approvals on anything that becomes fact, credentials used without being pasted, and one log to show the client.",
  ],
  [
    "Solo builders",
    "Several AI tools and machines, one source of truth. Stop copying CLAUDE.md between tools and keeping .env files where any coding agent can read them.",
  ],
  [
    "Small product teams",
    "Some people use Claude, some ChatGPT, some Cursor. Give everyone the same reviewed context, scoped to what they need, and keep keys out of chat messages.",
  ],
];

const ceiling = ["Approve its own change", "Change the rules", "Add or remove people", "Reveal a secret's value", "Export or delete a vault"];

const faq: Array<[string, Raw]> = [
  ["Is Reliquary an AI model or a chatbot?", html`No. Reliquary runs no model. It holds context and credentials, and the AI tools you already use connect to it over MCP.`],
  ["Do I need to host anything?", html`No. Reliquary is hosted in the EU, and nothing depends on your machine staying on.`],
  ["Which AI provider sees my data?", html`Only the ones you connect, and only what their agent reads through your account. They process it under your own agreement with them. See <a href="/subprocessors">sub-processors</a>.`],
  ["Is it for regulated data?", html`Not yet. Reliquary has no SOC 2 report or SSO today. Don't store health or payment card data in it.`],
  ["Can my agents see my secrets?", html`Not through Reliquary: no MCP tool returns a variable's value. <code>reliquary run</code> puts values into one process, and an agent that can run commands in that process could read them there. The <a href="/security">security page</a> says what that means.`],
  ["How is it different from Claude Projects or ChatGPT memory?", html`It works across vendors, people approve changes before they become fact, and it holds credentials as well as context.`],
  ["Can I leave?", html`Yes. An owner can export a whole vault as plain markdown files at any time, and delete it for good.`],
];

export function landing(theme: Theme): string {
  // Headline "The canon for humans and agents." (2026-09-29): kept. It's
  // distinctive and the H1 shouldn't just repeat what "How it works"
  // explains a few scrolls down. But three independent read-throughs
  // (synthetic ICP reader-check, 2026-09-30) all misread "canon" as a
  // wiki/fandom term until several sections in, because the sub-line never
  // actually named it. Fixed narrowly: the sub-line now says "canon"
  // itself instead of leaving the reader to connect the two, and "Who it's
  // for" (previously after "What makes it different") moved up next to the
  // Problem section, since all three reads recognized themselves in their
  // own audience card and had to scroll past two sections to reach it.
  //
  // Vendor lock-in, stated as a problem and a differentiator (2026-09-30,
  // owner's call): the earlier copy leaned on "works with Claude, ChatGPT,
  // Cursor" three times as if listing vendors were the differentiator on
  // its own -- research says that's close to table stakes now. The actual
  // argument is sharper than the vendor list: betting on one AI vendor
  // means inheriting their risk (pricing, outages, who they're allowed to
  // serve), and the fix is being able to switch, not just being told the
  // product happens to work with several tools today.
  const body = html`
<section class="hero" aria-labelledby="hero-title">
  <div class="hero-text">
    <p class="eyebrow"><span class="logo" aria-hidden="true"></span>Shared context and credentials for AI teams</p>
    <h1 id="hero-title">The canon for humans and agents.</h1>
    <p class="hero-sub">Your agents propose changes to canon. You approve them.</p>
    <p class="hero-lede">One shared vault of context and credentials for your team and every AI tool you use: Claude, ChatGPT, Cursor, Claude Code and more. People and agents alike only see what they're scoped to. Secrets stay out of the chat.</p>
    ${cta("Get started")}
    <p class="hero-small">EU-hosted. Bring your own model. Open pre-alpha: sign in with your email to start. Want help setting up? Tell us about your team.</p>
    ${preAlphaNote()}
  </div>
  ${proposalCard}
</section>

<section class="site-section problem" aria-labelledby="problem-title">
  <h2 id="problem-title">The problem</h2>
  <ul class="problem-list">
    <li>Every person has their own AI memory, so the project's truth drifts.</li>
    <li>Agents write things nobody checked, and the next agent believes them.</li>
    <li>API keys travel by email and sit in <code>.env</code> files any agent can read.</li>
    <li>Bet everything on one AI vendor, and their risk becomes yours: pricing, outages, even who they're allowed to serve.</li>
  </ul>
</section>

<section class="site-section" aria-labelledby="who-title">
  <h2 id="who-title">Who it's for</h2>
  <div class="grid-3">
    ${audiences.map(([t, d]) => html`<div class="feature"><h3>${t}</h3><p>${d}</p></div>`)}
  </div>
  <p class="not-for"><strong>What Reliquary is not:</strong> an AI model or chatbot, search over your Drive and Slack, or a memory that writes itself.</p>
  <p class="muted small">Works with Claude, Claude Code, ChatGPT, Cursor and any MCP client. For client work, invites, credential requests and client guests are coming.</p>
</section>

<section class="site-section" id="how" aria-labelledby="how-title">
  <h2 id="how-title">How it works</h2>
  <ol class="steps">
    ${steps.map(([t, d]) => html`<li><h3>${t}</h3><p>${d}</p></li>`)}
  </ol>
</section>

<section class="site-section" aria-labelledby="why-title">
  <h2 id="why-title">What makes it different</h2>
  <div class="grid-2">
    ${differentiators.map(([t, d]) => html`<div class="feature"><h3>${t}</h3><p>${d}</p></div>`)}
  </div>
</section>

<section class="site-section trust" aria-labelledby="trust-title">
  <h2 id="trust-title">What your agent can't do</h2>
  <ul class="cant-list">
    ${ceiling.map((c) => html`<li><span class="cant-mark" aria-hidden="true">✕</span>${c}</li>`)}
  </ul>
  <p>Enforced in the database, not the prompt, and tested on every push. Data is hosted in the EU; variable values are encrypted with a key the database never holds. We say plainly what we can't promise: an agent can read what reaches its process, and we, as the operator, could technically decrypt values.</p>
  <p><a href="/security">Read how security works</a></p>
</section>

${PRICING.show
    ? html`<section class="site-section" id="pricing" aria-labelledby="pricing-title">
  <h2 id="pricing-title">Pricing</h2>
  <p class="callout success beta-banner"><strong>${PRICING.banner}.</strong> ${PRICING.note}</p>
  <ul class="tiers">
    ${PRICING.tiers.map(
      (t) => html`<li class="tier${t.badge ? " tier-highlight" : ""}">
      <h3>${t.name}${t.badge ? html` <span class="badge">${t.badge}</span>` : ""}</h3>
      <p class="tier-for">${t.for}</p>
      <p class="tier-price"><span class="amount">${t.price}</span>${t.period ? html` <span class="per">${t.period}</span>` : ""}</p>
      <p class="tier-yearly">${t.yearly || " "}</p>
      <ul>${t.features.map((f) => html`<li>${f}</li>`)}</ul>
    </li>`,
    )}
  </ul>
  <p class="muted small">${PRICING.everyPlan}</p>
</section>`
    : ""}

<section class="site-section" id="faq" aria-labelledby="faq-title">
  <h2 id="faq-title">Questions</h2>
  <div class="faq">
    ${faq.map(([q, a]) => html`<details><summary>${q}</summary><p>${a}</p></details>`)}
  </div>
</section>

<section class="site-section closing" aria-labelledby="closing-title">
  <h2 id="closing-title">Try it on your next project</h2>
  <p>Reliquary is an open pre-alpha: sign in with your email and create a vault. New accounts a day are limited while we grow, so if today's are taken, come back tomorrow. Want a hand? Tell us about your team and the AI tools you use, and we'll set up your first vault with you.</p>
  ${cta("Get started")}
</section>`;
  return sitePage({
    title: "The canon for humans and agents.",
    description:
      "One shared vault of context and credentials for your team and every AI tool you use. Agents propose, people approve, secrets stay out of the chat. EU-hosted.",
    path: "/",
    body,
    theme,
    home: true,
  });
}
