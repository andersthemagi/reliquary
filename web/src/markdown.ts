// Markdown rendering for file previews. Raw HTML in files is escaped, never
// rendered; links are limited to http(s), mailto and relative paths; images
// only load from this origin anyway (CSP img-src 'self').
//
// The public docs (docs.ts) use the same renderer and the same limits, with
// two additions that apply only when rendering a docs page: headings get
// ids (for the table of contents and links to them), and relative links are
// resolved to absolute paths (so `../concepts/vaults.md` works from any URL).
// Tables wrap to scroll on narrow screens everywhere: a file or a proposal's
// text is as likely to hold a wide table as a docs page is.

import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

const SAFE_LINK = /^(https?:|mailto:|#|\/(?!\/)|\.{0,2}\/|[^:]*$)/i;
md.validateLink = (url: string) => SAFE_LINK.test(url.trim());

// What a docs render collects and needs. Absent for file previews.
export type DocEnv = {
  resolve: (href: string) => string; // a link as written -> the href to use
  headings: { level: number; text: string; id: string }[];
};
const docEnv = (env: unknown): DocEnv | undefined =>
  env && typeof env === "object" && "headings" in env ? (env as DocEnv) : undefined;

type Rule = NonNullable<typeof md.renderer.rules.link_open>;
const defaultLink: Rule =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const doc = docEnv(env);
  if (doc) tokens[idx].attrSet("href", doc.resolve(String(tokens[idx].attrGet("href") ?? "")));
  const href = String(tokens[idx].attrGet("href") ?? "");
  if (/^https?:/i.test(href)) {
    tokens[idx].attrSet("rel", "noopener noreferrer nofollow");
  }
  return defaultLink(tokens, idx, options, env, self);
};

// A heading's id: its text, lower case, letters, digits, `_` and `-` kept,
// spaces to `-` (GitHub's rule, so links written for either work).
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const doc = docEnv(env);
  if (doc) {
    const text = (tokens[idx + 1]?.children ?? [])
      .filter((t) => t.type === "text" || t.type === "code_inline")
      .map((t) => t.content)
      .join("");
    const base = headingId(text) || "section";
    let id = base;
    for (let n = 2; doc.headings.some((h) => h.id === id); n++) id = `${base}-${n}`;
    doc.headings.push({ level: Number(tokens[idx].tag.slice(1)), text, id });
    tokens[idx].attrSet("id", id);
  }
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.table_open = (tokens, idx, options, _env, self) => `<div class="table-wrap">${self.renderToken(tokens, idx, options)}`;
md.renderer.rules.table_close = (tokens, idx, options, _env, self) => `${self.renderToken(tokens, idx, options)}</div>`;

export function renderMarkdown(source: string): string {
  return md.render(source);
}

// A docs page: the HTML, and its headings in order (level 1 to 6).
export function renderDocMarkdown(source: string, resolve: DocEnv["resolve"]): { html: string; headings: DocEnv["headings"] } {
  const env: DocEnv = { resolve, headings: [] };
  return { html: md.render(source, env), headings: env.headings };
}
