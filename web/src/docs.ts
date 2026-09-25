// The public docs at /docs: server-rendered from docs-build/ (made by
// scripts/gen-docs.mjs from docs/public/ at build time), in the public site's
// frame, with no script. Every page is also served as its Markdown at
// /docs/<slug>.md for agents, and /llms.txt and /llms-full.txt index and
// concatenate them (https://llmstxt.org).
//
// Only pages the build's manifest names are served: a request path is looked
// up in a map, never joined onto the filesystem. Without docs-build/ (a
// build that skipped gen-docs), /docs answers 404 and nothing else changes.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRE_ALPHA, html, preAlphaNote, raw, type Raw, type Theme } from "./html.js";
import { renderDocMarkdown } from "./markdown.js";
import { siteOrigin, sitePage } from "./site.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs-build");

type Page = { slug: string; title: string; navTitle: string; summary: string; section: string; source: string };
type RoadmapItem = { title: string; summary: string; status: string; milestone?: string; issue?: string; docs?: string; version?: string };
type Docs = { sections: { title: string; pages: Page[] }[]; bySlug: Map<string, Page>; order: Page[]; roadmap: RoadmapItem[] };

let loaded: Docs | null | undefined;
function docs(): Docs | null {
  if (loaded !== undefined) return loaded;
  try {
    const manifest = JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as {
      sections: { title: string; pages: Omit<Page, "section" | "source">[] }[];
    };
    const sections = manifest.sections.map((s) => ({
      title: s.title,
      pages: s.pages.map((p) => ({ ...p, section: s.title, source: readFileSync(join(DIR, `${p.slug}.md`), "utf8") })),
    }));
    const order = sections.flatMap((s) => s.pages);
    const roadmap = JSON.parse(readFileSync(join(DIR, "roadmap.json"), "utf8")) as RoadmapItem[];
    loaded = { sections, order, bySlug: new Map(order.map((p) => [p.slug, p])), roadmap };
  } catch {
    loaded = null;
  }
  return loaded;
}

export const pageUrl = (slug: string) => (slug === "index" ? "/docs" : `/docs/${slug}`);
const rawUrl = (slug: string) => `/docs/${slug}.md`;

// The public paths of the roadmap and every docs page, for the sitemap.
export function docsPaths(): string[] {
  const d = docs();
  return d ? ["/roadmap", ...d.order.map((p) => pageUrl(p.slug))] : [];
}

// A link as a page's Markdown writes it (relative to the page's own file,
// like `../concepts/vaults.md#tokens`) -> the site path it means
// (`/docs/concepts/vaults#tokens`). Absolute paths, anchors and other
// schemes are left alone.
function resolver(fromSlug: string): (href: string) => string {
  return (href) => {
    if (!href || href.startsWith("/") || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return href;
    const u = new URL(href, `http://docs.invalid/docs/${fromSlug}.md`);
    if (u.host !== "docs.invalid") return href;
    let path = u.pathname;
    if (path.endsWith(".md")) path = path === "/docs/index.md" ? "/docs" : path.slice(0, -3);
    return path + u.search + u.hash;
  };
}

// For llms-full.txt and /roadmap.md: every Markdown link as an absolute
// URL, docs pages as their Markdown (an agent follows them as text).
function absoluteLinks(p: Page): string {
  const resolve = resolver(p.slug);
  return p.source.replace(/\]\(([^)\s]+)\)/g, (_, href: string) => {
    let to = resolve(href);
    if (to.startsWith("/docs")) {
      const [path, hash = ""] = to.split("#");
      to = `${path === "/docs" ? "/docs/index" : path}.md${hash ? `#${hash}` : ""}`;
    }
    return `](${to.startsWith("/") ? siteOrigin + to : to})`;
  });
}

const rendered = new Map<string, ReturnType<typeof renderDocMarkdown>>();
function render(p: Page) {
  let r = rendered.get(p.slug);
  if (!r) {
    r = renderDocMarkdown(p.source, resolver(p.slug));
    rendered.set(p.slug, r);
  }
  return r;
}

function sidebar(d: Docs, current: string): Raw {
  return html`${d.sections.map(
    (s) => html`<div class="docs-nav-section">
      ${s.title ? html`<p class="docs-nav-title">${s.title}</p>` : ""}
      <ul>${s.pages.map(
        (p) => html`<li><a href="${pageUrl(p.slug)}"${p.slug === current ? raw(' aria-current="page"') : ""}>${p.navTitle}</a></li>`,
      )}</ul>
    </div>`,
  )}`;
}

function frame(d: Docs, current: string, article: Raw, aside: Raw | ""): Raw {
  return html`<div class="docs">
    <div class="docs-side"><nav aria-label="Docs">${sidebar(d, current)}</nav>${preAlphaNote()}</div>
    <details class="docs-menu"><summary>Docs menu</summary><nav aria-label="Docs menu">${sidebar(d, current)}</nav></details>
    <article class="docs-article">${article}</article>
    ${aside}
  </div>`;
}

function docPage(d: Docs, p: Page, theme: Theme): string {
  const { html: body, headings } = render(p);
  const toc = headings.filter((h) => h.level === 2 || h.level === 3);
  const i = d.order.indexOf(p);
  const prev = d.order[i - 1];
  const next = d.order[i + 1];
  const article = html`
    ${p.section ? html`<p class="crumb"><a href="/docs">Docs</a> / ${p.section}</p>` : ""}
    <div class="prose docs-prose">${raw(body)}</div>
    ${prev || next
      ? html`<nav class="docs-pager" aria-label="Previous and next">
      ${prev ? html`<a class="docs-prev" href="${pageUrl(prev.slug)}" rel="prev"><span>Previous</span>${prev.navTitle}</a>` : ""}
      ${next ? html`<a class="docs-next" href="${pageUrl(next.slug)}" rel="next"><span>Next</span>${next.navTitle}</a>` : ""}
    </nav>`
      : ""}
    <p class="docs-source">For agents: <a href="${rawUrl(p.slug)}">this page as Markdown</a>, and every page at <a href="/llms.txt">/llms.txt</a>.</p>`;
  const aside =
    toc.length >= 2
      ? html`<aside class="docs-toc"><nav aria-labelledby="docs-toc-title"><p class="docs-nav-title" id="docs-toc-title">On this page</p><ul>${toc.map(
          (h) => html`<li class="toc-${h.level}"><a href="#${h.id}">${h.text}</a></li>`,
        )}</ul></nav></aside>`
      : "";
  return sitePage({
    title: p.title,
    description: p.summary,
    path: pageUrl(p.slug),
    body: frame(d, p.slug, article, aside),
    theme,
    alternate: rawUrl(p.slug),
  });
}

function notFound(d: Docs | null, path: string, theme: Theme): DocsReply {
  const article = html`<h1>Page not found</h1><p class="lede">There’s no docs page at <code>${path}</code>. Start from the <a href="/docs">docs home</a>.</p>`;
  const body = d ? frame(d, "", article, "") : html`<div class="legal">${article}</div>`;
  return { status: 404, type: "text/html; charset=utf-8", body: sitePage({ title: "Page not found", description: "No docs page here.", path, body, theme }) };
}

// llms.txt: the site, then each section's pages with their summaries. The
// last section (the changelog) is "Optional", as the convention names what
// an agent may skip.
function llmsTxt(d: Docs): string {
  const home = d.bySlug.get("index");
  const lines = ["# Reliquary", "", `> ${home?.summary ?? ""}`, ""];
  lines.push(
    "Each page below is Markdown. Everything in one file: " + `${siteOrigin}/llms-full.txt`,
    "",
  );
  d.sections.forEach((s, n) => {
    const last = n === d.sections.length - 1 && d.sections.length > 1;
    lines.push(`## ${last ? "Optional" : s.title || "Start here"}`, "");
    for (const p of s.pages) lines.push(`- [${p.title}](${siteOrigin}${rawUrl(p.slug)}): ${p.summary}`);
    lines.push("");
  });
  return lines.join("\n");
}

function llmsFullTxt(d: Docs): string {
  return `${d.order.map((p) => `<!-- ${siteOrigin}${pageUrl(p.slug)} -->\n\n${absoluteLinks(p).trim()}\n`).join("\n\n")}`;
}

// /roadmap: docs/public/roadmap.yml as four columns. Shipped items link to
// their docs page and the changelog.
const ROADMAP_COLUMNS: [string, string][] = [
  ["shipped", "Shipped"],
  ["in-progress", "In progress"],
  ["planned", "Planned"],
  ["considering", "Considering"],
];
const SUGGEST = `mailto:andres@redmage.cc?subject=${encodeURIComponent("Reliquary feature suggestion")}`;

function roadmapPage(d: Docs, theme: Theme): string {
  const item = (it: RoadmapItem) => {
    const meta = [
      it.milestone ? html`<span>Milestone ${it.milestone.slice(1)}</span>` : "",
      it.version ? html`<span>In ${it.version}</span>` : "",
      it.issue ? html`<span>Issue #${it.issue}</span>` : "",
      it.docs && d.bySlug.has(it.docs) ? html`<a href="${pageUrl(it.docs)}">Docs</a>` : "",
      it.status === "shipped" ? html`<a href="/docs/changelog">Changelog</a>` : "",
    ].filter((m) => m !== "");
    return html`<li class="roadmap-item"><h3>${it.title}</h3><p>${it.summary}</p>${
      meta.length ? html`<p class="roadmap-meta">${meta}</p>` : ""
    }</li>`;
  };
  const body = html`<div class="roadmap-page">
    <h1>Roadmap</h1>
    <p class="lede">What Reliquary does today, what is being built, and what may come next. ${PRE_ALPHA}</p>
    <p class="roadmap-actions"><a class="button primary" href="${SUGGEST}">Suggest a feature</a> <a class="button" href="/docs/changelog">Changelog</a> <a class="button" href="/roadmap.md">As Markdown</a></p>
    <div class="roadmap">${ROADMAP_COLUMNS.map(([status, label]) => {
      const list = d.roadmap.filter((it) => it.status === status);
      return html`<section class="roadmap-col" aria-labelledby="rm-${status}">
        <h2 id="rm-${status}">${label} <span class="count">${list.length}</span></h2>
        ${list.length ? html`<ul class="roadmap-list">${list.map(item)}</ul>` : html`<p class="muted small">Nothing here yet.</p>`}
      </section>`;
    })}</div>
  </div>`;
  return sitePage({
    title: "Roadmap",
    description: "What Reliquary does today, what is being built, and what may come next.",
    path: "/roadmap",
    body,
    theme,
    alternate: "/roadmap.md",
  });
}

export type DocsReply = { status?: number; type: string; body: string };

const TEXT = "text/plain; charset=utf-8";
const MARKDOWN = "text/markdown; charset=utf-8";

// GET only (the caller checks). undefined: not a docs path.
export function docsRoute(path: string, theme: Theme): DocsReply | undefined {
  const isDocs = path === "/docs" || path.startsWith("/docs/") || path === "/roadmap";
  if (!isDocs && !["/llms.txt", "/llms-full.txt", "/roadmap.md"].includes(path)) return undefined;
  const d = docs();
  if (!d) return isDocs ? notFound(null, path, theme) : { status: 404, type: TEXT, body: "Docs aren't built on this server.\n" };
  if (path === "/llms.txt") return { type: TEXT, body: llmsTxt(d) };
  if (path === "/llms-full.txt") return { type: TEXT, body: llmsFullTxt(d) };
  if (path === "/roadmap") return { type: "text/html; charset=utf-8", body: roadmapPage(d, theme) };
  if (path === "/roadmap.md") {
    const p = d.bySlug.get("roadmap");
    return p ? { type: MARKDOWN, body: absoluteLinks(p) } : { status: 404, type: TEXT, body: "No roadmap.\n" };
  }
  if (path === "/docs" || path === "/docs/") return { type: "text/html; charset=utf-8", body: docPage(d, d.bySlug.get("index")!, theme) };
  const rest = path.slice("/docs/".length);
  if (rest.endsWith(".md")) {
    const p = d.bySlug.get(rest.slice(0, -3));
    return p ? { type: MARKDOWN, body: p.source } : { status: 404, type: TEXT, body: "No such docs page.\n" };
  }
  const p = rest === "index" ? undefined : d.bySlug.get(rest);
  return p ? { type: "text/html; charset=utf-8", body: docPage(d, p, theme) } : notFound(d, path, theme);
}
