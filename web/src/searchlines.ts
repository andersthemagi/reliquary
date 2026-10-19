// A vault's search for the web app's two search pages, over the shared
// search.ts (the same file as the MCP server's, so a person and their
// agent see the same files and lines), and the lines a result shows as HTML.

import type pg from "pg";
import { openBody } from "./content.js";
import { minSimilarity } from "./embeddings.js";
import { html, type Raw } from "./html.js";
import { capNote, queryTerms, rankFiles, SEARCH_CAP, type Candidate, type Hit, type Vector } from "./search.js";

export { queryTerms };

const CHARS = 200;

// One vault's search, done here (search.ts): public.search_files gives its
// newest files under RLS, up to SEARCH_CAP, which this server opens; with
// `vector` (the query's, from queryVector) the stored vectors come too.
// `note` says when the vault had more files than were read.
export async function searchVault(c: pg.PoolClient, vault: string, query: string, limit: number, vector: number[] | null): Promise<{ hits: Hit[]; note: string }> {
  const { rows } = await c.query(`select path, policy, body, updated_at, author, agent, total from public.search_files($1, $2)`, [vault, SEARCH_CAP]);
  const files: Candidate[] = rows.map((r) => ({ ...r, body: openBody(r.body, vault) }));
  const vectors: Vector[] = vector
    ? (
        await c.query(
          `select f.path, e.line, e.embedding
             from public.file_embeddings e
             join public.files f on f.id = e.file_id and f.current_version_id = e.version_id and f.deleted_at is null
            where e.vault_id = $1`,
          [vault],
        )
      ).rows
    : [];
  return { hits: rankFiles(files, query, limit, vector, minSimilarity(), vectors), note: rows.length ? capNote(Number(rows[0].total), rows.length) : "" };
}

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
