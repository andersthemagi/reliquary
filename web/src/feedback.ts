// Feedback and bug reports (/feedback, and the Feedback button in the top
// bar, html.ts). The database keeps and checks them (public.send_feedback,
// public.feedback with RLS: your own, and your agents'; at most 20 an hour;
// 20260926163000_feedback.sql). Agents send the same over MCP
// (send_feedback, list_my_feedback; docs/parity.md).
//
// Notices: the operator is emailed about each new message through Resend
// (mailer.ts), from the web app only, since the MCP server has no mailer.
// flushFeedbackNotices() claims messages not yet notified (the database's
// claim lapses after 10 minutes, at most 5 tries, the last 7 days), sends
// each, and marks it notified. It runs after every feedback form, on a
// signed-in page at most once a minute per instance (server.ts), and every
// minute where the server is long-running (not on Vercel). So an agent's
// feedback is emailed on the next of those; a notice that fails is tried
// again later, and the message itself is never lost: scripts/feedback.sh
// lists everything.
//
// Where notices go: FEEDBACK_EMAIL when set. Otherwise, only on the hosted
// service (VERCEL, not SELF_HOSTED), the operator's contact address in
// site.ts. A self-hosted instance with no FEEDBACK_EMAIL emails nobody:
// its feedback stays with its own operator, never Red Mage.

import { asPerson, pool } from "./db.js";
import { refusalText } from "./errorpage.js";
import { fail, Refusal } from "./failure.js";
import { callout, csrfField, emptyState, esc, FEEDBACK_KINDS, FEEDBACK_MAX, html, pageHeader, raw, time } from "./html.js";
import { ADDRESS, idempotencyKey, mailerOffReason, sendEmail, validFrom } from "./mailer.js";
import { render, UUID, type Ctx, type Reply } from "./pages.js";
import { safeNext } from "./signin.js";
import { loadShell } from "./inbox.js";
import { OPERATOR } from "./site.js";

// The kinds, as the top bar's Feedback button (html.ts) lists them.
const KINDS = FEEDBACK_KINDS;
const KIND_WORD: Record<string, string> = { bug: "bug report", idea: "idea", question: "question", other: "feedback" };

const STATUS: Record<string, { label: string; tone: string; help: string }> = {
  new: { label: "New", tone: "", help: "Sent; not read yet" },
  seen: { label: "Seen", tone: "info", help: "The operator has read it" },
  planned: { label: "Planned", tone: "attention", help: "The operator plans to act on it" },
  fixed: { label: "Fixed", tone: "success", help: "Fixed or done" },
  wont_fix: { label: "Won’t fix", tone: "", help: "The operator decided not to act on it" },
};
export const statusBadge = (s: string) => {
  const x = STATUS[s] ?? { label: s, tone: "", help: "" };
  return html`<span class="badge${x.tone ? ` ${x.tone}` : ""}" title="${x.help}">${x.label}</span>`;
};

type Sent = {
  id: string;
  kind: string;
  message: string;
  vault: string | null;
  context: string | null;
  source: string;
  agent: string | null;
  created_at: Date;
  status: string;
  reply: string | null;
  replied_at: Date | null;
};

// The page in the top bar the popover was sent from, as a local path, or
// nothing.
function pageOf(v: string | null): string | null {
  const p = (v ?? "").trim();
  if (!p || safeNext(p) !== p) return null;
  return p.slice(0, 500);
}

export async function feedbackRoutes(ctx: Ctx): Promise<Reply> {
  if (ctx.method === "GET") return feedbackPage(ctx);
  return sendFeedback(ctx);
}

type Draft = { kind?: string; message?: string; vault?: string; page?: string | null; error?: string };

async function feedbackPage(ctx: Ctx, draft: Draft = {}): Promise<Reply> {
  // A refused form comes back here from a POST, which has no top bar yet.
  ctx.shell ??= await asPerson(ctx.userId, loadShell);
  const sent = await asPerson(ctx.userId, async (c) =>
    (
      await c.query(
        `select f.id, f.kind, f.message, v.name as vault, f.context, f.source, f.agent, f.created_at,
                f.status, f.reply, f.replied_at
           from public.feedback f left join public.vaults v on v.id = f.vault_id
          where f.user_id = $1
          order by f.created_at desc limit 100`,
        [ctx.userId],
      )
    ).rows as Sent[],
  );
  const vaults = ctx.shell?.vaults ?? [];
  // From the account menu (?from=, the page it was opened on), or a refused
  // form's page: offered to include, as the top bar's button does.
  const from = draft.page ?? pageOf(ctx.url.searchParams.get("from"));
  const came = from && !from.startsWith("/feedback") ? from : null;
  const form = html`<form method="post" action="/feedback" id="feedback-form" class="panel choice-form feedback-page-form">
      ${csrfField(ctx.csrf)}${came ? html`<input type="hidden" name="page" value="${came}">` : ""}
      <fieldset>
        <legend>What is it?</legend>
        ${KINDS.map(
          (k, i) => html`<label class="choice"><input type="radio" name="kind" value="${k.id}"${i === 0 ? raw(" required") : ""}${
            draft.kind === k.id ? raw(" checked") : ""}> <span><strong>${k.label}</strong> <span class="muted">${k.hint}</span></span></label>`,
        )}
      </fieldset>
      <label for="feedback-message">Message</label>
      <textarea id="feedback-message" name="message" class="short" required maxlength="${FEEDBACK_MAX}" aria-describedby="feedback-message-hint">${draft.message ?? ""}</textarea>
      <p class="hint" id="feedback-message-hint">Up to ${FEEDBACK_MAX} characters. For a bug: what you did, what happened, and any reference (ref) an error showed. Never paste secrets, tokens or variable values.</p>
      ${vaults.length
        ? html`<label for="feedback-vault">About a vault <span class="muted">(optional)</span></label>
          <select id="feedback-vault" name="vault">
            <option value="">Not about one vault</option>
            ${vaults.map((v) => html`<option value="${v.id}"${draft.vault === v.id ? raw(" selected") : ""}>${v.name}</option>`)}
          </select>`
        : ""}
      ${came
        ? html`<label class="choice"><input type="checkbox" name="include_page" value="1" checked> <span>Include the page you came from <code>${came.length > 60 ? `${came.slice(0, 57)}...` : came}</code></span></label>`
        : ""}
      <div class="actions"><button class="primary">Send feedback</button></div>
    </form>`;
  const rows = sent.map((f) => {
    const via = f.source === "web" ? "Web UI" : `Agent: ${f.agent ?? "agent"}`;
    return html`<tr>
      <td data-label="Sent">${time(f.created_at)}</td>
      <td data-label="Kind">${KINDS.find((k) => k.id === f.kind)?.label ?? f.kind}</td>
      <td data-label="Message" class="feedback-message"><div><p class="feedback-text">${f.message}</p>${
        f.vault || f.context ? html`<p class="small muted">${f.vault ? html`Vault ${f.vault}` : ""}${f.vault && f.context ? " · " : ""}${f.context ? html`From <code>${f.context}</code>` : ""}</p>` : ""}</div></td>
      <td data-label="Via">${via}</td>
      <td data-label="Status">${statusBadge(f.status)}</td>
      <td data-label="Reply">${f.reply ? html`<div><p class="feedback-text">${f.reply}</p><p class="small muted">${time(f.replied_at)}</p></div>` : html`<span class="muted">None yet</span>`}</td>
    </tr>`;
  });
  const body = html`${pageHeader({
      title: "Feedback",
      description: "Report a bug, suggest an idea or ask a question. It goes to the people who run this Reliquary, who can reply here.",
      primary: html`<button class="primary" form="feedback-form">Send feedback</button>`,
    })}
    ${draft.error ? callout("danger", draft.error, { title: "Not sent" }) : ""}
    ${form}
    <section aria-labelledby="sent">
      <h2 id="sent">What you’ve sent</h2>
      ${sent.length
        ? html`<p class="small muted">Newest first, including what your agents sent for you. The status and reply are the operator’s.</p>
          <div class="table-wrap"><table class="table-stack feedback-list">
          <thead><tr><th>Sent</th><th>Kind</th><th>Message</th><th>Via</th><th>Status</th><th>Reply</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
        : emptyState({
            title: "Nothing sent yet",
            body: "What you send here, from the Feedback button in the top bar, or through your agent, shows up here with its status and any reply.",
          })}
    </section>`;
  const reply = render(ctx, "Feedback", body, "feedback");
  return draft.error ? { ...reply, status: 400 } : reply;
}

async function sendFeedback(ctx: Ctx): Promise<Reply> {
  const f = ctx.form;
  const kind = f.get("kind") ?? "";
  const message = f.get("message") ?? "";
  const page = f.get("include_page") ? pageOf(f.get("page")) : null;
  let vault = f.get("vault") ?? "";
  // From the top bar on a vault's page, with "Include this page": that vault.
  if (!f.has("vault") && page) vault = /^\/v\/([0-9a-f-]{36})(?:[/?]|$)/.exec(page)?.[1] ?? "";
  const draft: Draft = { kind, message, vault, page };
  if (vault && !UUID.test(vault)) {
    return feedbackPage(ctx, { ...draft, vault: "", error: refusalText(new Refusal({ status: 400, where: "web app (feedback form)", why: "That vault isn’t one of yours: choose one from the list, or none." })) });
  }
  if (message.includes("\u0000")) {
    return feedbackPage(ctx, { ...draft, message: message.replaceAll("\u0000", ""), error: refusalText(new Refusal({ status: 400, where: "web app (feedback form)", why: "The message has a NUL character in it, which feedback can’t hold: remove it and send again." })) });
  }
  let id: string;
  try {
    id = await asPerson(ctx.userId, async (c) =>
      (await c.query(`select public.send_feedback($1, $2, $3::uuid, $4) as id`, [kind, message, vault || null, page])).rows[0].id as string,
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // The hourly limit (54000) is ours and in words; say it as the others.
    const error = e.code === "54000" ? refusalText(new Refusal({ status: 429, where: "database (feedback limit)", why: `${(e.message ?? "").replace(/^./, (s) => s.toUpperCase())}.` })) : refusalText(err);
    return feedbackPage(ctx, { ...draft, error });
  }
  void flushFeedbackNotices();
  ctx.setFlash(`Sent. Your ${KIND_WORD[kind] ?? "feedback"} (${id.slice(0, 8)}) went to the people who run this Reliquary; it’s listed below, where their reply will show.`, "success");
  return { redirect: "/feedback" };
}

// ---------------------------------------------------------------------------
// Notices to the operator

// Where notices go, or why nothing is sent. Names settings, never values.
export function noticeTarget(env: NodeJS.ProcessEnv = process.env): { to: string } | { off: string } {
  const set = (env.FEEDBACK_EMAIL ?? "").trim();
  if (set) return ADDRESS.test(set) && validFrom(set) ? { to: set } : { off: "FEEDBACK_EMAIL isn’t an email address" };
  if (env.SELF_HOSTED === "1") return { off: "FEEDBACK_EMAIL isn’t set: a self-hosted instance emails its own operator only, at that address" };
  if (env.VERCEL) return { to: OPERATOR.contactEmail };
  return { off: "FEEDBACK_EMAIL isn’t set (only the hosted service falls back to its operator’s contact address)" };
}

type Notice = {
  id: string;
  kind: string;
  message: string;
  more: boolean;
  sender: string;
  via: string;
  vault: string | null;
  context: string | null;
  created_at: Date;
};

export function noticeEmail(n: Notice): { subject: string; html: string } {
  const kind = KINDS.find((k) => k.id === n.kind)?.label ?? n.kind;
  const first = n.message.split("\n").find((l) => l.trim())?.trim() ?? "";
  const subject = `Reliquary feedback (${kind.toLowerCase()}): ${first.length > 60 ? `${first.slice(0, 57)}...` : first}`.replace(/[\r\n]+/g, " ");
  const row = (k: string, v: string | null) =>
    v ? `<tr><th style="text-align:left;padding:2px 12px 2px 0;vertical-align:top">${esc(k)}</th><td style="padding:2px 0">${esc(v)}</td></tr>` : "";
  const body = `<!doctype html><html><body style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111">
<p>New ${esc(KIND_WORD[n.kind] ?? "feedback")} for Reliquary.</p>
<table style="border-collapse:collapse">${row("Kind", kind)}${row("From", n.sender)}${row("Via", n.via)}${row("Vault", n.vault)}${row("Page", n.context)}${row("Sent", n.created_at.toISOString().replace("T", " ").slice(0, 16) + " UTC")}${row("Id", n.id)}</table>
<pre style="white-space:pre-wrap;font-family:inherit;border-left:3px solid #ccc;padding-left:12px">${esc(n.message)}${n.more ? "\n[...]" : ""}</pre>
<p style="color:#555">${n.more ? "The message goes on. " : ""}Read it all, set a status or reply with <code>scripts/feedback.sh show ${esc(n.id)}</code>. The sender sees your status and reply on their Feedback page.</p>
</body></html>`;
  return { subject, html: body };
}

let running: Promise<number> | undefined;

// Emails the operator about feedback not yet notified. Never throws: a
// failure is logged with its ref (failure.ts, mailer.ts) and the notice is
// tried again once its claim lapses. Returns how many were sent.
export function flushFeedbackNotices(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  running ??= flush(env).finally(() => (running = undefined));
  return running;
}

async function flush(env: NodeJS.ProcessEnv): Promise<number> {
  const target = noticeTarget(env);
  if ("off" in target || mailerOffReason()) return 0;
  let sent = 0;
  try {
    const { rows } = await pool.query(
      "select id, kind, message, more, sender, via, vault, context, created_at from private.claim_feedback_notices(5)",
    );
    for (const n of rows as Notice[]) {
      const { subject, html: body } = noticeEmail(n);
      const r = await sendEmail({
        to: target.to,
        subject,
        html: body,
        idempotencyKey: idempotencyKey("feedback", n.id),
        tag: "feedback",
        what: "Emailing the operator about new feedback",
      });
      if (r.sent) {
        await pool.query("select private.feedback_notified($1)", [n.id]);
        sent++;
      }
    }
  } catch (err) {
    fail(err, { what: "Emailing the operator about new feedback", where: "web app (feedback notices)", status: 500 });
  }
  return sent;
}

// At most once a minute per instance, from a signed-in page (server.ts).
let lastTick = 0;
export function feedbackTick(now = Date.now()): void {
  if (now - lastTick < 60_000) return;
  lastTick = now;
  void flushFeedbackNotices();
}
