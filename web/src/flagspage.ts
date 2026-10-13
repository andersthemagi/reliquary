// "New for you" on a vault's Updates page (docs/design.md, "Notifications";
// docs/public/concepts/flags.md): what changed since the person signed in to
// the web app was last told. Agents have had this over MCP since 20260928
// (list_flags, advance_flags); this is the same data, for the person
// themselves, who has no other way to see it (the Inbox only ever shows
// category 3, waiting on you, account-wide; this also shows your own
// proposals' events and your watched paths, per vault, since list_flags is
// vault-scoped).
//
// Showing it marks it shown for the person's own watermark (advance_flags,
// in the same request, only once list_flags has returned), same contract as
// design.md's "advances the moment a flag is actually shown in a response,
// not on request": rendering the section is that response. This never
// touches an agent connection's own watermark, so looking at it doesn't
// silence anything for your agents, and their list_flags doesn't silence
// this either.

import type pg from "pg";
import { describe } from "./activity.js";
import { html, time, type Raw } from "./html.js";
import { planPath } from "./tasks.js";
import { threadPath } from "./threadrefs.js";
import { filePath, proposalPath, vaultPath, who, type Ctx } from "./pages.js";

type Flag = {
  seq: string;
  category: "thread" | "responsibility" | "working_set" | "subscription";
  reason: string;
  event: string;
  path: string | null;
  proposal_id: string | null;
  actor: string | null;
  agent: string | null;
  at: string;
  watching: string | null;
  thread_id: string | null;
  message_id: number | null;
  plan: string | null;
  step: string | null;
  step_title: string | null;
};

// The widest page list_flags takes, so "showing them" and "marking them
// shown" cover the same flags: a second page would need its own watermark
// step, which this doesn't offer.
const LIMIT = 200;

function categoryBadge(f: Pick<Flag, "category" | "reason">): Raw {
  if (f.category === "thread") return html`<span class="badge info">Thread</span>`;
  if (f.category === "responsibility") return html`<span class="badge warning">Waiting on you</span>`;
  if (f.reason === "base_changed") return html`<span class="badge info">File changed</span>`;
  if (f.reason === "cite_moved") return html`<span class="badge warning">Context moved</span>`;
  if (f.category === "working_set") return html`<span class="badge info">Your proposal</span>`;
  return html`<span class="badge info">Watching</span>`;
}

// One row per flag, in the changes feed's row shape: why and what, then
// where, who and when as one meta line.
function flagRows(ctx: Ctx, id: string, rows: Flag[]): Raw {
  return html`<ul class="rows feed">${rows.map((f) => {
    const what = describe(ctx.userId, { event: f.event });
    const whatLink = f.reason === "step_review" && f.plan
      ? html`<a href="${planPath(id, f.plan)}">Task “${f.step_title}” awaits your review</a>`
      : f.proposal_id
      ? html`<a href="${proposalPath(id, f.proposal_id)}">${what}</a>`
      : f.thread_id
        ? html`<a href="${threadPath(id, f.thread_id)}${f.message_id === null ? "" : `#message-${f.message_id}`}">${what}</a>`
        : what;
    const where = f.path
      ? html`<span>${f.event === "file.write" ? html`<a href="${filePath(id, f.path)}">${f.path}</a>` : f.path}${
          f.watching && f.watching !== f.path ? ` via ${f.watching}` : ""
        }</span>`
      : "";
    const cited = f.reason === "cite_moved" && f.plan ? html`<span>cited in <a href="${planPath(id, f.plan)}">${f.plan}</a></span>` : "";
    return html`<li class="flag"><span class="change-what">${categoryBadge(f)} ${whatLink}</span><span class="meta">${where}${cited}<span>${who(ctx, f.actor, f.agent)}</span><span>${time(f.at)}</span></span></li>`;
  })}</ul>`;
}

export async function newForYou(c: pg.PoolClient, ctx: Ctx, id: string): Promise<Raw> {
  const { rows } = await c.query(`select public.list_flags($1, $2) as r`, [id, LIMIT]);
  const r = rows[0].r as { watermark: number; through: number; more: boolean; flags: Flag[] };
  // A failed query above never reaches here, so it loses nothing (design.md,
  // "A separate watermark").
  await c.query(`select public.advance_flags($1, $2)`, [id, r.through]);
  return html`<section class="new-for-you" aria-labelledby="new-for-you"><h2 id="new-for-you">New for you</h2>
    ${r.flags.length
      ? flagRows(ctx, id, r.flags)
      : // Showing marks them seen, so empty means nothing new, not nothing
        // waiting: a proposal can still wait on the person, counted in Proposals.
        html`<p class="muted">Nothing new since you last looked. Proposals still waiting on you are in <a href="${vaultPath(id, "/proposals")}">Proposals</a>.</p>`}
    ${r.more ? html`<p class="hint">More than ${LIMIT} flags were waiting; the oldest are shown first. Reload for the next batch.</p>` : ""}</section>`;
}
