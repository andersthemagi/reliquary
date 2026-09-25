// HTML helpers. Everything user- or agent-written goes through esc(); there
// is no other way to put text on a page. File text is shown as plain text,
// never rendered as markdown or HTML.

import { personRef } from "./personref.js";
import { BUILD } from "./version.js";

export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Tagged template: interpolated values are escaped unless wrapped in raw().
export class Raw {
  constructor(readonly html: string) {}
}
export const raw = (html: string) => new Raw(html);

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0];
  values.forEach((v, i) => {
    if (v instanceof Raw) out += v.html;
    else if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.html : esc(x))).join("");
    else out += esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

export type Theme = "auto" | "light" | "dark";

// Content hash of style.css, set by the server at start, so a changed
// stylesheet is never served from a stale browser cache.
let styleVersion = "";
export const setStyleVersion = (v: string) => {
  styleVersion = v;
};
export const styleHref = () => `/style.css?v=${styleVersion}`;

// How people sign in (AUTH_MODE), set by the server at start: the account
// menu says "(local)" for the dev.sh stand-in, and offers Sign out otherwise.
let accountMode: "local" | "supabase" = "local";
export const setAccountMode = (m: "local" | "supabase") => {
  accountMode = m;
};

// The public pages every footer links to (site.ts renders them).
export const LEGAL_LINKS: ReadonlyArray<readonly [string, string]> = [
  ["/terms", "Terms"],
  ["/privacy", "Privacy"],
  ["/dpa", "Data processing"],
  ["/subprocessors", "Sub-processors"],
  ["/security", "Security"],
];
export const footerLinks = () =>
  html`<nav class="footer-links" aria-label="Legal">${LEGAL_LINKS.map(([href, label]) => html`<a href="${href}">${label}</a>`)}</nav>`;

// The release this is, in every footer, linking to what changed in it.
export const versionLink = () =>
  BUILD.version === "unknown" ? "" : html`<a class="footer-version" href="/docs/changelog">v${BUILD.version}</a>`;

// Reliquary's stage, said on every frame: a badge in the top bar (the app's
// and the public site's) linking to the roadmap, and the sentence itself
// where there is room (the landing page, the docs, the roadmap, the
// Account menu).
export const PRE_ALPHA = "Pre-alpha: things change and may break; data is backed up daily.";
export const stageBadge = () => html`<a class="stage" href="/roadmap" title="${PRE_ALPHA}">Pre-alpha</a>`;
export const preAlphaNote = () =>
  html`<p class="prealpha-note"><strong>Pre-alpha:</strong> things change and may break; data is backed up daily. <a href="/roadmap">See the roadmap</a>.</p>`;

export type Nav = "home" | "review" | "vaults" | "activity" | "connect" | "tokens";

export type PageOpts = {
  user?: string;
  flash?: string;
  theme?: Theme;
  csrf?: string;
  path?: string; // current path, so the theme form can come back here
  nav?: Nav;
  reviewCount?: number;
};

export function page(title: string, body: Raw, opts: PageOpts = {}): string {
  const theme = opts.theme ?? "auto";
  const current = (...n: Nav[]) => (opts.nav && n.includes(opts.nav) ? raw(' aria-current="page"') : "");
  const count = opts.reviewCount ?? 0;
  const themeButton = (t: Theme, label: string) =>
    html`<button name="theme" value="${t}" aria-pressed="${theme === t ? "true" : "false"}">${label}</button>`;
  return html`<!doctype html>
<html lang="en"${theme === "auto" ? "" : raw(` data-theme="${theme}"`)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>${title} · Reliquary</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/inter-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/style.css?v=${styleVersion}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="top-inner">
  <a class="wordmark" href="/"><span class="logo" aria-hidden="true"></span>Reliquary</a>
  ${stageBadge()}
  ${opts.user
    ? html`<nav aria-label="Main">
    <a href="/"${current("home", "vaults")}>Vaults</a>
    <a href="/review"${current("review")}>Review${count ? html`<span class="count" aria-label="${count} waiting">${count}</span>` : ""}</a>
    <a href="/activity"${current("activity")}>Activity</a>
    <a href="/connect"${current("connect")}>Connect</a>
    <a href="/tokens"${current("tokens")}>Tokens</a>
  </nav>
  ${opts.csrf
    ? html`<details class="account menu-wrap">
    <summary class="button quiet">Account</summary>
    <div class="menu">
      <p class="menu-meta">Signed in as <strong>${personRef(opts.user)}</strong>${accountMode === "local" ? " (local)" : ""}</p>
      <p class="menu-links"><a href="/docs">Docs</a><a href="/roadmap">Roadmap</a></p>
      <p class="menu-meta">${PRE_ALPHA}</p>
      <form method="post" action="/theme" class="theme" aria-label="Theme">
        ${csrfField(opts.csrf)}<input type="hidden" name="back" value="${opts.path ?? "/"}">
        <span class="menu-label">Theme</span>
        <span class="segmented">${themeButton("auto", "Auto")}${themeButton("light", "Light")}${themeButton("dark", "Dark")}</span>
      </form>
      ${accountMode === "supabase"
        ? html`<form method="post" action="/signout" class="signout">${csrfField(opts.csrf)}<button class="quiet">Sign out</button></form>`
        : ""}
    </div>
  </details>`
    : ""}`
    : ""}
  </div>
</header>
<main id="main">
${opts.flash ? html`<p class="callout info flash" role="status">${opts.flash}</p>` : ""}
${body}
</main>
<footer><span>Reliquary by Red Mage</span>${footerLinks()}${versionLink()}</footer>
</body>
</html>`.html;
}

// A plain message page (sign-in, errors) in the same frame.
export function notice(title: string, message: Raw | string, theme?: Theme): string {
  return page(title, html`<h1>${title}</h1><p class="lede">${message}</p>`, { theme });
}

export function when(d: Date | null | undefined): string {
  if (!d) return "";
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

// The top of a page: breadcrumb, then the title with an optional status
// badge and the page's main actions (right-aligned on wide screens, wrapping
// below the title on narrow ones), then a meta line. A page's primary action
// lives here, never only at the bottom. A submit button for a form further
// down uses the form="" attribute (no script). At most one primary, last.
export function pageHeader(o: {
  title: Raw | string;
  crumb?: Raw;
  badge?: Raw;
  meta?: Raw;
  actions?: Raw | "";
  path?: boolean; // the title is a file path or name: long, may need to break
}): Raw {
  return html`<div class="page-head">
    ${o.crumb ?? ""}
    <div class="page-title-row">
      <div class="page-title"><h1${o.path ? raw(' class="path"') : ""}>${o.title}</h1>${o.badge ?? ""}</div>
      ${o.actions && o.actions.html.trim() ? html`<div class="page-actions">${o.actions}</div>` : ""}
    </div>
    ${o.meta ?? ""}
  </div>`;
}

// Hidden field carrying the CSRF token for every form.
export const csrfField = (token: string) => html`<input type="hidden" name="csrf" value="${token}">`;
