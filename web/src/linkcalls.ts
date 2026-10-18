// A link's Calls page (issue #440; docs/design.md, "Links": "every proxied
// call is logged: who, which agent, which tool, the outcome and size"):
// what a shared account is being used for. Reads public.link_calls as the
// signed-in person; its writer_read policy (20260928120000_links.sql)
// returns rows to owners and editors only, so this page only chooses what
// to say to a viewer. The arguments and result were never stored, only
// their hashes, and the hashes aren't shown: they say nothing to a person.
//
//   GET /v/:id/links/:linkId/calls[?before=<id>]

import { asPerson } from "./db.js";
import { emptyState, html, pageHeader, raw, time, type Raw } from "./html.js";
import { formatBytes } from "./plans.js";
import { notFound, render, vault, vaultPath, who, type Ctx, type Reply } from "./pages.js";
import { vaultShell } from "./files.js";

const PAGE = 100;
const NONE = raw('<span class="muted" aria-label="none">—</span>');
const OUTCOME: Record<string, Raw> = {
  ok: html`<span class="badge success">OK</span>`,
  error: html`<span class="badge warning">Error</span>`,
  refused: html`<span class="badge danger">Refused</span>`,
};

type Call = { id: string; at: Date; actor: string | null; agent: string | null; tool_name: string; outcome: string; result_bytes: number | null };

export async function linkCalls(ctx: Ctx, id: string, linkId: string): Promise<Reply> {
  const cursor = ctx.url.searchParams.get("before") ?? "";
  const before = /^\d{1,18}$/.test(cursor) ? cursor : undefined;
  const base = vaultPath(id, `/links/${linkId}/calls`);
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const link = (await c.query(`select id, name from public.links where vault_id = $1 and id = $2`, [id, linkId])).rows[0] as
      | { id: string; name: string }
      | undefined;
    if (!link) return { gone: true as const };
    let table: Raw;
    if (v.role !== "owner" && v.role !== "editor") {
      table = emptyState({ title: "Only owners and editors can see a link’s calls." });
    } else {
      const rows: Call[] = (
        await c.query(
          `select id::text, at, actor, agent, tool_name, outcome, result_bytes from public.link_calls
            where vault_id = $1 and link_id = $2 and ($3::bigint is null or id < $3::bigint)
            order by link_calls.id desc limit $4`,
          [id, linkId, before ?? null, PAGE + 1],
        )
      ).rows;
      const more = rows.length > PAGE;
      const shown = rows.slice(0, PAGE);
      table = html`${shown.length
        ? html`<div class="table-wrap"><table class="table-stack link-calls">
            <thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">Tool</th><th scope="col">Outcome</th><th scope="col" class="num">Size</th></tr></thead>
            <tbody>${shown.map(
              (r) => html`<tr><td class="small" data-label="When"><div>${time(r.at)}</div></td>
                <td class="small" data-label="Who"><div>${who(ctx, r.actor, r.agent)}</div></td>
                <td data-label="Tool"><code>${link.name}.${r.tool_name}</code></td>
                <td data-label="Outcome">${OUTCOME[r.outcome] ?? r.outcome}</td>
                <td class="small num" data-label="Size">${r.result_bytes === null ? NONE : formatBytes(r.result_bytes)}</td></tr>`,
            )}</tbody></table></div>`
        : before
          ? emptyState({
              title: "No older calls",
              body: "This is where this link’s calls begin.",
              action: html`<a class="button" href="${base}">Back to the newest</a>`,
            })
          : emptyState({
              title: "No calls yet",
              body: html`No agent has called <code>${link.name}</code> yet. Each call shows here with who made it, through which agent, the tool, how it went and how much came back, newest first.`,
            })}
        ${more || (before && shown.length)
          ? html`<nav class="pager" aria-label="Pages">${before ? html`<a href="${base}">Newest</a>` : ""}${
              more ? html`<a class="older" href="${base}?before=${shown[shown.length - 1].id}">Older</a>` : ""
            }</nav>`
          : ""}`;
    }
    const body = html`
      ${pageHeader({
        crumb: [
          { label: v.name, href: vaultPath(id) },
          { label: "Links", href: vaultPath(id, "/links") },
          { label: `Calls to ${link.name}` },
        ],
        title: `Calls to ${link.name}`,
        description: "Every call an agent made through this link, newest first: who, which agent, which tool, how it went and the size of the answer. Arguments and answers are never stored.",
      })}
      ${table}
      <p class="hint">A refused call is one this link’s grants or the caller’s connection didn’t allow; nothing reached the service. <a href="/docs/concepts/links">How links work</a></p>`;
    return { link, shell: await vaultShell(c, ctx, v, { section: "links" }, body) };
  });
  if (!data) return notFound(ctx);
  if ("gone" in data) {
    ctx.setFlash("That link doesn’t exist; it may have been deleted already.", "warning");
    return { redirect: vaultPath(id, "/links") };
  }
  return render(ctx, `Calls to ${data.link.name}`, data.shell, "vaults");
}
