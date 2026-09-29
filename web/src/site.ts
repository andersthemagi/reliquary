// The public site: the landing page (landing.ts), the legal and trust pages
// (legal.ts), robots.txt, sitemap.xml and security.txt. Server-rendered, no
// script, nothing loaded from another origin (the CSP forbids it anyway).
//
// Everything the owner still has to decide or fill in lives in the two
// config objects below: OPERATOR (who runs the service, placeholders until
// filled) and PRICING (the tiers, easy to change or hide). A field left null
// renders as a visible "[to be filled: ...]" mark, never as an invented fact.

import { appHref, publicSiteOrigin } from "./hosts.js";
import { LEGAL_LINKS, esc, footerLinks, html, raw, stageBadge, styleHref, versionLink, type Raw, type Theme } from "./html.js";

// Who runs Reliquary. null = not decided or not known yet: shown as a
// placeholder on the page. Fill these in before the pages leave draft.
export const OPERATOR = {
  product: "Reliquary",
  brand: "Reliquary by Red Mage",
  tradingName: "Red Mage",
  person: "Andrés",
  contactEmail: "andres@redmage.cc",
  securityEmail: "andres@redmage.cc",
  // Where the site lives when neither SITE_URL nor PUBLIC_URL is set
  // (links in the sitemap, canonical and Open Graph URLs).
  defaultOrigin: "https://reliquary.redmage.cc",
  lastUpdated: "2026-09-24",
  legalName: null as string | null, // the legal entity or sole trader's full name
  legalForm: null as string | null, // e.g. sole trader, limited company
  registrationNumber: null as string | null,
  vatId: null as string | null,
  address: null as string | null, // registered or postal address
  country: null as string | null, // country of establishment
  governingLaw: null as string | null, // law and courts for the terms
  supervisoryAuthority: null as string | null, // lead data protection authority
  liabilityCap: null as string | null, // e.g. fees paid in the 12 months before the claim
  feeNoticeDays: null as string | null, // notice before any fee applies
  closureNotice: null as string | null, // notice before the service closes
  subprocessorNoticeDays: null as string | null, // notice before a new sub-processor
  transferSafeguard: null as string | null, // basis for any transfer outside the EU
  backupRetention: "Supabase keeps daily backups for 7 days; the operator also keeps up to 14 off-site copies, in which variable values exist only as ciphertext" as string | null, // how long database backups are kept
  hostingLogRetention: null as string | null, // how long the host keeps request logs
  disclosureResponse: null as string | null, // how soon a security report is acknowledged
  minimumAge: null as string | null, // e.g. 16
};

// A config value, or a visible placeholder naming what goes there.
export function fill(key: keyof typeof OPERATOR, what: string): Raw {
  const v = OPERATOR[key];
  return v ? html`${v}` : html`<mark class="placeholder">[to be filled: ${what}]</mark>`;
}

// Pricing. `show: false` hides the section and its nav link. The model: an
// account plan limits the vaults a person owns; each vault's tier limits
// its people and storage, and one vault can be upgraded on its own. The
// limits are enforced (20260925230000_plans.sql); nothing is billed during
// the beta.
export const PRICING = {
  show: true,
  banner: "Early access: free while in beta",
  note: "Everyone is on Free while we build. Per-vault upgrades are coming; nothing is billed today, and you’ll hear from us well before anything is.",
  tiers: [
    {
      name: "Free",
      price: "$0",
      period: "",
      yearly: "",
      for: "Everyone, during the beta",
      features: ["5 vaults you own", "Up to 10 people in each vault", "100 MB in each vault", "Unlimited agents and AI tools"],
      badge: "Now",
    },
    {
      name: "Pro vault",
      price: "Coming",
      period: "",
      yearly: "per vault, when billing starts",
      for: "One vault that needs more room",
      features: ["Upgrade a single vault; the others stay as they are", "Up to 50 people", "5 GB"],
      badge: "",
    },
    {
      name: "Alpha tester",
      price: "By invitation",
      period: "",
      yearly: "",
      for: "People testing Reliquary with us",
      features: ["25 vaults you own", "Up to 25 people in each vault", "1 GB in each vault"],
      badge: "",
    },
  ],
  everyPlan: "Every plan: unlimited agents and AI tools, approvals and quorum, the agent ceiling enforced in the database, the activity log, and export. Storage counts every version of every file and your variables.",
};

// Mail to the operator (OPERATOR.contactEmail), one subject per reason.
const mailOperator = (subject: string) => `mailto:${OPERATOR.contactEmail}?subject=${encodeURIComponent(subject)}`;
export const requestAccessHref = () => mailOperator("Reliquary early access");
export const biggerPlanHref = () => mailOperator("Reliquary: a bigger plan");
export const suggestFeatureHref = () => mailOperator("Reliquary feature suggestion");

// The site's own origin: SITE_URL when the public site has a host of its
// own (hosts.ts), else PUBLIC_URL, else the default. server.ts refuses to
// start on a malformed one.
export const siteOrigin = publicSiteOrigin(OPERATOR.defaultOrigin);

// Drafts: every legal page carries this until the owner has had it reviewed.
export const draftNote = () =>
  html`<p class="callout attention draft-note" role="note"><strong>Draft, pending legal review.</strong> Last updated ${OPERATOR.lastUpdated}. Bracketed items are still to be filled in.</p>`;

// The public page frame: its own header (no app nav, no account menu), the
// meta a search engine and a link preview need, and the footer with the
// legal links. Indexable, unlike the app's pages.
// `alternate`: the page as Markdown (docs pages), for agents.
export function sitePage(o: { title: string; description: string; path: string; body: Raw; theme: Theme; home?: boolean; alternate?: string }): string {
  const url = siteOrigin + o.path;
  const fullTitle = o.home ? `${OPERATOR.brand}: ${o.title}` : `${o.title} · ${OPERATOR.brand}`;
  return html`<!doctype html>
<html lang="en"${o.theme === "auto" ? "" : raw(` data-theme="${o.theme}"`)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${fullTitle}</title>
<meta name="description" content="${o.description}">
<link rel="canonical" href="${url}">
${o.alternate ? html`<link rel="alternate" type="text/markdown" href="${o.alternate}">` : ""}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${OPERATOR.brand}">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${o.description}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${siteOrigin}/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Reliquary. Your agents propose, you approve.">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/inter-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${styleHref()}">
</head>
<body class="site">
<a class="skip" href="#main">Skip to content</a>
<header class="top site-top">
  <div class="top-inner">
  <a class="wordmark" href="/" aria-label="Reliquary by Red Mage, home"><span class="logo" aria-hidden="true"></span>Reliquary<span class="wordmark-by" aria-hidden="true">by Red Mage</span></a>
  ${stageBadge()}
  <nav aria-label="Site">
    <a href="/#how">How it works</a>
    ${PRICING.show ? html`<a href="/#pricing">Pricing</a>` : ""}
    <a href="/security"${o.path === "/security" ? raw(' aria-current="page"') : ""}>Security</a>
    <a href="/#faq">FAQ</a>
    <a href="/docs"${o.path === "/docs" || o.path.startsWith("/docs/") ? raw(' aria-current="page"') : ""}>Docs</a>
    <a href="/roadmap"${o.path === "/roadmap" ? raw(' aria-current="page"') : ""}>Roadmap</a>
  </nav>
  <a class="button site-signin" href="${appHref("/signin")}">Sign in</a>
  </div>
</header>
<main id="main" class="site-main">
${o.body}
</main>
<footer class="site-footer">
  <div class="site-footer-brand"><span class="logo" aria-hidden="true"></span><span>${OPERATOR.brand}</span></div>
  ${footerLinks()}
  <a href="${requestAccessHref()}">Contact</a>
  ${versionLink()}
</footer>
</body>
</html>`.html;
}

// robots.txt: everything public may be crawled; the app's pages say noindex
// themselves (a Disallow would hide that from crawlers).
export function robotsTxt(): string {
  return `User-agent: *\nAllow: /\nDisallow: /oauth/\nDisallow: /api/\n\nSitemap: ${siteOrigin}/sitemap.xml\n`;
}

export const PUBLIC_PAGES = ["/", ...LEGAL_LINKS.map(([href]) => href)];

// `extra`: more public paths, the docs pages (docs.ts), after these.
export function sitemapXml(extra: readonly string[] = []): string {
  const urls = [...PUBLIC_PAGES, ...extra].map(
    (p) => `  <url><loc>${esc(siteOrigin + p)}</loc><lastmod>${OPERATOR.lastUpdated}</lastmod></url>`,
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

// RFC 9116. Expires a year after the pages were last updated.
export function securityTxt(): string {
  const expires = new Date(`${OPERATOR.lastUpdated}T00:00:00Z`);
  expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  return [
    `Contact: mailto:${OPERATOR.securityEmail}`,
    `Expires: ${expires.toISOString().replace(".000", "")}`,
    "Preferred-Languages: en",
    `Canonical: ${siteOrigin}/.well-known/security.txt`,
    `Policy: ${siteOrigin}/security#disclosure`,
    "",
  ].join("\n");
}
