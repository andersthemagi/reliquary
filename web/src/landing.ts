// The landing page: what signed-out visitors see at `/` (signed-in people
// get Home). Kept to what is built today. It brings its own frame (the
// inverted bands carry the nav and the footer), so sitePage renders none.

import { appHref } from "./hosts.js";
import { footerLinks, html, preAlphaNote, raw, stageBadge, versionLink, type Raw, type Theme } from "./html.js";
import { OPERATOR, PRICING, requestAccessHref, siteNav, sitePage } from "./site.js";

const cta = (where: string) => html`<div class="site-cta" aria-label="${where}">
  <a class="button primary" href="${appHref("/signin")}">Sign up</a>
  <a class="button" href="#how">See how approval works</a>
</div>`;

// The AI tools people scan for, likeliest first. Names only: logos would
// mean trademarks, scripts and assets this page doesn't have.
const clients = ["Claude", "Claude Code", "ChatGPT", "Cursor"];

const ceiling = ["Approve its own change", "Change who approves what", "Add or remove people", "Reveal a secret's value", "Export or delete a vault"];

// The mark: the logo, masked from /logo.svg so it takes the band's brand
// colour, as the first band's picture and, smaller, the closing's. It is
// the one shape every small diamond on the page descends from.
const mark = html`<div class="p-mark" aria-hidden="true"></div>`;

// The rail: the mark's silhouette repeats down the left margin, hollow at the top and
// filling as the reader passes the approval sections (scroll-driven in the
// stylesheet, static where that isn't supported).
const rail = html`<div class="p-rail" aria-hidden="true">${raw("<i></i>".repeat(14))}</div>`;

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
    html`<p><code>reliquary run --env development -- npm start</code> puts variables into one process. No AI tool is ever handed a value; only the process you start sees it.</p>`,
  ],
];

// The run, drawn: the variable's name shows, its value is a row of filled
// diamonds, a value nobody reads.
const terminal = html`<pre class="term" aria-label="A terminal: reliquary run starts the app with DATABASE_URL set, and the value is never shown">$ reliquary run --env development -- npm start
<span class="term-muted">DATABASE_URL</span> <span class="term-value" aria-hidden="true">◆◆◆◆◆◆◆◆</span><span class="sr-only">(value hidden)</span>
<span class="term-muted">1 variable into 1 process. Shown to no one.</span></pre>`;

// An example of the append-only log, with invented names; the caption says
// so in visible text. Hollow marks are agents writing, filled are people.
const logLines: Array<[boolean, string, string]> = [
  [true, "Claude Code", "proposed a change to brief.md for Ana"],
  [false, "Ana", "approved brief.md, now canon"],
  [true, "Cursor", "wrote notes/standup.md in an open folder"],
  [false, "Marc", "added DATABASE_URL to development"],
  [false, "reliquary run", "put 1 variable into 1 process for Marc"],
  [true, "ChatGPT", "proposed a change to onboarding.md for Steph"],
  [false, "Steph", "requested changes on onboarding.md"],
  [false, "Ana", "exported the vault as markdown"],
];

const problems: Array<[Raw, Raw]> = [
  [html`Every person and every tool has its own AI memory, so three people get three versions of the project.`, html`One vault of approved context that every tool and every person reads, kept current by what agents propose and people approve.`],
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
  // Reader-check of the poster (2026-10-11, three synthetic ICP readers):
  // all three got the mechanism from the first band alone and found the
  // framed drawings honest because their captions say what they are; the
  // one overclaim all three found was the absolute "never receives a
  // value" against the FAQ's own caveat, so step 3 now says who does see
  // it, and the promise names where the key is held.
  //
  // The poster (2026-10-11, owner's call after the copy pass of #276 read
  // as "barebones"): one typeface at two extremes, 200 for what is open and
  // 800 for what is canon, hairlines, no cards, the diamond as the only
  // picture. The first and last screens are bands inverted against the
  // page; the mark, big, is the first band's picture (it replaced a field
  // of diamonds that read as a dot grid, not as a brand) and its silhouette
  // repeats down the margin as a rail that fills with scroll.
  // Built with the impeccable process: a concept roll (seed 19e81c4a), two
  // review rounds, and every finding closed;
  // the mock and its captures lived in /tmp, not the repo.
  //
  // Copy history, kept because the words didn't change: the H1 states the
  // mechanism (#250) after three synthetic ICP read-throughs on 2026-10-11
  // all got "propose" from it alone and found "canon" opaque until the lede
  // names it; "Change the rules" was vague to all three and is "Change who
  // approves what". The works-with line sits under the buttons, said once
  // (#251); the problem is a ledger of pains and fixes (#252); the closing
  // says who builds it (#255). Vendor lock-in stays a pain and a
  // differentiator (2026-09-30, owner's call).
  const path = "/";
  const body = html`${rail}
<header class="p-inv p-fold">
  <div class="p-wrap p-top">
    <a class="wordmark" href="/" aria-label="Reliquary by Red Mage, home"><span class="logo" aria-hidden="true"></span>Reliquary</a>
    ${stageBadge()}
    ${siteNav(path)}
    <a class="button site-signin" href="${appHref("/signin")}">Sign in</a>
  </div>
  <section class="p-wrap p-fold-body" aria-labelledby="hero-title">
    <h1 class="p-h1 p-fold-head" id="hero-title"><span class="p-open">Agents propose.</span><span class="p-canon">People approve.</span><span class="p-sealed">Secrets stay in the vault.</span></h1>
    <div class="p-fold-text">
      <p class="p-sub">One shared vault of context and credentials for your team and every AI tool you use.</p>
      <p class="p-lede">Your agents read the approved context, called canon, and propose changes to it. Nothing becomes canon until a person says so. People and agents alike only see what they're scoped to, and secrets stay out of the chat.</p>
      ${cta("Get started")}
      <p class="p-works">Works with ${clients.map((c, i) => html`${i ? ", " : ""}<strong>${c}</strong>`)} and any MCP client.</p>
      <p class="p-small">EU-hosted. Bring your own model. Open pre-alpha: sign up with your email. We're letting people in steadily as usage grows.</p>
      ${preAlphaNote()}
    </div>
    ${mark}
  </section>
</header>

<main id="main" class="p-wrap">

<section class="p-sec" aria-labelledby="ceiling-title">
  <h2 id="ceiling-title">What your agent can't do</h2>
  <ul class="p-ceiling">
    ${ceiling.map((c) => html`<li><span class="p-x" aria-hidden="true"></span>${c}</li>`)}
  </ul>
  <p class="p-note">Enforced in the database, not the prompt. Tested on every push. <a href="/security">How security works</a></p>
</section>

<section class="p-sec" aria-labelledby="problem-title">
  <h2 id="problem-title">The problem, and what Reliquary does about it</h2>
  <div class="p-ledger-head" aria-hidden="true"><span>Today</span><span>With Reliquary</span></div>
  <dl class="p-ledger">
    ${problems.map(([pain, fix]) => html`<div><dt>${pain}</dt><dd>${fix}</dd></div>`)}
  </dl>
</section>

<section class="p-sec" aria-labelledby="who-title">
  <h2 id="who-title">Who it's for</h2>
  <div class="p-rows">
    ${audiences.map(([t, d]) => html`<div><h3>${t}</h3><p>${d}</p></div>`)}
  </div>
  <p class="p-not"><strong>What Reliquary is not:</strong> an AI model or chatbot, search over your Drive and Slack, or a memory that writes itself.</p>
</section>

<section class="p-sec" id="how" aria-labelledby="how-title">
  <h2 id="how-title">How it works</h2>
  <div class="p-frames">
    <figure class="p-frame" aria-labelledby="frame-review-cap">
      <div class="p-frame-art">${proposalCard}</div>
      <figcaption id="frame-review-cap">A drawing standing in for a screenshot of the Review page in a demo vault.</figcaption>
    </figure>
    <figure class="p-frame" aria-labelledby="frame-term-cap">
      <div class="p-frame-art">${terminal}</div>
      <figcaption id="frame-term-cap">A drawing standing in for a screenshot of a terminal run in a demo vault. The variable's name is shown; its value reaches one process and no one else.</figcaption>
    </figure>
  </div>
  <ol class="p-steps">
    ${steps.map(([t, d]) => html`<li><h3>${t}</h3>${d}</li>`)}
  </ol>
  <div class="p-log" aria-label="An example of the append-only activity log">
    <p class="p-log-cap">The log, append-only. An example, with invented names.</p>
    <div class="p-log-track">
      ${logLines.map(([open, who, what]) => html`<span${open ? raw(' class="p-o"') : ""}><b>${who}</b> ${what}</span>`)}
    </div>
  </div>
</section>

<section class="p-sec" aria-labelledby="why-title">
  <h2 id="why-title">What makes it different</h2>
  <div class="p-rows">
    ${differentiators.map(([t, d]) => html`<div><h3>${t}</h3><p>${d}</p></div>`)}
  </div>
</section>

<section class="p-sec" aria-labelledby="trust-title">
  <h2 id="trust-title" class="p-light">What we can and can't promise</h2>
  <p class="p-quote">Data is hosted in the EU; variable values are encrypted with a key held by the app, not the database. <strong>No MCP tool returns a value, ever.</strong> But an agent can read what reaches its process, and we, as the operator, could technically decrypt values. <a href="/security">Read how security works</a>.</p>
</section>

${PRICING.show
    ? html`<section class="p-sec" id="pricing" aria-labelledby="pricing-title">
  <h2 id="pricing-title">Pricing</h2>
  <p class="p-beta"><span><strong>${PRICING.banner}.</strong> ${PRICING.note}</span></p>
  <ul class="p-tiers">
    ${PRICING.tiers.map(
      (t) => html`<li>
      <h3>${t.name}${t.badge ? html` <span class="badge">${t.badge}</span>` : ""}</h3>
      <p class="tier-for">${t.for}</p>
      <p class="tier-price"><span class="amount">${t.price}</span>${t.period ? html` <span class="per">${t.period}</span>` : ""}</p>
      ${t.yearly ? html`<p class="tier-yearly">${t.yearly}</p>` : ""}
      <ul>${t.features.map((f) => html`<li>${f}</li>`)}</ul>
    </li>`,
    )}
  </ul>
  <p class="p-tiers-note">${PRICING.everyPlan}</p>
</section>`
    : ""}

<section class="p-sec" id="faq" aria-labelledby="faq-title">
  <h2 id="faq-title">Questions</h2>
  <div class="faq">
    ${faq.map(([q, a]) => html`<details><summary>${q}</summary><p>${a}</p></details>`)}
  </div>
</section>

</main>

<footer class="p-inv p-fold p-close">
  <section class="p-wrap p-fold-body" aria-labelledby="closing-title">
    <h2 class="p-close-h2 p-fold-head" id="closing-title"><b>Try it on</b> your next project.</h2>
    <div class="p-fold-text">
      <p class="p-lede">Reliquary is an open pre-alpha: sign up with your email and create a vault. We're letting people in steadily as usage grows, so it may take a while before you can create one. Want a hand? <a href="${requestAccessHref()}">Tell us about your team</a> and the AI tools you use, and we'll set up your first vault with you.</p>
      ${cta("Get started")}
      <p class="who-builds">Reliquary is built in Barcelona by ${OPERATOR.person} of <a href="${OPERATOR.site}">Red Mage</a>. It came out of running one vault per client as a consultant, with several AI tools and no way to keep them all honest.</p>
    </div>
    ${mark}
  </section>
  <div class="p-wrap p-footer">
    <span class="site-footer-brand"><span class="logo" aria-hidden="true"></span>${OPERATOR.brand}</span>
    ${footerLinks()}
    <a href="${requestAccessHref()}">Contact</a>
    ${versionLink()}
  </div>
</footer>`;
  return sitePage({
    title: "Agents propose. People approve. Secrets stay in the vault.",
    description:
      "One shared vault of context and credentials for your team and every AI tool you use. Agents propose changes to canon, people approve them, and no AI tool ever sees a secret's value. EU-hosted.",
    path,
    body,
    theme,
    home: true,
    frame: "poster",
  });
}
