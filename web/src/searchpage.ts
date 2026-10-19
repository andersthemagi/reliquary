// Search across every vault the person is in: the top bar's search box
// (html.ts) sends GET /search?q=. One query: public.search (the same one a
// vault's own search and the MCP `search` tool use, security invoker, so
// RLS decides) run for each of the reader's vaults, the best matches first.
// A vault's own search, from its sidebar, stays at /v/<vault>/search.

import { asPerson } from "./db.js";
import { minSimilarity, queryVector } from "./embeddings.js";
import { callout, emptyState, html, pageHeader } from "./html.js";
import { render, type Ctx, type Reply } from "./pages.js";
import { openBody } from "./content.js";
import { capNote, rankFiles, SEARCH_CAP, type Candidate } from "./search.js";
import { queryTerms, snippetLines } from "./searchlines.js";

// Matches per vault, and in all.
const PER_VAULT = 10;
const TOTAL = 50;
// Vaults searched, by name: far more than any plan allows a person to own.
const VAULTS = 100;

const badge = (policy: string) =>
  html`<span class="badge policy ${policy}">${policy === "canon" ? "Canon" : policy === "open" ? "Open" : policy}</span>`;

type Hit = { vault_id: string; vault: string; path: string; policy: string; lines: [number, string][]; rank: number; updated_at: Date };

export async function searchAll(ctx: Ctx): Promise<Reply> {
  const query = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const terms = queryTerms(query);
  const searched = `select v.id, v.name from public.vaults v
                       join public.vault_members m on m.vault_id = v.id and m.user_id = $1
                      order by v.name, v.id limit ${VAULTS}`;
  let note = "";
  const rows: Hit[] = query
    ? await asPerson(ctx.userId, async (c) => {
        // One embedding of the question serves every vault's search; the
        // same call embeds what those vaults have queued (embeddings.ts).
        const ids = (await c.query(`select v.id from (${searched}) v`, [ctx.userId])).rows.map((r) => r.id as string);
        const embedded = await queryVector(c, ids, query);
        const { rows: files } = await c.query(
          `select v.id as vault_id, v.name as vault, s.path, s.policy, s.body, s.updated_at, s.author, s.agent, s.total
             from (${searched}) v cross join lateral public.search_files(v.id, $2) s`,
          [ctx.userId, SEARCH_CAP],
        );
        // ponytail: every vault's files are read and ranked here on each
        // search (search.ts); a person with many large vaults pays for it.
        // Rank in the database again when that shows.
        const vectors = embedded.vector
          ? (
              await c.query(
                `select e.vault_id, f.path, e.line, e.embedding
                   from public.file_embeddings e
                   join public.files f on f.id = e.file_id and f.current_version_id = e.version_id and f.deleted_at is null
                  where e.vault_id = any($1::uuid[])`,
                [ids],
              )
            ).rows
          : [];
        const caps: string[] = [];
        const rows: Hit[] = [];
        for (const id of ids) {
          const own = files.filter((f) => f.vault_id === id);
          if (own.length === 0) continue;
          const cap = capNote(Number(own[0].total), own.length);
          if (cap) caps.push(`In ${own[0].vault}: ${cap}`);
          const candidates: Candidate[] = own.map((f) => ({ ...f, body: openBody(f.body, id) }));
          for (const h of rankFiles(candidates, query, PER_VAULT, embedded.vector, minSimilarity(), vectors.filter((v) => v.vault_id === id))) {
            rows.push({ vault_id: id, vault: own[0].vault, path: h.path, policy: h.policy, lines: h.lines, rank: h.rank, updated_at: h.updated_at });
          }
        }
        rows.sort((a, b) => b.rank - a.rank || b.updated_at.getTime() - a.updated_at.getTime());
        rows.splice(TOTAL);
        note = [...caps, embedded.note].filter(Boolean).join(" ");
        // Below TOTAL every vault's matches are here, so a vault with none
        // found nothing: noted for its owners (20261017140000_missed_searches.sql).
        // At TOTAL a vault may be missing only because others filled the page.
        if (rows.length < TOTAL)
          await c.query(`select private.note_missed_search(v.id, $2) from (${searched}) v where v.id <> all($3::uuid[])`, [
            ctx.userId,
            query,
            rows.map((r) => r.vault_id),
          ]);
        return rows;
      })
    : [];
  const vaults = new Set(rows.map((r) => r.vault_id)).size;
  const body = html`
    ${pageHeader({ title: "Search" })}
    <form class="search-page" method="get" action="/search" role="search">
      <label for="sq">Search file names and text in all your vaults</label>
      <div class="inline-field">
        <input id="sq" type="search" name="q" value="${query}" maxlength="200">
        <button>Search</button>
      </div>
      <p class="hint">Use quotes for a phrase, or <code>or</code> between words. To search one vault, use the search in its sidebar.</p>
    </form>
    ${note ? callout("warning", note) : ""}
    ${query
      ? rows.length
        ? html`<p class="muted small">${rows.length}${rows.length === TOTAL ? "+" : ""} result${rows.length === 1 ? "" : "s"} for “${query}” in ${vaults} ${vaults === 1 ? "vault" : "vaults"}</p>
          <ul class="rows results">${rows.map(
            (r) => html`<li><span><a class="name" href="/v/${r.vault_id}/file?path=${encodeURIComponent(r.path)}">${r.path}</a> ${badge(r.policy)}
              <span class="muted small"> · ${r.vault}</span>
              ${snippetLines(r.lines, terms)}</span></li>`,
          )}</ul>`
        : emptyState({ title: `Nothing in your vaults matches “${query}”`, body: "Try fewer words, or part of a file name." })
      : ""}`;
  return render(ctx, query ? `Search: ${query}` : "Search", body, "search");
}
