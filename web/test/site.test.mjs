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
// the sub-processors' own privacy policies.
const DOCUMENTED_LINKS = ["https://supabase.com/privacy", "https://vercel.com/legal/privacy-policy", "https://resend.com/legal/privacy-policy"];
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
  assert.match(h, /<h1 id="hero-title">The canon for humans and agents\.<\/h1>/);
  assert.match(h, /<p class="hero-sub">Your agents propose\. You approve\.<\/p>/);
  assert.match(h, /Reliquary by Red Mage/);
  assert.match(h, /<h2 id="how-title">How it works<\/h2>/);
  assert.equal((h.match(/<ol class="steps">[\s\S]*?<\/ol>/)[0].match(/<li>/g) ?? []).length, 3, "three steps");
  for (const section of ["What makes it different", "Who it's for", "What your agent can't do", "Pricing", "Questions"]) {
    assert.match(h, new RegExp(`<h2 id="[a-z]+-title">${section}</h2>`), section);
  }
  assert.match(h, /href="\/security"/);
  assert.doesNotMatch(h, /<script/i);
});

test("site landing: what an agent can't do is a plain list with a mark, not button-like pills", async () => {
  const h = await text(A, "/");
  const list = /<ul class="cant-list">([\s\S]*?)<\/ul>/.exec(h)?.[1] ?? "";
  const items = [...list.matchAll(/<li><span class="cant-mark" aria-hidden="true">✕<\/span>([^<]+)<\/li>/g)].map((m) => m[1]);
  assert.deepEqual(items, ["Approve its own change", "Change the rules", "Add or remove people", "Reveal a secret&#39;s value", "Export or delete a vault"]);
  assert.doesNotMatch(h, /<ul class="ceiling">/);
});

test("site landing: the demo card's buttons can't be focused or reached by assistive tech", async () => {
  const h = await text(A, "/");
  const actions = /<div class="hero-card-actions"([^>]*)>([\s\S]*?)<\/div>/.exec(h);
  assert.ok(actions, "the demo card has its buttons");
  assert.match(actions[1], /aria-hidden="true"/);
  assert.match(actions[1], /\binert\b/);
  assert.doesNotMatch(actions[2], /<button|<a /);
});

test("site landing: calls to action are Sign in and Request access by email with a subject", async () => {
  const h = await text(A, "/");
  assert.match(h, /<a class="button primary" href="mailto:andres@redmage\.cc\?subject=Reliquary%20early%20access">Request access<\/a>/);
  assert.match(h, /<a class="button[^"]*" href="\/signin">Sign in<\/a>/);
});

test("site landing: pricing shows the plans and their limits, clearly marked free while in beta", async () => {
  const h = await text(A, "/");
  const pricing = /<section[^>]*id="pricing"[\s\S]*?<\/section>/.exec(h)[0];
  assert.match(pricing, /Early access: free while in beta/);
  for (const tier of ["Free", "Pro vault", "Alpha tester"]) assert.match(pricing, new RegExp(`<h3>${tier}\\b`), tier);
  for (const limit of ["5 vaults you own", "Up to 10 people in each vault", "100 MB in each vault", "Up to 50 people", "5 GB", "1 GB in each vault"]) {
    assert.match(pricing, new RegExp(`<li>${limit}</li>`), limit);
  }
  assert.match(pricing, /<span class="amount">By invitation<\/span>/);
  assert.match(pricing, /Per-vault upgrades are coming; nothing is billed today/);
});

test("site landing: a title, a description, Open Graph tags and the icon; indexable", async () => {
  const h = await text(A, "/");
  assert.match(h, /<title>Reliquary by Red Mage: The canon for humans and agents\.<\/title>/);
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

test("site legal: sub-processors names Supabase and Vercel in Frankfurt, Resend for email, and no model providers", async () => {
  const h = await text(A, "/subprocessors");
  assert.match(h, /<strong>Supabase<\/strong>[\s\S]*?Database and sign-in[\s\S]*?Frankfurt/);
  assert.match(h, /<strong>Vercel<\/strong>[\s\S]*?Hosting and CDN[\s\S]*?Frankfurt \(fra1\)/);
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
  // The public pages first, then the roadmap and the docs (docs.test.mjs).
  assert.deepEqual(locs.slice(0, 1 + LEGAL.length), ["/", ...LEGAL].map((p) => ORIGIN + p));
  assert.ok(locs.slice(1 + LEGAL.length).every((l) => l === `${ORIGIN}/roadmap` || l.startsWith(`${ORIGIN}/docs`)));
});

test("site indexing: security.txt names the contact and an expiry", async () => {
  const r = await fetchAs(A, "/.well-known/security.txt");
  assert.equal(r.status, 200);
  const t = await r.text();
  assert.match(t, /^Contact: mailto:andres@redmage\.cc$/m);
  assert.match(t, /^Expires: \d{4}-\d{2}-\d{2}T00:00:00Z$/m);
});
