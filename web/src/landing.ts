// The landing page: what signed-out visitors see at `/` (signed-in people
// get Home). Kept to what is built today. It brings its own frame (the
// inverted bands carry the nav and the footer), so sitePage renders none.

import { appHref } from "./hosts.js";
import { footerLinks, html, alphaNote, raw, stageBadge, versionLink, type Raw, type Theme } from "./html.js";
import { OPERATOR, PRICING, requestAccessHref, siteNav, sitePage } from "./site.js";

// One filled button: the secondary is a link, so the primary reads as the
// primary (the 2026-10-11 review: two bordered buttons of equal weight
// made Sign up look like the second choice).
const cta = (where: string) => html`<div class="site-cta" aria-label="${where}">
  <a class="button primary" href="${appHref("/signin")}">Join the alpha test</a>
  <a class="site-cta-link" href="#how">See how it works</a>
</div>`;

// The AI tools people scan for, likeliest first, each with its mark where
// one is published under CC0 (simple-icons; Claude, Cursor and MCP are).
// OpenAI and Microsoft publish no reusable mark, so ChatGPT and VS Code are
// names alone. Claude Code isn't listed: naming Claude says it. The
// marks are inline paths in the band's own colour: nothing loads from
// elsewhere, and the names stay for anyone who can't see them. They are
// the hub's left side, so the page names each tool once.
const icon = (d: string) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${d}"/></svg>`);
const marks = {
  claude: icon("m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"),
  cursor: icon("M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"),
  mcp: icon("M13.85 0a4.16 4.16 0 0 0-2.95 1.217L1.456 10.66a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l9.442-9.442a2.49 2.49 0 0 1 3.541 0 2.49 2.49 0 0 1 0 3.541L8.59 12.97l-.1.1a.835.835 0 0 0 0 1.18.835.835 0 0 0 1.18 0l.1-.098 7.03-7.034a2.49 2.49 0 0 1 3.542 0l.049.05a2.49 2.49 0 0 1 0 3.54l-8.54 8.54a1.96 1.96 0 0 0 0 2.755l1.753 1.753a.835.835 0 0 0 1.18 0 .835.835 0 0 0 0-1.18l-1.753-1.753a.266.266 0 0 1 0-.394l8.54-8.54a4.185 4.185 0 0 0 0-5.9l-.05-.05a4.16 4.16 0 0 0-2.95-1.218c-.2 0-.401.02-.6.048a4.17 4.17 0 0 0-1.17-3.552A4.16 4.16 0 0 0 13.85 0m0 3.333a.84.84 0 0 0-.59.245L6.275 10.56a4.186 4.186 0 0 0 0 5.902 4.186 4.186 0 0 0 5.902 0L19.16 9.48a.835.835 0 0 0 0-1.18.835.835 0 0 0-1.18 0l-6.985 6.984a2.49 2.49 0 0 1-3.54 0 2.49 2.49 0 0 1 0-3.54l6.983-6.985a.835.835 0 0 0 0-1.18.84.84 0 0 0-.59-.245"),
};
const clients: Array<[string, Raw | null]> = [["Claude", marks.claude], ["ChatGPT", null], ["Cursor", marks.cursor], ["VS Code", null], ["any MCP client", marks.mcp]];
// The hub: what Reliquary is, drawn. AI tools on one side, the people on
// the other, the vault between them with the mark in it. Hollow diamonds
// sit on the tools' side (they propose), filled on the people's (they
// approve). HTML and CSS, so it reflows on a phone: tools above, people
// below, the links turned vertical. The key under it is the legend for
// every diamond on the page.
const hub = html`<figure class="p-hub" aria-labelledby="hub-cap">
  <ul class="p-hub-side p-hub-tools" aria-label="AI tools">
    ${clients.map(([name, mark]) => html`<li>${mark ?? ""}${name}</li>`)}
  </ul>
  <div class="p-hub-link p-hub-propose" aria-hidden="true"><i></i><span>propose</span></div>
  <div class="p-hub-vault"><span class="p-hub-mark" aria-hidden="true"></span><strong>One vault</strong><span>canon, proposals and sealed secrets</span></div>
  <div class="p-hub-link p-hub-approve" aria-hidden="true"><i></i><span>approve</span></div>
  <ul class="p-hub-side p-hub-people" aria-label="People">
    <li>You</li><li>Your team</li><li>The client</li>
  </ul>
  <figcaption id="hub-cap">
    <ul class="p-key" aria-label="The three states of everything in a vault">
      <li class="p-key-open"><strong>Proposed.</strong> An agent wrote it. Nobody has said yes.</li>
      <li class="p-key-canon"><strong>Canon.</strong> A person approved it, so every tool treats it as true.</li>
      <li class="p-key-sealed"><strong>Sealed.</strong> A secret your tools can use and never see.</li>
    </ul>
  </figcaption>
</figure>`;

const ceiling = ["Approve any change", "Change who approves what", "Add or remove people", "Reveal a secret's value", "Export or delete a vault"];

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
// arrow keys move between them and focus never lands on nothing. Each radio
// carries its own name and points at its state's caption line, because its
// visible label may be hidden and a live region whose children CSS shows and
// hides is announced unreliably; a screen reader reads the result as the
// arrow key checks the radio. A
// browser without :has() shows the open state, which is today's card.
// Nothing is sent anywhere: the page has no script and the card no form.
const proposalCard = html`<figure class="hero-card" aria-labelledby="hero-card-cap">
  <div class="hero-card-head">
    <span data-when="open changes"><span class="policy open badge">Open</span></span>
    <span data-when="approved"><span class="policy canon badge">Canon</span></span>
    <span class="hero-card-path">brief.md</span>
  </div>
  <p class="hero-card-meta">Proposed by <strong>your agent</strong> · <code>brief.md</code> is canon<span data-when="open changes"> · needs 1 approval</span></p>
  <div class="hero-diff" data-when="open changes" aria-hidden="true">
    <div class="del"><span>−</span>Deploy to: staging</div>
    <div class="add"><span>+</span>Deploy to: eu-production</div>
  </div>
  <div class="hero-diff hero-canon" data-when="approved" aria-hidden="true">
    <div><span></span>Deploy to: eu-production</div>
  </div>
  <p class="hero-log" data-when="approved" aria-hidden="true">Approved by <strong>you</strong> · just now</p>
  <div class="hero-note" data-when="changes">
    <label for="demo-note">Note for your agent</label>
    <textarea id="demo-note" class="note-field" rows="2" placeholder="Staging first; production after the client signs off."></textarea>
  </div>
  <fieldset class="hero-card-actions">
    <legend class="sr-only">Decide on the proposal. A demo: nothing is saved.</legend>
    <input type="radio" name="demo" id="demo-approve" value="approve" class="sr-only" aria-label="Approve" aria-describedby="cap-approved">
    <input type="radio" name="demo" id="demo-changes" value="changes" class="sr-only" aria-label="Request changes" aria-describedby="cap-changes">
    <input type="radio" name="demo" id="demo-open" value="open" class="sr-only" aria-label="Start over" aria-describedby="cap-open" checked>
    <span data-when="open changes"><label class="button primary" for="demo-approve">Approve</label></span>
    <span data-when="open"><label class="button" for="demo-changes">Request changes</label></span>
    <span data-when="approved changes"><label class="hero-reset" for="demo-open">Start over</label></span>
  </fieldset>
  <figcaption id="hero-card-cap">
    <span id="cap-open" data-when="open">An agent proposes a change to canon. It lands only when a person approves. Try it: nothing is saved.</span>
    <span id="cap-approved" data-when="approved">Approved: <code>brief.md</code> now says "Deploy to: eu-production", and the log records who approved it and when.</span>
    <span id="cap-changes" data-when="changes">Changes requested: the proposal stays open, and the agent gets your note.</span>
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

// An example of the append-only log; the caption says so in visible text.
// Roles, not names: a first name reads as a real person. Hollow marks are
// agents writing, filled are people.
const logLines: Array<[boolean, string, string]> = [
  [true, "Your agent", "proposed a change to brief.md"],
  [false, "You", "approved brief.md, now canon"],
  [true, "A teammate's agent", "wrote notes/standup.md in an open folder"],
  [false, "A teammate", "added DATABASE_URL to development"],
  [false, "reliquary run", "put 1 variable into 1 process for a teammate"],
  [true, "Another agent", "proposed a change to onboarding.md"],
  [false, "A teammate", "requested changes on onboarding.md"],
  [false, "You", "exported the vault as markdown"],
];

// Why Reliquary: the six reasons, each one something the code does today.
const why: Array<[string, Raw]> = [
  ["Every AI tool, one vault", html`Claude, ChatGPT, Cursor, VS Code and any MCP client read the same context. Reliquary holds no model, so switching tools loses nothing.`],
  ["Built for agents and people together", html`Agents read, take notes and propose. People review, approve and talk it through in threads. Every change lands in one append-only log.`],
  ["Secrets stay secret", html`No MCP tool, log line or error message returns a value. <code>reliquary run</code> puts it into one process and nowhere else.`],
  ["Guarded by the database", html`Every permission is a Postgres row-level security rule with a test that tries to break it on every push. A prompt can't talk its way past it.`],
  ["Source available", html`The code is public. Read it, run it, self-host it for free. Each release turns Apache 2.0 two years on, and the CLI is MIT.`],
  ["Yours to take with you", html`Export a whole vault as plain markdown any time, or delete it for good. No lock-in to us or to any AI vendor.`],
];

const problems: Array<[Raw, Raw]> = [
  [html`Every person and every tool has its own AI memory, so three people get three versions of the project.`, html`One vault of approved context that every tool and every person reads, kept current by what agents propose and people approve.`],
  [html`Agents write things nobody checked, and the next agent believes them.`, html`Agents propose. Nothing becomes canon until a person, or a quorum, approves it.`],
  [html`API keys travel by Slack and email and sit in <code>.env</code> files any agent can read.`, html`Variables live in the vault. <code>reliquary run</code> puts them into one process; no AI tool ever gets a value.`],
  [html`Every AI vendor wants to be the one place your context lives, and your team already uses three of them.`, html`Built for teams on different systems: Reliquary holds no model and takes any MCP client. Use Claude today and something better tomorrow; the context, the approvals and the log stay, and an owner can export it all as plain markdown at any time.`],
];

// Teams first: the people who say this out loud (2026-10-11 research) run
// Claude Code or Cursor together at five to twenty people. Agencies are a
// segment to test, so they stay second with their own reason.
const audiences: Array<[string, string]> = [
  [
    "Teams on several AI tools",
    "Some people use Claude, some ChatGPT, some Cursor, and every CLAUDE.md and rules file drifts on its own. Give everyone the same reviewed context, scoped to what they need, and keep keys out of chat messages.",
  ],
  [
    "Agencies and consultancies",
    "One vault per client: everyone on your team only sees what they're scoped to, approvals on anything that becomes fact, credentials used without being pasted, and one log to show the client.",
  ],
  [
    "Solo builders",
    "Several AI tools and machines, one source of truth. Stop copying CLAUDE.md between tools and keeping .env files where any coding agent can read them. You approve your own agents' changes, or mark a folder open and let them write.",
  ],
];


const faq: Array<[string, Raw]> = [
  ["Is Reliquary an AI model or a chatbot?", html`No. Reliquary runs no model, doesn't search your Drive or Slack, and is not a memory that writes itself. It holds context and credentials, and the AI tools you already use connect to it over MCP.`],
  ["What will it cost after the alpha?", html`Free stays free during the alpha. The plan is paid vaults for teams that need more room, ways to support the project, and enough to keep the lights on. Nothing is billed today, you'll hear from us well before anything is, and self-hosting stays free.`],
  ["Is it open source?", html`The code is public. The server is under the Functional Source License: run it yourself for any purpose, except offering it to others as a competing service, and each release becomes Apache 2.0 two years on. The CLI is MIT. <a href="/docs/how-to/self-host">Self-host Reliquary</a>.`],
  ["How do I move an existing .env and CLAUDE.md in?", html`Paste the <code>.env</code> or send it with <code>reliquary env push</code>, then run the project with <code>reliquary run</code> and retire the file: <a href="/docs/how-to/move-env-into-vault">Move a .env into a vault</a>. Put <code>CLAUDE.md</code> and your rules files in the vault as canon and point each tool at the vault: <a href="/docs/how-to/connect-claude-code">Connect Claude Code</a>.`],
  ["How is one client's agent kept out of another client's vault?", html`Give each client their own vault and connect the agent to that vault only; the database refuses everything else, and a hostile test checks it on every push. <a href="/docs/how-to/keep-client-work-separate">Keep client work separate</a>.`],
  ["Do I need to host anything?", html`No. Reliquary is hosted for you, and nothing depends on your machine staying on. If you'd rather run it on your own server, you can: <a href="/docs/how-to/self-host">Self-host Reliquary</a>.`],
  ["Which AI provider sees my data?", html`Only the ones you connect, and only what their agent reads through your account. They process it under your own agreement with them. See <a href="/subprocessors">sub-processors</a>.`],
  ["Is it for regulated data?", html`Not yet. Reliquary has no SOC 2 report or SSO today. Don't store health or payment card data in it.`],
  ["Can my agents see my secrets?", html`Not through Reliquary: no MCP tool returns a variable's value, ever. <code>reliquary run</code> puts values into one process, and an agent that can run commands in that process could read them there. Values are encrypted with a key held by the app, not the database, so we, as the operator, could technically decrypt them. The <a href="/security">security page</a> says what that means.`],
  ["How is it different from Claude Projects or ChatGPT memory?", html`It works across vendors, people approve changes before they become fact, and it holds credentials as well as context.`],
  ["Can I leave?", html`Yes. An owner can export a whole vault as plain markdown files at any time, delete it for good, or move it to a self-hosted Reliquary.`],
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
    <h1 class="p-h1 p-fold-head" id="hero-title"><span class="p-open">A secure second brain</span><span class="p-canon">for people and their agents.</span></h1>
    <div class="p-fold-text">
      <p class="p-lede">Dead simple context to share across any AI tool. Claude, ChatGPT and Cursor read the same vault, agents propose, people approve, and secrets never reach a model.</p>
      ${cta("Get started")}
      <p class="p-small">Works with any MCP client. The code is public and it's free for everyone during the alpha. Self-host it if you'd rather.</p>
    </div>
    ${hub}
  </section>
</header>

<main id="main" class="p-wrap">

<section class="p-sec" id="why" aria-labelledby="why-title">
  <h2 id="why-title">Why Reliquary</h2>
  <div class="p-why">
    ${why.map(([t, d]) => html`<div><h3>${t}</h3><p>${d}</p></div>`)}
  </div>
</section>

<section class="p-sec" aria-labelledby="ceiling-title">
  <h2 id="ceiling-title">What your agent can't do</h2>
  <ul class="p-ceiling">
    ${ceiling.map((c) => html`<li><span class="p-x" aria-hidden="true"></span>${c}</li>`)}
  </ul>
  <p class="p-note">Enforced as row-level security in Postgres, not in a prompt. Each rule has a test that tries to break it, and they run on every push. <a href="/security">How security works</a></p>
  <p class="p-note p-note-who">Built in Barcelona by ${OPERATOR.person} of <a href="${OPERATOR.site}">Red Mage</a>, out of running one vault per client as a consultant.</p>
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
</section>

<section class="p-sec" id="how" aria-labelledby="how-title">
  <h2 id="how-title">How it works</h2>
  <div class="p-frames">
    <figure class="p-frame" aria-labelledby="frame-review-cap">
      <div class="p-frame-art">${proposalCard}</div>
      <figcaption id="frame-review-cap">The Review page, drawn. Try it: approve or request changes. Nothing is saved.</figcaption>
    </figure>
    <figure class="p-frame" aria-labelledby="frame-term-cap">
      <div class="p-frame-art">${terminal}</div>
      <figcaption id="frame-term-cap">A run, drawn. The variable's name is shown; its value reaches one process and no one else.</figcaption>
    </figure>
  </div>
  <ol class="p-steps">
    ${steps.map(([t, d]) => html`<li><h3>${t}</h3>${d}</li>`)}
  </ol>
  <div class="p-log" aria-label="An example of the append-only activity log">
    <p class="p-log-cap">The log, append-only. An example.</p>
    <div class="p-log-track">
      ${logLines.map(([open, who, what]) => html`<span${open ? raw(' class="p-o"') : ""}><b>${who}</b> ${what}</span>`)}
    </div>
  </div>
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
      <p class="tier-price"><span class="${t.price.startsWith("$") ? "amount" : "amount amount-word"}">${t.price}</span>${t.period ? html` <span class="per">${t.period}</span>` : ""}</p>
      ${t.yearly ? html`<p class="tier-yearly">${t.yearly}</p>` : ""}
      <ul>${t.features.map((f) => html`<li>${f}</li>`)}</ul>
    </li>`,
    )}
  </ul>
  <p class="p-tiers-note">${PRICING.everyPlan}</p>
  ${cta("Start free")}
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
      <p class="p-lede">Reliquary is in open alpha: sign up with your email and create a vault. It's free while we build, the code is public, and you can self-host. We're letting people in steadily as usage grows, so it may take a while before you can create one. Want a hand? <a href="${requestAccessHref()}">Tell us about your team</a> and the AI tools you use, and we'll set up your first vault with you.</p>
      ${cta("Get started")}
      ${alphaNote()}
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
    title: "A secure second brain for people and their agents.",
    description:
      "Dead simple context to share across any AI tool. Claude, ChatGPT and Cursor read the same vault; agents propose, people approve, and secrets never reach a model. Free during the alpha, and you can self-host.",
    path,
    body,
    theme,
    home: true,
    frame: "poster",
  });
}
