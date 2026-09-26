// Search across every vault the person is in: the top bar's search box
// (html.ts) sends GET /search?q=. One query: public.search (the same one a
// vault's own search and the MCP `search` tool use, security invoker, so
// RLS decides) run for each of the reader's vaults, the best matches first.
// A vault's own search, from its sidebar, stays at /v/<vault>/search.

import { asPerson } from "./db.js";
import { html, pageHeader } from "./html.js";
import { render, type Ctx, type Reply } from "./pages.js";

// Matches per vault, and in all.
const PER_VAULT = 10;
const TOTAL = 50;
// Vaults searched, by name: far more than any plan allows a person to own.
const VAULTS = 100;

const badge = (policy: string) =>
  html`<span class="badge policy ${policy}">${policy === "canon" ? "Canon" : policy === "open" ? "Open" : policy}</span>`;

type Hit = { vault_id: string; vault: string; path: string; policy: string; body: string };

export async function searchAll(ctx: Ctx): Promise<Reply> {
  const query = (ctx.url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const rows: Hit[] = query
    ? await asPerson(ctx.userId, async (c) =>
        (
          await c.query(
            // Only the start of each text, for its snippet.
            `select v.id as vault_id, v.name as vault, s.path, s.policy, left(s.body, 4000) as body
               from (select v.id, v.name from public.vaults v
                       join public.vault_members m on m.vault_id = v.id and m.user_id = $1
                      order by v.name, v.id limit ${VAULTS}) v
              cross join lateral public.search(v.id, $2, ${PER_VAULT}) s
              order by s.rank desc, s.updated_at desc
              limit ${TOTAL}`,
            [ctx.userId, query],
          )
        ).rows,
      )
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
              <span class="snippet">${r.body.replace(/\s+/g, " ").slice(0, 200)}</span></span></li>`,
          )}</ul>`
        : html`<div class="empty">Nothing in your vaults matches “${query}”. Try fewer words, or part of a file name.</div>`
      : ""}`;
  return render(ctx, query ? `Search: ${query}` : "Search", body, "search");
}
