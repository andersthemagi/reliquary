// The public site (web/src/site.ts, landing.ts, legal.ts): the landing page
// for signed-out visitors at `/` on the hosted (supabase) instances, the
// legal and trust pages on every instance, robots.txt, sitemap.xml and
// security.txt. Signs Ana in against the fake Supabase Auth for the Home
// check; seeds nothing and writes nothing.

import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { before, test } from "node:test";

const { WEB_AUTH_A_URL: A, WEB_AUTH_PUBLIC_URL: PUBLIC_URL, FAKE_AUTH_URL: FAKE, AUTH_SECRETS_FILE, LOGIN_FILE } = process.env;
const LOCAL = process.env.WEB_URL ?? "http://127.0.0.1:8791";
const ORIGIN = PUBLIC_URL ? new URL(PUBLIC_URL).origin : "";
const LEGAL = ["/terms", "/privacy", "/dpa", "/subprocessors", "/security"];
// The only other sites a public page may link to (links, never loaded):
// the code on GitHub and the sub-processors' own privacy policies.
const REPO = "https://github.com/andersthemagi/reliquary";
const DOCUMENTED_LINKS = ["https://redmage.cc", REPO, "https://supabase.com/privacy", "https://www.netlify.com/privacy/", "https://resend.com/legal/privacy-policy"];
const CONTACT = "mailto:andres@redmage.cc";

let localCookie = "";
before(async () => {
  assert.ok(A && FAKE && PUBLIC_URL, "run through web/test.sh (supabase-mode instances and the fake Auth)");
  const r = await fetch(readFileSync(LOGIN_FILE, "utf8").trim(), { redirect: "manual" });
  localCookie = r.headers.get("set-cookie").split(";")[0];
});

const fetchAs = (base, path, cookie = "") => fetch(base + path, { headers: cookie ? { cookie } : {}, redirect: "manual" });
const text = async (base, path, cookie) => (await fetchAs(base, path, cookie)).text();

// Sign Ana in on instance A by emailed code; returns the Cookie header.
async function signIn() {
  const jar = new Map();
  const take = (r) => {
    for (const sc of r.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      if (/Max-Age=0(;|$)/.test(sc)) jar.delete(pair.slice(0, i));
      else jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return r;
  };
  const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const post = async (path, fields) =>
    take(
      await fetch(A + path, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: header(), "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: new URLSearchParams(fields).toString(),
      }),
    );
  const csrfOf = (h) => /name="csrf" value="([0-9a-f]+)"/.exec(h)[1];
  const form = await take(await fetchAs(A, "/signin")).text();
  const codePage = await (await post("/signin", { csrf: csrfOf(form), email: "ana@example.test", next: "/" })).text();
  const { code } = await (await fetch(`${FAKE}/_last_email?email=${encodeURIComponent("ana@example.test")}`)).json();
  if (AUTH_SECRETS_FILE) appendFileSync(AUTH_SECRETS_FILE, `${code}\n`);
  const done = await post("/signin/code", { csrf: csrfOf(codePage), email: "ana@example.test", code, next: "/" });
  assert.equal(done.status, 303);
  if (AUTH_SECRETS_FILE) appendFileSync(AUTH_SECRETS_FILE, `${jar.get("__Host-rlq_rt")}\n`);
  return header();
}

// Every URL a page names in an attribute (href, src, action, content).
const urls = (h) => [...h.matchAll(/\b(?:href|src|action|content|srcset)="([^"]*)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));

// Landing ----------------------------------------------------------------------

test("site landing: a signed-out visitor at / gets the landing page, not a redirect", async () => {
  const r = await fetchAs(A, "/");
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<h1 class="p-h1 p-fold-head" id="hero-title"><span class="p-open">A secure second brain<\/span><span class="p-canon">for people and their agents\.<\/span><\/h1>/);
  assert.match(h, /<figcaption id="hub-cap">\s*<ul class="p-key" aria-label="The three states of everything in a vault">\s*<li class="p-key-open"><strong>Proposed\.<\/strong>[^<]*<\/li>\s*<li class="p-key-canon"><strong>Canon\.<\/strong>[^<]*<\/li>\s*<li class="p-key-sealed"><strong>Sealed\.<\/strong>[^<]*<\/li>/, "the key to the three marks is the hub's caption");
  assert.match(h, /Reliquary by Red Mage/);
  assert.match(h, /<h2 id="how-title">How it works<\/h2>/);
  assert.equal((h.match(/<ol class="p-steps">[\s\S]*?<\/ol>/)[0].match(/<li>/g) ?? []).length, 3, "three steps");
  for (const section of ["Why Reliquary", "What your agent can't do", "The problem, and what Reliquary does about it", "Who it's for", "Pricing", "Questions"]) {
    assert.match(h, new RegExp(`<h2 id="[a-z]+-title">${section}</h2>`), section);
  }
  // Order: the band, why Reliquary, the ceiling with its proof, the ledger, who, how, pricing, questions, the closing band.
  const ids = [...h.matchAll(/<h2 [^>]*id="([a-z]+)-title"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["why", "ceiling", "problem", "who", "how", "pricing", "faq", "closing"]);
  assert.match(h, /href="\/security"/);
  assert.doesNotMatch(h, /<script/i);
  assert.doesNotMatch(h, /<p class="eyebrow">/, "no label above the heading");
});

test("site landing: the page brings its own frame: the inverted band carries the site nav, the stage badge and Sign in; the closing band carries the footer", async () => {
  const h = await text(A, "/");
  assert.match(h, /<body class="site p-site">/);
  assert.doesNotMatch(h, /<header class="top site-top">|<footer class="site-footer">/);
  const top = /<header class="p-inv p-fold">\s*<div class="p-wrap p-top">([\s\S]*?)<\/div>/.exec(h)?.[1] ?? "";
  assert.match(top, /<a class="wordmark" href="\/"/);
  assert.match(top, /<a class="stage" href="\/roadmap"/);
  assert.match(top, /<nav aria-label="Site">[\s\S]*<a href="\/docs">Docs<\/a>[\s\S]*<a href="\/roadmap">Roadmap<\/a>[\s\S]*<\/nav>/);
  assert.match(top, /<a class="button site-signin" href="\/signin">Sign in<\/a>/);
  assert.equal(h.match(/>Sign in</g).length, 2, "the header's Sign in, and the menu's for narrow screens");
  const foot = /<footer class="p-inv p-fold p-close">[\s\S]*<\/footer>/.exec(h)?.[0] ?? "";
  assert.match(foot, /<h2 class="p-close-h2 p-fold-head" id="closing-title"><b>Try it on<\/b> your next project\.<\/h2>/);
  assert.match(foot, /<div class="p-wrap p-footer">[\s\S]*href="\/terms"[\s\S]*href="\/privacy"/);
});

test("site landing: why Reliquary follows the hero with six reasons, source available among them", async () => {
  const h = await text(A, "/");
  const why = /<section class="p-sec" id="why" aria-labelledby="why-title">([\s\S]*?)<\/section>/.exec(h)?.[1] ?? "";
  assert.ok(h.indexOf('id="why"') > h.indexOf("</header>") && h.indexOf('id="why"') < h.indexOf('id="ceiling-title"'), "right after the first band");
  const reasons = [...why.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
  assert.deepEqual(reasons, ["Every AI tool, one vault", "Built for agents and people together", "Secrets stay secret", "Guarded by the database", "Source available", "Yours to take with you"]);
  assert.match(why, /The code is public\. Read it, run it, self-host it for free\. Each release turns Apache 2\.0 two years on, and the CLI is MIT\./);
});

test("site landing: the GitHub link with its star count is in the top band, the hero, Source available and the closing, and the footer and FAQ link the code", async () => {
  const h = await text(A, "/");
  // The fake GitHub API (web/test/fake-auth.mjs) answers 1234 stars.
  const badge = new RegExp(`<a class="p-gh" href="${REPO}">[\\s\\S]*?<span class="p-gh-stars">[\\s\\S]*?1\\.2K<span class="sr-only"> stars</span></span></a>`, "g");
  const top = /<div class="p-wrap p-top">[\s\S]*?<\/div>/.exec(h)[0];
  assert.equal(top.match(badge).length, 1, "the top band");
  const hero = /<section class="p-wrap p-fold-body" aria-labelledby="hero-title">[\s\S]*?<figure/.exec(h)[0];
  assert.match(hero, /Read the code on GitHub/, "the hero");
  const why = /<section class="p-sec" id="why"[\s\S]*?<\/section>/.exec(h)[0];
  assert.match(why, /Source available<\/h3>[\s\S]*?Star it on GitHub/, "Source available");
  const closing = /<footer class="p-inv p-fold p-close">[\s\S]*?<\/footer>/.exec(h)[0];
  assert.equal(closing.match(badge).length, 1, "the closing band");
  assert.match(closing, new RegExp(`<div class="p-wrap p-footer">[\\s\\S]*<a href="${REPO}">GitHub</a>`), "the footer");
  assert.match(h, new RegExp(`The code is public <a href="${REPO}">on GitHub</a>`), "the FAQ");
  assert.equal(h.match(badge).length, 4);
});

test("site landing: the hub, the mark and the rail are drawn; the hub in the first band, the mark in the closing", async () => {
  const h = await text(A, "/");
  const hub = /<figure class="p-hub" aria-labelledby="hub-cap">([\s\S]*?)<\/figure>/.exec(h)?.[1] ?? "";
  assert.ok(hub, "the hub is in the first band");
  assert.ok(h.indexOf('<figure class="p-hub"') < h.indexOf("</header>"));
  const tools = [...(/<ul class="p-hub-side p-hub-tools" aria-label="AI tools">([\s\S]*?)<\/ul>/.exec(hub)?.[1] ?? "").matchAll(/<li>(?:<svg [^>]*><path d="[^"]+"\/><\/svg>)?([^<]+)<\/li>/g)].map((m) => m[1]);
  assert.deepEqual(tools, ["Claude", "ChatGPT", "Cursor", "VS Code", "any MCP client"]);
  assert.equal((hub.match(/<svg /g) ?? []).length, 3, "a mark for each tool that publishes one; ChatGPT and VS Code are names alone");
  assert.match(hub, /<ul class="p-hub-side p-hub-people" aria-label="People">\s*<li>You<\/li><li>Your team<\/li><li>The client<\/li>/);
  assert.match(hub, /<div class="p-hub-link p-hub-propose" aria-hidden="true"><i><\/i><span>propose<\/span><\/div>[\s\S]*<div class="p-hub-vault"><span class="p-hub-mark" aria-hidden="true"><\/span><strong>One vault<\/strong>[\s\S]*<div class="p-hub-link p-hub-approve" aria-hidden="true"><i><\/i><span>approve<\/span><\/div>/, "tools propose into the vault, people approve");
  assert.equal(h.match(/<div class="p-mark" aria-hidden="true"><\/div>/g)?.length, 1, "the mark closes the page");
  assert.match(h, /<div class="p-rail" aria-hidden="true">(?:<i><\/i>){14}<\/div>/);
});

test("site landing: what an agent can't do is the first section, five lines with a drawn mark, not a glyph or a pill", async () => {
  const h = await text(A, "/");
  const list = /<ul class="p-ceiling">([\s\S]*?)<\/ul>/.exec(h)?.[1] ?? "";
  const items = [...list.matchAll(/<li><span class="p-x" aria-hidden="true"><\/span>([^<]+)<\/li>/g)].map((m) => m[1]);
  assert.deepEqual(items, ["Approve any change", "Change who approves what", "Add or remove people", "Reveal a secret&#39;s value", "Export or delete a vault"]);
  assert.doesNotMatch(list, /✕|<span class="cant-mark"/);
  assert.match(h, /<p class="p-note">Enforced as row-level security in Postgres, not in a prompt\. Each rule has a test that tries to break it, and they run on every push\. <a href="\/security">How security works<\/a><\/p>/);
  assert.match(h, /<p class="p-note p-note-who">Built in Barcelona by Andrés of <a href="https:\/\/redmage\.cc">Red Mage<\/a>, out of running one vault per client/);
});

test("site landing: the demo card works without a script: a radio group decides on the proposal, and each state is in the markup", async () => {
  const h = await text(A, "/");
  const card = /<section class="p-sec" id="how"[\s\S]*?<figure class="p-frame" aria-labelledby="frame-review-cap">[\s\S]*?(<figure class="hero-card"[\s\S]*?<\/figure>)/.exec(h)?.[1];
  assert.ok(card, "the card sits in a frame in How it works");
  assert.doesNotMatch(card, /<button|<form|<script|on[a-z]+=/i);
  const radios = [...card.matchAll(/<input type="radio" name="demo" id="demo-[a-z]+" value="([a-z]+)" class="sr-only" aria-label="([^"]+)" aria-describedby="(cap-[a-z]+)"( checked)?>/g)];
  assert.deepEqual(radios.map((m) => m[1]), ["approve", "changes", "open"]);
  assert.deepEqual(radios.filter((m) => m[4]).map((m) => m[1]), ["open"], "open by default");
  // Each radio is named whether or not its visible label is shown, and names the visible label's words.
  assert.deepEqual(radios.map((m) => m[2]), ["Approve", "Request changes", "Start over"]);
  assert.match(card, /<legend class="sr-only">Decide on the proposal\. A demo: nothing is saved\.<\/legend>/);
  assert.match(card, /<label class="button primary" for="demo-approve">Approve<\/label>/);
  assert.match(card, /<label class="button" for="demo-changes">Request changes<\/label>/);
  assert.match(card, /<label class="hero-reset" for="demo-open">Start over<\/label>/);
  // The radios come before every label, so a checked one is never inside a hidden part and focus is never lost.
  assert.ok(card.indexOf('<input type="radio" name="demo" id="demo-open"') < card.indexOf('<label class="button primary"'));
  // Approved: the badge flips from hollow Open to filled Canon, the diff resolves, the log line appears.
  assert.match(card, /<span data-when="open changes"><span class="policy open badge">Open<\/span><\/span>/);
  assert.match(card, /<span data-when="approved"><span class="policy canon badge">Canon<\/span><\/span>/);
  assert.match(card, /<div class="hero-diff hero-canon" data-when="approved" aria-hidden="true">[\s\S]*?Deploy to: eu-production/);
  assert.match(card, /<p class="hero-log" data-when="approved" aria-hidden="true">Approved by <strong>you<\/strong> · just now<\/p>/);
  // Changes requested: the note field, labelled.
  assert.match(card, /<div class="hero-note" data-when="changes">\s*<label for="demo-note">Note for your agent<\/label>\s*<textarea id="demo-note" class="note-field"/);
  // The caption names the state, and each radio is described by its state's line, for people who can't see it change.
  const cap = /<figcaption id="hero-card-cap">([\s\S]*?)<\/figcaption>/.exec(card)?.[1] ?? "";
  for (const state of ["open", "approved", "changes"]) assert.match(cap, new RegExp(`<span id="cap-${state}" data-when="${state}">`), state);
  assert.deepEqual(radios.map((m) => m[3]), ["cap-approved", "cap-changes", "cap-open"]);
});

test("site landing: the two frames say they are drawings, without claiming to be screenshots, and the terminal never shows a value", async () => {
  const h = await text(A, "/");
  assert.match(h, /<figcaption id="frame-review-cap">The Review page, drawn\. Try it: approve or request changes\. Nothing is saved\./);
  assert.doesNotMatch(h, /standing in for a screenshot/);
  const term = /<figure class="p-frame" aria-labelledby="frame-term-cap">[\s\S]*?<\/figure>/.exec(h)?.[0] ?? "";
  assert.match(term, /<pre class="term"[^>]*>\$ reliquary run --env development -- npm start\n<span class="term-muted">DATABASE_URL<\/span> <span class="term-value" aria-hidden="true">◆◆◆◆◆◆◆◆<\/span>/);
  assert.match(term, /<figcaption id="frame-term-cap">A run, drawn\. The variable's name is shown; its value reaches one process and no one else\./);
  const shown = (/<pre class="term"[^>]*>([\s\S]*?)<\/pre>/.exec(term)?.[1] ?? "").replace(/<[^>]+>/g, "");
  assert.doesNotMatch(shown, /postgres|:\/\/|=/, "names only, never a value");
});

test("site landing: the log is an example and says so, eight lines, nothing moving", async () => {
  const h = await text(A, "/");
  const log = /<div class="p-log" aria-label="An example of the append-only activity log">([\s\S]*?)<\/div>\s*<\/div>/.exec(h)?.[1] ?? "";
  assert.match(log, /<p class="p-log-cap">The log, append-only\. An example\.<\/p>/);
  assert.equal((log.match(/<span( class="p-o")?><b>/g) ?? []).length, 8);
  assert.doesNotMatch(log, /aria-hidden/);
});

test("site landing: the one filled button is Join the alpha test, to the sign-in page that makes accounts, with See how approval works as a link; the email ask stays in the closing", async () => {
  const h = await text(A, "/");
  assert.equal(h.match(/<a class="button primary" href="\/signin">Join the alpha test<\/a>/g).length, 3, "first band, pricing and closing");
  assert.equal(h.match(/<a class="site-cta-link" href="#how">See how it works<\/a>/g).length, 3);
  assert.doesNotMatch(h, /<a class="button" href="#how"/, "the secondary is a link, not a second button");
  assert.match(h, /<a href="mailto:andres@redmage\.cc\?subject=Reliquary%20early%20access">Tell us about your team<\/a>/);
  assert.doesNotMatch(h, /invite-only/i);
});

test("site landing: each AI tool is named once, in the hub, and the band says what is free and public without an EU claim", async () => {
  const h = await text(A, "/");
  const band = /<header class="p-inv p-fold">[\s\S]*?<\/header>/.exec(h)?.[0] ?? "";
  for (const tool of ["Claude", "ChatGPT", "Cursor", "VS Code"]) assert.equal(band.match(new RegExp(`>${tool}<`, "g"))?.length, 1, tool);
  assert.match(band, /<p class="p-small">Works with any MCP client\. The code is public and it's free for everyone during the alpha\. Self-host it if you'd rather\.<\/p>/);
  assert.doesNotMatch(h, /EU-hosted|hosted in the EU|Frankfurt/, "no hosting-region claim: the app runs on Netlify");
  // The badge's title attribute carries the sentence; the visible text doesn't repeat it.
  assert.doesNotMatch(band.replace(/<[^>]+>/g, ""), /letting people in steadily|things change and may break/, "the first band says unfinished once, in the badge; the note moved to the closing");
  assert.match(h, /<footer class="p-inv p-fold p-close">[\s\S]*<p class="alpha-note"><strong>Alpha:<\/strong>/);
  assert.doesNotMatch(h, /<img/);
});

test("site landing: each problem is paired with what Reliquary does about it, one ledger of four rows that ends on no vendor lock-in", async () => {
  const h = await text(A, "/");
  const ledger = /<dl class="p-ledger">([\s\S]*?)<\/dl>/.exec(h)?.[1] ?? "";
  const rows = [...ledger.matchAll(/<div><dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd><\/div>/g)];
  assert.equal(rows.length, 4);
  assert.match(rows[3][1], /already uses three of them/);
  assert.match(rows[3][2], /Built for teams on different systems[\s\S]*export it all as plain markdown/);
  assert.doesNotMatch(h, /id="trust-title"/, "no separate promise section");
  assert.match(rows[1][1], /nobody checked/);
  assert.match(rows[1][2], /a person, or a quorum, approves/);
  assert.match(rows[2][2], /no AI tool ever gets a value/);
  assert.match(h, /<div class="p-ledger-head" aria-hidden="true"><span>Today<\/span><span>With Reliquary<\/span><\/div>/);
});

test("site landing: the page says who builds it, in the closing band", async () => {
  const h = await text(A, "/");
  assert.match(h, /<p class="who-builds">Reliquary is built in Barcelona by Andrés of <a href="https:\/\/redmage\.cc">Red Mage<\/a>\./);
});

test("site landing: pricing shows the plans and their limits, clearly marked free during the alpha, with the roadmap and self-hosting", async () => {
  const h = await text(A, "/");
  const pricing = /<section[^>]*id="pricing"[\s\S]*?<\/section>/.exec(h)[0];
  assert.match(pricing, /Alpha test: free for everyone/);
  assert.match(pricing, /paid vaults for teams that need more room, ways to support the project, and enough to keep the lights on/);
  assert.match(pricing, /self-hosting stays free/);
  for (const tier of ["Free", "Pro vault"]) assert.match(pricing, new RegExp(`<h3>${tier}\\b`), tier);
  assert.doesNotMatch(pricing, /Alpha tester/, "by-invitation plans are not on the price list");
  for (const limit of ["5 vaults you own", "Up to 10 people in each vault", "100 MB in each vault", "Up to 50 people", "5 GB"]) {
    assert.match(pricing, new RegExp(`<li>${limit}</li>`), limit);
  }
  assert.match(pricing, /<span class="amount">\$0<\/span>/);
  assert.match(pricing, /<span class="amount amount-word">Coming<\/span>/, "a word is not set like a price");
  assert.match(pricing, /<a class="button primary" href="\/signin">Join the alpha test<\/a>/, "a button under the plans");
  assert.match(pricing, /Nothing is billed today/);
});

test("site landing: a title, a description, Open Graph tags and the icon; indexable", async () => {
  const h = await text(A, "/");
  assert.match(h, /<title>Reliquary by Red Mage: A secure second brain for people and their agents\.<\/title>/);
  assert.match(h, /<meta name="description" content="[^"]{50,}">/);
  for (const p of ["og:title", "og:description", "og:type", "og:site_name"]) assert.match(h, new RegExp(`<meta property="${p}" content="[^"]+">`), p);
  assert.match(h, new RegExp(`<meta property="og:url" content="${ORIGIN}/">`));
  assert.match(h, new RegExp(`<link rel="canonical" href="${ORIGIN}/">`));
  assert.match(h, /<link rel="icon" href="\/favicon\.svg"/);
  assert.doesNotMatch(h, /name="robots"/);
});

test("site landing: a signed-in person at / still gets Home", async () => {
  const cookie = await signIn();
  const r = await fetchAs(A, "/", cookie);
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<nav class="app-nav" aria-label="Main">/);
  assert.doesNotMatch(h, /hero-title/);
});

test("site landing: a session that ended (cookies present, refused) at / still goes to sign in", async () => {
  const r = await fetchAs(A, "/", "__Host-rlq_rt=not-a-real-refresh-token");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), "/signin");
});

test("site landing: other pages signed out still go to sign in", async () => {
  const r = await fetchAs(A, "/review");
  assert.equal(r.status, 303);
  assert.equal(r.headers.get("location"), `/signin?next=${encodeURIComponent("/review")}`);
});

// Links and requests ---------------------------------------------------------------

test("site links: no URL to another site but the contact mailto and the documented links", async () => {
  for (const path of ["/", ...LEGAL]) {
    const h = await text(A, path);
    for (const u of urls(h)) {
      if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(u)) continue; // a local path, or plain text (content="width=...")
      if (u.startsWith(`${ORIGIN}/`)) continue; // our own canonical / og:url
      if (u.startsWith("mailto:")) {
        assert.ok(u === CONTACT || u.startsWith(`${CONTACT}?subject=`), `${path}: ${u}`);
        continue;
      }
      assert.ok(DOCUMENTED_LINKS.includes(u), `${path} names an undocumented external URL: ${u}`);
    }
    // Nothing is loaded from elsewhere: every src and stylesheet, icon and font is local.
    for (const m of h.matchAll(/<(?:link|script|img|iframe)\b[^>]*>/g)) {
      if (/rel="canonical"/.test(m[0])) continue;
      assert.match(m[0], /(?:href|src)="\/(?!\/)/, `${path}: ${m[0]}`);
    }
  }
});

// Legal and trust pages -------------------------------------------------------------

test("site legal: every legal page answers signed out on each instance, marked draft with a date", async () => {
  for (const base of [A, LOCAL]) {
    for (const path of LEGAL) {
      const r = await fetchAs(base, path);
      assert.equal(r.status, 200, `${base}${path}`);
      const h = await r.text();
      assert.match(h, /<strong>Draft, pending legal review\.<\/strong> Last updated \d{4}-\d{2}-\d{2}\./, path);
      assert.match(h, /<h1>[^<]+<\/h1>/, path);
      assert.match(h, /<meta name="description" content="[^"]+">/, path);
      assert.doesNotMatch(h, /name="robots"/, path);
      assert.doesNotMatch(h, /<script/i, path);
    }
  }
});

test("site legal: facts not known yet are visible placeholders, not invented", async () => {
  const h = await text(A, "/terms");
  assert.match(h, /<mark class="placeholder">\[to be filled: registration number\]<\/mark>/);
  assert.match(h, /<mark class="placeholder">\[to be filled: address\]<\/mark>/);
});

test("site legal: sub-processors names Supabase in Frankfurt, Netlify in the United States, Resend for email, and no model providers", async () => {
  const h = await text(A, "/subprocessors");
  assert.match(h, /<strong>Supabase<\/strong>[\s\S]*?Database and sign-in[\s\S]*?Frankfurt/);
  assert.match(h, /<strong>Netlify<\/strong>[\s\S]*?Hosting and CDN[\s\S]*?United States/);
  assert.match(h, /<strong>Resend<\/strong>[\s\S]*?Sending email[\s\S]*?Ireland, eu-west-1[\s\S]*?stored in the US/);
  assert.doesNotMatch(h, /Email provider/);
  assert.match(h, /<h2>Model providers: none<\/h2>/);
});

test("site legal: the security page states the caveats plainly and how to report a vulnerability", async () => {
  const h = await text(A, "/security");
  assert.match(h, /Agents can read what reaches them\./);
  assert.match(h, /The operator can decrypt\./);
  assert.match(h, /hostile test/);
  assert.match(h, /key kept outside the database/);
  assert.match(h, /<h2 id="disclosure">Reporting a vulnerability<\/h2>[\s\S]*?mailto:andres@redmage\.cc/);
});

test("site legal: the security page states the current stage and the release it describes", async () => {
  const h = await text(A, "/security");
  assert.match(h, /<h2 id="status">Status<\/h2>\s*<p>Alpha: things change and may break; data is backed up daily\. This page is built from the same code as the running release(, v\d+\.\d+\.\d+)?, so it changes when a release does\./);
  assert.match(h, /<a href="\/docs\/changelog">The changelog<\/a>/);
  assert.doesNotMatch(h, /EU hosting/);
});

test("site legal: a POST to a legal page is not served as the page", async () => {
  const r = await fetch(A + "/terms", { method: "POST", redirect: "manual", headers: { origin: ORIGIN } });
  assert.notEqual(r.status, 200);
});

// Footer, headers, indexing -------------------------------------------------------------

test("site footer: public pages, sign-in and the app all link every legal page", async () => {
  const pages = [await text(A, "/"), await text(A, "/privacy"), await text(A, "/signin"), await text(LOCAL, "/", localCookie)];
  for (const h of pages) {
    const footer = /<footer[\s\S]*?<\/footer>/.exec(h)[0];
    for (const path of LEGAL) assert.match(footer, new RegExp(`href="${path}"`), path);
  }
});

test("site headers: public pages carry the app's security headers unchanged", async () => {
  const app = await fetchAs(LOCAL, "/", localCookie);
  for (const path of ["/", "/terms", "/security"]) {
    const r = await fetchAs(A, path);
    for (const name of ["content-security-policy", "x-content-type-options", "referrer-policy", "cache-control"]) {
      assert.equal(r.headers.get(name), app.headers.get(name), `${path} ${name}`);
    }
  }
  assert.match(app.headers.get("content-security-policy"), /default-src 'none'/);
});

test("site indexing: app pages and sign-in say noindex; public pages don't", async () => {
  for (const [base, path, cookie] of [[LOCAL, "/", localCookie], [LOCAL, "/inbox", localCookie], [A, "/signin", ""]]) {
    assert.match(await text(base, path, cookie), /<meta name="robots" content="noindex">/, path);
  }
  for (const path of ["/", ...LEGAL]) assert.doesNotMatch(await text(A, path), /noindex/, path);
});

test("site indexing: robots.txt allows the site and names the sitemap; the sitemap lists the public pages", async () => {
  const robots = await fetchAs(A, "/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type"), /^text\/plain/);
  const r = await robots.text();
  assert.match(r, /^User-agent: \*$/m);
  assert.match(r, new RegExp(`^Sitemap: ${ORIGIN}/sitemap\\.xml$`, "m"));
  assert.doesNotMatch(r, /^Disallow: \/$/m);
  const map = await fetchAs(A, "/sitemap.xml");
  assert.match(map.headers.get("content-type"), /^application\/xml/);
  const locs = [...(await map.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  // The public pages first, then the docs (docs.test.mjs).
  assert.deepEqual(locs.slice(0, 1 + LEGAL.length), ["/", ...LEGAL].map((p) => ORIGIN + p));
  assert.ok(locs.slice(1 + LEGAL.length).every((l) => l.startsWith(`${ORIGIN}/docs`)));
});

test("site indexing: security.txt names the contact and an expiry", async () => {
  const r = await fetchAs(A, "/.well-known/security.txt");
  assert.equal(r.status, 200);
  const t = await r.text();
  assert.match(t, /^Contact: mailto:andres@redmage\.cc$/m);
  assert.match(t, /^Expires: \d{4}-\d{2}-\d{2}T00:00:00Z$/m);
});
