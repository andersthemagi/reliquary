// Search across every vault the person is in: the top bar's search box
// (html.ts) sends GET /search?q=. One query: public.search (the same one a
// vault's own search and the MCP `search` tool use, security invoker, so
// RLS decides) run for each of the reader's vaults, the best matches first.
// A vault's own search, from its sidebar, stays at /v/<vault>/search.

import { asPerson } from "./db.js";
import { emptyState, html, pageHeader } from "./html.js";
import { render, type Ctx, type Reply } from "./pages.js";
import { LINES_SQL, queryTerms, snippetLines } from "./searchlines.js";

// Matches per vault, and in all.
const PER_VAULT = 10;
const TOTAL = 50;
// Vaults searched, by name: far more than any plan allows a person to own.
const VAULTS = 100;

const badge = (policy: string) =>
  html`<span class="badge policy ${policy}">${policy === "canon" ? "Canon" : policy === "open" ? "Open" : policy}</span>`;

type Hit = { vault_id: string; vault: string; path: string; policy: string; lines: [number, string][] };

export async function searchAll(ctx: Ctx): Promise<Reply> {
  const query = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const terms = queryTerms(query);
  const searched = `select v.id, v.name from public.vaults v
                       join public.vault_members m on m.vault_id = v.id and m.user_id = $1
                      order by v.name, v.id limit ${VAULTS}`;
  const rows: Hit[] = query
    ? await asPerson(ctx.userId, async (c) => {
        const { rows } = await c.query(
          `select v.id as vault_id, v.name as vault, s.path, s.policy, ${LINES_SQL}
             from (${searched}) v
            cross join lateral public.search(v.id, $2, ${PER_VAULT}) s
            order by s.rank desc, s.updated_at desc
            limit ${TOTAL}`,
          [ctx.userId, query, terms],
        );
        // Below TOTAL every vault's matches are here, so a vault with none
        // found nothing: noted for its owners (20261017130000_missed_searches.sql).
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
