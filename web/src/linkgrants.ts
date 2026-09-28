// A link's tool grants (docs/design.md, "Links" -> "Grants per link and
// role"): which of a link's discovered tools each role's agent may call,
// once the MCP proxy (mcp/, not built yet) exists to call them. The
// database decides (set_link_grant, 20260928120000_links.sql): owners
// only, in person; every member reads the list (link_grants' member_read
// RLS policy). This page only chooses what to offer.
//
// A grant toggle is adjustable and reversible either direction -- unlike
// naming a path owner (pathowners.ts's "bigger trust delta": unsupervised,
// no-review write power over part of the vault itself), a link's tools are
// only reachable at all because an owner already added the link, in
// person, and reviewed what discovery found. So this follows rules.ts's
// "set a rule" pattern: a plain POST, no separate confirm page. Read tools
// default on for editor and owner at discovery time; write tools default
// off until an owner turns them on here.
//
//   GET  /v/:id/links/:linkId/grants   the link's tools and grants; owners get checkboxes
//   POST /v/:id/links/:linkId/grants   save every changed cell

import type pg from "pg";
import { asPerson } from "./db.js";
import { emptyState, html, pageHeader, type CrumbPart } from "./html.js";
import { message, notFound, render, vault, vaultPath, type Ctx, type Reply } from "./pages.js";
import { vaultShell } from "./files.js";
import { roleName } from "./invites.js";

type Link = { id: string; name: string };
type Tool = { tool_name: string; is_write: boolean; description: string | null };
type Grant = { role: string; tool_name: string; enabled: boolean };

const ROLES = ["owner", "editor", "viewer"] as const;

async function loadLink(c: pg.PoolClient, vaultId: string, linkId: string): Promise<Link | undefined> {
  return (await c.query(`select id, name from public.links where vault_id = $1 and id = $2`, [vaultId, linkId])).rows[0];
}

async function loadTools(c: pg.PoolClient, linkId: string): Promise<Tool[]> {
  return (
    await c.query(`select tool_name, is_write, description from public.link_tools where link_id = $1 order by tool_name`, [linkId])
  ).rows;
}

async function loadGrants(c: pg.PoolClient, linkId: string): Promise<Grant[]> {
  return (await c.query(`select role, tool_name, enabled from public.link_grants where link_id = $1`, [linkId])).rows;
}

const crumb = (vaultName: string, id: string, link: Link): CrumbPart[] => [
  { label: vaultName, href: vaultPath(id) },
  { label: "Links", href: vaultPath(id, "/links") },
  { label: `Grants for ${link.name}` },
];

const gone = (ctx: Ctx, id: string): Reply => {
  ctx.setFlash("That link doesn’t exist; it may have been deleted already.", "warning");
  return { redirect: vaultPath(id, "/links") };
};

export async function linkGrants(ctx: Ctx, id: string, linkId: string): Promise<Reply> {
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const link = await loadLink(c, id, linkId);
    if (!link) return { gone: true as const };
    const owner = v.role === "owner";
    const tools = await loadTools(c, linkId);
    const grants = await loadGrants(c, linkId);
    const enabled = new Set(grants.filter((g) => g.enabled).map((g) => `${g.role}:${g.tool_name}`));

    const cell = (r: string, t: Tool) => {
      const key = `${r}:${t.tool_name}`;
      if (!owner) return enabled.has(key) ? "Yes" : "—";
      return html`<input type="checkbox" name="grant" value="${key}" aria-label="${roleName(r)}: ${t.tool_name}"${
        enabled.has(key) ? html` checked` : ""
      }>`;
    };

    const table = tools.length
      ? html`<form method="post" action="${vaultPath(id, `/links/${link.id}/grants`)}">
          <div class="table-wrap"><table class="table-stack grants-table">
            <thead><tr><th scope="col">Tool</th>${ROLES.map((r) => html`<th scope="col" class="num">${roleName(r)}</th>`)}</tr></thead>
            <tbody>${tools.map(
              (t) => html`<tr>
                <td data-label="Tool"><code>${t.tool_name}</code>${t.is_write ? html` <span class="badge">Write</span>` : ""}${
                  t.description ? html`<span class="token-client">${t.description}</span>` : ""
                }</td>
                ${ROLES.map((r) => html`<td class="num" data-label="${roleName(r)}">${cell(r, t)}</td>`)}
              </tr>`,
            )}</tbody>
          </table></div>
          ${owner ? html`<div class="actions"><button class="primary">Save grants</button></div>` : ""}
        </form>`
      : emptyState({
          title: "No tools discovered",
          body: "Nothing to grant yet. Discovery runs when a link is added; there’s no rediscovery yet, so retrying today means deleting and re-adding the link.",
        });

    const body = html`
      ${pageHeader({
        crumb: crumb(v.name, id, link),
        title: `Grants for ${link.name}`,
        description: "Which of this link's tools each role's agent may call once the MCP proxy calls them. Read tools default on for editors and owners; write tools stay off until turned on here.",
      })}
      ${table}
      <p class="hint">Calling a link's tool isn't built yet: nothing acts on a grant until the MCP proxy does. <a href="/docs/concepts/links">How links work</a></p>`;
    return { v, link, shell: await vaultShell(c, ctx, v, { section: "links" }, body) };
  });
  if (!data) return notFound(ctx);
  if ("gone" in data) return gone(ctx, id);
  return render(ctx, `Grants for ${data.link.name}`, data.shell, "vaults");
}

export async function saveLinkGrants(ctx: Ctx, id: string, linkId: string): Promise<Reply> {
  const back = vaultPath(id, `/links/${linkId}/grants`);
  const posted = new Set(ctx.form.getAll("grant"));
  try {
    const result = await asPerson(ctx.userId, async (c) => {
      const v = await vault(c, ctx, id);
      if (!v) return null;
      const link = await loadLink(c, id, linkId);
      if (!link) return { gone: true as const };
      const tools = await loadTools(c, linkId);
      const grants = await loadGrants(c, linkId);
      const current = new Map(grants.map((g) => [`${g.role}:${g.tool_name}`, g.enabled]));
      let changed = 0;
      for (const t of tools) {
        for (const r of ROLES) {
          const key = `${r}:${t.tool_name}`;
          const want = posted.has(key);
          const have = current.get(key) ?? false;
          if (want === have) continue;
          await c.query(`select public.set_link_grant($1, $2, $3, $4)`, [linkId, r, t.tool_name, want]);
          changed++;
        }
      }
      return { changed, name: link.name };
    });
    if (!result) return notFound(ctx);
    if ("gone" in result) return gone(ctx, id);
    ctx.setFlash(
      result.changed ? `Saved ${result.changed} grant change${result.changed === 1 ? "" : "s"} for ${result.name}.` : `No changes to ${result.name}’s grants.`,
      "success",
    );
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: back };
}

export async function linkGrantsRoutes(ctx: Ctx, id: string, linkId: string): Promise<Reply> {
  return ctx.method === "GET" ? linkGrants(ctx, id, linkId) : saveLinkGrants(ctx, id, linkId);
}
