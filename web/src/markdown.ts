// Markdown rendering for file previews. Raw HTML in files is escaped, never
// rendered; links are limited to http(s), mailto and relative paths; images
// only load from this origin anyway (CSP img-src 'self').

import MarkdownIt from "markdown-it";

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

const SAFE_LINK = /^(https?:|mailto:|#|\/(?!\/)|\.{0,2}\/|[^:]*$)/i;
md.validateLink = (url: string) => SAFE_LINK.test(url.trim());

type Rule = NonNullable<typeof md.renderer.rules.link_open>;
const defaultLink: Rule =
  md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = String(tokens[idx].attrGet("href") ?? "");
  if (/^https?:/i.test(href)) {
    tokens[idx].attrSet("rel", "noopener noreferrer nofollow");
  }
  return defaultLink(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}
