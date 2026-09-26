// Proposals: the per-vault list, the proposal page with its decision form,
// Edit, then approve, Revise, and the rows the Inbox and Home share
// (reviewRow). Each handler runs as the signed-in person through asPerson();
// the database decides who may decide, revise or propose.

import { asPerson } from "./db.js";
import { diffMode, diffSection } from "./diffview.js";
import { csrfField, html, pageHeader, raw, when } from "./html.js";
import { vaultShell } from "./files.js";
import {
  ago,
  canWrite,
  message,
  notFound,
  proposalPath,
  render,
  UUID,
  vault,
  vaultPath,
  who,
  type Ctx,
  type Reply,
} from "./pages.js";
import { latestFeedback, rowSnooze, snoozeControl, threadSection } from "./thread.js";

// ---------------------------------------------------------------------------
// Risk: facts about a change that deserve a closer look. Computed from the
// change itself, never from what the agent says about it.

export function risks(
  p: { kind: string; body: string | null; current_body: string | null; revision: number },
  extra: string[] = [],
): string[] {
  const out: string[] = [];
  if (p.kind === "delete") out.push("Deletes the file");
  const before = (p.current_body ?? "").split("\n").filter((l) => l.trim());
  const after = new Set((p.kind === "delete" ? "" : p.body ?? "").split("\n"));
  const removed = before.filter((l) => !after.has(l)).length;
  if (p.kind !== "delete" && before.length >= 4 && removed / before.length >= 0.5)
    out.push(`Removes ${removed} of ${before.length} lines`);
  if (p.current_body === null && p.kind !== "delete") out.push("Creates a new file");
  if (p.revision > 1) out.push(`Revised ${p.revision - 1} time${p.revision > 2 ? "s" : ""}; earlier approvals don’t count`);
  return [...out, ...extra];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const reviewRow = (ctx: Ctx, p: any, showVault = false, snoozable = false) => {
  // A new file is shown as a neutral label; only real risks get the amber badge.
  const r = risks(p).filter((x) => x !== "Creates a new file");
  const verb = p.kind === "delete" ? "Delete" : p.current_body === null ? "Create" : "Change";
  return html`<li>
    <span><a class="name" href="${proposalPath(p.vault_id, p.id)}">${verb} ${p.path}</a>
      <span class="muted small"> · ${showVault ? `${p.vault} · ` : ""}by ${who(ctx, p.proposed_by, p.agent)} · ${ago(p.created_at)}</span></span>
    <span class="row-end small">${verb === "Create" ? html`<span class="badge">New file</span> ` : ""}${r.length ? html`<span class="badge attention risk-count" title="${r.join("; ")}">${r[0]}${r.length > 1 ? ` +${r.length - 1} more` : ""}</span> ` : ""}<span class="muted">${p.approvals} of ${p.quorum}</span>${
      snoozable ? rowSnooze(ctx, p.vault_id, p.id, `${verb} ${p.path}`) : ""
    }</span>
  </li>`;
};

// ---------------------------------------------------------------------------
// Proposals

const STATES = [
  ["open", "Open"],
  ["changes_requested", "Changes requested"],
  ["applied", "Applied"],
  ["rejected", "Rejected"],
  ["stale", "Stale"],
] as const;

export async function proposalList(ctx: Ctx, id: string): Promise<Reply> {
  const requested = ctx.url.searchParams.get("status");
  const status = STATES.find(([s]) => s === requested)?.[0] ?? "open";
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const rows = (
      await c.query(
        // Quorums from one set-based rules_for() for the page, not
        // rule_for() per row.
        `with page as (
           select p.id, p.vault_id, p.kind, p.path, p.proposed_by, p.agent, p.created_at, p.revision, p.body,
                  row_number() over (order by p.created_at desc) as ord
             from public.proposals p where p.vault_id = $1 and p.status = $2 order by p.created_at desc limit 100)
         select p.*, cur.body as current_body, r.quorum,
                (select count(*) from public.approvals a where a.proposal_id = p.id and a.decision = 'approve'
                  and a.revision = p.revision)::int as approvals
           from page p
           join private.rules_for($1, array(select distinct path from page)) r on r.path = p.path
           left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
           left join public.file_versions cur on cur.id = f.current_version_id
          order by p.ord`,
        [id, status],
      )
    ).rows;
    const empty: Record<string, string> = {
      open: "Nothing waiting. When an agent proposes a change to a canon file, it shows up here.",
      changes_requested: "Nothing is waiting on a revision.",
      applied: "No proposals have been applied yet.",
      rejected: "No proposals have been rejected.",
      stale: "No stale proposals. One goes stale when its file changes before it’s approved.",
    };
    const body = html`
      ${pageHeader({ title: "Proposals" })}
      <nav class="tabs" aria-label="Proposal status">${STATES.map(
        ([s, label]) => html`<a href="${vaultPath(id, `/proposals?status=${s}`)}"${s === status ? raw(' aria-current="page"') : ""}>${label}</a>`,
      )}</nav>
      ${rows.length ? html`<ul class="rows">${rows.map((p) => reviewRow(ctx, p))}</ul>` : html`<div class="empty">${empty[status]}</div>`}`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, "Proposals", data.shell, "vaults");
}

const STATE_TEXT: Record<string, string> = {
  open: "Open",
  changes_requested: "Changes requested",
  applied: "Applied",
  rejected: "Rejected",
  stale: "Stale",
};

export async function proposalView(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const p = (
      await c.query(
        `select p.*, cur.body as current_body, (private.rule_for(p.vault_id, p.path)).quorum
           from public.proposals p
           left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
           left join public.file_versions cur on cur.id = f.current_version_id
          where p.id = $1 and p.vault_id = $2`,
        [pid, id],
      )
    ).rows[0];
    if (!p) return null;
    const approvals = (
      await c.query(`select user_id, decision, at from public.approvals where proposal_id = $1 and revision = $2 order by at`, [
        pid,
        p.revision,
      ])
    ).rows;
    const firstFromAgent = p.agent
      ? (
          await c.query(`select count(*)::int as n from public.proposals where vault_id = $1 and agent = $2 and created_at < $3`, [
            id,
            p.agent,
            p.created_at,
          ])
        ).rows[0].n === 0
      : false;
    const verb = p.kind === "delete" ? "Delete" : p.current_body === null ? "Create" : "Change";
    const approvers = approvals.filter((a) => a.decision === "approve");
    const mine = approvals.some((a) => a.user_id === ctx.userId);
    const flags = p.status === "open" || p.status === "changes_requested"
      ? risks(p, firstFromAgent ? [`First proposal from ${p.agent} in this vault`] : [])
      : [];
    const decidable = canWrite(v) && p.status === "open" && !mine;
    const rejectable = canWrite(v) && (decidable || p.status === "changes_requested");
    const editable = canWrite(v) && (p.status === "open" || p.status === "changes_requested") && p.kind === "write" && p.body !== null;
    // The proposer revises their own proposal (as their agent can over MCP):
    // a new revision, approved by nobody.
    const revisable = editable && p.proposed_by === ctx.userId;
    const thread = await threadSection(c, ctx, { vaultId: id, p, canWrite: canWrite(v) });
    const feedback = await latestFeedback(c, ctx, p);
    const snoozeForm = await snoozeControl(c, ctx, { vaultId: id, p, waitingOnMe: decidable });

    // The decision sits at the top, under the title, as on a GitHub pull
    // request: the note, then the verdicts, all visible without opening
    // anything. The diff follows immediately. (docs/research/ux-patterns.md)
    const controls = rejectable
      ? html`<form method="post" action="${proposalPath(id, pid, "/decide")}" class="panel decide" aria-label="Your review">
          ${csrfField(ctx.csrf)}
          <label for="note">Note <span class="hint">Required to request changes or reject. The proposer sees it.</span></label>
          <textarea id="note" name="note" class="note-field" rows="2"></textarea>
          <div class="actions">
            ${decidable
              ? html`<button class="primary" name="decision" value="approve">Approve</button>
                <button name="decision" value="request_changes">Request changes</button>`
              : ""}
            <button class="danger" name="decision" value="reject">Reject</button>
          </div>
        </form>`
      : "";
    const status =
      p.status === "stale" && canWrite(v) && p.kind === "write" && p.body !== null
        ? html`<div class="callout attention"><p>The file changed after this was proposed, so it wasn’t applied. You can propose the same text again against the current version; the diff will show what it would change now.</p>
            <form method="post" action="${proposalPath(id, pid, "/repropose")}">${csrfField(ctx.csrf)}
              <button class="primary">Propose again</button></form></div>`
        : p.status === "changes_requested"
          ? html`<p class="callout neutral">Waiting for the proposer to revise.${rejectable ? " You can still edit it yourself, or reject it." : ""}</p>`
          : p.status === "open" && mine
            ? html`<p class="callout neutral">You’ve decided on this revision. It needs more approvals before it applies.</p>`
            : "";

    const body = html`
      ${pageHeader({
        crumb: html`<p class="crumb"><a href="${vaultPath(id, "/proposals")}">Proposals</a></p>`,
        title: `${verb} ${p.path}`,
        path: true,
        badge: html`<span class="badge state ${p.status}">${STATE_TEXT[p.status]}</span>`,
        meta: html`<p class="meta"><span>Revision ${p.revision}</span>
          <span>By ${who(ctx, p.proposed_by, p.agent)}</span><span>${when(p.created_at)}</span></p>`,
        actions: html`${revisable ? html`<a class="button" href="${proposalPath(id, pid, "/revise")}">Revise</a>` : ""}${
          editable && rejectable ? html`<a class="button" href="${proposalPath(id, pid, "/edit")}">Edit, then approve</a>` : ""
        }`,
      })}
      <div class="review-top">
        ${p.proposed_by === ctx.userId && p.agent
          ? html`<p class="callout info">You’re reviewing a change your own agent (${p.agent}) proposed. That’s allowed: the agent can’t approve, you can.</p>`
          : ""}
        ${feedback}
        ${flags.length ? html`<ul class="risks" aria-label="Worth a closer look">${flags.map((f) => html`<li class="badge attention">${f}</li>`)}</ul>` : ""}
        ${status}${controls}${snoozeForm}
      </div>

      ${p.body === null && p.kind === "write"
        ? html`<div class="empty">This proposal’s content was erased.</div>`
        : diffSection({
            before: p.current_body,
            after: p.kind === "delete" ? null : p.body,
            mode: diffMode(ctx.url.searchParams),
            href: (m) => proposalPath(id, pid, `?diff=${m}`),
          })}

      <h2>${p.agent ? "Agent’s stated reason (unverified)" : "Reason"}</h2>
      <blockquote class="claim">${p.reason || "No reason given."}</blockquote>

      <h2>Approvals</h2>
      <p>${approvers.length} of ${p.quorum} for revision ${p.revision}${
        approvers.length ? `: ${approvers.map((a) => who(ctx, a.user_id, null)).join(", ")}` : "."
      }</p>

      ${thread}`;
    return { v, p, shell: await vaultShell(c, ctx, v, { path: p.path, section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, `Proposal: ${data.p.path}`, data.shell, "vaults");
}

export async function proposalEdit(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !canWrite(v)) return null;
    const p = (
      await c.query(
        `select * from public.proposals where id = $1 and vault_id = $2 and kind = 'write'
            and status in ('open', 'changes_requested') and body is not null`,
        [pid, id],
      )
    ).rows[0];
    if (!p) return null;
    const body = html`
      ${pageHeader({
        crumb: html`<p class="crumb"><a href="${proposalPath(id, pid)}">Back to the proposal</a></p>`,
        title: "Edit, then approve",
        path: true,
        actions: html`<a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a>
          <button class="primary" form="edit-approve">Save edit and approve</button>`,
      })}
      <p class="lede">Change the proposed text of <code>${p.path}</code>. Saving records your edit as a new revision and approves it. If this path needs more than one approval, the others approve your edited version.</p>
      <form method="post" action="${proposalPath(id, pid, "/edit")}" class="panel" id="edit-approve">
        ${csrfField(ctx.csrf)}
        <label for="content">Proposed text</label>
        <textarea id="content" name="content">${p.body}</textarea>
        <label for="note">What you changed</label>
        <input id="note" type="text" name="note" placeholder="Optional, for the history">
        <div class="actions"><button class="primary">Save edit and approve</button>
          <a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a></div>
      </form>`;
    return { v, shell: await vaultShell(c, ctx, v, { path: p.path, section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, "Edit, then approve", data.shell, "vaults");
}

// Revising your own proposal: the same editor, without approving. The
// database only lets the proposer (or their agent) revise.
export async function proposalRevise(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !canWrite(v)) return null;
    const p = (
      await c.query(
        `select * from public.proposals where id = $1 and vault_id = $2 and kind = 'write' and proposed_by = $3
            and status in ('open', 'changes_requested') and body is not null`,
        [pid, id, ctx.userId],
      )
    ).rows[0];
    if (!p) return null;
    const body = html`
      ${pageHeader({
        crumb: html`<p class="crumb"><a href="${proposalPath(id, pid)}">Back to the proposal</a></p>`,
        title: "Revise your proposal",
        path: true,
        actions: html`<a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a>
          <button class="primary" form="revise-proposal">Save revision</button>`,
      })}
      <p class="lede">Change the proposed text of <code>${p.path}</code>. Saving makes it revision ${p.revision + 1} and sends it back for review; approvals of earlier revisions no longer count.</p>
      <form method="post" action="${proposalPath(id, pid, "/revise")}" class="panel" id="revise-proposal">
        ${csrfField(ctx.csrf)}
        <label for="content">Proposed text</label>
        <textarea id="content" name="content">${p.body}</textarea>
        <label for="reason">What changed</label>
        <input id="reason" type="text" name="reason" placeholder="Optional, for the reviewers">
        <div class="actions"><button class="primary">Save revision</button>
          <a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a></div>
      </form>`;
    return { v, shell: await vaultShell(c, ctx, v, { path: p.path, section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, "Revise your proposal", data.shell, "vaults");
}

export async function reviseProposal(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  try {
    const revision = await asPerson(
      ctx.userId,
      async (c) =>
        (
          await c.query(`select public.revise_proposal($1, $2, $3) as r`, [
            pid,
            (ctx.form.get("content") ?? "").replaceAll("\r\n", "\n"),
            ctx.form.get("reason") || null,
          ])
        ).rows[0].r as number,
    );
    ctx.setFlash(`Revised. This is revision ${revision}, waiting for review again.`);
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: proposalPath(id, pid) };
}

const DECIDED: Record<string, string> = {
  applied: "Approved and applied.",
  open: "Approved. It needs more approvals before it applies.",
  rejected: "Rejected. The file is unchanged.",
  changes_requested: "Changes requested. The proposer can see your note and revise.",
  stale: "The file changed after this was proposed, so it was marked stale instead of applied.",
};

export async function decide(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const d = ctx.form.get("decision");
  const decision = d === "reject" || d === "request_changes" ? d : "approve";
  try {
    const result = await asPerson(
      ctx.userId,
      async (c) => (await c.query(`select public.decide($1, $2, $3) as r`, [pid, decision, ctx.form.get("note") || null])).rows[0].r as string,
    );
    ctx.setFlash(DECIDED[result] ?? result);
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: proposalPath(id, pid) };
}

export async function editAndApprove(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  try {
    const result = await asPerson(
      ctx.userId,
      async (c) =>
        (
          await c.query(`select public.edit_and_approve($1, $2, $3) as r`, [
            pid,
            (ctx.form.get("content") ?? "").replaceAll("\r\n", "\n"),
            ctx.form.get("note") || null,
          ])
        ).rows[0].r as string,
    );
    ctx.setFlash(DECIDED[result] ?? result);
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: proposalPath(id, pid) };
}

export async function repropose(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  try {
    const next = await asPerson(ctx.userId, async (c) => {
      const p = (
        await c.query(`select * from public.proposals where id = $1 and vault_id = $2 and status = 'stale' and kind = 'write'`, [pid, id])
      ).rows[0];
      if (!p || p.body === null) return null;
      return (await c.query(`select public.propose($1, $2, $3, $4) as id`, [id, p.path, p.body, `Proposed again: ${p.reason}`])).rows[0]
        .id as string;
    });
    if (!next) return notFound(ctx);
    ctx.setFlash("Proposed again against the current version.");
    return { redirect: proposalPath(id, next) };
  } catch (err) {
    ctx.setFlash(message(err));
    return { redirect: proposalPath(id, pid) };
  }
}
