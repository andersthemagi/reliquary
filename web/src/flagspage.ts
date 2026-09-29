// A vault's Flags page (docs/design.md, "Notifications"; docs/public/concepts/flags.md):
// what changed since you were last told, for the person signed in to the
// web app. Agents have had this over MCP since 20260928 (list_flags,
// advance_flags); this is the same data, for the person themselves, who has
// no other way to see it (the Inbox only ever shows category 3, waiting on
// you, account-wide; this also shows your own proposals' events and your
// watched paths, per vault, since list_flags is vault-scoped).
//
// Read-only: there is nothing to act on here except open the proposal or
// file a flag names. Loading the page marks it shown for the person's own
// watermark (advance_flags, in the same request, only once list_flags has
// returned), same contract as design.md's "advances the moment a flag is
// actually shown in a response, not on request": rendering this page is that
// response. This never touches an agent connection's own watermark, so
// looking at this page doesn't silence anything for your agents, and their
// list_flags doesn't silence this page either.

import type pg from "pg";
import { asPerson } from "./db.js";
import { describe } from "./activity.js";
import { emptyState, html, pageHeader, time, type Raw } from "./html.js";
import { vaultShell } from "./files.js";
import { filePath, notFound, proposalPath, render, vault, vaultPath, who, type Ctx, type Reply } from "./pages.js";

export const flagsPath = (id: string) => vaultPath(id, "/flags");

type Flag = {
  seq: string;
  category: "responsibility" | "working_set" | "subscription";
  reason: string;
  event: string;
  path: string | null;
  proposal_id: string | null;
  actor: string | null;
  agent: string | null;
  at: string;
  watching: string | null;
};

// The widest page list_flags takes, so "loading the page" and "marking it
// shown" cover the same flags: a second page would need its own watermark
// step, which this first pass doesn't offer.
const LIMIT = 200;

function categoryBadge(f: Pick<Flag, "category" | "reason">): Raw {
  if (f.category === "responsibility") return html`<span class="badge warning">Waiting on you</span>`;
  if (f.reason === "base_changed") return html`<span class="badge info">File changed</span>`;
  if (f.category === "working_set") return html`<span class="badge info">Your proposal</span>`;
  return html`<span class="badge info">Watching</span>`;
}

function flagsTable(ctx: Ctx, id: string, rows: Flag[]): Raw {
  return html`<div class="table-wrap activity-wrap"><table class="activity">
    <thead><tr><th>When</th><th>Why</th><th>What</th><th>Where</th><th>By</th></tr></thead>
    <tbody>${rows.map((f) => {
      const what = describe(ctx.userId, { event: f.event });
      const whatCell = f.proposal_id ? html`<a href="${proposalPath(id, f.proposal_id)}">${what}</a>` : what;
      const whereCell = f.path
        ? f.event === "file.write"
          ? html`<a href="${filePath(id, f.path)}">${f.path}</a>`
          : html`${f.path}`
        : "";
      return html`<tr class="ev"><td class="small nowrap ev-when">${time(f.at)}</td>
        <td class="small">${categoryBadge(f)}</td>
        <td class="small ev-what">${whatCell}</td>
        <td class="path-cell">${whereCell}${f.watching && f.watching !== f.path ? html`<span class="token-client">via ${f.watching}</span>` : ""}</td>
        <td class="small">${who(ctx, f.actor, f.agent)}</td></tr>`;
    })}</tbody></table></div>`;
}

export async function flags(ctx: Ctx, id: string): Promise<Reply> {
  const out = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const { rows } = await c.query(`select public.list_flags($1, $2) as r`, [id, LIMIT]);
    const r = rows[0].r as { watermark: number; through: number; more: boolean; flags: Flag[] };
    // Marks these shown for the person, once list_flags has actually
    // returned: a failed query above never reaches here, so it loses
    // nothing (design.md, "A separate watermark").
    await c.query(`select public.advance_flags($1, $2)`, [id, r.through]);
    const body = html`
      ${pageHeader({
        title: "Flags",
        description: html`What’s changed in ${v.name} since you were last told: a proposal waiting on you, your own proposals, and paths you watch.`,
      })}
      ${r.flags.length
        ? flagsTable(ctx, id, r.flags)
        : emptyState({
            title: "Nothing new",
            body: "Nothing is waiting on you, none of your proposals have changed, and nothing you watch has either.",
          })}
      ${r.more ? html`<p class="hint">More than ${LIMIT} flags were waiting; the oldest are shown first. Check back after these clear.</p>` : ""}
      <p class="hint">Your agents see the same flags over MCP (<code>list_flags</code>), kept separately from yours: opening this page doesn’t mark theirs shown, and their calls don’t mark yours. <a href="/docs/concepts/flags">About flags</a> · <a href="${vaultPath(id, "/config/watching")}">What you watch</a></p>`;
    return vaultShell(c, ctx, v, { section: "flags" }, body);
  });
  if (!out) return notFound(ctx);
  return render(ctx, "Flags", out, "vaults");
}
