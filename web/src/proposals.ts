// Proposals: the per-vault list, the proposal page with its decision form,
// Edit, then approve, Revise, and the rows the Inbox and Home share
// (reviewRow). Each handler runs as the signed-in person through asPerson();
// the database decides who may decide, revise or propose.

import type pg from "pg";
import { asPerson } from "./db.js";
import { diffMode, diffSection } from "./diffview.js";
import { callout, csrfField, emptyState, html, pageHeader, time, type CrumbPart, type Raw, type Tone } from "./html.js";
import { vaultShell } from "./files.js";
import {
  canWrite,
  message,
  notFound,
  proposalPath,
  render,
  UUID,
  vault,
  vaultPath,
  writablePath,
  type Ctx,
  type Reply,
  type Vault,
} from "./pages.js";
import { byWhom, latestFeedback, person, rowSnooze, snoozeControl, threadSection } from "./thread.js";
import { risks } from "./risk.js";

export { risks } from "./risk.js";

// What a proposal is measured against. While it waits: the file as it is
// now. Once it has applied or been rejected: the version it was made
// against, because after approval the file already says what was proposed
// and "now" would show an empty diff, and a Change where there was a Create.
// A stale one stays against the current file: its page offers to propose the
// same text again against that.
type Basis = { status?: string; base_version_id?: string | null; base_body?: string | null; current_body: string | null };
const againstBase = (p: Basis) => p.status === "applied" || p.status === "rejected";
const beforeOf = (p: Basis) => (againstBase(p) ? (p.base_body ?? null) : p.current_body);
const createsFile = (p: Basis) => (againstBase(p) ? (p.base_version_id ?? null) === null : p.current_body === null);
const verbOf = (p: Basis & { kind: string }) => (p.kind === "delete" ? "Delete" : createsFile(p) ? "Create" : "Change");

// A file's name, the last part of its path, for titles that name it.
const fileName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

const STATE_TEXT: Record<string, string> = {
  open: "Open",
  changes_requested: "Changes requested",
  applied: "Applied",
  rejected: "Rejected",
  stale: "Stale",
};
const STATE_HELP: Record<string, string> = {
  stale: "The file changed before this was approved, so it can’t apply",
};
const stateBadge = (status: string) =>
  html`<span class="badge state ${status}"${STATE_HELP[status] ? html` title="${STATE_HELP[status]}"` : ""}>${STATE_TEXT[status] ?? status}</span>`;

const decided = (status: string | undefined) => status === "applied" || status === "rejected" || status === "stale";

// "n of m approvals": the count always says what it counts.
const approvalCount = (n: number, quorum: number) => `${n} of ${quorum} approval${quorum === 1 ? "" : "s"}`;

// How a decided proposal ended, in one line: who decided and when. `by` is
// who approved it (applied) or who rejected it.
function outcome(ctx: Ctx, status: string, by: string[], at: Date | null): Raw {
  const names = by.map((id) => person(ctx, id)).join(", ");
  const text =
    status === "applied"
      ? names
        ? `Applied, approved by ${names}`
        : "Applied"
      : status === "rejected"
        ? names
          ? `Rejected by ${names}`
          : "Rejected"
        : "Went stale: the file changed before it was approved";
  return html`${text}${at ? html` · ${time(at)}` : ""}`;
}

// A proposal in a list (the vault's Proposals, the Inbox, Home): what it
// does to which file, then the vault (across vaults), who proposed it and
// when. At the end, while it's live: a New file label, the first risk (all
// of them in the badge's title) and its approvals so far; once decided, how
// it ended. Rows the Inbox can snooze carry a Snooze menu.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const reviewRow = (ctx: Ctx, p: any, showVault = false, snoozable = false) => {
  const verb = verbOf(p);
  const done = decided(p.status);
  const r = done ? [] : risks(p);
  const end = done
    ? html`<span class="muted outcome">${outcome(ctx, p.status, p.deciders ?? [], p.decided_at ?? null)}</span> ${stateBadge(p.status)}`
    : html`${verb === "Create" ? html`<span class="badge">New file</span> ` : ""}${
        r.length
          ? html`<span class="badge attention risk-count" title="${r.map((x) => x.long).join(" ")}">${r[0].short}${
              r.length > 1 ? ` +${r.length - 1} more` : ""
            }</span> `
          : ""
      }<span class="muted">${approvalCount(p.approvals, p.quorum)}</span>`;
  return html`<li>
    <span><a class="name" href="${proposalPath(p.vault_id, p.id)}">${verb} ${p.path}</a>
      <span class="muted small"> · ${showVault ? `${p.vault} · ` : ""}${byWhom(ctx, p.proposed_by, p.agent)} · ${time(p.created_at)}</span></span>
    <span class="row-end small">${end}${snoozable ? rowSnooze(ctx, p.vault_id, p.id, `${verb} ${p.path}`) : ""}</span>
  </li>`;
};

// ---------------------------------------------------------------------------
// Proposals: the vault's list, by state, as tabs with counts. Rejected and
// stale proposals share Closed, each row saying which.

const TABS = [
  ["open", "Open"],
  ["changes_requested", "Changes requested"],
  ["applied", "Applied"],
  ["closed", "Closed"],
] as const;
type TabId = (typeof TABS)[number][0];
const IN_TAB: Record<TabId, string[]> = {
  open: ["open"],
  changes_requested: ["changes_requested"],
  applied: ["applied"],
  closed: ["rejected", "stale"],
};
const EMPTY: Record<TabId, { title: string; body: string }> = {
  open: { title: "Nothing waiting", body: "When someone or their agent proposes a change to a canon file, it shows up here." },
  changes_requested: {
    title: "Nothing sent back",
    body: "When a reviewer asks for changes, the proposal waits here until its proposer revises it.",
  },
  applied: { title: "Nothing applied yet", body: "A proposal applies when it gets the approvals its rule asks for." },
  closed: {
    title: "Nothing closed",
    body: "Rejected proposals end up here, and stale ones: their file changed before they were approved.",
  },
};

export async function proposalList(ctx: Ctx, id: string): Promise<Reply> {
  const requested = ctx.url.searchParams.get("status");
  // Older links name rejected or stale: both are in Closed now.
  const tab: TabId =
    requested === "rejected" || requested === "stale" ? "closed" : (TABS.find(([s]) => s === requested)?.[0] ?? "open");
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const counts = new Map<string, number>(
      (await c.query(`select status, count(*)::int as n from public.proposals where vault_id = $1 group by status`, [id])).rows.map(
        (r) => [r.status as string, r.n as number],
      ),
    );
    const rows = (
      await c.query(
        // Quorums from one set-based rules_for() for the page, not
        // rule_for() per row. Who decided: the approvers of the applied
        // revision, or who rejected it. Decided ones by when, newest first.
        `with page as (
           select p.id, p.vault_id, p.kind, p.path, p.proposed_by, p.agent, p.created_at, p.revision, p.body,
                  p.status, p.decided_at, p.base_version_id,
                  row_number() over (order by coalesce(p.decided_at, p.created_at) desc) as ord
             from public.proposals p where p.vault_id = $1 and p.status = any($2::text[])
            order by coalesce(p.decided_at, p.created_at) desc limit 100)
         select p.*, cur.body as current_body, r.quorum,
                (select count(*) from public.approvals a where a.proposal_id = p.id and a.decision = 'approve'
                  and a.revision = p.revision)::int as approvals,
                array(select a.user_id from public.approvals a
                       where a.proposal_id = p.id and a.revision = p.revision
                         and a.decision = case when p.status = 'rejected' then 'reject' else 'approve' end
                       order by a.at) as deciders
           from page p
           join private.rules_for($1, array(select distinct path from page)) r on r.path = p.path
           left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
           left join public.file_versions cur on cur.id = f.current_version_id
          order by p.ord`,
        [id, IN_TAB[tab]],
      )
    ).rows;
    const count = (t: TabId) => IN_TAB[t].reduce((n, s) => n + (counts.get(s) ?? 0), 0);
    const body = html`
      ${pageHeader({
        crumb: [{ label: v.name, href: vaultPath(id) }, { label: "Proposals" }],
        title: "Proposals",
        tabs: TABS.map(([t, label]) => ({ href: vaultPath(id, `/proposals?status=${t}`), label, count: count(t), current: t === tab })),
        tabsLabel: "Proposal status",
      })}
      ${rows.length ? html`<ul class="rows proposal-rows">${rows.map((p) => reviewRow(ctx, p))}</ul>` : emptyState(EMPTY[tab])}`;
    return { v, shell: await vaultShell(c, ctx, v, { section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, "Proposals", data.shell, "vaults");
}

// Where a proposal's pages sit: the vault, its Proposals, the proposal, and
// the page under it, if any.
function proposalCrumb(v: Vault, p: Basis & { id: string; kind: string; path: string }, here?: string): CrumbPart[] {
  return [
    { label: v.name, href: vaultPath(v.id) },
    { label: "Proposals", href: vaultPath(v.id, "/proposals") },
    { label: `${verbOf(p)} ${p.path}`, href: proposalPath(v.id, p.id) },
    ...(here ? [{ label: here }] : []),
  ];
}

// A refused decision, shown again on the proposal page (answered 400): the
// database's reason inside the decision box, and the note as it was typed.
type Refused = { error: string; decision: string; note: string };

export async function proposalView(ctx: Ctx, id: string, pid: string, refused?: Refused): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const p = (
      await c.query(
        `select p.*, cur.body as current_body, f.current_version_id, base.body as base_body, (private.rule_for(p.vault_id, p.path)).quorum
           from public.proposals p
           left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
           left join public.file_versions cur on cur.id = f.current_version_id
           left join public.file_versions base on base.id = p.base_version_id
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
    const verb = verbOf(p);
    const live = p.status === "open" || p.status === "changes_requested";
    // decide() applies a proposal only while the file is at the version it
    // was proposed against, and neither Revise nor Edit, then approve moves
    // that base, so a proposal whose file has moved on can only go stale.
    const moved = p.status === "open" && (p.base_version_id ?? null) !== (p.current_version_id ?? null);
    const approvers = approvals.filter((a) => a.decision === "approve");
    const mine = approvals.some((a) => a.user_id === ctx.userId);
    const flags = live
      ? risks(p, firstFromAgent ? [{ short: `First proposal from ${p.agent}`, long: `First proposal from ${p.agent} in this vault.` }] : [])
      : [];
    // Vault-wide write access, or a named owner of this path (writablePath):
    // decide(), comment_on_proposal and edit_and_approve all gate on the
    // same can_write_path, so a path-owning viewer sees these controls too,
    // not just vault editors and owners.
    const writable = await writablePath(c, v, p.path);
    const decidable = writable && p.status === "open" && !mine;
    const rejectable = writable && (decidable || p.status === "changes_requested");
    const editable = writable && live && p.kind === "write" && p.body !== null;
    // The proposer revises their own proposal (as their agent can over MCP):
    // a new revision, approved by nobody. revise_proposal stays vault-role
    // gated (canWrite), never path-owner aware: a path's named owner never
    // proposes on it in the first place (they write directly), so they're
    // never the proposer here regardless.
    const revisable = canWrite(v) && live && p.kind === "write" && p.body !== null && p.proposed_by === ctx.userId;
    const thread = await threadSection(c, ctx, { vaultId: id, p, canWrite: writable });
    const feedback = await latestFeedback(c, ctx, p);
    const snooze = await snoozeControl(c, ctx, { vaultId: id, p, waitingOnMe: decidable });

    // The decision sits at the top, under the title, as on a GitHub pull
    // request: the note, then the verdicts, all visible without opening
    // anything. The diff follows immediately. (docs/research/ux-patterns.md)
    // A refused decision comes back here with the reason inside the box and
    // the note as typed; a missing note marks the field.
    const noteMissing = !!refused && refused.decision !== "approve" && !refused.note.trim();
    const refusal = refused ? callout("danger", refused.error, { id: "decide-error" }) : html``;
    const controls = rejectable
      ? html`<form method="post" action="${proposalPath(id, pid, "/decide")}" class="panel decide" aria-label="Your review">
          ${csrfField(ctx.csrf)}
          ${refusal}
          <label for="note">Note</label>
          <p class="hint" id="note-hint">Required to request changes or reject. The proposer sees it.</p>
          <textarea id="note" name="note" class="note-field" rows="2" aria-describedby="${noteMissing ? "decide-error note-hint" : "note-hint"}"${
            noteMissing ? html` aria-invalid="true"` : ""
          }>${refused?.note ?? ""}</textarea>
          <div class="actions">
            ${decidable && !moved
              ? html`<button class="primary" name="decision" value="approve">Approve</button>
                <button name="decision" value="request_changes">Request changes</button>`
              : ""}
            <button class="danger" name="decision" value="reject">Reject</button>
          </div>
        </form>`
      : null;
    const by = (d: string) => approvals.filter((a) => a.decision === d).map((a) => a.user_id as string);
    const ended = decided(p.status) ? outcome(ctx, p.status, by(p.status === "rejected" ? "reject" : "approve"), p.decided_at) : null;
    const again = p.status === "stale" && canWrite(v) && p.kind === "write" && p.body !== null;
    const status =
      p.status === "stale"
        ? html`<div class="callout warning outcome-line"><p>${ended}.${
            again ? " You can propose the same text again against the current version; the diff will show what it would change now." : ""
          }</p>${
            again
              ? html`<form method="post" action="${proposalPath(id, pid, "/repropose")}">${csrfField(ctx.csrf)}
              <button class="primary">Propose again</button></form>`
              : ""
          }</div>`
        : ended
          ? html`<p class="callout ${p.status === "applied" ? "success" : "neutral"} outcome-line">${ended}.</p>`
          : p.status === "changes_requested"
            ? html`<p class="callout neutral">Waiting for the proposer to revise.${rejectable ? " You can still edit it yourself, or reject it." : ""}</p>`
            : p.status === "open" && mine && !moved
              ? html`<p class="callout neutral">You’ve decided on this revision. It needs more approvals before it applies.</p>`
              : "";

    const body = html`
      ${pageHeader({
        crumb: proposalCrumb(v, p),
        title: `${verb} ${p.path}`,
        path: true,
        badge: html`${stateBadge(p.status)}${verb === "Create" ? html` <span class="badge">New file</span>` : ""}`,
        meta: html`<p class="meta">${p.revision > 1 ? html`<span>Revision ${p.revision}</span>` : ""}<span>By ${byWhom(
          ctx,
          p.proposed_by,
          p.agent,
        )}</span><span>${time(p.created_at)}</span></p>`,
        secondary: html`${snooze.menu}${revisable ? html`<a class="button" href="${proposalPath(id, pid, "/revise")}">Revise</a>` : ""}${
          editable && rejectable ? html`<a class="button" href="${proposalPath(id, pid, "/edit")}">Edit, then approve</a>` : ""
        }`,
      })}
      <div class="review-top">
        ${p.proposed_by === ctx.userId && p.agent
          ? html`<p class="callout info">You’re reviewing a change your own agent (${p.agent}) proposed. That’s allowed: the agent can’t approve, you can.</p>`
          : ""}
        ${snooze.note}
        ${feedback}
        ${flags.length
          ? html`<ul class="risks" aria-label="Worth a closer look">${flags.map(
              (f) => html`<li><span class="badge attention">${f.short}</span> <span class="risk-long">${f.long}</span></li>`,
            )}</ul>`
          : ""}
        ${moved
          ? callout(
              "warning",
              "The file changed after this was proposed. Approving it would mark it stale instead of applying it, and revising or editing it doesn’t change that. The diff below compares with the file as it is now. To go ahead, reject it and propose the same text again against the current version.",
            )
          : ""}
        ${status}${controls ?? refusal}
      </div>

      ${p.body === null && p.kind === "write"
        ? html`<div class="empty">This proposal’s content was erased.</div>`
        : diffSection({
            before: beforeOf(p),
            earlier: againstBase(p),
            after: p.kind === "delete" ? null : p.body,
            mode: diffMode(ctx.url.searchParams),
            href: (m) => proposalPath(id, pid, `?diff=${m}`),
          })}

      <h2>${p.agent ? "Agent’s stated reason (unverified)" : "Reason"}</h2>
      <blockquote class="claim">${p.reason || "No reason given."}</blockquote>

      ${live
        ? html`<h2>Approvals</h2>
      <p>${approvalCount(approvers.length, p.quorum)}${p.revision > 1 ? ` for revision ${p.revision}` : ""}${
        approvers.length ? `: ${approvers.map((a) => person(ctx, a.user_id)).join(", ")}` : "."
      }</p>`
        : ""}

      ${thread}`;
    return { v, p, shell: await vaultShell(c, ctx, v, { path: p.path, section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  const reply = render(ctx, `Proposal: ${data.p.path}`, data.shell, "vaults");
  return refused ? { ...reply, status: 400 } : reply;
}

// Edit, then approve, and Revise: the proposed text in an editor, with the
// file as it is now folded above it to compare against.
function currentFile(current: string | null): Raw {
  return current === null
    ? html``
    : html`<details class="current-file"><summary>The file as it is now</summary><pre class="current-text">${current}</pre></details>`;
}

export async function proposalEdit(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v) return null;
    const p = await loadEditable(c, id, pid, null);
    if (!p || !(await writablePath(c, v, p.path))) return null;
    const body = html`
      ${pageHeader({
        crumb: proposalCrumb(v, p, "Edit, then approve"),
        title: `Edit, then approve ${fileName(p.path)}`,
        path: true,
        secondary: html`<a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a>`,
        primary: html`<button class="primary" form="edit-approve">Save edit and approve</button>`,
      })}
      <p class="lede">Change the proposed text of <code>${p.path}</code>. Saving records your edit as a new revision and approves it. If this path needs more than one approval, the others approve your edited version.</p>
      ${currentFile(p.current_body)}
      <form method="post" action="${proposalPath(id, pid, "/edit")}" class="panel" id="edit-approve">
        ${csrfField(ctx.csrf)}
        <label for="content">Proposed text</label>
        <textarea id="content" name="content">${p.body}</textarea>
        <label for="note">What you changed</label>
        <input id="note" type="text" name="note" placeholder="Optional, for the history">
        <div class="actions"><button class="primary">Save edit and approve</button>
          <a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a></div>
      </form>`;
    return { v, p, shell: await vaultShell(c, ctx, v, { path: p.path, section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, `Edit, then approve ${fileName(data.p.path)}`, data.shell, "vaults");
}

// A live write proposal in the vault with its text and the file's current
// text; `own` limits it to one this person proposed (Revise).
async function loadEditable(c: pg.PoolClient, id: string, pid: string, own: string | null) {
  return (
    await c.query(
      `select p.*, cur.body as current_body
         from public.proposals p
         left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
         left join public.file_versions cur on cur.id = f.current_version_id
        where p.id = $1 and p.vault_id = $2 and p.kind = 'write'
          and p.status in ('open', 'changes_requested') and p.body is not null
          and ($3::uuid is null or p.proposed_by = $3)`,
      [pid, id, own],
    )
  ).rows[0];
}

// Revising your own proposal: the same editor, without approving. The
// database only lets the proposer (or their agent) revise.
export async function proposalRevise(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const data = await asPerson(ctx.userId, async (c) => {
    const v = await vault(c, ctx, id);
    if (!v || !canWrite(v)) return null;
    const p = await loadEditable(c, id, pid, ctx.userId);
    if (!p) return null;
    const body = html`
      ${pageHeader({
        crumb: proposalCrumb(v, p, "Revise"),
        title: `Revise ${fileName(p.path)}`,
        path: true,
        secondary: html`<a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a>`,
        primary: html`<button class="primary" form="revise-proposal">Save revision</button>`,
      })}
      <p class="lede">Change the proposed text of <code>${p.path}</code>. Saving makes it revision ${p.revision + 1} and sends it back for review; approvals of earlier revisions no longer count.</p>
      ${currentFile(p.current_body)}
      <form method="post" action="${proposalPath(id, pid, "/revise")}" class="panel" id="revise-proposal">
        ${csrfField(ctx.csrf)}
        <label for="content">Proposed text</label>
        <textarea id="content" name="content">${p.body}</textarea>
        <label for="reason">New reason (replaces the old one; leave empty to keep it)</label>
        <p class="hint" id="reason-hint">Reviewers read this as why the proposal exists, so say why, not only what changed. It is also added to the discussion.</p>
        <input id="reason" type="text" name="reason" aria-describedby="reason-hint">
        <div class="actions"><button class="primary">Save revision</button>
          <a class="button quiet" href="${proposalPath(id, pid)}">Cancel</a></div>
      </form>`;
    return { v, p, shell: await vaultShell(c, ctx, v, { path: p.path, section: "proposals" }, body) };
  });
  if (!data) return notFound(ctx);
  return render(ctx, `Revise ${fileName(data.p.path)}`, data.shell, "vaults");
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
    ctx.setFlash(`Revised. This is revision ${revision}, waiting for review again.`, "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: proposalPath(id, pid) };
}

// What a decision did, in its tone: done is success; a proposal that went
// stale instead of applying is a warning.
const DECIDED: Record<string, [string, Tone]> = {
  applied: ["Approved and applied.", "success"],
  open: ["Approved. It needs more approvals before it applies.", "success"],
  rejected: ["Rejected. The file is unchanged.", "success"],
  changes_requested: ["Changes requested. The proposer can see your note and revise.", "success"],
  stale: ["The file changed after this was proposed, so it was marked stale instead of applied.", "warning"],
};
const decidedFlash = (ctx: Ctx, result: string) => {
  const [text, tone] = DECIDED[result] ?? [result, "info" as Tone];
  ctx.setFlash(text, tone);
};

// A decision. Refused (a missing note, a decision already made, a proposal
// no longer open), the proposal page is answered again with the reason in
// the decision box and the note kept, not a redirect that loses it.
export async function decide(ctx: Ctx, id: string, pid: string): Promise<Reply> {
  if (!UUID.test(pid)) return notFound(ctx);
  const d = ctx.form.get("decision");
  const decision = d === "reject" || d === "request_changes" ? d : "approve";
  const note = ctx.form.get("note") ?? "";
  try {
    const result = await asPerson(
      ctx.userId,
      async (c) => (await c.query(`select public.decide($1, $2, $3) as r`, [pid, decision, note || null])).rows[0].r as string,
    );
    decidedFlash(ctx, result);
  } catch (err) {
    return proposalView(ctx, id, pid, { error: message(err), decision, note });
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
    decidedFlash(ctx, result);
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
    ctx.setFlash("Proposed again against the current version.", "success");
    return { redirect: proposalPath(id, next) };
  } catch (err) {
    ctx.setFlash(message(err));
    return { redirect: proposalPath(id, pid) };
  }
}
