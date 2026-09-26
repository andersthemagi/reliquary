// HTML helpers. Everything user- or agent-written goes through esc(); there
// is no other way to put text on a page. File text is shown as plain text,
// never rendered as markdown or HTML.

import { siteHref } from "./hosts.js";
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
// Whether this instance offers Sign out (hosted sign-in, not the local stand-in).
export const signsOut = () => accountMode === "supabase";

// The public pages every footer links to (site.ts renders them).
export const LEGAL_LINKS: ReadonlyArray<readonly [string, string]> = [
  ["/terms", "Terms"],
  ["/privacy", "Privacy"],
  ["/dpa", "Data processing"],
  ["/subprocessors", "Sub-processors"],
  ["/security", "Security"],
];
export const footerLinks = () =>
  html`<nav class="footer-links" aria-label="Legal">${LEGAL_LINKS.map(([href, label]) => html`<a href="${siteHref(href)}">${label}</a>`)}</nav>`;

// The release this is, in every footer, linking to what changed in it.
export const versionLink = () =>
  BUILD.version === "unknown" ? "" : html`<a class="footer-version" href="${siteHref("/docs/changelog")}">v${BUILD.version}</a>`;

// Reliquary's stage, said on every frame: a badge in the top bar (the app's
// and the public site's) linking to the roadmap, and the sentence itself
// where there is room (the landing page, the docs, the roadmap, the
// Account menu).
export const PRE_ALPHA = "Pre-alpha: things change and may break; data is backed up daily.";
export const stageBadge = () => html`<a class="stage" href="${siteHref("/roadmap")}" title="${PRE_ALPHA}">Pre-alpha</a>`;
export const preAlphaNote = () =>
  html`<p class="prealpha-note"><strong>Pre-alpha:</strong> things change and may break; data is backed up daily. <a href="${siteHref("/roadmap")}">See the roadmap</a>.</p>`;

export type Nav =
  | "home"
  | "inbox"
  | "review" // the old name of the inbox: marks Inbox as current
  | "vaults"
  | "activity"
  | "connect"
  | "tokens"
  | "search"
  | "settings"
  | "account";

// What the top bar shows, from one call per page (inbox.ts, loadShell;
// public.shell_summary in 20260926100000_shell_inbox.sql).
export type ShellItem = {
  kind: "review" | "revise" | "import" | "invite" | "notice";
  at: string;
  vault: string;
  id?: string;
  vault_id?: string;
  path?: string;
  verb?: string;
  names?: number;
  environments?: string[];
  role?: string;
  by?: string | null;
  expires_at?: string;
};
export type Shell = {
  me: { email: string | null; name: string | null };
  vaults: { id: string; name: string; role: string }[];
  more_vaults: boolean;
  counts: { review: number; revise: number; imports: number; invites: number; notices: number };
  total: number;
  items: ShellItem[];
};

export type PageOpts = {
  user?: string;
  flash?: string;
  theme?: Theme;
  csrf?: string;
  path?: string; // current path and query: the theme form comes back here, the switcher and search read it
  nav?: Nav;
  shell?: Shell; // absent on a page answering a form: the bar then shows no counts
};

const UUID_AT = /^\/v\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?]|$)/;

function agoText(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(s)) return "";
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// One inbox item as a link: where it goes, what it is, and a line of context.
export function inboxItem(i: ShellItem): { href: string; title: string; meta: string } {
  const when = agoText(i.at);
  switch (i.kind) {
    case "review":
      return { href: `/v/${i.vault_id}/proposals/${i.id}`, title: `${i.verb ?? "Change"} ${i.path}`, meta: `Review · ${i.vault} · ${when}` };
    case "revise":
      return { href: `/v/${i.vault_id}/proposals/${i.id}`, title: `Revise ${i.path}`, meta: `Changes requested · ${i.vault} · ${when}` };
    case "import":
      return {
        href: `/v/${i.vault_id}/variables/imports/${i.id}`,
        title: `Apply a .env import (${plural(i.names ?? 0, "name")})`,
        meta: `${(i.environments ?? []).join(", ")} · ${i.vault} · ${when}`,
      };
    case "invite":
      return { href: "/inbox#invites", title: `Invite to ${i.vault} as ${i.role}`, meta: `From ${i.by ?? "an owner"} · ${when}` };
    case "notice":
      return { href: "/inbox#notices", title: `${i.vault} was deleted`, meta: `By ${i.by ?? "an owner"} · ${when}` };
  }
}

// Icons, drawn inline (no image requests; currentColor follows the theme).
const ICON_INBOX = raw(
  '<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2.8 2h10.4c.5 0 .9.3 1.1.7l1.6 5.1c.1.2.1.4.1.6V13c0 .6-.4 1-1 1H1c-.6 0-1-.4-1-1V8.4c0-.2 0-.4.1-.6l1.6-5.1C1.9 2.3 2.3 2 2.8 2Zm.2 1.5L1.7 7.5h3.1c.4 0 .7.3.7.7a2.5 2.5 0 0 0 5 0c0-.4.3-.7.7-.7h3.1L13 3.5H3ZM1.5 9v3.5h13V9h-2.5a4 4 0 0 1-8 0H1.5Z"/></svg>',
);
const ICON_SEARCH = raw(
  '<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M10.7 11.8a6 6 0 1 1 1.1-1.1l3.5 3.5a.8.8 0 1 1-1.1 1.1l-3.5-3.5ZM11.5 7a4.5 4.5 0 1 0-9 0 4.5 4.5 0 0 0 9 0Z"/></svg>',
);

// The first letter of a name or address, for the account button.
const initial = (s: string) => (Array.from(s.trim())[0] ?? "?").toUpperCase();

function searchForm(q: string, id: string): Raw {
  return html`<form class="top-search" method="get" action="/search" role="search">
      <label class="sr-only" for="${id}">Search your vaults</label>
      <span class="top-search-field">${ICON_SEARCH}<input id="${id}" type="search" name="q" placeholder="Search vaults" value="${q}" maxlength="200" autocomplete="off"></span>
    </form>`;
}

// The signed-in top bar: brand, the main nav (with the vault switcher), a
// search box, the inbox and the account menu. HTML and CSS only: the
// switcher, the inbox and the account menu are <details>.
function appBar(opts: PageOpts, theme: Theme): Raw {
  const user = opts.user!;
  const current = (...n: Nav[]) => (opts.nav && n.includes(opts.nav) ? raw(' aria-current="page"') : "");
  const path = opts.path ?? "/";
  const here = UUID_AT.exec(path)?.[1];
  let q = "";
  if (path.startsWith("/search")) {
    try {
      q = new URL(path, "http://x").searchParams.get("q") ?? "";
    } catch {
      q = "";
    }
  }
  const s = opts.shell;
  const vaults = s?.vaults ?? [];
  const inVault = here ? vaults.find((v) => v.id === here) : undefined;

  // Vault switcher: the vaults this person is in, the current one marked.
  const switcher = vaults.length
    ? html`<details class="menu-wrap vault-switch">
      <summary${current("vaults")}><span class="vault-switch-label">${inVault ? inVault.name : "Vaults"}</span></summary>
      <div class="menu vault-menu">
        <p class="menu-label">Switch vault</p>
        <ul class="menu-list">${vaults.map(
          (v) => html`<li><a href="/v/${v.id}"${v.id === here ? raw(' aria-current="page"') : ""}><span class="menu-item-title">${v.name}</span><span class="menu-item-meta">${v.role}</span></a></li>`,
        )}</ul>
        <p class="menu-foot"><a href="/">${s?.more_vaults ? "All vaults" : "Home"}</a><a href="/vaults/new">New vault</a></p>
      </div>
    </details>`
    : "";

  // Inbox: the count (hidden at zero) and the newest items.
  const total = s?.total ?? 0;
  const inbox = s
    ? html`<details class="menu-wrap inbox">
      <summary class="button quiet icon-button" aria-label="${total ? `Inbox, ${total} waiting` : "Inbox, nothing waiting"}"${current("inbox", "review")}>${ICON_INBOX}${total ? html`<span class="count" aria-hidden="true">${total > 99 ? "99+" : total}</span>` : ""}</summary>
      <div class="menu inbox-menu">
        <p class="menu-head"><span class="menu-label">Inbox</span><a href="/inbox">View all</a></p>
        ${s.items.length
          ? html`<ul class="menu-list inbox-list">${s.items.map((i) => {
              const it = inboxItem(i);
              return html`<li><a href="${it.href}"><span class="menu-item-title">${it.title}</span><span class="menu-item-meta">${it.meta}</span></a></li>`;
            })}</ul>
            ${total > s.items.length ? html`<p class="menu-foot"><a href="/inbox">${plural(total - s.items.length, "more item")} in your inbox</a></p>` : ""}`
          : html`<p class="menu-meta inbox-empty">Nothing needs you. Proposals to review, invites and .env imports to apply show up here.</p>`}
      </div>
    </details>`
    : html`<a class="button quiet icon-button" href="/inbox" aria-label="Inbox">${ICON_INBOX}</a>`;

  // Account: who is signed in, their pages, the theme and signing out.
  const who = s?.me.name ?? s?.me.email ?? null;
  const label = who ?? personRef(user);
  const account = opts.csrf
    ? html`<details class="account menu-wrap">
      <summary class="button quiet account-button" aria-label="Account menu"${current("settings", "account", "tokens")}><span class="avatar" aria-hidden="true">${who ? initial(who) : "?"}</span><span class="account-name">${label}</span></summary>
      <div class="menu account-menu">
        <p class="menu-who">Signed in as <strong>${label}</strong>${
          s?.me.name && s.me.email ? html`<span class="menu-meta">${s.me.email}</span>` : ""}${
          accountMode === "local" ? html`<span class="menu-meta">Local sign-in (dev.sh)</span>` : ""}</p>
        <ul class="menu-list">
          <li><a href="/settings"${current("settings")}>Account settings</a></li>
          <li><a href="/account"${current("account")}>Plan and usage</a></li>
          <li><a href="/tokens"${current("tokens")}>Tokens and connections</a></li>
        </ul>
        <p class="menu-links"><a href="${siteHref("/docs")}">Docs</a><a href="${siteHref("/roadmap")}">Roadmap</a></p>
        <p class="menu-meta">${PRE_ALPHA}</p>
        <form method="post" action="/theme" class="theme" aria-label="Theme">
          ${csrfField(opts.csrf)}<input type="hidden" name="back" value="${path}">
          <span class="menu-label">Theme</span>
          ${themeButtons(theme)}
        </form>
        ${accountMode === "supabase"
          ? html`<form method="post" action="/signout" class="signout">${csrfField(opts.csrf)}<button class="quiet">Sign out</button></form>`
          : ""}
      </div>
    </details>`
    : "";

  return html`<header class="top app-top">
  <div class="top-inner">
  <a class="wordmark" href="/"><span class="logo" aria-hidden="true"></span>Reliquary</a>
  ${stageBadge()}
  <nav class="app-nav" aria-label="Main">
    <a href="/"${current("home")}>Home</a>
    ${switcher}
    <a href="/activity"${current("activity")}>Activity</a>
    <a href="/connect"${current("connect")}>Connect</a>
    <a href="${siteHref("/docs")}">Docs</a>
  </nav>
  <div class="top-tools">
    ${searchForm(q, "top-q")}
    <details class="menu-wrap search-pop">
      <summary class="button quiet icon-button" aria-label="Search">${ICON_SEARCH}</summary>
      <div class="menu search-menu">${searchForm(q, "top-q-sm")}</div>
    </details>
    ${inbox}
    ${account}
  </div>
  </div>
</header>`;
}

// Auto, Light and Dark, the current one pressed (the Account menu and
// Account settings).
export const themeButtons = (theme: Theme): Raw =>
  html`<span class="segmented">${(
    [
      ["auto", "Auto"],
      ["light", "Light"],
      ["dark", "Dark"],
    ] as const
  ).map(([t, label]) => html`<button name="theme" value="${t}" aria-pressed="${theme === t ? "true" : "false"}">${label}</button>`)}</span>`;

export function page(title: string, body: Raw, opts: PageOpts = {}): string {
  const theme = opts.theme ?? "auto";
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
${opts.user
  ? appBar(opts, theme)
  : html`<header class="top">
  <div class="top-inner">
  <a class="wordmark" href="/"><span class="logo" aria-hidden="true"></span>Reliquary</a>
  ${stageBadge()}
  </div>
</header>`}
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
