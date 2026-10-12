// The landing page: what signed-out visitors see at `/` (signed-in people
// get Home). Kept to what is built today; later work is marked "coming".

import { appHref } from "./hosts.js";
import { html, preAlphaNote, type Raw, type Theme } from "./html.js";
import { OPERATOR, PRICING, requestAccessHref, sitePage } from "./site.js";

const cta = (where: string) => html`<div class="site-cta" aria-label="${where}">
  <a class="button primary" href="${appHref("/signin")}">Sign up</a>
  <a class="button" href="#how">See how approval works</a>
</div>`;

// The AI tools people scan for, likeliest first. Names only: logos would
// mean trademarks, scripts and assets this page doesn't have.
const clients = ["Claude", "Claude Code", "ChatGPT", "Cursor"];

const ceiling = ["Approve its own change", "Change who approves what", "Add or remove people", "Reveal a secret's value", "Export or delete a vault"];

// The hero opens with what an agent can't do (#256, direction A): every AI
// page promises what agents can do, so the ceiling is the one thing a
// visitor hasn't read elsewhere, and it is the trust argument.
const ceilingFigure = html`<figure class="hero-ceiling" aria-labelledby="ceiling-cap">
  <p class="hero-ceiling-title" id="ceiling-cap">What your agent can't do</p>
  <ul class="cant-list">
    ${ceiling.map((c) => html`<li><span class="cant-mark" aria-hidden="true">✕</span>${c}</li>`)}
  </ul>
  <figcaption class="canon-line">Enforced in the database, not the prompt. Tested on every push. <a href="/security">How security works</a></figcaption>
</figure>`;

// The product's core loop, drawn in HTML, and workable without a script
// (#256, direction B): three radios in one group hold the state, and the
// stylesheet's :has() shows the open, approved or changes-requested view.
// Approve resolves the diff into canon text, flips the badge from hollow
// Open to filled Canon and adds the log line; Request changes shows the
// note field the product shows. The radios stay in the page whatever the
// state (only their labels come and go), so the group is one Tab stop, the
// arrow keys move between them and focus never lands on nothing; the caption
// says which state the card is in, for people who can't see it change. A
// browser without :has() shows the open state, which is today's card.
// Nothing is sent anywhere: the page has no script and the card no form.
const proposalCard = html`<figure class="hero-card" aria-labelledby="hero-card-cap">
  <div class="hero-card-head">
    <span data-when="open changes"><span class="policy open badge">Open</span></span>
    <span data-when="approved"><span class="policy canon badge">Canon</span></span>
    <span class="hero-card-path">brief.md</span>
  </div>
  <p class="hero-card-meta">Proposed by <strong>Claude Code</strong> for Ana · <code>brief.md</code> is canon<span data-when="open changes"> · needs 1 approval</span></p>
  <div class="hero-diff" data-when="open changes" aria-hidden="true">
    <div class="del"><span>−</span>Deploy to: staging</div>
    <div class="add"><span>+</span>Deploy to: eu-production</div>
  </div>
  <div class="hero-diff hero-canon" data-when="approved" aria-hidden="true">
    <div><span></span>Deploy to: eu-production</div>
  </div>
  <p class="hero-log" data-when="approved" aria-hidden="true">Approved by <strong>you</strong> · just now</p>
  <div class="hero-note" data-when="changes">
    <label for="demo-note">Note for Claude Code</label>
    <textarea id="demo-note" class="note-field" rows="2" placeholder="Staging first; production after the client signs off."></textarea>
  </div>
  <fieldset class="hero-card-actions">
    <legend class="sr-only">Decide on the proposal. A demo: nothing is saved.</legend>
    <input type="radio" name="demo" id="demo-approve" value="approve" class="sr-only">
    <input type="radio" name="demo" id="demo-changes" value="changes" class="sr-only">
    <input type="radio" name="demo" id="demo-open" value="open" class="sr-only" checked>
    <span data-when="open changes"><label class="button primary" for="demo-approve">Approve</label></span>
    <span data-when="open"><label class="button" for="demo-changes">Request changes</label></span>
    <span data-when="approved changes"><label class="hero-reset" for="demo-open">Start over</label></span>
  </fieldset>
  <figcaption id="hero-card-cap" aria-live="polite">
    <span data-when="open">An agent proposes a change to canon. It lands only when a person approves. Try it: nothing is saved.</span>
    <span data-when="approved">Approved: <code>brief.md</code> now says "Deploy to: eu-production", and the log records who approved it and when.</span>
    <span data-when="changes">Changes requested: the proposal stays open, and the agent gets your note.</span>
  </figcaption>
</figure>`;

const steps: Array<[string, Raw]> = [
  [
    "Connect any AI tool with one URL",
    html`<p>Paste Reliquary's MCP (Model Context Protocol) URL into Claude, ChatGPT or Claude Code and sign in. Other MCP clients use a scoped, expiring token you can revoke.</p>`,
  ],
  [
    "Agents read and propose",
    html`<p>Open folders take notes directly. Canon folders change only when a person approves, with a quorum if you want one. Every change is in an append-only log.</p>`,
  ],
  [
    "Run with secrets, never show them",
    html`<p><code>reliquary run --env development -- npm start</code> puts variables into one process. No AI tool ever receives a value.</p><pre class="term" aria-label="A terminal: reliquary run starts the app with DATABASE_URL set, and the value is never shown">$ reliquary run --env development -- npm start
<span class="term-muted">DATABASE_URL</span> <span class="term-value" aria-hidden="true">◆◆◆◆◆◆◆◆</span><span class="sr-only">(value hidden)</span>
<span class="term-muted">1 variable into 1 process. Shown to no one.</span></pre>`,
  ],
];

const problems: Array<[Raw, Raw]> = [
  [html`Every person has their own AI memory, so the project's truth drifts.`, html`One vault of approved context that every tool and every person reads, kept current by what agents propose and people approve.`],
  [html`Agents write things nobody checked, and the next agent believes them.`, html`Agents propose. Nothing becomes canon until a person, or a quorum, approves it.`],
  [html`API keys travel by Slack and email and sit in <code>.env</code> files any agent can read.`, html`Variables live in the vault. <code>reliquary run</code> puts them into one process; no AI tool ever gets a value.`],
  [html`Bet everything on one AI vendor, and their risk becomes yours: pricing, outages, even who they're allowed to serve.`, html`Reliquary holds no model and resells no inference, so your provider is your choice. Any MCP client connects; switch when a better one comes along, and the context and the log stay.`],
];

const differentiators: Array<[string, string]> = [
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
    "Several AI tools and machines, one source of truth. Stop copying CLAUDE.md between tools and keeping .env files where any coding agent can read them. You approve your own agents' changes, or mark a folder open and let them write.",
  ],
  [
    "Small product teams",
    "Some people use Claude, some ChatGPT, some Cursor. Give everyone the same reviewed context, scoped to what they need, and keep keys out of chat messages.",
  ],
];


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
  //
  // H1 carries the claim (2026-10-11, #250, #251, #252, #255, #256 A): the
  // old H1 was a label and the mechanism only arrived in the sub-line.
  // Three synthetic ICP read-throughs of this version (agency owner, solo
  // builder, security-minded product lead) all got "propose" from the H1
  // alone. Two of three preferred the "one vault your team and every AI
  // tool share" candidate for saying what it is, one preferred this one
  // for naming the control; kept this one, with "every AI tool" in the
  // sub-line. All three found "canon" opaque while it was the eyebrow and
  // only settled at the lede's "called canon", so the eyebrow says what the
  // vault holds instead. All three found "Change the rules" vague: now
  // "Change who approves what". "Secrets stay in the vault" reads a shade
  // stronger than the FAQ's in-process caveat, so the promise section
  // stays, and the ceiling figure links to /security from the hero.
  const body = html`
<section class="hero" aria-labelledby="hero-title">
  <div class="hero-text">
    <p class="eyebrow"><span class="logo" aria-hidden="true"></span>Shared context and credentials for humans and agents</p>
    <h1 id="hero-title">Agents propose. People approve. Secrets stay in the vault.</h1>
    <p class="hero-sub">One shared vault of context and credentials for your team and every AI tool you use.</p>
    <p class="hero-lede">Your agents read the approved context, called canon, and propose changes to it. Nothing becomes canon until a person says so. People and agents alike only see what they're scoped to, and secrets stay out of the chat.</p>
    ${cta("Get started")}
    <p class="hero-works">Works with ${clients.join(", ")} and any MCP client.</p>
    <p class="hero-small">EU-hosted. Bring your own model. Open pre-alpha: sign up with your email. We're letting people in steadily as usage grows.</p>
    ${preAlphaNote()}
  </div>
  ${ceilingFigure}
</section>

<section class="site-section problem" aria-labelledby="problem-title">
  <h2 id="problem-title">The problem, and what Reliquary does about it</h2>
  <dl class="problem-rows">
    ${problems.map(([pain, fix]) => html`<div class="problem-row"><dt>${pain}</dt><dd>${fix}</dd></div>`)}
  </dl>
</section>

<section class="site-section" aria-labelledby="who-title">
  <h2 id="who-title">Who it's for</h2>
  <div class="grid-3">
    ${audiences.map(([t, d]) => html`<div class="feature"><h3>${t}</h3><p>${d}</p></div>`)}
  </div>
  <p class="not-for"><strong>What Reliquary is not:</strong> an AI model or chatbot, search over your Drive and Slack, or a memory that writes itself.</p>
</section>

<section class="site-section" id="how" aria-labelledby="how-title">
  <h2 id="how-title">How it works</h2>
  ${proposalCard}
  <ol class="steps">
    ${steps.map(([t, d]) => html`<li><h3>${t}</h3>${d}</li>`)}
  </ol>
</section>

<section class="site-section" aria-labelledby="why-title">
  <h2 id="why-title">What makes it different</h2>
  <div class="grid-2">
    ${differentiators.map(([t, d]) => html`<div class="feature"><h3>${t}</h3><p>${d}</p></div>`)}
  </div>
</section>

<section class="site-section trust" aria-labelledby="trust-title">
  <h2 id="trust-title">What we can and can't promise</h2>
  <p>Data is hosted in the EU; variable values are encrypted with a key the database never holds. No MCP tool returns a value, ever. But an agent can read what reaches its process, and we, as the operator, could technically decrypt values. <a href="/security">Read how security works</a>.</p>
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
      <p class="tier-yearly">${t.yearly || " "}</p>
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
  <p>Reliquary is an open pre-alpha: sign up with your email and create a vault. We're letting people in steadily as usage grows, so it may take a while before you can create one. Want a hand? <a href="${requestAccessHref()}">Tell us about your team</a> and the AI tools you use, and we'll set up your first vault with you.</p>
  ${cta("Get started")}
  <p class="who-builds">Reliquary is built in Barcelona by ${OPERATOR.person} of <a href="${OPERATOR.site}">Red Mage</a>. It came out of running one vault per client as a consultant, with several AI tools and no way to keep them all honest.</p>
</section>`;
  return sitePage({
    title: "Agents propose. People approve. Secrets stay in the vault.",
    description:
      "One shared vault of context and credentials for your team and every AI tool you use. Agents propose, people approve, and no AI tool ever receives a secret's value. EU-hosted.",
    path: "/",
    body,
    theme,
    home: true,
  });
}
