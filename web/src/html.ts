// HTML helpers. Everything user- or agent-written goes through esc(); there
// is no other way to put text on a page. File text is shown as plain text,
// never rendered as markdown or HTML.

import { randomBytes } from "node:crypto";
import { toFlash, type Flash, type Tone } from "./flash.js";
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
  | "vaults"
  | "activity"
  | "connect"
  | "connections"
  | "search"
  | "settings"
  | "account"
  | "feedback"
  | "welcome";

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
  welcome_unseen?: boolean; // no Welcome tour seen yet (welcome.ts)
  items: ShellItem[];
};

export type PageOpts = {
  user?: string;
  flash?: Flash | string; // a bare string is info, or danger when it ends with a ref (flash.ts)
  theme?: Theme;
  csrf?: string;
  path?: string; // current path and query: the theme form comes back here, the switcher and search read it
  nav?: Nav;
  shell?: Shell; // absent on a page answering a form: the bar then shows no counts
};

const UUID_AT = /^\/v\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?]|$)/;

const agoText = (iso: string): string => relativeTime(iso);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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
      <summary class="button quiet icon-button" aria-label="${total ? `Inbox, ${total} waiting` : "Inbox, nothing waiting"}"${current("inbox")}>${ICON_INBOX}${total ? html`<span class="count" aria-hidden="true">${total > 99 ? "99+" : total}</span>` : ""}</summary>
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
      <summary class="button quiet account-button" aria-label="Account menu"${current("settings", "account", "connections")}><span class="avatar" aria-hidden="true">${who ? initial(who) : "?"}</span><span class="account-name">${label}</span></summary>
      <div class="menu account-menu">
        <p class="menu-who">Signed in as <strong>${label}</strong>${
          s?.me.name && s.me.email ? html`<span class="menu-meta">${s.me.email}</span>` : ""}${
          accountMode === "local" ? html`<span class="menu-meta">Local sign-in (dev.sh)</span>` : ""}</p>
        <ul class="menu-list">
          <li><a href="/settings"${current("settings")}>Account settings</a></li>
          <li><a href="/account"${current("account")}>Plan and usage</a></li>
          <li><a href="/connections"${current("connections")}>Connections</a></li>
          <li><a href="/feedback?from=${encodeURIComponent(path)}"${current("feedback")}>Send feedback</a></li>
          <li><a href="/welcome"${current("welcome")}>Welcome tour</a></li>
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
    ${opts.csrf ? feedbackPop(opts.csrf, path, opts.nav === "feedback") : ""}
    ${inbox}
    ${account}
  </div>
  </div>
</header>`;
}

// Feedback ------------------------------------------------------------------

// The kinds of feedback (public.send_feedback), for the top bar's button and
// the Feedback page (feedback.ts).
export const FEEDBACK_KINDS = [
  { id: "bug", label: "Bug", hint: "Something broke or didn’t do what it said" },
  { id: "idea", label: "Idea", hint: "Something that would help" },
  { id: "question", label: "Question", hint: "Something you couldn’t work out" },
  { id: "other", label: "Other", hint: "Anything else" },
] as const;
export const FEEDBACK_MAX = 5000;

const ICON_FEEDBACK = raw(
  '<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M2.5 2h11c.8 0 1.5.7 1.5 1.5v7c0 .8-.7 1.5-1.5 1.5H8.3l-3.1 2.6c-.5.4-1.2 0-1.2-.6V12H2.5C1.7 12 1 11.3 1 10.5v-7C1 2.7 1.7 2 2.5 2Zm0 1.5v7h3v1.9l2.3-1.9h5.7v-7h-11ZM4 5.5h8V7H4V5.5Zm0 2.5h5v1.5H4V8Z"/></svg>',
);

// The Feedback button in the top bar: a short form in a <details> popover
// (no script), posting to /feedback (feedback.ts) with the page it sits on.
// The address feedback names for a page. An invite link's token is a bearer
// secret and a sign-in code or OAuth request is as good as one, so for those
// pages (and a search, which is the person's own words) it is the page without
// its query: feedback is stored and emailed to the operator, and the box that
// sends the page is ticked by default.
const FEEDBACK_NO_QUERY = /^\/(?:invite|login|signin|oauth\/authorize|search)(?:[/?]|$)|^\/v\/[0-9a-f-]{36}\/search(?:[/?]|$)/;
export function feedbackPath(path: string): string {
  const here = path.startsWith("/") && !path.startsWith("//") ? path : "/";
  return (FEEDBACK_NO_QUERY.test(here) ? here.split(/[?#]/)[0] : here).slice(0, 500);
}

function feedbackPop(csrf: string, path: string, current: boolean): Raw {
  const here = feedbackPath(path);
  const shown = here.length > 48 ? `${here.slice(0, 45)}...` : here;
  return html`<details class="menu-wrap feedback-pop">
      <summary class="button quiet icon-button feedback-button"${current ? raw(' aria-current="page"') : ""}>${ICON_FEEDBACK}<span class="feedback-label">Feedback</span></summary>
      <div class="menu feedback-menu">
        <p class="menu-head"><span class="menu-label">Send feedback</span><a href="/feedback">Your feedback</a></p>
        <form method="post" action="/feedback" class="feedback-form">
          ${csrfField(csrf)}<input type="hidden" name="page" value="${here}">
          <fieldset class="feedback-kinds"><legend class="sr-only">What is it?</legend>${FEEDBACK_KINDS.map(
            (k, i) => html`<label title="${k.hint}"><input type="radio" name="kind" value="${k.id}"${i === 0 ? raw(" required") : ""}> ${k.label}</label>`,
          )}</fieldset>
          <label class="sr-only" for="feedback-pop-message">Message</label>
          <textarea id="feedback-pop-message" name="message" rows="4" required maxlength="${FEEDBACK_MAX}" placeholder="What happened, or what would help?"></textarea>
          <label class="feedback-include"><input type="checkbox" name="include_page" value="1" checked> Include this page <code>${shown}</code></label>
          <p class="hint">Goes to the people who run this Reliquary. Never paste secrets, tokens or variable values.</p>
          <div class="actions"><button class="primary">Send</button></div>
        </form>
      </div>
    </details>`;
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
${placeFlash(body, opts.flash)}
</main>
<footer><span>Reliquary by Red Mage</span>${footerLinks()}${versionLink()}</footer>
</body>
</html>`.html;
}

// A plain message page (sign-in, errors) in the same frame.
export function notice(title: string, message: Raw | string, theme?: Theme): string {
  return page(title, html`<h1>${title}</h1><p class="lede">${message}</p>`, { theme });
}

// The exact time as text ("2026-09-26 06:49 UTC"). For markup, time() below.
export function when(d: Date | null | undefined): string {
  if (!d) return "";
  return utc(d);
}

// Hidden field carrying the CSRF token for every form.
export const csrfField = (token: string) => html`<input type="hidden" name="csrf" value="${token}">`;

// A text to put inside <textarea>…</textarea>. Browsers drop one newline
// right after the opening tag, so a text that starts with a newline would
// lose it on every save unless there is one more in front.
export const textareaText = (text: string | null | undefined): Raw => html`${/^[\r\n]/.test(text ?? "") ? "\n" : ""}${text ?? ""}`;

// ---------------------------------------------------------------------------
// Components. The shared parts every page builds from; the inventory, with
// when to use each, is in docs/research/ui-design-system.md ("Components as
// built"). Each returns Raw and escapes whatever text it is given.

export type { Flash, Tone } from "./flash.js";

// Time --------------------------------------------------------------------------

// "2026-09-26 06:49 UTC": the exact time, for a title or where exactness is
// the point (an expiry, an error's timestamp).
export const utc = (d: Date) => d.toISOString().replace("T", " ").slice(0, 16) + " UTC";

const asDate = (d: Date | string | number | null | undefined): Date | undefined => {
  if (d === null || d === undefined || d === "") return undefined;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isFinite(x.getTime()) ? x : undefined;
};

// "just now", "6 min ago", "3 h ago", "4 days ago", and ahead of now "in 6
// min" and so on; past 30 days either way, the date ("2026-08-01").
export function relativeTime(d: Date | string | number | null | undefined, now = Date.now()): string {
  const x = asDate(d);
  if (!x) return "";
  const s = (now - x.getTime()) / 1000;
  const a = Math.abs(s);
  const say = (n: number, unit: string) => (s >= 0 ? `${n} ${unit} ago` : `in ${n} ${unit}`);
  if (a < 90) return "just now";
  if (a < 5400) return say(Math.round(a / 60), "min");
  if (a < 129600) return say(Math.round(a / 3600), "h");
  if (a < 30 * 86400) return say(Math.round(a / 86400), "days");
  return x.toISOString().slice(0, 10);
}

// One way to show a time: relative, with the exact UTC time in the title
// and the machine form in datetime. { absolute: true } shows the UTC time
// itself (expiries, timestamps to copy). Never wraps (style.css), so "UTC"
// doesn't end up alone on a line. Nothing for a missing or invalid time.
export function time(d: Date | string | number | null | undefined, o: { absolute?: boolean; now?: number } = {}): Raw {
  const x = asDate(d);
  if (!x) return raw("");
  return o.absolute
    ? html`<time datetime="${x.toISOString()}">${utc(x)}</time>`
    : html`<time datetime="${x.toISOString()}" title="${utc(x)}">${relativeTime(x, o.now)}</time>`;
}

// Breadcrumbs -----------------------------------------------------------------

// Where a page sits, from the vault down: vault / folder / … / this page.
// A part with an href is a link; the last part is the current page (not a
// link, aria-current="page") whether or not it has one.
export type CrumbPart = { label: string; href?: string };
export function crumb(parts: CrumbPart[]): Raw {
  if (!parts.length) return raw("");
  const last = parts.length - 1;
  return html`<nav class="crumb" aria-label="Breadcrumb"><ol>${parts.map((p, i) =>
    i === last
      ? html`<li aria-current="page">${p.label}</li>`
      : p.href
        ? html`<li><a href="${p.href}">${p.label}</a></li>`
        : html`<li>${p.label}</li>`,
  )}</ol></nav>`;
}

// Tabs ------------------------------------------------------------------------

// Links styled as tabs, flush under a page header: the current one marked
// with aria-current, an optional count in a pill.
export type Tab = { href: string; label: string; count?: number; current?: boolean };
export function tabs(list: Tab[], label = "Sections"): Raw {
  if (!list.length) return raw("");
  return html`<nav class="tabs" aria-label="${label}">${list.map(
    (t) =>
      html`<a href="${t.href}"${t.current ? raw(' aria-current="page"') : ""}>${t.label}${
        t.count !== undefined ? html`<span class="count">${t.count}</span>` : ""
      }</a>`,
  )}</nav>`;
}

// Page header -----------------------------------------------------------------

// Where the flash goes: right after the page header, in the page's content
// column (page() puts it there). A comment with a per-process random name,
// so no text on a page (escaped, or rendered markdown) can place one.
const FLASH_SLOT = `<!--flash-${randomBytes(8).toString("hex")}-->`;

// The top of a page: breadcrumb, then the title with an optional status
// badge and the page's actions (right-aligned on wide screens, wrapping
// below the title on narrow ones), then a one-sentence description, a meta
// line and tabs. Controls live here, at the top, never only at the bottom
// (the owner's rule). Actions go secondary first, then the one primary,
// last. A submit button for a form further down uses the form="" attribute
// (no script); it only submits a form whose required fields are on the
// first screen. `actions` is the older slot: everything in it goes before
// `secondary` and `primary`.
export function pageHeader(o: {
  title: Raw | string;
  crumb?: Raw | CrumbPart[];
  badge?: Raw;
  description?: Raw | string;
  meta?: Raw;
  actions?: Raw | "";
  secondary?: Raw | "";
  primary?: Raw | "";
  tabs?: Tab[];
  tabsLabel?: string;
  path?: boolean; // the title is a file path or name: long, may need to break
}): Raw {
  const acts = [o.actions, o.secondary, o.primary].filter((a): a is Raw => a instanceof Raw && a.html.trim() !== "");
  const top = Array.isArray(o.crumb) ? crumb(o.crumb) : (o.crumb ?? "");
  return html`<div class="page-head${o.tabs?.length ? " has-tabs" : ""}">
    ${top}
    <div class="page-title-row">
      <div class="page-title"><h1${o.path ? raw(' class="path"') : ""}>${o.title}</h1>${o.badge ?? ""}</div>
      ${acts.length ? html`<div class="page-actions">${acts}</div>` : ""}
    </div>
    ${o.description ? html`<p class="page-desc">${o.description}</p>` : ""}
    ${o.meta ?? ""}
    ${o.tabs?.length ? tabs(o.tabs, o.tabsLabel) : ""}
  </div>${raw(FLASH_SLOT)}`;
}

// Flash -------------------------------------------------------------------------

// The message a form left for the next page, in its tone: danger is an
// alert (read out at once), the rest a status.
export function flashMessage(f: Flash | string): Raw {
  const x = typeof f === "string" ? toFlash(f) : f;
  return html`<p class="callout ${x.tone} flash" role="${x.tone === "danger" ? "alert" : "status"}">${x.text}</p>`;
}

// The page body with the flash placed: after the page header when the page
// has one (so, in a vault, in the content column beside the sidebar), else
// at the top of <main>.
export function placeFlash(body: Raw, f: Flash | string | undefined): Raw {
  const at = body.html.indexOf(FLASH_SLOT);
  const shown = f ? flashMessage(f).html : "";
  if (at < 0) return raw(shown + body.html);
  return raw(body.html.slice(0, at) + shown + body.html.slice(at + FLASH_SLOT.length).replaceAll(FLASH_SLOT, ""));
}

// Callouts --------------------------------------------------------------------

// A boxed message in a tone: info (context), success (done), warning (check
// this first), danger (refused or destructive; an alert, read out at once).
// A string body is one paragraph; a Raw body is used as it is.
export function callout(tone: Tone, body: Raw | string, o: { title?: string; id?: string } = {}): Raw {
  return html`<div class="callout ${tone}"${tone === "danger" ? raw(' role="alert"') : ""}${o.id ? html` id="${o.id}"` : ""}>${
    o.title ? html`<p class="callout-title"><strong>${o.title}</strong></p>` : ""
  }${typeof body === "string" ? html`<p>${body}</p>` : body}</div>`;
}

// Badges ------------------------------------------------------------------------

// Canon and open: a filled or hollow diamond (drawn in CSS) and the word,
// with what the word means in the title, so the policy never rests on the
// mark alone and the term is explained wherever it appears.
export const POLICY_HELP: Record<string, string> = {
  canon: "Canon: changes are proposals that people approve",
  open: "Open: members and agents write directly",
};
export function policyBadge(policy: string): Raw {
  const label = policy === "canon" ? "Canon" : policy === "open" ? "Open" : policy;
  const help = POLICY_HELP[policy];
  return help
    ? html`<span class="badge policy ${policy}" title="${help}">${label}</span>`
    : html`<span class="badge">${label}</span>`;
}

// Menus -----------------------------------------------------------------------

// An action menu (More, ⋯, Snooze): a <details> whose summary is a button,
// opened with Enter or Space, closed the same way; its items are links, or
// one-button forms (POST with the CSRF token) for actions. No script (the
// CSP forbids it), and no role="menu", which would promise arrow keys: the
// items are a list you Tab through. Destructive items say so (danger) and
// should lead to a confirm page rather than act at once.
const ICON_MORE = raw(
  '<svg class="icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Zm5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3Z"/></svg>',
);
export type MenuItem =
  | { href: string; label: string; description?: string; danger?: boolean; current?: boolean }
  | { action: string; csrf: string; fields?: Record<string, string>; label: string; description?: string; danger?: boolean };
export function menu(o: {
  label: string; // the button's text; with icon "more", its accessible name
  items: MenuItem[];
  icon?: "more"; // a ⋯ button instead of a text one
  heading?: string; // a line at the top of the open menu
  align?: "left" | "right"; // which edge the menu lines up with (default right)
  ghost?: boolean; // a ghost button rather than a secondary one
  className?: string;
}): Raw {
  const item = (i: MenuItem) => {
    const inner = html`<span class="menu-item-title">${i.label}</span>${i.description ? html`<span class="menu-item-meta">${i.description}</span>` : ""}`;
    const cls = `menu-item${i.danger ? " danger" : ""}`;
    if ("href" in i) return html`<li><a class="${cls}" href="${i.href}"${i.current ? raw(' aria-current="page"') : ""}>${inner}</a></li>`;
    return html`<li><form method="post" action="${i.action}">${csrfField(i.csrf)}${hiddenFields(i.fields)}<button class="${cls}">${inner}</button></form></li>`;
  };
  const summary =
    o.icon === "more"
      ? html`<summary class="button quiet icon-button" aria-label="${o.label}" title="${o.label}">${ICON_MORE}</summary>`
      : html`<summary class="button${o.ghost ? " quiet" : ""}">${o.label}</summary>`;
  // A ⋯ button is a table row's menu: var-menu (named for Variables, where
  // it began) opens the list from the button, not the cell, so the table's
  // overflow never clips it.
  const cls = [o.icon === "more" ? "var-menu" : "", o.className ?? ""].filter(Boolean).join(" ");
  return html`<details class="menu-wrap action-menu${cls ? ` ${cls}` : ""}">
    ${summary}
    <div class="menu action-list${o.align === "left" ? " menu-left" : ""}">
      ${o.heading ? html`<p class="menu-label">${o.heading}</p>` : ""}
      <ul class="menu-list">${o.items.map(item)}</ul>
    </div>
  </details>`;
}

const hiddenFields = (fields: Record<string, string> = {}) =>
  Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`);

// Empty states ----------------------------------------------------------------

// What's missing, when it will appear, and the action that fills it (a
// secondary button or a link). Filtered to nothing: say so and offer
// "Clear filters", not a create button.
export function emptyState(o: { title: string; body?: Raw | string; action?: Raw }): Raw {
  return html`<div class="empty"><strong>${o.title}</strong>${o.body ? html`<p>${o.body}</p>` : ""}${
    o.action ? html`<p class="empty-action">${o.action}</p>` : ""
  }</div>`;
}

// Confirm pages ------------------------------------------------------------------

// A destructive action's confirm step: the header (with where it happens),
// what will happen in one sentence, the consequences as a list, and a form
// with the danger button (repeating the verb and the object: "Revoke Claude
// Code on laptop") and Cancel. `typed` asks for a name typed exactly (the
// database checks it; this only asks). `error` re-renders it after a wrong
// name, as an alert. Returns the body; the caller renders it (status 400
// with an error).
export function confirmPage(o: {
  title: string;
  crumb?: Raw | CrumbPart[];
  lede: Raw | string;
  consequences?: (Raw | string)[];
  action: string;
  csrf: string;
  fields?: Record<string, string>;
  typed?: { value: string; name?: string; label?: Raw | string };
  button: string;
  cancel: string; // where Cancel goes: the page the person came from
  // For a confirm whose danger button is itself a "Cancel …" (cancelling a
  // task), so the two controls don't read the same and mean opposites.
  cancelLabel?: string;
  error?: string;
}): Raw {
  const t = o.typed;
  return html`${pageHeader({ crumb: o.crumb, title: o.title })}
    ${o.error ? callout("danger", o.error) : ""}
    <p class="lede confirm-lede">${o.lede}</p>
    ${o.consequences?.length ? html`<ul class="consequences">${o.consequences.map((c) => html`<li>${c}</li>`)}</ul>` : ""}
    <form method="post" action="${o.action}" class="panel confirm">
      ${csrfField(o.csrf)}${hiddenFields(o.fields)}
      ${t
        ? html`<label for="confirm-typed">${t.label ?? html`Type <strong>${t.value}</strong> to confirm`}</label>
          <input id="confirm-typed" type="text" name="${t.name ?? "confirm_name"}" required autocomplete="off" spellcheck="false" autocapitalize="off">`
        : ""}
      <div class="actions"><button class="danger solid">${o.button}</button><a class="button quiet" href="${o.cancel}">${o.cancelLabel ?? "Cancel"}</a></div>
    </form>`;
}
