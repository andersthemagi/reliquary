// HTML helpers. Everything user- or agent-written goes through esc(); there
// is no other way to put text on a page. File text is shown as plain text,
// never rendered as markdown or HTML.

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
<title>${title} · Reliquary</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/inter-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/style.css?v=${styleVersion}">
</head>
<body>
<header class="top">
  <a class="wordmark" href="/">Reliquary</a>
  ${opts.user
    ? html`<nav aria-label="Main">
    <a href="/"${current("home", "vaults")}>Vaults</a>
    <a href="/review"${current("review")}>Review${count ? html`<span class="count" aria-label="${count} waiting">${count}</span>` : ""}</a>
    <a href="/activity"${current("activity")}>Activity</a>
    <a href="/connect"${current("connect")}>Connect</a>
    <a href="/tokens"${current("tokens")}>Tokens</a>
  </nav>`
    : ""}
</header>
<main>
${opts.flash ? html`<p class="flash" role="status">${opts.flash}</p>` : ""}
${body}
</main>
${opts.user && opts.csrf
    ? html`<footer>
  <span>Red Mage · Reliquary</span>
  <form method="post" action="/theme" class="theme">
    ${csrfField(opts.csrf)}<input type="hidden" name="back" value="${opts.path ?? "/"}">
    <span>Theme</span>${themeButton("auto", "Auto")}${themeButton("light", "Light")}${themeButton("dark", "Dark")}
  </form>
</footer>`
    : ""}
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

// The top of a page: breadcrumb, title, a meta line, and the page's main
// actions, right-aligned on wide screens and wrapping below on narrow ones.
// A page's primary action lives here, never only at the bottom. A submit
// button for a form further down uses the form="" attribute (no script).
export function pageHeader(o: {
  title: Raw | string;
  crumb?: Raw;
  meta?: Raw;
  actions?: Raw | "";
  path?: boolean; // the title is a file path or name, not a word
}): Raw {
  return html`<div class="page-head">
    <div class="page-head-text">${o.crumb ?? ""}<h1${o.path ? raw(' class="path"') : ""}>${o.title}</h1>${o.meta ?? ""}</div>
    ${o.actions && o.actions.html.trim() ? html`<div class="page-actions">${o.actions}</div>` : ""}
  </div>`;
}

// Hidden field carrying the CSRF token for every form.
export const csrfField = (token: string) => html`<input type="hidden" name="csrf" value="${token}">`;
