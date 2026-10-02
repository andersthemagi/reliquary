// A proposal's discussion (comments, review notes and approvals in one
// timeline), and per-person snooze of proposals in the Inbox.
// Everything is decided by the database (see
// supabase/migrations/20260924170000_threads_snooze.sql); these handlers only
// render and forward. Comment text is people's and agents' words: it goes
// through html``, so it is always escaped text.

import type pg from "pg";
import { asPerson } from "./db.js";
import { refusalText } from "./errorpage.js";
import { csrfField, html, menu, time, when, type Raw } from "./html.js";
import type { Ctx, Reply } from "./pages.js";
import { personRef, UUID } from "./personref.js";

const proposalPath = (id: string, pid: string, rest = "") => `/v/${id}/proposals/${pid}${rest}`;

// Proposals this person snoozed, still in force. Appended to the Review
// inbox's query, where $1 is the person.
export const NOT_SNOOZED_SQL = `
     and not exists (select 1 from public.active_snoozes s where s.proposal_id = p.id and s.user_id = $1)`;

// A refusal from the database, as its reason and a reference (errorpage.ts).
const message = refusalText;

const who = (ctx: Ctx, id: string | null, agent: string | null) =>
  `${id === ctx.userId ? "you" : id ? personRef(id) : "system"}${agent ? ` via ${agent}` : ""}`;

// A person, as the reader sees them: "you", or their email where the reader
// may see it (people.ts).
export const person = (ctx: Ctx, id: string | null) => (id === ctx.userId ? "you" : id ? personRef(id) : "system");

// Who proposed something, the agent first when there is one, since that is
// what did the work: "Claude Code for ben@example.test", or just the person.
export const byWhom = (ctx: Ctx, id: string | null, agent: string | null) =>
  agent ? `${agent} for ${person(ctx, id)}` : person(ctx, id);

const LABEL: Record<string, string> = {
  comment: "Comment",
  request_changes: "Requested changes",
  reject: "Rejected",
  revise: "Revised",
  edit: "Edited before approving",
  approve: "Approved",
};

const live = (status: string) => status === "open" || status === "changes_requested";

// ---------------------------------------------------------------------------
// The top of a proposal page: the latest request for changes, so a reviewer
// of a revised proposal reads it before deciding, and snooze. Both sit with
// the decision controls, above the diff.

export async function latestFeedback(c: pg.PoolClient, ctx: Ctx, p: { id: string; status: string; revision: number }): Promise<Raw> {
  if (!live(p.status)) return html``;
  const n = (
    await c.query(
      `select body, author, agent, revision, at from public.proposal_notes
        where proposal_id = $1 and kind = 'request_changes' and erased_at is null
        order by at desc limit 1`,
      [p.id],
    )
  ).rows[0];
  if (!n) return html``;
  return html`<section class="feedback" aria-labelledby="feedback">
    <h2 id="feedback">Latest requested changes</h2>
    <p class="small muted">${who(ctx, n.author, n.agent)} · revision ${n.revision} · ${time(n.at)}${
      p.revision > n.revision ? html` · <strong>revised since: this is revision ${p.revision}</strong>` : ""
    }</p>
    <blockquote class="claim">${n.body}</blockquote>
  </section>`;
}

const snoozeButtons = html`<button name="for" value="day">For a day</button>
      <button name="for" value="week">For a week</button>
      <button name="for" value="change">Until it changes</button>`;

// Snooze on a proposal page: a note saying it's snoozed (with Unsnooze),
// shown above the decision; or, when it waits on this person, a Snooze
// menu for the page header's actions, beside Revise and Edit, then approve.
export async function snoozeControl(
  c: pg.PoolClient,
  ctx: Ctx,
  o: { vaultId: string; p: { id: string; status: string }; waitingOnMe: boolean },
): Promise<{ note: Raw; menu: Raw }> {
  const { vaultId: id, p } = o;
  const snoozed = (await c.query(`select until from public.active_snoozes where proposal_id = $1 and user_id = $2`, [p.id, ctx.userId]))
    .rows[0];
  if (snoozed)
    return {
      note: html`<form method="post" action="${proposalPath(id, p.id, "/unsnooze")}" class="snoozed-note">
        ${csrfField(ctx.csrf)}<input type="hidden" name="back" value="proposal">
        <span>Snoozed in your inbox ${snoozed.until ? html`until ${when(snoozed.until)}, or ` : ""}until it changes.</span>
        <button class="quiet">Unsnooze</button>
      </form>`,
      menu: html``,
    };
  if (!o.waitingOnMe || !live(p.status)) return { note: html``, menu: html`` };
  const item = (value: string, label: string, description: string) => ({
    action: proposalPath(id, p.id, "/snooze"),
    csrf: ctx.csrf,
    fields: { for: value },
    label,
    description,
  });
  return {
    note: html``,
    menu: menu({
      label: "Snooze",
      heading: "Hide it from your inbox",
      className: "snooze-menu",
      items: [
        item("day", "For a day", "Or until it changes"),
        item("week", "For a week", "Or until it changes"),
        item("change", "Until it changes", "A new revision or someone else’s comment brings it back. Only you see this."),
      ],
    }),
  };
}

// Snooze from a row of the Inbox; the handler redirects to /inbox.
// One "Snooze" menu per row (a <details>, no script), so the list stays quiet.
export const rowSnooze = (ctx: Ctx, vaultId: string, pid: string, label: string) =>
  html`<details class="menu-wrap row-snooze-menu">
    <summary class="button small quiet" aria-label="Snooze ${label}">Snooze</summary>
    <form method="post" action="${proposalPath(vaultId, pid, "/snooze")}" class="menu row-snooze" aria-label="Snooze ${label}">
      ${csrfField(ctx.csrf)}<span class="menu-label">Hide it from your inbox</span>${snoozeButtons}
    </form>
  </details>`;

// ---------------------------------------------------------------------------
// The proposal page's discussion, at the end of the page.

export async function threadSection(
  c: pg.PoolClient,
  ctx: Ctx,
  o: { vaultId: string; p: { id: string; status: string }; canWrite: boolean },
): Promise<Raw> {
  const { vaultId: id, p } = o;
  const entries = (
    await c.query(
      `select kind, body, author, agent, revision, at, erased_at from public.proposal_notes
        where proposal_id = $1
       union all
       select 'approve', null, user_id, null, revision, at, null from public.approvals
        where proposal_id = $1 and decision = 'approve'
       order by at`,
      [p.id],
    )
  ).rows;

  // A decided proposal nobody discussed has no discussion to show.
  if (!live(p.status) && !entries.length) return html``;

  const timeline = entries.length
    ? html`<ol class="notes thread">${entries.map(
        (n) => html`<li${n.agent ? html` class="by-agent"` : ""}><p class="small muted">${LABEL[n.kind] ?? n.kind} · ${who(ctx, n.author, n.agent)} · revision ${n.revision} · ${time(n.at)}</p>
          ${n.body ? html`<p>${n.body}</p>` : n.erased_at ? html`<p class="muted small">Erased.</p>` : ""}</li>`,
      )}</ol>`
    : html`<p class="muted">No comments yet.</p>`;

  const form = !live(p.status)
    ? html`<p class="muted small">This proposal is decided, so its discussion is closed.</p>`
    : o.canWrite
      ? html`<form method="post" action="${proposalPath(id, p.id, "/comment")}" class="panel comment">
          ${csrfField(ctx.csrf)}
          <label for="comment">Add to the discussion</label>
          <textarea id="comment" name="body" class="short" maxlength="4000" required></textarea>
          <p class="hint">Everyone in this vault can read it, and so can their agents, as quoted text. A comment doesn’t approve or change the proposal.</p>
          <div class="actions"><button>Comment</button></div>
        </form>`
      : html`<p class="muted small">Viewers can read the discussion but not add to it.</p>`;

  return html`<section class="discussion" aria-labelledby="discussion"><h2 id="discussion">Discussion</h2>${timeline}${form}</section>`;
}

// ---------------------------------------------------------------------------
// Handlers

// The proposal must be in the vault named by the URL, so a form can't write
// to one vault's proposal from another vault's page.
async function inVault(c: pg.PoolClient, id: string, pid: string): Promise<boolean> {
  if (!UUID.test(pid)) return false;
  return (await c.query(`select 1 from public.proposals where id = $1 and vault_id = $2`, [pid, id])).rowCount === 1;
}

export async function postComment(ctx: Ctx, id: string, pid: string, notFound: () => Reply): Promise<Reply> {
  try {
    const found = await asPerson(ctx.userId, async (c) => {
      if (!(await inVault(c, id, pid))) return false;
      await c.query(`select public.comment_on_proposal($1, $2)`, [pid, (ctx.form.get("body") ?? "").replaceAll("\r\n", "\n")]);
      return true;
    });
    if (!found) return notFound();
    ctx.setFlash("Comment added.", "success");
  } catch (err) {
    ctx.setFlash(message(err));
  }
  return { redirect: `${proposalPath(id, pid)}#discussion` };
}

const SNOOZE: Record<string, { sql: string; flash: string }> = {
  day: { sql: "now() + interval '1 day'", flash: "Snoozed for a day, or until it changes." },
  week: { sql: "now() + interval '7 days'", flash: "Snoozed for a week, or until it changes." },
  change: { sql: "null", flash: "Snoozed until it changes." },
};

export async function snooze(ctx: Ctx, id: string, pid: string, notFound: () => Reply): Promise<Reply> {
  const choice = SNOOZE[ctx.form.get("for") ?? ""] ?? SNOOZE.change;
  try {
    const found = await asPerson(ctx.userId, async (c) => {
      if (!(await inVault(c, id, pid))) return false;
      await c.query(`select public.snooze_proposal($1, ${choice.sql})`, [pid]);
      return true;
    });
    if (!found) return notFound();
    ctx.setFlash(choice.flash, "success");
    return { redirect: "/inbox" };
  } catch (err) {
    ctx.setFlash(message(err));
    return { redirect: proposalPath(id, pid) };
  }
}

export async function unsnooze(ctx: Ctx, id: string, pid: string, notFound: () => Reply): Promise<Reply> {
  const found = await asPerson(ctx.userId, async (c) => {
    if (!(await inVault(c, id, pid))) return false;
    await c.query(`select public.unsnooze_proposal($1)`, [pid]);
    return true;
  });
  if (!found) return notFound();
  ctx.setFlash("Back in your inbox.", "success");
  return { redirect: ctx.form.get("back") === "review" ? "/inbox?snoozed=1" : proposalPath(id, pid) };
}

// ---------------------------------------------------------------------------
// The Review page's snoozed items: what would be waiting on this person if
// they hadn't snoozed it.

export async function snoozedList(c: pg.PoolClient, userId: string) {
  return (
    await c.query(
      `select p.id, p.vault_id, v.name as vault, p.kind, p.path, p.proposed_by, p.agent, s.until,
              (f.id is null) as creates
         from public.active_snoozes s
         join public.proposals p on p.id = s.proposal_id
         join public.vaults v on v.id = p.vault_id
         left join public.files f on f.vault_id = p.vault_id and f.path = p.path and f.deleted_at is null
        where s.user_id = $1 and p.status = 'open' and private.can_write(p.vault_id)
          and not exists (select 1 from public.approvals a
                           where a.proposal_id = p.id and a.user_id = $1 and a.revision = p.revision)
        order by s.until nulls last, p.created_at`,
      [userId],
    )
  ).rows;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function snoozedSection(ctx: Ctx, rows: any[]): Raw {
  if (rows.length === 0) return html``;
  if (!ctx.url.searchParams.has("snoozed")) {
    return html`<p class="snooze-toggle small"><a href="/inbox?snoozed=1">Show snoozed (${rows.length})</a></p>`;
  }
  return html`<h2 id="snoozed">Snoozed</h2>
    <p class="muted small">Hidden from your inbox until their time, or until they change. <a href="/inbox">Hide snoozed</a></p>
    <ul class="rows">${rows.map(
      (p) => html`<li>
        <span><a class="name" href="${proposalPath(p.vault_id, p.id)}">${p.kind === "delete" ? "Delete" : p.creates ? "Create" : "Change"} ${p.path}</a>
          <span class="muted small"> · ${p.vault} · ${byWhom(ctx, p.proposed_by, p.agent)} · ${p.until ? `until ${when(p.until)}` : "until it changes"}</span></span>
        <form method="post" action="${proposalPath(p.vault_id, p.id, "/unsnooze")}">
          ${csrfField(ctx.csrf)}<input type="hidden" name="back" value="review">
          <button class="quiet">Unsnooze</button>
        </form>
      </li>`,
    )}</ul>`;
}
