// The lines a search result shows: up to three lines that hold a searched
// word, numbered, each cut at 200 characters; the first non-blank line when
// only the path matched; the first three non-blank lines of its best chunk
// (`s.line`, from public.search) when it was found by meaning alone. The same shape as the MCP server's SEARCH_SQL
// (mcp/src/vaultfiles-tools.ts; separate deployables, no shared package),
// so a person and their agent see the same lines. The database picks them,
// so no file's whole text leaves it for a snippet.

import { html, type Raw } from "./html.js";

// mcp/src/vaultfiles-tools.ts queryTerms: the words of a websearch query,
// quotes, `or` and -exclusions dropped. The database already decided which
// files match; this only chooses their lines.
export function queryTerms(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/"/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "or" && !w.startsWith("-"))
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
}

const LINES = 3;
const CHARS = 200;
// JavaScript's trim() whitespace, for "blank".
const JS_SPACE = "\\t\\n\\u000b\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";

// A select-list column over a search row `s`; the terms are $3 in both
// callers (search.ts, rules.ts).
export const LINES_SQL = `
  coalesce(
    (select json_agg(json_build_array(m.n, left(m.line, ${CHARS + 1})) order by m.n)
       from (select l.line, l.n from string_to_table(s.body, E'\\n') with ordinality l(line, n)
              where exists (select 1 from unnest($3::text[]) t where strpos(lower(l.line), t) > 0)
              order by l.n limit ${LINES}) m),
    (select json_agg(json_build_array(m.n, left(m.line, ${CHARS + 1})))
       from (select l.line, l.n from string_to_table(s.body, E'\\n') with ordinality l(line, n)
              where l.line ~ '[^${JS_SPACE}]' and l.n >= coalesce(s.line, 1)
              order by l.n limit case when s.line is null then 1 else ${LINES} end) m),
    '[]') as lines`;

const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The lines as HTML, each searched word in <mark>. Every piece of file text
// goes through html``, so it is escaped.
export function snippetLines(lines: [number, string][], terms: string[]): Raw {
  const words = terms.length ? new RegExp(`(${terms.map(reEscape).join("|")})`, "giu") : null;
  const mark = (line: string) =>
    (words ? line.split(words) : [line]).map((part, i) => (i % 2 ? html`<mark>${part}</mark>` : html`${part}`));
  return html`<span class="snippet">${lines.map(([n, l]) => {
    const text = l.length > CHARS ? l.slice(0, CHARS) + "…" : l;
    return html`<span class="snippet-line"><span class="line-no">${n}</span> ${mark(text)}</span>`;
  })}</span>`;
}
